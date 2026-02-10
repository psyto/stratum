use anchor_lang::prelude::*;
use anchor_lang::solana_program::program::invoke_signed;
use stratum::merkle::{hash_struct, verify_proof};
use stratum::expiry::ExpiryConfig;

pub mod errors;
pub mod events;
pub mod matching;
pub mod state;

use errors::OrderBookError;
use events::*;
use matching::{validate_price_match, calculate_quote_amount};
use state::*;

declare_id!("OBKm1111111111111111111111111111111111111111");

/// SPL Token Program ID
pub mod spl_token {
    use anchor_lang::declare_id;
    declare_id!("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
}

#[program]
pub mod stratum_orderbook {
    use super::*;

    /// Create a new order book for a trading pair
    pub fn create_order_book(
        ctx: Context<CreateOrderBook>,
        tick_size: u64,
        fee_bps: u16,
        settlement_ttl_seconds: i64,
    ) -> Result<()> {
        let ob = &mut ctx.accounts.order_book;
        let clock = Clock::get()?;

        require!(tick_size > 0, OrderBookError::InvalidTickSize);

        ob.authority = ctx.accounts.authority.key();
        ob.base_mint = ctx.accounts.base_mint.key();
        ob.quote_mint = ctx.accounts.quote_mint.key();
        ob.base_vault = ctx.accounts.base_vault.key();
        ob.quote_vault = ctx.accounts.quote_vault.key();
        ob.current_epoch = 0;
        ob.total_orders = 0;
        ob.total_settlements = 0;
        ob.tick_size = tick_size;
        ob.fee_bps = fee_bps;
        ob.fee_vault = ctx.accounts.fee_vault.key();
        ob.history = stratum::events::HistorySummary::default();
        ob.settlement_expiry = ExpiryConfig {
            created_at: clock.unix_timestamp,
            expires_at: 0, // template, actual settlement receipts get their own
            grace_period: 86400, // 1 day
            cleanup_reward: 5000, // 5000 lamports
        };
        ob.is_active = true;
        ob.bump = ctx.bumps.order_book;
        ob.base_vault_bump = ctx.bumps.base_vault;
        ob.quote_vault_bump = ctx.bumps.quote_vault;

        emit!(OrderBookCreated {
            order_book: ob.key(),
            authority: ob.authority,
            base_mint: ob.base_mint,
            quote_mint: ob.quote_mint,
            tick_size,
        });

        Ok(())
    }

    /// Create the next epoch for order batching
    pub fn create_epoch(ctx: Context<CreateEpoch>) -> Result<()> {
        let ob = &mut ctx.accounts.order_book;
        let epoch = &mut ctx.accounts.epoch;
        let clock = Clock::get()?;

        require!(ob.is_active, OrderBookError::OrderBookInactive);

        let epoch_index = ob.current_epoch;

        epoch.order_book = ob.key();
        epoch.epoch_index = epoch_index;
        epoch.merkle_root = [0u8; 32];
        epoch.order_count = 0;
        epoch.is_finalized = false;
        epoch.root_submitted = false;
        epoch.created_at = clock.unix_timestamp;
        epoch.finalized_at = 0;
        epoch.bump = ctx.bumps.epoch;

        ob.current_epoch = ob.current_epoch.saturating_add(1);

        emit!(EpochCreated {
            order_book: ob.key(),
            epoch: epoch.key(),
            epoch_index,
        });

        Ok(())
    }

    /// Create an order chunk (bitfield) for tracking active orders in an epoch
    pub fn create_order_chunk(
        ctx: Context<CreateOrderChunk>,
        chunk_index: u32,
    ) -> Result<()> {
        let chunk = &mut ctx.accounts.order_chunk;

        chunk.epoch = ctx.accounts.epoch.key();
        chunk.chunk_index = chunk_index;
        chunk.bits = [0u8; 256];
        chunk.active_count = 0;
        chunk.bump = ctx.bumps.order_chunk;

        Ok(())
    }

