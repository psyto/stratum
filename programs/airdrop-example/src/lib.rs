use anchor_lang::prelude::*;
use anchor_lang::solana_program::program::invoke_signed;
use stratum::{
    events::HistorySummary,
    expiry::ExpiryConfig,
    merkle::{hash_leaf, verify_proof},
};

declare_id!("6TTbWd9hqr6D2ijnT7RPm3EZws32Uiyfn52FEaJUvw6r");

/// SPL Token Program ID
pub mod spl_token {
    use anchor_lang::declare_id;
    declare_id!("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
}

/// Airdrop Example - Demonstrates Stratum state primitives
///
/// Features:
/// - Merkle tree whitelist (commit to 100k recipients in 32 bytes)
/// - Bitfield claim tracking (2048 claims per 0.003 SOL)
/// - Expiry with cleanup rewards
/// - Event-based history (minimal on-chain state)
///
/// Flow:
/// 1. Authority creates campaign with merkle root
/// 2. Authority funds the campaign vault
/// 3. Whitelisted users claim with merkle proof
/// 4. After expiry, anyone can cleanup for reward
#[program]
pub mod airdrop_example {
    use super::*;

    /// Create a new airdrop campaign
    ///
    /// # Arguments
    /// * `merkle_root` - Root of merkle tree containing eligible addresses
    /// * `total_recipients` - Total number of recipients in the tree
    /// * `amount_per_claim` - Token amount each recipient can claim
    /// * `expires_in_seconds` - Time until campaign expires (0 = never)
    pub fn create_campaign(
        ctx: Context<CreateCampaign>,
        merkle_root: [u8; 32],
        total_recipients: u64,
        amount_per_claim: u64,
        expires_in_seconds: i64,
    ) -> Result<()> {
        let campaign = &mut ctx.accounts.campaign;
        let clock = Clock::get()?;

        campaign.authority = ctx.accounts.authority.key();
        campaign.token_mint = ctx.accounts.token_mint.key();
        campaign.vault = ctx.accounts.vault.key();
        campaign.merkle_root = merkle_root;
        campaign.total_recipients = total_recipients;
        campaign.amount_per_claim = amount_per_claim;

        // Calculate required chunks for bitfield tracking
        campaign.chunks_required = ((total_recipients + 2047) / 2048) as u32;
        campaign.chunks_created = 0;

        // Setup expiry
        campaign.expiry = ExpiryConfig {
            created_at: clock.unix_timestamp,
            expires_at: if expires_in_seconds > 0 {
                clock.unix_timestamp + expires_in_seconds
            } else {
                0
            },
            grace_period: 86400, // 1 day grace period
            cleanup_reward: 10000, // 0.00001 SOL reward for cleanup
        };

        // Initialize history tracking
        campaign.claim_history = HistorySummary::default();

        campaign.is_active = true;
        campaign.bump = ctx.bumps.campaign;
        campaign.vault_bump = ctx.bumps.vault;

        emit!(CampaignCreated {
            campaign: campaign.key(),
            authority: campaign.authority,
            token_mint: campaign.token_mint,
            merkle_root,
            total_recipients,
            amount_per_claim,
            expires_at: campaign.expiry.expires_at,
        });

        msg!(
            "Campaign created: {} recipients, {} tokens each",
            total_recipients,
            amount_per_claim
        );

        Ok(())
    }

    /// Create a bitfield chunk for tracking claims
    ///
    /// Multiple chunks may be needed for large airdrops:
    /// - 2,048 recipients = 1 chunk
    /// - 100,000 recipients = 49 chunks
    pub fn create_claim_chunk(ctx: Context<CreateClaimChunk>, chunk_index: u32) -> Result<()> {
        let campaign = &mut ctx.accounts.campaign;
        let chunk = &mut ctx.accounts.claim_chunk;

        require!(
            chunk_index < campaign.chunks_required,
            AirdropError::InvalidChunkIndex
        );

        // Initialize the chunk
        chunk.campaign = campaign.key();
        chunk.chunk_index = chunk_index;
        chunk.bits = [0u8; 256]; // 2048 bits
        chunk.set_count = 0;
        chunk.bump = ctx.bumps.claim_chunk;

        campaign.chunks_created += 1;

        msg!("Created claim chunk {} of {}", chunk_index + 1, campaign.chunks_required);

        Ok(())
    }

