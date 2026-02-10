use anchor_lang::prelude::*;

#[error_code]
pub enum OrderBookError {
    #[msg("Unauthorized")]
    Unauthorized,

    #[msg("Order book is not active")]
    OrderBookInactive,

    #[msg("Epoch is already finalized")]
    EpochAlreadyFinalized,

    #[msg("Epoch is not finalized")]
    EpochNotFinalized,

    #[msg("Invalid merkle proof for maker order")]
    InvalidMakerProof,

    #[msg("Invalid merkle proof for taker order")]
    InvalidTakerProof,

    #[msg("Order is not active (already filled or cancelled)")]
    OrderNotActive,

    #[msg("Price constraint violated: bid price must be >= ask price")]
    PriceConstraintViolated,

    #[msg("Fill amount exceeds order remaining amount")]
    FillAmountExceeded,

    #[msg("Fill amount must be greater than zero")]
    ZeroFillAmount,

    #[msg("Order has not expired yet")]
    OrderNotExpired,

    #[msg("Settlement receipt has not expired yet")]
    SettlementNotExpired,

    #[msg("Epoch root already submitted")]
    EpochRootAlreadySubmitted,

    #[msg("Order count mismatch")]
    OrderCountMismatch,

    #[msg("Invalid order side for this operation")]
    InvalidOrderSide,

    #[msg("Maker is not the order owner")]
    NotOrderOwner,

    #[msg("Arithmetic overflow")]
    Overflow,

    #[msg("Invalid tick size")]
    InvalidTickSize,

    #[msg("Invalid epoch index")]
    InvalidEpochIndex,
}