    /// Cranker submits a computed merkle root for an epoch's orders
    pub fn submit_epoch_root(
        ctx: Context<SubmitEpochRoot>,
        root: [u8; 32],
        order_count: u32,
    ) -> Result<()> {
        let epoch = &mut ctx.accounts.epoch;

        require!(!epoch.is_finalized, OrderBookError::EpochAlreadyFinalized);
        require!(!epoch.root_submitted, OrderBookError::EpochRootAlreadySubmitted);

        epoch.merkle_root = root;
        epoch.order_count = order_count;
        epoch.root_submitted = true;

        let ob = &mut ctx.accounts.order_book;
        ob.total_orders = ob.total_orders.saturating_add(order_count as u64);

        emit!(EpochRootSubmitted {
            epoch: epoch.key(),
            merkle_root: root,
            order_count,
        });

        Ok(())
    }

    /// Finalize an epoch — no more orders can be added
    pub fn finalize_epoch(ctx: Context<FinalizeEpoch>) -> Result<()> {
        let epoch = &mut ctx.accounts.epoch;
        let clock = Clock::get()?;

        require!(!epoch.is_finalized, OrderBookError::EpochAlreadyFinalized);
        require!(epoch.root_submitted, OrderBookError::EpochNotFinalized);

        epoch.is_finalized = true;
        epoch.finalized_at = clock.unix_timestamp;

        emit!(EpochFinalized {
            epoch: epoch.key(),
            epoch_index: epoch.epoch_index,
            order_count: epoch.order_count,
        });

        Ok(())
    }

