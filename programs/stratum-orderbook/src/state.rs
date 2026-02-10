use anchor_lang::prelude::*;
use stratum::events::HistorySummary;
use stratum::expiry::ExpiryConfig;

/// Order side enum
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, InitSpace)]
pub enum OrderSide {
    Bid,
    Ask,
}

/// Order book for a trading pair
#[account]
pub struct OrderBook {
    /// Authority that manages this order book
    pub authority: Pubkey,

    /// Base token mint (the asset being traded)
    pub base_mint: Pubkey,

    /// Quote token mint (the pricing currency)
    pub quote_mint: Pubkey,

    /// Base token vault (holds maker deposits for bids/asks)
    pub base_vault: Pubkey,

    /// Quote token vault
    pub quote_vault: Pubkey,

    /// Current epoch index (incremented when a new epoch is created)
    pub current_epoch: u32,

    /// Total orders ever submitted across all epochs
    pub total_orders: u64,

    /// Total settlements completed
    pub total_settlements: u64,

    /// Minimum price increment (price precision)
    pub tick_size: u64,

    /// Fee in basis points charged on fills
    pub fee_bps: u16,

    /// Fee destination account
    pub fee_vault: Pubkey,

    /// Aggregate trade history (from Stratum)
    pub history: HistorySummary,

    /// Expiry config for settlement receipts
    pub settlement_expiry: ExpiryConfig,

    /// Whether the order book is active
    pub is_active: bool,

    /// PDA bump
    pub bump: u8,

    /// Base vault bump
    pub base_vault_bump: u8,

    /// Quote vault bump
    pub quote_vault_bump: u8,
}

impl OrderBook {
    pub const SPACE: usize = 8 + // discriminator
        32 + // authority
        32 + // base_mint
        32 + // quote_mint
        32 + // base_vault
        32 + // quote_vault
        4 +  // current_epoch
        8 +  // total_orders
        8 +  // total_settlements
        8 +  // tick_size
        2 +  // fee_bps
        32 + // fee_vault
        (8 + 16 + 8 + 8 + 8 + 8 + 32) + // history (HistorySummary)
        (8 + 8 + 8 + 8) + // settlement_expiry (ExpiryConfig)
        1 +  // is_active
        1 +  // bump
        1 +  // base_vault_bump
        1;   // quote_vault_bump

    pub const SEED_PREFIX: &'static [u8] = b"order_book";
}

/// An epoch containing a batch of orders committed via merkle root
#[account]
pub struct Epoch {
    /// Parent order book
    pub order_book: Pubkey,

    /// Epoch index (sequential)
    pub epoch_index: u32,

    /// Merkle root committing to all orders in this epoch
    pub merkle_root: [u8; 32],

    /// Number of orders in this epoch
    pub order_count: u32,

    /// Whether this epoch is finalized (no more orders)
    pub is_finalized: bool,

    /// Whether the merkle root has been submitted
    pub root_submitted: bool,

    /// Creation timestamp
    pub created_at: i64,

    /// Finalization timestamp
    pub finalized_at: i64,

    /// PDA bump
    pub bump: u8,
}

impl Epoch {
    pub const SPACE: usize = 8 + // discriminator
        32 + // order_book
        4 +  // epoch_index
        32 + // merkle_root
        4 +  // order_count
        1 +  // is_finalized
        1 +  // root_submitted
        8 +  // created_at
        8 +  // finalized_at
        1;   // bump

    pub const SEED_PREFIX: &'static [u8] = b"epoch";
}

/// Bitfield chunk tracking active/filled status of orders within an epoch.
/// Wraps Stratum's BitfieldChunk concept but owns its own PDA.
/// bit set = active order, bit unset = filled/cancelled
#[account]
pub struct OrderChunk {
    /// Parent epoch
    pub epoch: Pubkey,

    /// Chunk index within this epoch
    pub chunk_index: u32,