    /// Claim airdrop tokens with merkle proof
    ///
    /// # Arguments
    /// * `proof` - Merkle proof siblings
    /// * `index` - Leaf index in the merkle tree
    pub fn claim(ctx: Context<Claim>, proof: Vec<[u8; 32]>, index: u32) -> Result<()> {
        let campaign = &ctx.accounts.campaign;
        let chunk = &mut ctx.accounts.claim_chunk;
        let clock = Clock::get()?;

        // Check campaign is active and not expired
        require!(campaign.is_active, AirdropError::CampaignInactive);
        require!(
            campaign.expiry.expires_at == 0 || clock.unix_timestamp <= campaign.expiry.expires_at,
            AirdropError::CampaignExpired
        );

        // Verify chunk index matches
        let expected_chunk = index / 2048;
        require!(
            chunk.chunk_index == expected_chunk,
            AirdropError::WrongClaimChunk
        );

        // Check not already claimed (bitfield)
        let local_index = (index % 2048) as u16;
        require!(!chunk.is_set(local_index), AirdropError::AlreadyClaimed);

        // Verify merkle proof
        let leaf = hash_leaf(ctx.accounts.claimer.key().as_ref());
        require!(
            verify_proof(&proof, campaign.merkle_root, leaf, index),
            AirdropError::InvalidProof
        );

        // Mark as claimed in bitfield
        chunk.set(local_index)?;

        // Transfer tokens via CPI
        let seeds = &[
            b"campaign",
            campaign.authority.as_ref(),
            campaign.token_mint.as_ref(),
            &[campaign.bump],
        ];
        let signer = &[&seeds[..]];

        spl_transfer(
            ctx.accounts.vault.to_account_info(),
            ctx.accounts.claimer_token_account.to_account_info(),
            ctx.accounts.campaign.to_account_info(),
            ctx.accounts.token_program.to_account_info(),
            campaign.amount_per_claim,
            signer,
        )?;

        // Update history (minimal on-chain state)
        let campaign = &mut ctx.accounts.campaign;
        let amount = campaign.amount_per_claim;
        let total_recipients = campaign.total_recipients;
        campaign.claim_history.record(
            amount,
            clock.slot,
            clock.unix_timestamp,
        );
        let total_claimed = campaign.claim_history.total_count;

        emit!(TokensClaimed {
            campaign: campaign.key(),
            claimer: ctx.accounts.claimer.key(),
            index,
            amount,
            total_claimed,
        });

        msg!(
            "Claimed {} tokens (claim #{} of {})",
            amount,
            total_claimed,
            total_recipients
        );

        Ok(())
    }