    /// Core matching instruction: verify both proofs, check bitfields,
    /// validate price, transfer tokens, update bitfield, emit event
    pub fn settle_match(
        ctx: Context<SettleMatch>,
        maker_order: OrderLeaf,
        maker_proof: Vec<[u8; 32]>,
        maker_index: u32,
        taker_order: OrderLeaf,
        taker_proof: Vec<[u8; 32]>,
        taker_index: u32,
        fill_amount: u64,
    ) -> Result<()> {
        let ob = &ctx.accounts.order_book;
        let clock = Clock::get()?;

        require!(ob.is_active, OrderBookError::OrderBookInactive);
        require!(fill_amount > 0, OrderBookError::ZeroFillAmount);

        // Verify maker epoch is finalized
        let maker_epoch = &ctx.accounts.maker_epoch;
        require!(maker_epoch.is_finalized, OrderBookError::EpochNotFinalized);

        // Verify taker epoch is finalized
        let taker_epoch = &ctx.accounts.taker_epoch;
        require!(taker_epoch.is_finalized, OrderBookError::EpochNotFinalized);

        // Verify maker merkle proof
        let maker_leaf = hash_struct(&maker_order)?;
        require!(
            verify_proof(&maker_proof, maker_epoch.merkle_root, maker_leaf, maker_index),
            OrderBookError::InvalidMakerProof
        );

        // Verify taker merkle proof
        let taker_leaf = hash_struct(&taker_order)?;
        require!(
            verify_proof(&taker_proof, taker_epoch.merkle_root, taker_leaf, taker_index),
            OrderBookError::InvalidTakerProof
        );

        // Check bitfield — both orders must be active
        let maker_chunk = &mut ctx.accounts.maker_chunk;
        let (_, maker_local) = OrderChunk::split_index(maker_index);
        require!(
            maker_chunk.is_active(maker_local),
            OrderBookError::OrderNotActive
        );

        let taker_chunk = &mut ctx.accounts.taker_chunk;
        let (_, taker_local) = OrderChunk::split_index(taker_index);
        require!(
            taker_chunk.is_active(taker_local),
            OrderBookError::OrderNotActive
        );

        // Validate fill amount doesn't exceed order amounts
        require!(
            fill_amount <= maker_order.amount,
            OrderBookError::FillAmountExceeded
        );
        require!(
            fill_amount <= taker_order.amount,
            OrderBookError::FillAmountExceeded
        );

        // Validate price match
        let fill_price = validate_price_match(
            maker_order.side,
            maker_order.price,
            taker_order.side,
            taker_order.price,
        )?;

        // Calculate quote amount
        let quote_amount = calculate_quote_amount(fill_amount, fill_price, ob.tick_size)?;

        // Calculate fee
        let fee = (quote_amount as u128)
            .checked_mul(ob.fee_bps as u128)
            .ok_or(OrderBookError::Overflow)?
            .checked_div(10000)
            .ok_or(OrderBookError::Overflow)? as u64;

        // Transfer tokens based on order sides
        let ob_seeds = &[
            OrderBook::SEED_PREFIX,
            ob.authority.as_ref(),
            ob.base_mint.as_ref(),
            ob.quote_mint.as_ref(),
            &[ob.bump],
        ];
        let signer = &[&ob_seeds[..]];

        match maker_order.side {
            OrderSide::Ask => {
                // Maker sells base, taker buys base
                // Transfer base: vault → taker
                spl_transfer(
                    ctx.accounts.base_vault.to_account_info(),
                    ctx.accounts.taker_base_account.to_account_info(),
                    ctx.accounts.order_book.to_account_info(),
                    ctx.accounts.token_program.to_account_info(),
                    fill_amount,
                    signer,
                )?;
                // Transfer quote (minus fee): vault → maker
                spl_transfer(
                    ctx.accounts.quote_vault.to_account_info(),
                    ctx.accounts.maker_quote_account.to_account_info(),
                    ctx.accounts.order_book.to_account_info(),
                    ctx.accounts.token_program.to_account_info(),
                    quote_amount.saturating_sub(fee),
                    signer,
                )?;
            }
            OrderSide::Bid => {
                // Maker buys base, taker sells base
                // Transfer base: vault → maker
                spl_transfer(
                    ctx.accounts.base_vault.to_account_info(),
                    ctx.accounts.maker_base_account.to_account_info(),
                    ctx.accounts.order_book.to_account_info(),
                    ctx.accounts.token_program.to_account_info(),
                    fill_amount,
                    signer,
                )?;
                // Transfer quote (minus fee): vault → taker
                spl_transfer(
                    ctx.accounts.quote_vault.to_account_info(),
                    ctx.accounts.taker_quote_account.to_account_info(),
                    ctx.accounts.order_book.to_account_info(),
                    ctx.accounts.token_program.to_account_info(),
                    quote_amount.saturating_sub(fee),
                    signer,
                )?;
            }
        }

        // Transfer fee to fee vault
        if fee > 0 {
            spl_transfer(
                ctx.accounts.quote_vault.to_account_info(),
                ctx.accounts.fee_vault.to_account_info(),
                ctx.accounts.order_book.to_account_info(),
                ctx.accounts.token_program.to_account_info(),
                fee,
                signer,
            )?;
        }

        // If fill_amount == order amount, unset bitfield bits (fully filled)
        if fill_amount == maker_order.amount {
            maker_chunk.set_inactive(maker_local);
        }
        if fill_amount == taker_order.amount {
            taker_chunk.set_inactive(taker_local);
        }

        // Create settlement receipt
        let receipt = &mut ctx.accounts.settlement_receipt;
        receipt.order_book = ob.key();
        receipt.maker = maker_order.maker;
        receipt.taker = taker_order.maker;
        receipt.maker_order_id = maker_order.order_id;
        receipt.taker_order_id = taker_order.order_id;
        receipt.fill_amount = fill_amount;
        receipt.fill_price = fill_price;
        receipt.fee_paid = fee;
        receipt.expiry = ExpiryConfig {
            created_at: clock.unix_timestamp,
            expires_at: clock.unix_timestamp + 604800, // 1 week
            grace_period: ob.settlement_expiry.grace_period,
            cleanup_reward: ob.settlement_expiry.cleanup_reward,
        };
        receipt.settled_at = clock.unix_timestamp;
        receipt.bump = ctx.bumps.settlement_receipt;

        // Update order book history
        let ob = &mut ctx.accounts.order_book;
        ob.total_settlements = ob.total_settlements.saturating_add(1);
        ob.history.record(fill_amount, clock.slot, clock.unix_timestamp);

        emit!(OrderSettled {
            order_book: ob.key(),
            maker: maker_order.maker,
            taker: taker_order.maker,
            fill_amount,
            fill_price,
            maker_order_id: maker_order.order_id,
            taker_order_id: taker_order.order_id,
        });

        Ok(())
    }

