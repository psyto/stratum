use anchor_lang::prelude::*;

pub mod bitfield;
pub mod errors;
pub mod events;
pub mod expiry;
pub mod merkle;
pub mod resurrection;

pub use bitfield::*;
pub use errors::*;
pub use events::*;
pub use expiry::*;
pub use merkle::*;
pub use resurrection::*;

declare_id!("97VX5yBvf55TdgpV6Cmc7pXdgshWyeCrHvn71bX6CHcJ");

/// Stratum - State primitives for Solana
///
/// Components:
/// - Bitfield: Compact tracking for claims, spent flags, etc.
/// - Merkle: Merkle tree commitments and proof verification
/// - Expiry: TTL and cleanup crank patterns
/// - Events: History summarization without state bloat
/// - Resurrection: Archive state and restore with proofs
#[program]
pub mod stratum {
    use super::*;

    // =========================================================================
    // Bitfield Instructions
    // =========================================================================

    /// Create a new bitfield registry
    pub fn create_bitfield_registry(
        ctx: Context<CreateBitfieldRegistry>,
        total_capacity: u64,
    ) -> Result<()> {
        let registry = &mut ctx.accounts.registry;
        registry.initialize(
            ctx.accounts.authority.key(),
            total_capacity,
            ctx.bumps.registry,
        );
        Ok(())
    }

    /// Create a new bitfield chunk
    pub fn create_bitfield_chunk(
        ctx: Context<CreateBitfieldChunk>,
        chunk_index: u32,
    ) -> Result<()> {
        let chunk = &mut ctx.accounts.chunk;
        chunk.initialize(
            ctx.accounts.authority.key(),
            ctx.accounts.registry.key(),
            chunk_index,
            ctx.bumps.chunk,
        );

        let registry = &mut ctx.accounts.registry;
        registry.chunks_created = registry.chunks_created.saturating_add(1);

        Ok(())
    }

    /// Set a bit in a bitfield chunk
    pub fn set_bit(ctx: Context<ModifyBitfield>, index: u16) -> Result<()> {
        let chunk = &mut ctx.accounts.chunk;
        let newly_set = chunk.set(index)?;

        if newly_set {
            let registry = &mut ctx.accounts.registry;
            registry.record_set();
        }

        Ok(())
    }

    /// Unset a bit in a bitfield chunk
    pub fn unset_bit(ctx: Context<ModifyBitfield>, index: u16) -> Result<()> {
        let chunk = &mut ctx.accounts.chunk;
        let was_set = chunk.unset(index)?;

        if was_set {
            let registry = &mut ctx.accounts.registry;
            registry.record_unset();
        }

        Ok(())
    }

    // =========================================================================
    // Merkle Instructions
    // =========================================================================

    /// Create a new merkle root account
    pub fn create_merkle_root(
        ctx: Context<CreateMerkleRoot>,
        _seed: u64,
        root: [u8; 32],
        leaf_count: u64,
        max_depth: u8,
    ) -> Result<()> {
        let merkle = &mut ctx.accounts.merkle_root;
        merkle.initialize(
            ctx.accounts.authority.key(),
            root,
            leaf_count,
            max_depth,
            ctx.bumps.merkle_root,
        )
    }

    /// Update a merkle root (before finalization)
    pub fn update_merkle_root(
        ctx: Context<UpdateMerkleRoot>,
        new_root: [u8; 32],
        new_leaf_count: u64,
    ) -> Result<()> {
        let merkle = &mut ctx.accounts.merkle_root;
        merkle.update(new_root, new_leaf_count)
    }

    /// Finalize a merkle root (no more updates)
    pub fn finalize_merkle_root(ctx: Context<UpdateMerkleRoot>) -> Result<()> {
        let merkle = &mut ctx.accounts.merkle_root;
        merkle.finalize()
    }

    /// Verify a merkle proof (view function, emits result)
    pub fn verify_merkle_proof(
        ctx: Context<VerifyMerkleProof>,
        proof: Vec<[u8; 32]>,
        leaf: [u8; 32],
        index: u32,
    ) -> Result<()> {
        let merkle = &ctx.accounts.merkle_root;
        let is_valid = verify_proof(&proof, merkle.root, leaf, index);

        emit!(MerkleProofVerified {
            merkle_root: merkle.key(),
            leaf,
            index,
            is_valid,
        });

        require!(is_valid, StratumError::InvalidMerkleProof);
        Ok(())
    }

    // =========================================================================
    // Archive/Resurrection Instructions
    // =========================================================================

    /// Create a new archive registry
    pub fn create_archive_registry(
        ctx: Context<CreateArchiveRegistry>,
        name: String,
    ) -> Result<()> {
        let registry = &mut ctx.accounts.archive_registry;
        registry.initialize(
            ctx.accounts.authority.key(),
            name,
            ctx.accounts.bitfield_registry.key(),
            ctx.bumps.archive_registry,
        )
    }

