/**
 * Stratum Deploy Script
 *
 * Initializes the foundational accounts for all three stratum programs:
 *   1. stratum        — BitfieldRegistry + initial chunk, MerkleRoot
 *   2. airdrop_example — Campaign + ClaimChunk (demo campaign)
 *   3. stratum_orderbook — OrderBook + initial Epoch + OrderChunk
 *
 * Invoked via: anchor migrate
 */

import * as anchor from "@coral-xyz/anchor";
import { PublicKey, SystemProgram, Keypair } from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  createMint,
} from "@solana/spl-token";

module.exports = async function (provider: anchor.AnchorProvider) {
  anchor.setProvider(provider);

  const authority = provider.wallet;
  const connection = provider.connection;

  console.log("=== Stratum Deploy ===");
  console.log("Authority:", authority.publicKey.toBase58());

  // ========================================================================
  // 1. Stratum — Bitfield Registry + Chunk + Merkle Root
  // ========================================================================

  const stratum = anchor.workspace.stratum;
  if (stratum) {
    console.log("\n--- Stratum (bitfield / merkle) ---");
    console.log("Program ID:", stratum.programId.toBase58());

    // Create bitfield registry (capacity for 1 chunk = 2048 flags)
    const [registryPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("bitfield_registry"), authority.publicKey.toBuffer()],
      stratum.programId
    );

    try {
      await stratum.account.bitfieldRegistry.fetch(registryPda);
      console.log("BitfieldRegistry already exists:", registryPda.toBase58());
    } catch {
      const tx = await stratum.methods
        .createBitfieldRegistry(new anchor.BN(2048))
        .accounts({
          registry: registryPda,
          authority: authority.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
      console.log("Created BitfieldRegistry:", tx);
    }

    // Create initial chunk (index 0)
    const chunkIndex = 0;
    const [chunkPda] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("bitfield_chunk"),
        registryPda.toBuffer(),
        new Uint8Array(new Uint32Array([chunkIndex]).buffer),
      ],
      stratum.programId
    );

    try {
      await stratum.account.bitfieldChunk.fetch(chunkPda);
      console.log("BitfieldChunk 0 already exists:", chunkPda.toBase58());
    } catch {
      const tx = await stratum.methods
        .createBitfieldChunk(chunkIndex)
        .accounts({
          registry: registryPda,
          chunk: chunkPda,
          authority: authority.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
      console.log("Created BitfieldChunk 0:", tx);
    }

    // Create a merkle root (seed = 1, placeholder root)
    const merkleRootSeed = new anchor.BN(1);
    const [merklePda] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("merkle_root"),
        authority.publicKey.toBuffer(),
        merkleRootSeed.toArrayLike(Buffer, "le", 8),
      ],
      stratum.programId
    );

    try {
      await stratum.account.merkleRoot.fetch(merklePda);
      console.log("MerkleRoot already exists:", merklePda.toBase58());
    } catch {
      const placeholderRoot = Array.from(Buffer.alloc(32, 0));
      const tx = await stratum.methods
        .createMerkleRoot(merkleRootSeed, placeholderRoot, new anchor.BN(0), 20)
        .accounts({
          merkleRoot: merklePda,
          authority: authority.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
      console.log("Created MerkleRoot:", tx);
    }
  } else {
    console.log("Stratum program not found in workspace, skipping.");
  }

  // ========================================================================
  // 2. Airdrop Example — Demo Campaign
  // ========================================================================

  const airdrop = anchor.workspace.airdropExample;
  if (airdrop) {
    console.log("\n--- Airdrop Example ---");
    console.log("Program ID:", airdrop.programId.toBase58());

    // Create a demo SPL token mint
    const mintAuthority = Keypair.generate();
    const airdropSig = await connection.requestAirdrop(
      mintAuthority.publicKey,
      2 * anchor.web3.LAMPORTS_PER_SOL
    );
    await connection.confirmTransaction(airdropSig);

    const tokenMint = await createMint(
      connection,
      mintAuthority,
      mintAuthority.publicKey,
      null,
      6 // 6 decimals
    );
    console.log("Created demo token mint:", tokenMint.toBase58());

    // Derive campaign PDA
    const [campaignPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("campaign"), authority.publicKey.toBuffer(), tokenMint.toBuffer()],
      airdrop.programId
    );

    // Derive vault PDA
    const [vaultPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), campaignPda.toBuffer()],
      airdrop.programId
    );

    try {
      await airdrop.account.campaign.fetch(campaignPda);
      console.log("Campaign already exists:", campaignPda.toBase58());
    } catch {
      const merkleRoot = Array.from(Buffer.alloc(32, 0)); // placeholder
      const totalRecipients = new anchor.BN(100);
      const amountPerClaim = new anchor.BN(1_000_000); // 1 token
      const expiresInSeconds = new anchor.BN(7 * 24 * 60 * 60); // 7 days

      const tx = await airdrop.methods
        .createCampaign(merkleRoot, totalRecipients, amountPerClaim, expiresInSeconds)
        .accounts({
          campaign: campaignPda,
          vault: vaultPda,
          tokenMint,
          authority: authority.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
      console.log("Created Campaign:", tx);

      // Create initial claim chunk
      const [claimChunkPda] = PublicKey.findProgramAddressSync(
        [
          Buffer.from("claim_chunk"),
          campaignPda.toBuffer(),
          new Uint8Array(new Uint32Array([0]).buffer),
        ],
        airdrop.programId
      );

      const chunkTx = await airdrop.methods
        .createClaimChunk(0)
        .accounts({
          campaign: campaignPda,
          claimChunk: claimChunkPda,
          authority: authority.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
      console.log("Created ClaimChunk 0:", chunkTx);
    }
  } else {
    console.log("Airdrop Example program not found in workspace, skipping.");
  }

  // ========================================================================
  // 3. Stratum Orderbook — OrderBook + Epoch + OrderChunk
  // ========================================================================

  const orderbook = anchor.workspace.stratumOrderbook;
  if (orderbook) {
    console.log("\n--- Stratum Orderbook ---");
    console.log("Program ID:", orderbook.programId.toBase58());

    // Create base and quote mints for the order book
    const obMintAuthority = Keypair.generate();
    const obAirdropSig = await connection.requestAirdrop(
      obMintAuthority.publicKey,
      2 * anchor.web3.LAMPORTS_PER_SOL
    );
    await connection.confirmTransaction(obAirdropSig);

    const baseMint = await createMint(
      connection,
      obMintAuthority,
      obMintAuthority.publicKey,
      null,
      9 // 9 decimals (SOL-like)
    );

    const quoteMint = await createMint(
      connection,
      obMintAuthority,
      obMintAuthority.publicKey,
      null,
      6 // 6 decimals (USDC-like)
    );

    console.log("Base mint:", baseMint.toBase58());
    console.log("Quote mint:", quoteMint.toBase58());

    // Derive order book PDA
    const [orderBookPda] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("order_book"),
        authority.publicKey.toBuffer(),
        baseMint.toBuffer(),
        quoteMint.toBuffer(),
      ],
      orderbook.programId
    );

    // Derive vault PDAs
    const [baseVaultPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("base_vault"), orderBookPda.toBuffer()],
      orderbook.programId
    );
    const [quoteVaultPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("quote_vault"), orderBookPda.toBuffer()],
      orderbook.programId
    );
    const [feeVaultPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("fee_vault"), orderBookPda.toBuffer()],
      orderbook.programId
    );

    try {
      await orderbook.account.orderBook.fetch(orderBookPda);
      console.log("OrderBook already exists:", orderBookPda.toBase58());
    } catch {
      const tickSize = new anchor.BN(1_000); // 0.001 quote per tick
      const feeBps = 30; // 0.3%
      const settlementTtl = new anchor.BN(24 * 60 * 60); // 1 day

      const tx = await orderbook.methods
        .createOrderBook(tickSize, feeBps, settlementTtl)
        .accounts({
          orderBook: orderBookPda,
          baseVault: baseVaultPda,
          quoteVault: quoteVaultPda,
          baseMint,
          quoteMint,
          feeVault: feeVaultPda,
          authority: authority.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
      console.log("Created OrderBook:", tx);

      // Create initial epoch (index 0)
      const [epochPda] = PublicKey.findProgramAddressSync(
        [
          Buffer.from("epoch"),
          orderBookPda.toBuffer(),
          new Uint8Array(new Uint32Array([0]).buffer),
        ],
        orderbook.programId
      );

      const epochTx = await orderbook.methods
        .createEpoch(0)
        .accounts({
          orderBook: orderBookPda,
          epoch: epochPda,
          authority: authority.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
      console.log("Created Epoch 0:", epochTx);

      // Create initial order chunk for epoch 0
      const [orderChunkPda] = PublicKey.findProgramAddressSync(
        [
          Buffer.from("order_chunk"),
          epochPda.toBuffer(),
          new Uint8Array(new Uint32Array([0]).buffer),
        ],
        orderbook.programId
      );

      const chunkTx = await orderbook.methods
        .createOrderChunk(0)
        .accounts({
          epoch: epochPda,
          orderChunk: orderChunkPda,
          authority: authority.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
      console.log("Created OrderChunk 0:", chunkTx);
    }
  } else {
    console.log("Stratum Orderbook program not found in workspace, skipping.");
  }

  console.log("\n=== Deploy complete ===");
};
