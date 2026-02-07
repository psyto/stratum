use anchor_lang::prelude::*;

#[error_code]
pub enum StratumError {
    // Bitfield errors
    #[msg("Bit index out of bounds")]
    IndexOutOfBounds,

    #[msg("Wrong bitfield chunk for this index")]
    WrongBitfieldChunk,

    #[msg("Bit already set")]
    AlreadySet,

    // Merkle errors
    #[msg("Invalid merkle proof")]
    InvalidMerkleProof,

    #[msg("Merkle tree is full")]
    TreeFull,

    #[msg("Leaf index out of range")]
    LeafIndexOutOfRange,

    // Expiry errors
    #[msg("Record has not expired yet")]
    NotExpired,

    #[msg("Record has already expired")]
    AlreadyExpired,

    #[msg("Cannot cleanup during grace period")]
    InGracePeriod,

    // Resurrection errors
    #[msg("Record already resurrected")]
    AlreadyResurrected,

    #[msg("Archive registry is full")]
    ArchiveFull,

    #[msg("Invalid resurrection proof")]
    InvalidResurrectionProof,

    // General errors
    #[msg("Unauthorized")]
    Unauthorized,

    #[msg("Invalid configuration")]
    InvalidConfig,

    #[msg("Arithmetic overflow")]
    Overflow,
}