    /// Update archive merkle root
    pub fn update_archive_root(
        ctx: Context<UpdateArchiveRoot>,
        new_root: [u8; 32],
        new_count: u64,
    ) -> Result<()> {
        let registry = &mut ctx.accounts.archive_registry;
        registry.update_root(new_root, new_count)
    }

    /// Finalize archive (no more additions)
    pub fn finalize_archive(ctx: Context<UpdateArchiveRoot>) -> Result<()> {
        let registry = &mut ctx.accounts.archive_registry;
        registry.finalize()
    }
}

// =============================================================================
// Account Contexts
// =============================================================================

#[derive(Accounts)]
pub struct CreateBitfieldRegistry<'info> {
    #[account(
        init,
        payer = authority,
        space = 8 + BitfieldRegistry::INIT_SPACE,
        seeds = [b"bitfield_registry", authority.key().as_ref()],
        bump
    )]
    pub registry: Account<'info, BitfieldRegistry>,

    #[account(mut)]
    pub authority: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(chunk_index: u32)]
pub struct CreateBitfieldChunk<'info> {
    #[account(
        mut,
        seeds = [b"bitfield_registry", authority.key().as_ref()],
        bump = registry.bump,
        constraint = registry.authority == authority.key() @ StratumError::Unauthorized
    )]
    pub registry: Account<'info, BitfieldRegistry>,

    #[account(
        init,
        payer = authority,
        space = 8 + BitfieldChunk::INIT_SPACE,
        seeds = [b"bitfield_chunk", registry.key().as_ref(), &chunk_index.to_le_bytes()],
        bump
    )]
    pub chunk: Account<'info, BitfieldChunk>,

    #[account(mut)]
    pub authority: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ModifyBitfield<'info> {
    #[account(
        mut,
        seeds = [b"bitfield_registry", authority.key().as_ref()],
        bump = registry.bump,
        constraint = registry.authority == authority.key() @ StratumError::Unauthorized
    )]
    pub registry: Account<'info, BitfieldRegistry>,

    #[account(
        mut,
        seeds = [b"bitfield_chunk", registry.key().as_ref(), &chunk.chunk_index.to_le_bytes()],
        bump = chunk.bump,
        constraint = chunk.registry == registry.key() @ StratumError::Unauthorized
    )]
    pub chunk: Account<'info, BitfieldChunk>,

    pub authority: Signer<'info>,
}

#[derive(Accounts)]
#[instruction(seed: u64)]
pub struct CreateMerkleRoot<'info> {
    #[account(
        init,
        payer = authority,
        space = 8 + MerkleRoot::INIT_SPACE,
        seeds = [b"merkle_root", authority.key().as_ref(), &seed.to_le_bytes()],
        bump
    )]
    pub merkle_root: Account<'info, MerkleRoot>,

    #[account(mut)]
    pub authority: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct UpdateMerkleRoot<'info> {
    #[account(
        mut,
        constraint = merkle_root.authority == authority.key() @ StratumError::Unauthorized
    )]
    pub merkle_root: Account<'info, MerkleRoot>,

    pub authority: Signer<'info>,
}

#[derive(Accounts)]
pub struct VerifyMerkleProof<'info> {
    pub merkle_root: Account<'info, MerkleRoot>,
}

#[derive(Accounts)]
#[instruction(name: String)]
pub struct CreateArchiveRegistry<'info> {
    #[account(
        init,
        payer = authority,
        space = 8 + ArchiveRegistry::INIT_SPACE,
        seeds = [b"archive_registry", authority.key().as_ref(), name.as_bytes()],
        bump
    )]
    pub archive_registry: Account<'info, ArchiveRegistry>,

    pub bitfield_registry: Account<'info, BitfieldRegistry>,

    #[account(mut)]
    pub authority: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct UpdateArchiveRoot<'info> {
    #[account(
        mut,
        constraint = archive_registry.authority == authority.key() @ StratumError::Unauthorized
    )]
    pub archive_registry: Account<'info, ArchiveRegistry>,

    pub authority: Signer<'info>,
}

// =============================================================================
// Events
// =============================================================================

#[event]
pub struct MerkleProofVerified {
    pub merkle_root: Pubkey,
    pub leaf: [u8; 32],
    pub index: u32,
    pub is_valid: bool,
}

#[event]
pub struct BitSet {
    pub registry: Pubkey,
    pub chunk: Pubkey,
    pub global_index: u32,
}

#[event]
pub struct BitUnset {
    pub registry: Pubkey,
    pub chunk: Pubkey,
    pub global_index: u32,
}
