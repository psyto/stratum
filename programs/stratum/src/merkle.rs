use anchor_lang::prelude::*;
use crate::errors::StratumError;

/// Compute a simple hash (for on-chain use we'd use syscalls, for testing we use a basic impl)
/// This uses a multiplicative hash with mixing for reasonable distribution
fn hash256(data: &[u8]) -> [u8; 32] {
    // Simple but effective hash: FNV-1a variant expanded to 256 bits
    // For production, would use proper keccak256 syscall
    let mut state = [
        0x6a09e667u32, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
        0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
    ];

    for (i, &byte) in data.iter().enumerate() {
        let idx = i % 8;
        state[idx] = state[idx].wrapping_mul(0x01000193).wrapping_add(byte as u32);
        // Mix
        state[(idx + 1) % 8] ^= state[idx].rotate_left(5);
    }

    // Final mixing
    for _ in 0..4 {
        for i in 0..8 {
            state[i] = state[i].wrapping_mul(0x01000193) ^ state[(i + 1) % 8];
        }
    }

    let mut result = [0u8; 32];
    for (i, &s) in state.iter().enumerate() {
        result[i * 4..i * 4 + 4].copy_from_slice(&s.to_le_bytes());
    }
    result
}

/// Leaf prefix for domain separation (prevents second preimage attacks)
pub const LEAF_PREFIX: u8 = 0x00;
/// Node prefix for domain separation
pub const NODE_PREFIX: u8 = 0x01;

/// Merkle root account that stores a commitment to a set of leaves
///
/// Use cases:
/// - Airdrop whitelists (commit to 100k addresses, ~0.003 SOL)
/// - Batch updates (commit to changes, apply lazily)
/// - Historical state proofs
#[account]
#[derive(InitSpace)]
pub struct MerkleRoot {
    /// Authority that can update the root
    pub authority: Pubkey,

    /// The merkle root hash
    pub root: [u8; 32],

    /// Number of leaves in the tree
    pub leaf_count: u64,

    /// Maximum depth of the tree (determines max capacity: 2^depth)
    pub max_depth: u8,

    /// Whether the tree is finalized (no more updates)
    pub is_finalized: bool,

    /// Creation timestamp
    pub created_at: i64,

    /// Last update timestamp
    pub updated_at: i64,

    /// Bump seed for PDA
    pub bump: u8,
}

impl MerkleRoot {
    /// Maximum supported depth (2^20 = ~1M leaves)
    pub const MAX_DEPTH: u8 = 20;

    /// Calculate max capacity for a given depth
    pub fn max_capacity(depth: u8) -> u64 {
        if depth > Self::MAX_DEPTH {
            return 0;
        }
        1u64 << depth
    }

    /// Initialize a new merkle root
    pub fn initialize(
        &mut self,
        authority: Pubkey,
        root: [u8; 32],
        leaf_count: u64,
        max_depth: u8,
        bump: u8,
    ) -> Result<()> {
        require!(max_depth <= Self::MAX_DEPTH, StratumError::InvalidConfig);
        require!(
            leaf_count <= Self::max_capacity(max_depth),
            StratumError::TreeFull
        );

        let clock = Clock::get()?;
        self.authority = authority;
        self.root = root;
        self.leaf_count = leaf_count;
        self.max_depth = max_depth;
        self.is_finalized = false;
        self.created_at = clock.unix_timestamp;
        self.updated_at = clock.unix_timestamp;
        self.bump = bump;

        Ok(())
    }

    /// Update the merkle root (only before finalization)
    pub fn update(&mut self, new_root: [u8; 32], new_leaf_count: u64) -> Result<()> {
        require!(!self.is_finalized, StratumError::AlreadyExpired);
        require!(
            new_leaf_count <= Self::max_capacity(self.max_depth),
            StratumError::TreeFull
        );

        self.root = new_root;
        self.leaf_count = new_leaf_count;
        self.updated_at = Clock::get()?.unix_timestamp;

        Ok(())
    }

    /// Finalize the tree (no more updates allowed)
    pub fn finalize(&mut self) -> Result<()> {
        require!(!self.is_finalized, StratumError::AlreadyExpired);
        self.is_finalized = true;
        self.updated_at = Clock::get()?.unix_timestamp;
        Ok(())
    }
}

/// Hash a leaf with domain separation
pub fn hash_leaf(data: &[u8]) -> [u8; 32] {
    let mut prefixed = vec![LEAF_PREFIX];
    prefixed.extend_from_slice(data);
    hash256(&prefixed)
}

/// Hash two nodes together with domain separation
pub fn hash_nodes(left: &[u8; 32], right: &[u8; 32]) -> [u8; 32] {
    let mut combined = vec![NODE_PREFIX];
    combined.extend_from_slice(left);
    combined.extend_from_slice(right);
    hash256(&combined)
}