    /// The actual bits — 256 bytes = 2048 order slots
    pub bits: [u8; 256],

    /// Count of active (set) bits
    pub active_count: u16,

    /// PDA bump
    pub bump: u8,
}

impl OrderChunk {
    pub const BITS_PER_CHUNK: u32 = 2048;
    pub const BYTES_SIZE: usize = 256;

    pub const SPACE: usize = 8 + // discriminator
        32 + // epoch
        4 +  // chunk_index
        256 + // bits
        2 +  // active_count
        1;   // bump

    pub const SEED_PREFIX: &'static [u8] = b"order_chunk";

    /// Check if an order slot is active
    pub fn is_active(&self, index: u16) -> bool {
        if index >= Self::BITS_PER_CHUNK as u16 {
            return false;
        }
        let byte_idx = (index / 8) as usize;
        let bit_idx = index % 8;
        (self.bits[byte_idx] >> bit_idx) & 1 == 1
    }

    /// Set an order slot as active
    pub fn set_active(&mut self, index: u16) -> bool {
        if index >= Self::BITS_PER_CHUNK as u16 {
            return false;
        }
        let byte_idx = (index / 8) as usize;
        let bit_idx = index % 8;
        let was_active = self.is_active(index);
        if !was_active {
            self.bits[byte_idx] |= 1 << bit_idx;
            self.active_count = self.active_count.saturating_add(1);
        }
        !was_active
    }

    /// Unset an order slot (mark as filled/cancelled)
    pub fn set_inactive(&mut self, index: u16) -> bool {
        if index >= Self::BITS_PER_CHUNK as u16 {
            return false;
        }
        let byte_idx = (index / 8) as usize;
        let bit_idx = index % 8;
        let was_active = self.is_active(index);
        if was_active {
            self.bits[byte_idx] &= !(1 << bit_idx);
            self.active_count = self.active_count.saturating_sub(1);
        }
        was_active
    }

    /// Split a global order index into (chunk_index, local_index)
    pub fn split_index(global_index: u32) -> (u32, u16) {
        let chunk = global_index / Self::BITS_PER_CHUNK;
        let local = (global_index % Self::BITS_PER_CHUNK) as u16;
        (chunk, local)
    }
}

/// Settlement receipt for a completed fill
#[account]
pub struct SettlementReceipt {
    /// Parent order book
    pub order_book: Pubkey,

    /// Maker's public key
    pub maker: Pubkey,

    /// Taker's public key
    pub taker: Pubkey,

    /// Maker order ID
    pub maker_order_id: u64,

    /// Taker order ID
    pub taker_order_id: u64,

    /// Fill amount (in base tokens)
    pub fill_amount: u64,

    /// Fill price
    pub fill_price: u64,

    /// Fee paid (in quote tokens)
    pub fee_paid: u64,

    /// Expiry config for auto-cleanup
    pub expiry: ExpiryConfig,

    /// Settlement timestamp
    pub settled_at: i64,

    /// PDA bump
    pub bump: u8,
}

impl SettlementReceipt {
    pub const SPACE: usize = 8 + // discriminator
        32 + // order_book
        32 + // maker
        32 + // taker
        8 +  // maker_order_id
        8 +  // taker_order_id
        8 +  // fill_amount
        8 +  // fill_price
        8 +  // fee_paid
        (8 + 8 + 8 + 8) + // expiry (ExpiryConfig)
        8 +  // settled_at
        1;   // bump

    pub const SEED_PREFIX: &'static [u8] = b"settlement";
}

/// Order leaf data — not stored on-chain.
/// Serialized and hashed to create merkle tree leaves.
/// Must match the TypeScript SDK's serialization exactly.
#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct OrderLeaf {
    pub maker: Pubkey,
    pub order_id: u64,
    pub side: OrderSide,
    pub price: u64,
    pub amount: u64,
    pub epoch_index: u32,
    pub order_index: u32,
    pub created_at: i64,
    pub expires_at: i64,
}