    /// Maker cancels their own order: verify proof + unset bit
    pub fn cancel_order(
        ctx: Context<CancelOrder>,
        order: OrderLeaf,
        proof: Vec<[u8; 32]>,
        index: u32,
    ) -> Result<()> {
        let epoch = &ctx.accounts.epoch;
        let chunk = &mut ctx.accounts.order_chunk;

        require!(epoch.is_finalized, OrderBookError::EpochNotFinalized);

        // Verify the canceller is the maker
        require!(
            order.maker == ctx.accounts.maker.key(),
            OrderBookError::NotOrderOwner
        );

        // Verify merkle proof
        let leaf = hash_struct(&order)?;
        require!(
            verify_proof(&proof, epoch.merkle_root, leaf, index),
            OrderBookError::InvalidMakerProof
        );

        // Check order is active
        let (_, local_index) = OrderChunk::split_index(index);
        require!(
            chunk.is_active(local_index),
            OrderBookError::OrderNotActive
        );

        // Unset the bit
        chunk.set_inactive(local_index);

        // Refund tokens to maker (from appropriate vault based on side)
        let ob = &ctx.accounts.order_book;
        let ob_seeds = &[
            OrderBook::SEED_PREFIX,
            ob.authority.as_ref(),
            ob.base_mint.as_ref(),
            ob.quote_mint.as_ref(),
            &[ob.bump],
        ];
        let signer = &[&ob_seeds[..]];

        match order.side {
            OrderSide::Ask => {
                // Was selling base, refund base
                spl_transfer(
                    ctx.accounts.base_vault.to_account_info(),
                    ctx.accounts.maker_refund_account.to_account_info(),
                    ctx.accounts.order_book.to_account_info(),
                    ctx.accounts.token_program.to_account_info(),
                    order.amount,
                    signer,
                )?;
            }
            OrderSide::Bid => {
                // Was buying base (deposited quote), refund quote
                let quote_amount = calculate_quote_amount(order.amount, order.price, ob.tick_size)?;
                spl_transfer(
                    ctx.accounts.quote_vault.to_account_info(),
                    ctx.accounts.maker_refund_account.to_account_info(),
                    ctx.accounts.order_book.to_account_info(),
                    ctx.accounts.token_program.to_account_info(),
                    quote_amount,
                    signer,
                )?;
            }
        }

        emit!(OrderCancelled {
            order_book: ob.key(),
            maker: order.maker,
            order_id: order.order_id,
            epoch_index: order.epoch_index,
            order_index: order.order_index,
        });

        Ok(())
    }

    /// Anyone can cleanup expired orders for a reward
    pub fn cleanup_expired_orders(
        ctx: Context<CleanupExpiredOrder>,
        order: OrderLeaf,
        proof: Vec<[u8; 32]>,
        index: u32,
    ) -> Result<()> {
        let epoch = &ctx.accounts.epoch;
        let chunk = &mut ctx.accounts.order_chunk;
        let clock = Clock::get()?;

        // Verify the order has expired
        require!(
            order.expires_at > 0 && clock.unix_timestamp > order.expires_at,
            OrderBookError::OrderNotExpired
        );

        // Verify merkle proof
        let leaf = hash_struct(&order)?;
        require!(
            verify_proof(&proof, epoch.merkle_root, leaf, index),
            OrderBookError::InvalidMakerProof
        );

        // Check order is still active
        let (_, local_index) = OrderChunk::split_index(index);
        require!(
            chunk.is_active(local_index),
            OrderBookError::OrderNotActive
        );

        // Unset the bit
        chunk.set_inactive(local_index);

        // Refund tokens to maker
        let ob = &ctx.accounts.order_book;
        let ob_seeds = &[
            OrderBook::SEED_PREFIX,
            ob.authority.as_ref(),
            ob.base_mint.as_ref(),
            ob.quote_mint.as_ref(),
            &[ob.bump],
        ];
        let signer = &[&ob_seeds[..]];

        match order.side {
            OrderSide::Ask => {
                spl_transfer(
                    ctx.accounts.base_vault.to_account_info(),
                    ctx.accounts.maker_refund_account.to_account_info(),
                    ctx.accounts.order_book.to_account_info(),
                    ctx.accounts.token_program.to_account_info(),
                    order.amount,
                    signer,
                )?;
            }
            OrderSide::Bid => {
                let quote_amount = calculate_quote_amount(order.amount, order.price, ob.tick_size)?;
                spl_transfer(
                    ctx.accounts.quote_vault.to_account_info(),
                    ctx.accounts.maker_refund_account.to_account_info(),
                    ctx.accounts.order_book.to_account_info(),
                    ctx.accounts.token_program.to_account_info(),
                    quote_amount,
                    signer,
                )?;
            }
        }

        // Pay cleanup reward to caller
        let reward = ob.settlement_expiry.cleanup_reward;
        if reward > 0 {
            **ctx.accounts.order_book.to_account_info().try_borrow_mut_lamports()? -= reward;
            **ctx.accounts.cleaner.to_account_info().try_borrow_mut_lamports()? += reward;
        }

        emit!(ExpiredOrderCleaned {
            order_book: ob.key(),
            order_id: order.order_id,
            epoch_index: order.epoch_index,
            order_index: order.order_index,
            cleaner: ctx.accounts.cleaner.key(),
            reward,
        });

        Ok(())
    }