    /// Claim with variable amounts (pubkey + amount in merkle leaf)
    ///
    /// Use when different recipients get different amounts
    pub fn claim_variable(
        ctx: Context<Claim>,
        proof: Vec<[u8; 32]>,
        index: u32,
        amount: u64,
    ) -> Result<()> {
        let campaign = &ctx.accounts.campaign;
        let chunk = &mut ctx.accounts.claim_chunk;
        let clock = Clock::get()?;

        // Check campaign is active and not expired
        require!(campaign.is_active, AirdropError::CampaignInactive);
        require!(
            campaign.expiry.expires_at == 0 || clock.unix_timestamp <= campaign.expiry.expires_at,
            AirdropError::CampaignExpired
        );

        // Verify chunk index matches
        let expected_chunk = index / 2048;
        require!(
            chunk.chunk_index == expected_chunk,
            AirdropError::WrongClaimChunk
        );

        // Check not already claimed
        let local_index = (index % 2048) as u16;
        require!(!chunk.is_set(local_index), AirdropError::AlreadyClaimed);

        // Verify merkle proof with pubkey + amount as leaf
        let mut leaf_data = ctx.accounts.claimer.key().to_bytes().to_vec();
        leaf_data.extend_from_slice(&amount.to_le_bytes());
        let leaf = hash_leaf(&leaf_data);

        require!(
            verify_proof(&proof, campaign.merkle_root, leaf, index),
            AirdropError::InvalidProof
        );

        // Mark as claimed
        chunk.set(local_index)?;

        // Transfer tokens
        let seeds = &[
            b"campaign",
            campaign.authority.as_ref(),
            campaign.token_mint.as_ref(),
            &[campaign.bump],
        ];
        let signer = &[&seeds[..]];

        spl_transfer(
            ctx.accounts.vault.to_account_info(),
            ctx.accounts.claimer_token_account.to_account_info(),
            ctx.accounts.campaign.to_account_info(),
            ctx.accounts.token_program.to_account_info(),
            amount,
            signer,
        )?;

        // Update history
        let campaign = &mut ctx.accounts.campaign;
        campaign.claim_history.record(amount, clock.slot, clock.unix_timestamp);
        let total_claimed = campaign.claim_history.total_count;

        emit!(TokensClaimed {
            campaign: campaign.key(),
            claimer: ctx.accounts.claimer.key(),
            index,
            amount,
            total_claimed,
        });

        Ok(())
    }

    /// Pause the campaign (authority only)
    pub fn pause_campaign(ctx: Context<AdminAction>) -> Result<()> {
        let campaign = &mut ctx.accounts.campaign;
        campaign.is_active = false;

        emit!(CampaignPaused {
            campaign: campaign.key(),
            paused_by: ctx.accounts.authority.key(),
        });

        Ok(())
    }

    /// Resume the campaign (authority only)
    pub fn resume_campaign(ctx: Context<AdminAction>) -> Result<()> {
        let campaign = &mut ctx.accounts.campaign;
        campaign.is_active = true;

        emit!(CampaignResumed {
            campaign: campaign.key(),
            resumed_by: ctx.accounts.authority.key(),
        });

        Ok(())
    }

    /// Extend campaign expiry (authority only)
    pub fn extend_campaign(ctx: Context<AdminAction>, additional_seconds: i64) -> Result<()> {
        let campaign = &mut ctx.accounts.campaign;

        require!(campaign.expiry.expires_at > 0, AirdropError::NoExpiry);

        campaign.expiry.expires_at = campaign
            .expiry
            .expires_at
            .checked_add(additional_seconds)
            .ok_or(AirdropError::Overflow)?;

        emit!(CampaignExtended {
            campaign: campaign.key(),
            new_expires_at: campaign.expiry.expires_at,
        });

        Ok(())
    }

