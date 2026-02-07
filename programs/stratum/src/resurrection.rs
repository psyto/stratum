use anchor_lang::prelude::*;
use crate::bitfield::BitfieldChunk;
use crate::errors::StratumError;
use crate::events::HistorySummary;
use crate::merkle::{hash_leaf, MerkleProof};

/// Archive registry that tracks state that has been archived (closed)
/// but can be resurrected with a merkle proof
///
/// Use cases:
/// - Historical prediction records that can be proven
/// - Closed positions that may need verification
/// - Pruned state that users may want to restore
///
/// Pattern:
/// 1. Archive: Close account, emit event, add leaf to merkle tree
/// 2. Update: Periodically update merkle root with new archived items
/// 3. Resurrect: Provide merkle proof + check bitfield + recreate account
#[account]
#[derive(InitSpace)]
pub struct ArchiveRegistry {
    /// Authority that can update the registry
    pub authority: Pubkey,

    /// Name/identifier for this archive
    #[max_len(32)]
    pub name: String,

    /// Current merkle root of archived items
    pub merkle_root: [u8; 32],

    /// Total number of items archived
    pub archived_count: u64,

    /// Total number of items resurrected
    pub resurrected_count: u64,

    /// Pointer to first bitfield chunk (for resurrection tracking)
    pub bitfield_registry: Pubkey,

    /// Whether new archives can be added
    pub is_accepting_archives: bool,

    /// Whether resurrection is allowed
    pub is_resurrection_enabled: bool,

    /// Creation timestamp
    pub created_at: i64,

    /// Last update timestamp
    pub updated_at: i64,

    /// History summary of resurrections
    pub resurrection_history: HistorySummary,

    /// Bump seed for PDA
    pub bump: u8,
}

impl ArchiveRegistry {
    /// Initialize a new archive registry
    pub fn initialize(
        &mut self,
        authority: Pubkey,
        name: String,
        bitfield_registry: Pubkey,
        bump: u8,
    ) -> Result<()> {
        require!(name.len() <= 32, StratumError::InvalidConfig);

        let clock = Clock::get()?;
        self.authority = authority;
        self.name = name;
        self.merkle_root = [0u8; 32];
        self.archived_count = 0;
        self.resurrected_count = 0;
        self.bitfield_registry = bitfield_registry;
        self.is_accepting_archives = true;
        self.is_resurrection_enabled = true;
        self.created_at = clock.unix_timestamp;
        self.updated_at = clock.unix_timestamp;
        self.resurrection_history = HistorySummary::default();
        self.bump = bump;

        Ok(())
    }

    /// Update the merkle root after adding new archives
    pub fn update_root(&mut self, new_root: [u8; 32], new_count: u64) -> Result<()> {
        require!(self.is_accepting_archives, StratumError::InvalidConfig);
        require!(new_count >= self.archived_count, StratumError::InvalidConfig);

        self.merkle_root = new_root;
        self.archived_count = new_count;
        self.updated_at = Clock::get()?.unix_timestamp;

        Ok(())
    }

    /// Finalize the archive (no more additions)
    pub fn finalize(&mut self) -> Result<()> {
        self.is_accepting_archives = false;
        self.updated_at = Clock::get()?.unix_timestamp;
        Ok(())
    }

    /// Enable/disable resurrection
    pub fn set_resurrection_enabled(&mut self, enabled: bool) -> Result<()> {
        self.is_resurrection_enabled = enabled;
        self.updated_at = Clock::get()?.unix_timestamp;
        Ok(())
    }

    /// Record a successful resurrection
    pub fn record_resurrection(&mut self) -> Result<()> {
        self.resurrected_count = self.resurrected_count.saturating_add(1);
        self.resurrection_history.record_now(1)?;
        Ok(())
    }

    /// Get resurrection rate (basis points)
    pub fn resurrection_rate_bps(&self) -> u16 {
        if self.archived_count == 0 {
            return 0;
        }
        ((self.resurrected_count * 10000) / self.archived_count) as u16
    }
}

/// Proof required to resurrect an archived record
#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct ResurrectionProof {
    /// Merkle proof siblings
    pub merkle_proof: MerkleProof,

    /// Slot when the record was archived (for event lookup)
    pub archived_slot: u64,

    /// Original account pubkey (for verification)
    pub original_account: Pubkey,
}

impl ResurrectionProof {
    /// Create a new resurrection proof
    pub fn new(
        siblings: Vec<[u8; 32]>,
        leaf_index: u32,
        archived_slot: u64,
        original_account: Pubkey,
    ) -> Self {
        Self {
            merkle_proof: MerkleProof {
                siblings,
                leaf_index,
            },
            archived_slot,
            original_account,
        }
    }