    /// Reclaim settlement receipt rent after expiry
    pub fn cleanup_settlement(ctx: Context<CleanupSettlement>) -> Result<()> {
        let receipt = &ctx.accounts.settlement_receipt;
        let clock = Clock::get()?;

        let cleanup_time = receipt
            .expiry
            .expires_at
            .checked_add(receipt.expiry.grace_period)
            .ok_or(OrderBookError::Overflow)?;

        require!(
            receipt.expiry.expires_at > 0 && clock.unix_timestamp > cleanup_time,
            OrderBookError::SettlementNotExpired
        );

        let reward = receipt.expiry.cleanup_reward;
        if reward > 0 {
            **ctx.accounts.settlement_receipt.to_account_info().try_borrow_mut_lamports()? -= reward;
            **ctx.accounts.cleaner.to_account_info().try_borrow_mut_lamports()? += reward;
        }

        emit!(SettlementCleaned {
            settlement: ctx.accounts.settlement_receipt.key(),
            cleaner: ctx.accounts.cleaner.key(),
            reward,
        });

        // Close the account — rent goes to cleaner
        Ok(())
    }
}

// =============================================================================
// SPL Token Transfer Helper
// =============================================================================

fn spl_transfer<'info>(
    from: AccountInfo<'info>,
    to: AccountInfo<'info>,
    authority: AccountInfo<'info>,
    token_program: AccountInfo<'info>,
    amount: u64,
    signer_seeds: &[&[&[u8]]],
) -> Result<()> {
    if amount == 0 {
        return Ok(());
    }
    let ix = anchor_lang::solana_program::instruction::Instruction {
        program_id: spl_token::ID,
        accounts: vec![
            anchor_lang::solana_program::instruction::AccountMeta::new(*from.key, false),
            anchor_lang::solana_program::instruction::AccountMeta::new(*to.key, false),
            anchor_lang::solana_program::instruction::AccountMeta::new_readonly(*authority.key, true),
        ],
        data: {
            let mut data = vec![3u8]; // Transfer instruction discriminator
            data.extend_from_slice(&amount.to_le_bytes());
            data
        },
    };
    invoke_signed(&ix, &[from, to, authority, token_program], signer_seeds)?;
    Ok(())
}

// =============================================================================
// Account Contexts
// =============================================================================

