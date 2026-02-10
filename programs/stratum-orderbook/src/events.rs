use anchor_lang::prelude::*;

#[event]
pub struct OrderBookCreated {
    pub order_book: Pubkey,
    pub authority: Pubkey,
    pub base_mint: Pubkey,
    pub quote_mint: Pubkey,
    pub tick_size: u64,
}

#[event]
pub struct EpochCreated {
    pub order_book: Pubkey,
    pub epoch: Pubkey,
    pub epoch_index: u32,
}

#[event]
pub struct EpochRootSubmitted {
    pub epoch: Pubkey,
    pub merkle_root: [u8; 32],
    pub order_count: u32,
}

#[event]
pub struct EpochFinalized {
    pub epoch: Pubkey,
    pub epoch_index: u32,
    pub order_count: u32,
}

#[event]
pub struct OrderSettled {
    pub order_book: Pubkey,
    pub maker: Pubkey,
    pub taker: Pubkey,
    pub fill_amount: u64,
    pub fill_price: u64,
    pub maker_order_id: u64,
    pub taker_order_id: u64,
}

#[event]
pub struct OrderCancelled {
    pub order_book: Pubkey,
    pub maker: Pubkey,
    pub order_id: u64,
    pub epoch_index: u32,
    pub order_index: u32,
}

#[event]
pub struct ExpiredOrderCleaned {
    pub order_book: Pubkey,
    pub order_id: u64,
    pub epoch_index: u32,
    pub order_index: u32,
    pub cleaner: Pubkey,
    pub reward: u64,
}

#[event]
pub struct SettlementCleaned {
    pub settlement: Pubkey,
    pub cleaner: Pubkey,
    pub reward: u64,
}