    /// Get the chunk and local index for bitfield checking
    pub fn bitfield_indices(&self) -> (u32, u16) {
        BitfieldChunk::split_index(self.merkle_proof.leaf_index)
    }
}

/// Verify a resurrection is valid
///
/// Checks:
/// 1. Merkle proof is valid against registry root
/// 2. Leaf has not already been resurrected (bitfield check)
pub fn verify_resurrection(
    registry: &ArchiveRegistry,
    bitfield: &BitfieldChunk,
    proof: &ResurrectionProof,
    archived_data: &[u8],
) -> Result<()> {
    // Check resurrection is enabled
    require!(
        registry.is_resurrection_enabled,
        StratumError::InvalidConfig
    );

    // Verify merkle proof
    let leaf_hash = hash_leaf(archived_data);
    proof
        .merkle_proof
        .verify_result(registry.merkle_root, leaf_hash)?;

    // Check bitfield - must not be already resurrected
    let (expected_chunk, local_index) = proof.bitfield_indices();
    require!(
        bitfield.chunk_index == expected_chunk,
        StratumError::WrongBitfieldChunk
    );
    require!(
        !bitfield.is_set(local_index),
        StratumError::AlreadyResurrected
    );

    Ok(())
}

/// Mark a resurrection as complete (set the bitfield)
pub fn mark_resurrected(
    registry: &mut ArchiveRegistry,
    bitfield: &mut BitfieldChunk,
    proof: &ResurrectionProof,
) -> Result<()> {
    let (_, local_index) = proof.bitfield_indices();

    // Set the bit
    bitfield.set(local_index)?;

    // Update registry stats
    registry.record_resurrection()?;

    Ok(())
}

/// Archived record metadata (emitted as event when archiving)
#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct ArchivedRecord {
    /// Original account address
    pub account: Pubkey,

    /// Owner/authority of the original account
    pub owner: Pubkey,

    /// Index in the archive (for merkle proof)
    pub archive_index: u64,

    /// Slot when archived
    pub archived_slot: u64,

    /// Timestamp when archived
    pub archived_at: i64,

    /// Hash of the archived data
    pub data_hash: [u8; 32],

    /// Size of the original account data
    pub data_size: u32,
}

impl ArchivedRecord {
    pub fn new(
        account: Pubkey,
        owner: Pubkey,
        archive_index: u64,
        data: &[u8],
    ) -> Result<Self> {
        let clock = Clock::get()?;
        Ok(Self {
            account,
            owner,
            archive_index,
            archived_slot: clock.slot,
            archived_at: clock.unix_timestamp,
            data_hash: hash_leaf(data),
            data_size: data.len() as u32,
        })
    }

    /// Compute the leaf hash for merkle tree inclusion
    pub fn leaf_hash(&self) -> [u8; 32] {
        // Include all metadata in the leaf for full verifiability
        let mut data = self.account.to_bytes().to_vec();
        data.extend_from_slice(&self.owner.to_bytes());
        data.extend_from_slice(&self.archive_index.to_le_bytes());
        data.extend_from_slice(&self.archived_slot.to_le_bytes());
        data.extend_from_slice(&self.data_hash);
        hash_leaf(&data)
    }
}

/// Event emitted when a record is archived
#[event]
pub struct RecordArchived {
    pub registry: Pubkey,
    pub account: Pubkey,
    pub owner: Pubkey,
    pub archive_index: u64,
    pub data_hash: [u8; 32],
}

/// Event emitted when a record is resurrected
#[event]
pub struct RecordResurrected {
    pub registry: Pubkey,
    pub account: Pubkey,
    pub owner: Pubkey,
    pub archive_index: u64,
    pub resurrected_by: Pubkey,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_bitfield_indices() {
        let proof = ResurrectionProof::new(vec![], 0, 100, Pubkey::default());
        assert_eq!(proof.bitfield_indices(), (0, 0));

        let proof = ResurrectionProof::new(vec![], 2047, 100, Pubkey::default());
        assert_eq!(proof.bitfield_indices(), (0, 2047));

        let proof = ResurrectionProof::new(vec![], 2048, 100, Pubkey::default());
        assert_eq!(proof.bitfield_indices(), (1, 0));

        let proof = ResurrectionProof::new(vec![], 4096, 100, Pubkey::default());
        assert_eq!(proof.bitfield_indices(), (2, 0));
    }
}