#[derive(Accounts)]
pub struct CreateOrderBook<'info> {
    #[account(
        init,
        payer = authority,
        space = OrderBook::SPACE,
        seeds = [
            OrderBook::SEED_PREFIX,
            authority.key().as_ref(),
            base_mint.key().as_ref(),
            quote_mint.key().as_ref()
        ],
        bump
    )]
    pub order_book: Account<'info, OrderBook>,

    /// CHECK: Base token vault
    #[account(
        mut,
        seeds = [b"base_vault", order_book.key().as_ref()],
        bump
    )]
    pub base_vault: AccountInfo<'info>,

    /// CHECK: Quote token vault
    #[account(
        mut,
        seeds = [b"quote_vault", order_book.key().as_ref()],
        bump
    )]
    pub quote_vault: AccountInfo<'info>,

    /// CHECK: Base token mint
    pub base_mint: AccountInfo<'info>,

    /// CHECK: Quote token mint
    pub quote_mint: AccountInfo<'info>,

    /// CHECK: Fee collection vault
    pub fee_vault: AccountInfo<'info>,

    #[account(mut)]
    pub authority: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct CreateEpoch<'info> {
    #[account(
        mut,
        seeds = [
            OrderBook::SEED_PREFIX,
            order_book.authority.as_ref(),
            order_book.base_mint.as_ref(),
            order_book.quote_mint.as_ref()
        ],
        bump = order_book.bump,
        constraint = order_book.authority == authority.key() @ OrderBookError::Unauthorized
    )]
    pub order_book: Account<'info, OrderBook>,

    #[account(
        init,
        payer = authority,
        space = Epoch::SPACE,
        seeds = [
            Epoch::SEED_PREFIX,
            order_book.key().as_ref(),
            &order_book.current_epoch.to_le_bytes()
        ],
        bump
    )]
    pub epoch: Account<'info, Epoch>,

    #[account(mut)]
    pub authority: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(chunk_index: u32)]
pub struct CreateOrderChunk<'info> {
    #[account(
        seeds = [
            OrderBook::SEED_PREFIX,
            order_book.authority.as_ref(),
            order_book.base_mint.as_ref(),
            order_book.quote_mint.as_ref()
        ],
        bump = order_book.bump,
        constraint = order_book.authority == authority.key() @ OrderBookError::Unauthorized
    )]
    pub order_book: Account<'info, OrderBook>,

    #[account(
        seeds = [
            Epoch::SEED_PREFIX,
            order_book.key().as_ref(),
            &epoch.epoch_index.to_le_bytes()
        ],
        bump = epoch.bump,
        constraint = epoch.order_book == order_book.key() @ OrderBookError::Unauthorized
    )]
    pub epoch: Account<'info, Epoch>,

    #[account(
        init,
        payer = authority,
        space = OrderChunk::SPACE,
        seeds = [
            OrderChunk::SEED_PREFIX,
            epoch.key().as_ref(),
            &chunk_index.to_le_bytes()
        ],
        bump
    )]
    pub order_chunk: Account<'info, OrderChunk>,

    #[account(mut)]
    pub authority: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SubmitEpochRoot<'info> {
    #[account(
        mut,
        seeds = [
            OrderBook::SEED_PREFIX,
            order_book.authority.as_ref(),
            order_book.base_mint.as_ref(),
            order_book.quote_mint.as_ref()
        ],
        bump = order_book.bump,
        constraint = order_book.authority == authority.key() @ OrderBookError::Unauthorized
    )]
    pub order_book: Account<'info, OrderBook>,

    #[account(
        mut,
        seeds = [
            Epoch::SEED_PREFIX,
            order_book.key().as_ref(),
            &epoch.epoch_index.to_le_bytes()
        ],
        bump = epoch.bump,
        constraint = epoch.order_book == order_book.key() @ OrderBookError::Unauthorized
    )]
    pub epoch: Account<'info, Epoch>,

    pub authority: Signer<'info>,
}

#[derive(Accounts)]
pub struct FinalizeEpoch<'info> {
    #[account(
        seeds = [
            OrderBook::SEED_PREFIX,
            order_book.authority.as_ref(),
            order_book.base_mint.as_ref(),
            order_book.quote_mint.as_ref()
        ],
        bump = order_book.bump,
        constraint = order_book.authority == authority.key() @ OrderBookError::Unauthorized
    )]
    pub order_book: Account<'info, OrderBook>,

    #[account(
        mut,
        seeds = [
            Epoch::SEED_PREFIX,
            order_book.key().as_ref(),
            &epoch.epoch_index.to_le_bytes()
        ],
        bump = epoch.bump,
        constraint = epoch.order_book == order_book.key() @ OrderBookError::Unauthorized
    )]
    pub epoch: Account<'info, Epoch>,

    pub authority: Signer<'info>,
}

