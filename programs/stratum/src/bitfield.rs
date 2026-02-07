use anchor_lang::prelude::*;
use crate::errors::StratumError;

/// Compact bitfield chunk that tracks up to 2048 boolean flags
///
/// Use cases:
/// - Airdrop claim tracking
/// - One-time action flags (votes, redemptions)
/// - Spent/unspent UTXO tracking
/// - Resurrection tracking
///
/// Cost: ~0.003 SOL for 2048 flags = ~0.0000015 SOL per flag
/// vs ~0.002 SOL per flag with individual accounts (1300x cheaper)
#[account]
#[derive(InitSpace)]
pub struct BitfieldChunk {
    /// Authority that can modify this bitfield
    pub authority: Pubkey,

    /// Identifier for the parent registry/campaign
    pub registry: Pubkey,

    /// Which chunk this is (for >2048 items, use multiple chunks)
    pub chunk_index: u32,

    /// The actual bits - 256 bytes = 2048 bits
    #[max_len(256)]
    pub bits: Vec<u8>,

    /// Count of set bits (for quick stats)
    pub set_count: u16,

    /// Bump seed for PDA
    pub bump: u8,
}

impl BitfieldChunk {
    /// Maximum bits per chunk
    pub const BITS_PER_CHUNK: u32 = 256 * 8; // 2048

    /// Size of the bits array
    pub const BYTES_SIZE: usize = 256;

    /// Initialize with all zeros
    pub fn initialize(&mut self, authority: Pubkey, registry: Pubkey, chunk_index: u32, bump: u8) {
        self.authority = authority;
        self.registry = registry;
        self.chunk_index = chunk_index;
        self.bits = vec![0u8; Self::BYTES_SIZE];
        self.set_count = 0;
        self.bump = bump;
    }

    /// Check if a bit is set
    pub fn is_set(&self, index: u16) -> bool {
        if index >= Self::BITS_PER_CHUNK as u16 {
            return false;
        }
        let byte_idx = (index / 8) as usize;
        let bit_idx = index % 8;

        if byte_idx >= self.bits.len() {
            return false;
        }

        (self.bits[byte_idx] >> bit_idx) & 1 == 1
    }

    /// Set a bit, returns Ok(true) if newly set, Ok(false) if already set
    pub fn set(&mut self, index: u16) -> Result<bool> {
        require!(
            (index as u32) < Self::BITS_PER_CHUNK,
            StratumError::IndexOutOfBounds
        );

        let byte_idx = (index / 8) as usize;
        let bit_idx = index % 8;

        // Ensure bits vec is properly sized
        if self.bits.len() < Self::BYTES_SIZE {
            self.bits.resize(Self::BYTES_SIZE, 0);
        }

        let was_set = self.is_set(index);
        if !was_set {
            self.bits[byte_idx] |= 1 << bit_idx;
            self.set_count = self.set_count.saturating_add(1);
        }

        Ok(!was_set)
    }

    /// Unset a bit, returns Ok(true) if was set, Ok(false) if already unset
    pub fn unset(&mut self, index: u16) -> Result<bool> {
        require!(
            (index as u32) < Self::BITS_PER_CHUNK,
            StratumError::IndexOutOfBounds
        );

        let byte_idx = (index / 8) as usize;
        let bit_idx = index % 8;

        let was_set = self.is_set(index);
        if was_set {
            self.bits[byte_idx] &= !(1 << bit_idx);
            self.set_count = self.set_count.saturating_sub(1);
        }

        Ok(was_set)
    }

    /// Get the global index for a local bit index
    pub fn global_index(&self, local_index: u16) -> u32 {
        self.chunk_index * Self::BITS_PER_CHUNK + local_index as u32
    }

    /// Convert global index to (chunk_index, local_index)
    pub fn split_index(global_index: u32) -> (u32, u16) {
        let chunk = global_index / Self::BITS_PER_CHUNK;
        let local = (global_index % Self::BITS_PER_CHUNK) as u16;
        (chunk, local)
    }

    /// Count total set bits (expensive, use set_count for cached value)
    pub fn count_set(&self) -> u16 {
        self.bits.iter().map(|b| b.count_ones() as u16).sum()
    }

    /// Check if all bits are set
    pub fn is_full(&self) -> bool {
        self.set_count >= Self::BITS_PER_CHUNK as u16
    }

    /// Check if all bits are unset
    pub fn is_empty(&self) -> bool {
        self.set_count == 0
    }

    /// Get percentage of bits set (0-10000 for 0.00% - 100.00%)
    pub fn fill_rate_bps(&self) -> u16 {
        ((self.set_count as u32) * 10000 / Self::BITS_PER_CHUNK) as u16
    }
}

/// Registry to manage multiple bitfield chunks
#[account]
#[derive(InitSpace)]
pub struct BitfieldRegistry {
    /// Authority that can create chunks and modify settings
    pub authority: Pubkey,

    /// Total capacity (max items to track)
    pub total_capacity: u64,

    /// Number of chunks created
    pub chunks_created: u32,

    /// Total bits set across all chunks
    pub total_set: u64,

    /// Bump seed for PDA
    pub bump: u8,
}

impl BitfieldRegistry {
    /// Calculate how many chunks needed for a given capacity
    pub fn chunks_needed(capacity: u64) -> u32 {
        ((capacity + BitfieldChunk::BITS_PER_CHUNK as u64 - 1)
            / BitfieldChunk::BITS_PER_CHUNK as u64) as u32
    }

    /// Initialize the registry
    pub fn initialize(&mut self, authority: Pubkey, total_capacity: u64, bump: u8) {
        self.authority = authority;
        self.total_capacity = total_capacity;
        self.chunks_created = 0;
        self.total_set = 0;
        self.bump = bump;
    }

    /// Record that a bit was set
    pub fn record_set(&mut self) {
        self.total_set = self.total_set.saturating_add(1);
    }

    /// Record that a bit was unset
    pub fn record_unset(&mut self) {
        self.total_set = self.total_set.saturating_sub(1);
    }

    /// Get fill rate in basis points
    pub fn fill_rate_bps(&self) -> u16 {
        if self.total_capacity == 0 {
            return 0;
        }
        ((self.total_set * 10000) / self.total_capacity) as u16
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_bitfield_set_get() {
        let mut chunk = BitfieldChunk {
            authority: Pubkey::default(),
            registry: Pubkey::default(),
            chunk_index: 0,
            bits: vec![0u8; 256],
            set_count: 0,
            bump: 0,
        };

        assert!(!chunk.is_set(0));
        assert!(!chunk.is_set(100));
        assert!(!chunk.is_set(2047));

        chunk.set(0).unwrap();
        chunk.set(100).unwrap();
        chunk.set(2047).unwrap();

        assert!(chunk.is_set(0));
        assert!(chunk.is_set(100));
        assert!(chunk.is_set(2047));
        assert!(!chunk.is_set(1));

        assert_eq!(chunk.set_count, 3);
    }

    #[test]
    fn test_split_index() {
        assert_eq!(BitfieldChunk::split_index(0), (0, 0));
        assert_eq!(BitfieldChunk::split_index(2047), (0, 2047));
        assert_eq!(BitfieldChunk::split_index(2048), (1, 0));
        assert_eq!(BitfieldChunk::split_index(4096), (2, 0));
    }
}