    /// Cleanup expired campaign and reclaim remaining tokens
    ///
    /// Anyone can call after expiry + grace period
    /// Caller receives cleanup_reward as incentive
    pub fn cleanup_campaign(ctx: Context<CleanupCampaign>) -> Result<()> {
        let campaign = &ctx.accounts.campaign;
        let clock = Clock::get()?;

        // Verify cleanup is allowed
        let cleanup_time = campaign
            .expiry
            .expires_at
            .checked_add(campaign.expiry.grace_period)
            .ok_or(AirdropError::Overflow)?;

        require!(
            campaign.expiry.expires_at > 0 && clock.unix_timestamp > cleanup_time,
            AirdropError::CannotCleanupYet
        );

        // Get remaining tokens by reading vault data
        let vault_data = ctx.accounts.vault.try_borrow_data()?;
        let remaining = if vault_data.len() >= 72 {
            u64::from_le_bytes(vault_data[64..72].try_into().unwrap())
        } else {
            0
        };
        drop(vault_data);

        // Transfer remaining tokens to authority
        if remaining > 0 {
            let seeds = &[
                b"campaign",
                campaign.authority.as_ref(),
                campaign.token_mint.as_ref(),
                &[campaign.bump],
            ];
            let signer = &[&seeds[..]];

            spl_transfer(
                ctx.accounts.vault.to_account_info(),
                ctx.accounts.authority_token_account.to_account_info(),
                ctx.accounts.campaign.to_account_info(),
                ctx.accounts.token_program.to_account_info(),
                remaining,
                signer,
            )?;
        }

        // Pay cleanup reward to caller
        let reward = campaign.expiry.cleanup_reward;
        if reward > 0 {
            **ctx.accounts.campaign.to_account_info().try_borrow_mut_lamports()? -= reward;
            **ctx.accounts.cleaner.to_account_info().try_borrow_mut_lamports()? += reward;
        }

        emit!(CampaignCleanedUp {
            campaign: campaign.key(),
            cleaner: ctx.accounts.cleaner.key(),
            remaining_tokens: remaining,
            reward_paid: reward,
            total_claimed: campaign.claim_history.total_count,
        });

        msg!(
            "Campaign cleaned up. {} tokens returned, {} claims completed",
            remaining,
            campaign.claim_history.total_count
        );

        Ok(())
    }
}

// =============================================================================
// SPL Token Transfer Helper
// =============================================================================

/// Perform SPL token transfer via CPI
fn spl_transfer<'info>(
    from: AccountInfo<'info>,
    to: AccountInfo<'info>,
    authority: AccountInfo<'info>,
    token_program: AccountInfo<'info>,
    amount: u64,
    signer_seeds: &[&[&[u8]]],
) -> Result<()> {
    let ix = spl_token_transfer_ix(from.key, to.key, authority.key, amount);
    invoke_signed(
        &ix,
        &[from, to, authority, token_program],
        signer_seeds,
    )?;
    Ok(())
}

/// Build SPL token transfer instruction
fn spl_token_transfer_ix(
    from: &Pubkey,
    to: &Pubkey,
    authority: &Pubkey,
    amount: u64,
) -> anchor_lang::solana_program::instruction::Instruction {
    anchor_lang::solana_program::instruction::Instruction {
        program_id: spl_token::ID,
        accounts: vec![
            anchor_lang::solana_program::instruction::AccountMeta::new(*from, false),
            anchor_lang::solana_program::instruction::AccountMeta::new(*to, false),
            anchor_lang::solana_program::instruction::AccountMeta::new_readonly(*authority, true),
        ],
        data: {
            let mut data = vec![3u8]; // Transfer instruction discriminator
            data.extend_from_slice(&amount.to_le_bytes());
            data
        },
    }
}

// =============================================================================
// Account Structures
// =============================================================================

#[account]
pub struct Campaign {
    /// Authority who created the campaign
    pub authority: Pubkey,
    /// Token mint for the airdrop
    pub token_mint: Pubkey,
    /// Vault holding airdrop tokens
    pub vault: Pubkey,
    /// Merkle root of eligible addresses
    pub merkle_root: [u8; 32],
    /// Total recipients in the merkle tree
    pub total_recipients: u64,
    /// Amount each recipient can claim
    pub amount_per_claim: u64,
    /// Number of bitfield chunks required
    pub chunks_required: u32,
    /// Number of chunks created so far
    pub chunks_created: u32,
    /// Expiry configuration
    pub expiry: ExpiryConfig,
    /// Claim history summary
    pub claim_history: HistorySummary,
    /// Whether campaign is active
    pub is_active: bool,
    /// PDA bump
    pub bump: u8,
    /// Vault PDA bump
    pub vault_bump: u8,
}