/// Verify a merkle proof
///
/// # Arguments
/// * `proof` - Array of sibling hashes from leaf to root
/// * `root` - The expected merkle root
/// * `leaf` - The leaf hash to verify
/// * `index` - The index of the leaf in the tree
///
/// # Returns
/// * `true` if the proof is valid
pub fn verify_proof(proof: &[[u8; 32]], root: [u8; 32], leaf: [u8; 32], index: u32) -> bool {
    let mut computed_hash = leaf;
    let mut idx = index;

    for sibling in proof.iter() {
        computed_hash = if idx % 2 == 0 {
            // We're on the left, sibling is on the right
            hash_nodes(&computed_hash, sibling)
        } else {
            // We're on the right, sibling is on the left
            hash_nodes(sibling, &computed_hash)
        };
        idx /= 2;
    }

    computed_hash == root
}

/// Verify a merkle proof and return result
pub fn verify_proof_result(
    proof: &[[u8; 32]],
    root: [u8; 32],
    leaf: [u8; 32],
    index: u32,
) -> Result<()> {
    require!(
        verify_proof(proof, root, leaf, index),
        StratumError::InvalidMerkleProof
    );
    Ok(())
}

/// Merkle proof structure for passing in instructions
#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct MerkleProof {
    /// The sibling hashes from leaf to root
    pub siblings: Vec<[u8; 32]>,
    /// The index of the leaf
    pub leaf_index: u32,
}

impl MerkleProof {
    /// Verify this proof against a root and leaf
    pub fn verify(&self, root: [u8; 32], leaf: [u8; 32]) -> bool {
        verify_proof(&self.siblings, root, leaf, self.leaf_index)
    }

    /// Verify this proof and return Result
    pub fn verify_result(&self, root: [u8; 32], leaf: [u8; 32]) -> Result<()> {
        verify_proof_result(&self.siblings, root, leaf, self.leaf_index)
    }
}

/// Helper to compute a leaf hash from a pubkey
pub fn hash_pubkey(pubkey: &Pubkey) -> [u8; 32] {
    hash_leaf(pubkey.as_ref())
}

/// Helper to compute a leaf hash from pubkey + amount (for airdrops)
pub fn hash_pubkey_amount(pubkey: &Pubkey, amount: u64) -> [u8; 32] {
    let mut data = pubkey.to_bytes().to_vec();
    data.extend_from_slice(&amount.to_le_bytes());
    hash_leaf(&data)
}

/// Helper to compute a leaf hash from arbitrary struct
pub fn hash_struct<T: AnchorSerialize>(data: &T) -> Result<[u8; 32]> {
    let serialized = data.try_to_vec()?;
    Ok(hash_leaf(&serialized))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_hash_leaf() {
        let data = b"hello";
        let hash1 = hash_leaf(data);
        let hash2 = hash_leaf(data);
        assert_eq!(hash1, hash2);

        // Different data should produce different hash
        let hash3 = hash_leaf(b"world");
        assert_ne!(hash1, hash3);
    }

    #[test]
    fn test_simple_proof() {
        // Build a simple 2-leaf tree
        let leaf0 = hash_leaf(b"leaf0");
        let leaf1 = hash_leaf(b"leaf1");
        let root = hash_nodes(&leaf0, &leaf1);

        // Verify leaf0 with proof [leaf1]
        assert!(verify_proof(&[leaf1], root, leaf0, 0));

        // Verify leaf1 with proof [leaf0]
        assert!(verify_proof(&[leaf0], root, leaf1, 1));

        // Wrong index should fail
        assert!(!verify_proof(&[leaf1], root, leaf0, 1));
    }

    #[test]
    fn test_four_leaf_tree() {
        // Build a 4-leaf tree
        //        root
        //       /    \
        //      n01    n23
        //     / \    / \
        //    l0  l1 l2  l3

        let l0 = hash_leaf(b"leaf0");
        let l1 = hash_leaf(b"leaf1");
        let l2 = hash_leaf(b"leaf2");
        let l3 = hash_leaf(b"leaf3");

        let n01 = hash_nodes(&l0, &l1);
        let n23 = hash_nodes(&l2, &l3);
        let root = hash_nodes(&n01, &n23);

        // Verify each leaf
        assert!(verify_proof(&[l1, n23], root, l0, 0));
        assert!(verify_proof(&[l0, n23], root, l1, 1));
        assert!(verify_proof(&[l3, n01], root, l2, 2));
        assert!(verify_proof(&[l2, n01], root, l3, 3));
    }
}