#[derive(Accounts)]
#[instruction(
    maker_order: OrderLeaf,
    maker_proof: Vec<[u8; 32]>,
    maker_index: u32,
    taker_order: OrderLeaf,
    taker_proof: Vec<[u8; 32]>,
    taker_index: u32,
    fill_amount: u64,
)]
pub struct SettleMatch<'info> {
    #[account(
        mut,
        seeds = [
            OrderBook::SEED_PREFIX,
            order_book.authority.as_ref(),
            order_book.base_mint.as_ref(),
            order_book.quote_mint.as_ref()
        ],
        bump = order_book.bump
    )]
    pub order_book: Account<'info, OrderBook>,

    #[account(
        seeds = [
            Epoch::SEED_PREFIX,
            order_book.key().as_ref(),
            &maker_epoch.epoch_index.to_le_bytes()
        ],
        bump = maker_epoch.bump,
        constraint = maker_epoch.order_book == order_book.key() @ OrderBookError::Unauthorized
    )]
    pub maker_epoch: Account<'info, Epoch>,

    #[account(
        seeds = [
            Epoch::SEED_PREFIX,
            order_book.key().as_ref(),
            &taker_epoch.epoch_index.to_le_bytes()
        ],
        bump = taker_epoch.bump,
        constraint = taker_epoch.order_book == order_book.key() @ OrderBookError::Unauthorized
    )]
    pub taker_epoch: Account<'info, Epoch>,

    #[account(
        mut,
        seeds = [
            OrderChunk::SEED_PREFIX,
            maker_epoch.key().as_ref(),
            &(maker_index / OrderChunk::BITS_PER_CHUNK).to_le_bytes()
        ],
        bump = maker_chunk.bump,
        constraint = maker_chunk.epoch == maker_epoch.key() @ OrderBookError::Unauthorized
    )]
    pub maker_chunk: Account<'info, OrderChunk>,

    #[account(
        mut,
        seeds = [
            OrderChunk::SEED_PREFIX,
            taker_epoch.key().as_ref(),
            &(taker_index / OrderChunk::BITS_PER_CHUNK).to_le_bytes()
        ],
        bump = taker_chunk.bump,
        constraint = taker_chunk.epoch == taker_epoch.key() @ OrderBookError::Unauthorized
    )]
    pub taker_chunk: Account<'info, OrderChunk>,

    #[account(
        init,
        payer = cranker,
        space = SettlementReceipt::SPACE,
        seeds = [
            SettlementReceipt::SEED_PREFIX,
            order_book.key().as_ref(),
            &maker_order.order_id.to_le_bytes(),
            &taker_order.order_id.to_le_bytes()
        ],
        bump
    )]
    pub settlement_receipt: Account<'info, SettlementReceipt>,

    /// CHECK: Base token vault
    #[account(
        mut,
        seeds = [b"base_vault", order_book.key().as_ref()],
        bump = order_book.base_vault_bump
    )]
    pub base_vault: AccountInfo<'info>,

    /// CHECK: Quote token vault
    #[account(
        mut,
        seeds = [b"quote_vault", order_book.key().as_ref()],
        bump = order_book.quote_vault_bump
    )]
    pub quote_vault: AccountInfo<'info>,

    /// CHECK: Fee vault
    #[account(mut, constraint = fee_vault.key() == order_book.fee_vault @ OrderBookError::Unauthorized)]
    pub fee_vault: AccountInfo<'info>,

    /// CHECK: Maker's base token account
    #[account(mut)]
    pub maker_base_account: AccountInfo<'info>,

    /// CHECK: Maker's quote token account
    #[account(mut)]
    pub maker_quote_account: AccountInfo<'info>,

    /// CHECK: Taker's base token account
    #[account(mut)]
    pub taker_base_account: AccountInfo<'info>,

    /// CHECK: Taker's quote token account
    #[account(mut)]
    pub taker_quote_account: AccountInfo<'info>,

    #[account(mut)]
    pub cranker: Signer<'info>,

    /// CHECK: Token program
    #[account(address = spl_token::ID)]
    pub token_program: AccountInfo<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(order: OrderLeaf, proof: Vec<[u8; 32]>, index: u32)]