impl Campaign {
    pub const SPACE: usize = 8 + // discriminator
        32 + // authority
        32 + // token_mint
        32 + // vault
        32 + // merkle_root
        8 + // total_recipients
        8 + // amount_per_claim
        4 + // chunks_required
        4 + // chunks_created
        (8 + 8 + 8 + 8) + // expiry (ExpiryConfig)
        (8 + 16 + 8 + 8 + 8 + 8 + 32) + // claim_history (HistorySummary)
        1 + // is_active
        1 + // bump
        1; // vault_bump
}

/// Claim tracking chunk using Stratum's bitfield pattern
#[account]
pub struct ClaimChunk {
    /// Campaign this chunk belongs to
    pub campaign: Pubkey,
    /// Chunk index
    pub chunk_index: u32,
    /// Bits tracking claims (256 bytes = 2048 bits)
    pub bits: [u8; 256],
    /// Number of bits set
    pub set_count: u16,
    /// PDA bump
    pub bump: u8,
}

impl ClaimChunk {
    pub const SPACE: usize = 8 + // discriminator
        32 + // campaign
        4 + // chunk_index
        256 + // bits
        2 + // set_count
        1; // bump

    pub fn is_set(&self, index: u16) -> bool {
        if index >= 2048 {
            return false;
        }
        let byte_idx = (index / 8) as usize;
        let bit_idx = index % 8;
        (self.bits[byte_idx] >> bit_idx) & 1 == 1
    }

    pub fn set(&mut self, index: u16) -> Result<()> {
        require!(index < 2048, AirdropError::InvalidClaimIndex);
        let byte_idx = (index / 8) as usize;
        let bit_idx = index % 8;

        if !self.is_set(index) {
            self.bits[byte_idx] |= 1 << bit_idx;
            self.set_count += 1;
        }

        Ok(())
    }
}

// =============================================================================
// Account Contexts
// =============================================================================

#[derive(Accounts)]
pub struct CreateCampaign<'info> {
    #[account(
        init,
        payer = authority,
        space = Campaign::SPACE,
        seeds = [b"campaign", authority.key().as_ref(), token_mint.key().as_ref()],
        bump
    )]
    pub campaign: Account<'info, Campaign>,

    /// CHECK: Vault token account, initialized by token program
    #[account(
        mut,
        seeds = [b"vault", campaign.key().as_ref()],
        bump
    )]
    pub vault: AccountInfo<'info>,

    /// CHECK: Token mint account
    pub token_mint: AccountInfo<'info>,

    #[account(mut)]
    pub authority: Signer<'info>,

    /// CHECK: Token program
    #[account(address = spl_token::ID)]
    pub token_program: AccountInfo<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(chunk_index: u32)]
pub struct CreateClaimChunk<'info> {
    #[account(
        mut,
        seeds = [b"campaign", campaign.authority.as_ref(), campaign.token_mint.as_ref()],
        bump = campaign.bump,
        constraint = campaign.authority == authority.key() @ AirdropError::Unauthorized
    )]
    pub campaign: Account<'info, Campaign>,

    #[account(
        init,
        payer = authority,
        space = ClaimChunk::SPACE,
        seeds = [b"claim_chunk", campaign.key().as_ref(), &chunk_index.to_le_bytes()],
        bump
    )]
    pub claim_chunk: Account<'info, ClaimChunk>,

    #[account(mut)]
    pub authority: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(proof: Vec<[u8; 32]>, index: u32)]
pub struct Claim<'info> {
    #[account(
        mut,
        seeds = [b"campaign", campaign.authority.as_ref(), campaign.token_mint.as_ref()],
        bump = campaign.bump
    )]
    pub campaign: Account<'info, Campaign>,

    #[account(
        mut,
        seeds = [b"claim_chunk", campaign.key().as_ref(), &(index / 2048).to_le_bytes()],
        bump = claim_chunk.bump,
        constraint = claim_chunk.campaign == campaign.key() @ AirdropError::WrongClaimChunk
    )]
    pub claim_chunk: Account<'info, ClaimChunk>,

    /// CHECK: Vault token account
    #[account(
        mut,
        seeds = [b"vault", campaign.key().as_ref()],
        bump = campaign.vault_bump
    )]
    pub vault: AccountInfo<'info>,

    /// CHECK: Claimer's token account
    #[account(mut)]
    pub claimer_token_account: AccountInfo<'info>,

    pub claimer: Signer<'info>,

    /// CHECK: Token program
    #[account(address = spl_token::ID)]
    pub token_program: AccountInfo<'info>,
}

#[derive(Accounts)]
pub struct AdminAction<'info> {
    #[account(
        mut,
        seeds = [b"campaign", campaign.authority.as_ref(), campaign.token_mint.as_ref()],
        bump = campaign.bump,
        constraint = campaign.authority == authority.key() @ AirdropError::Unauthorized
    )]
    pub campaign: Account<'info, Campaign>,

    pub authority: Signer<'info>,
}

#[derive(Accounts)]
pub struct CleanupCampaign<'info> {
    #[account(
        mut,
        seeds = [b"campaign", campaign.authority.as_ref(), campaign.token_mint.as_ref()],
        bump = campaign.bump
    )]
    pub campaign: Account<'info, Campaign>,

    /// CHECK: Vault token account
    #[account(
        mut,
        seeds = [b"vault", campaign.key().as_ref()],
        bump = campaign.vault_bump
    )]
    pub vault: AccountInfo<'info>,

    /// CHECK: Authority's token account to receive remaining tokens
    #[account(mut)]
    pub authority_token_account: AccountInfo<'info>,

    /// Anyone can call cleanup, receives reward
    #[account(mut)]
    pub cleaner: Signer<'info>,

    /// CHECK: Token program
    #[account(address = spl_token::ID)]
    pub token_program: AccountInfo<'info>,
}

// =============================================================================
// Events
// =============================================================================

#[event]
pub struct CampaignCreated {
    pub campaign: Pubkey,
    pub authority: Pubkey,
    pub token_mint: Pubkey,
    pub merkle_root: [u8; 32],
    pub total_recipients: u64,
    pub amount_per_claim: u64,
    pub expires_at: i64,
}

#[event]
pub struct TokensClaimed {
    pub campaign: Pubkey,
    pub claimer: Pubkey,
    pub index: u32,
    pub amount: u64,
    pub total_claimed: u64,
}

#[event]
pub struct CampaignPaused {
    pub campaign: Pubkey,
    pub paused_by: Pubkey,
}

#[event]
pub struct CampaignResumed {
    pub campaign: Pubkey,
    pub resumed_by: Pubkey,
}

#[event]
pub struct CampaignExtended {
    pub campaign: Pubkey,
    pub new_expires_at: i64,
}

#[event]
pub struct CampaignCleanedUp {
    pub campaign: Pubkey,
    pub cleaner: Pubkey,
    pub remaining_tokens: u64,
    pub reward_paid: u64,
    pub total_claimed: u64,
}

// =============================================================================
// Errors
// =============================================================================

#[error_code]
pub enum AirdropError {
    #[msg("Unauthorized")]
    Unauthorized,

    #[msg("Campaign is not active")]
    CampaignInactive,

    #[msg("Campaign has expired")]
    CampaignExpired,

    #[msg("Invalid merkle proof")]
    InvalidProof,

    #[msg("Already claimed")]
    AlreadyClaimed,

    #[msg("Wrong claim chunk for this index")]
    WrongClaimChunk,

    #[msg("Invalid chunk index")]
    InvalidChunkIndex,

    #[msg("Invalid claim index")]
    InvalidClaimIndex,

    #[msg("Wrong token mint")]
    WrongTokenMint,

    #[msg("Wrong token owner")]
    WrongTokenOwner,

    #[msg("Cannot cleanup yet - wait for expiry + grace period")]
    CannotCleanupYet,

    #[msg("Campaign has no expiry")]
    NoExpiry,

    #[msg("Arithmetic overflow")]
    Overflow,
}