pub struct CancelOrder<'info> {
    #[account(
        seeds = [
            OrderBook::SEED_PREFIX,
            order_book.authority.as_ref(),
            order_book.base_mint.as_ref(),
            order_book.quote_mint.as_ref()
        ],
        bump = order_book.bump
    )]
    pub order_book: Account<'info, OrderBook>,

    #[account(
        seeds = [
            Epoch::SEED_PREFIX,
            order_book.key().as_ref(),
            &epoch.epoch_index.to_le_bytes()
        ],
        bump = epoch.bump,
        constraint = epoch.order_book == order_book.key() @ OrderBookError::Unauthorized
    )]
    pub epoch: Account<'info, Epoch>,

    #[account(
        mut,
        seeds = [
            OrderChunk::SEED_PREFIX,
            epoch.key().as_ref(),
            &(index / OrderChunk::BITS_PER_CHUNK).to_le_bytes()
        ],
        bump = order_chunk.bump,
        constraint = order_chunk.epoch == epoch.key() @ OrderBookError::Unauthorized
    )]
    pub order_chunk: Account<'info, OrderChunk>,

    /// CHECK: Base vault for refunds
    #[account(
        mut,
        seeds = [b"base_vault", order_book.key().as_ref()],
        bump = order_book.base_vault_bump
    )]
    pub base_vault: AccountInfo<'info>,

    /// CHECK: Quote vault for refunds
    #[account(
        mut,
        seeds = [b"quote_vault", order_book.key().as_ref()],
        bump = order_book.quote_vault_bump
    )]
    pub quote_vault: AccountInfo<'info>,

    /// CHECK: Maker's token account to receive refund
    #[account(mut)]
    pub maker_refund_account: AccountInfo<'info>,

    pub maker: Signer<'info>,

    /// CHECK: Token program
    #[account(address = spl_token::ID)]
    pub token_program: AccountInfo<'info>,
}

#[derive(Accounts)]
#[instruction(order: OrderLeaf, proof: Vec<[u8; 32]>, index: u32)]
pub struct CleanupExpiredOrder<'info> {
    #[account(
        mut,
        seeds = [
            OrderBook::SEED_PREFIX,
            order_book.authority.as_ref(),
            order_book.base_mint.as_ref(),
            order_book.quote_mint.as_ref()
        ],
        bump = order_book.bump
    )]
    pub order_book: Account<'info, OrderBook>,

    #[account(
        seeds = [
            Epoch::SEED_PREFIX,
            order_book.key().as_ref(),
            &epoch.epoch_index.to_le_bytes()
        ],
        bump = epoch.bump,
        constraint = epoch.order_book == order_book.key() @ OrderBookError::Unauthorized
    )]
    pub epoch: Account<'info, Epoch>,

    #[account(
        mut,
        seeds = [
            OrderChunk::SEED_PREFIX,
            epoch.key().as_ref(),
            &(index / OrderChunk::BITS_PER_CHUNK).to_le_bytes()
        ],
        bump = order_chunk.bump,
        constraint = order_chunk.epoch == epoch.key() @ OrderBookError::Unauthorized
    )]
    pub order_chunk: Account<'info, OrderChunk>,

    /// CHECK: Base vault
    #[account(
        mut,
        seeds = [b"base_vault", order_book.key().as_ref()],
        bump = order_book.base_vault_bump
    )]
    pub base_vault: AccountInfo<'info>,

    /// CHECK: Quote vault
    #[account(
        mut,
        seeds = [b"quote_vault", order_book.key().as_ref()],
        bump = order_book.quote_vault_bump
    )]
    pub quote_vault: AccountInfo<'info>,

    /// CHECK: Maker's refund account
    #[account(mut)]
    pub maker_refund_account: AccountInfo<'info>,

    /// Anyone can call cleanup
    #[account(mut)]
    pub cleaner: Signer<'info>,

    /// CHECK: Token program
    #[account(address = spl_token::ID)]
    pub token_program: AccountInfo<'info>,
}

#[derive(Accounts)]
pub struct CleanupSettlement<'info> {
    #[account(
        mut,
        close = cleaner
    )]
    pub settlement_receipt: Account<'info, SettlementReceipt>,

    /// Anyone can call cleanup
    #[account(mut)]
    pub cleaner: Signer<'info>,
}
