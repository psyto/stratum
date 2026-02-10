import { Connection, PublicKey, Keypair, Transaction } from '@solana/web3.js';
import { MerkleTree } from '@stratum/sdk';
import type { Order, MatchResult } from './types';
import { OrderStore } from './order-store';

/**
 * Settlement transaction builder and submitter.
 *
 * Builds the on-chain settle_match instruction with:
 * - Serialized maker/taker OrderLeaf data
 * - Merkle proofs for both orders
 * - Bitfield chunk accounts
 * - Token vault accounts
 */
export class SettlementSubmitter {
  private connection: Connection;
  private crankerKeypair: Keypair;
  private orderBookAddress: PublicKey;
  private programId: PublicKey;

  constructor(
    connection: Connection,
    crankerKeypair: Keypair,
    orderBookAddress: PublicKey,
    programId: PublicKey
  ) {
    this.connection = connection;
    this.crankerKeypair = crankerKeypair;
    this.orderBookAddress = orderBookAddress;
    this.programId = programId;
  }

  /**
   * Build and submit a settlement transaction for a match
   */
  async submitSettlement(
    match: MatchResult,
    orderStore: OrderStore
  ): Promise<string> {
    const { makerOrder, takerOrder, fillAmount } = match;

    // Get merkle proofs
    const makerProofData = orderStore.getMerkleProof(
      makerOrder.epochIndex,
      makerOrder.orderIndex
    );
    const takerProofData = orderStore.getMerkleProof(
      takerOrder.epochIndex,
      takerOrder.orderIndex
    );

    if (!makerProofData || !takerProofData) {
      throw new Error(
        'Merkle proofs not available. Ensure epoch is built and finalized.'
      );
    }

    // Derive PDAs
    const [epochPda] = this.deriveEpochPda(makerOrder.epochIndex);
    const [takerEpochPda] = this.deriveEpochPda(takerOrder.epochIndex);
    const makerChunkIndex = Math.floor(makerOrder.orderIndex / 2048);
    const takerChunkIndex = Math.floor(takerOrder.orderIndex / 2048);
    const [makerChunkPda] = this.deriveOrderChunkPda(epochPda, makerChunkIndex);
    const [takerChunkPda] = this.deriveOrderChunkPda(takerEpochPda, takerChunkIndex);
    const [baseVaultPda] = this.deriveVaultPda('base_vault');
    const [quoteVaultPda] = this.deriveVaultPda('quote_vault');

    // Serialize order data for the instruction
    const makerOrderData = orderStore.serializeOrder(makerOrder);
    const takerOrderData = orderStore.serializeOrder(takerOrder);

    // Convert proofs to arrays
    const makerProofArrays = makerProofData.proof.map((p) => Array.from(p));
    const takerProofArrays = takerProofData.proof.map((p) => Array.from(p));

    console.log(
      `Submitting settlement: ` +
        `maker_order=${makerOrder.orderId} (epoch ${makerOrder.epochIndex}), ` +
        `taker_order=${takerOrder.orderId} (epoch ${takerOrder.epochIndex}), ` +
        `fill=${fillAmount}`
    );

    // In production, this would build the actual Anchor transaction:
    // const tx = await program.methods
    //   .settleMatch(
    //     makerOrderData, makerProofArrays, makerOrder.orderIndex,
    //     takerOrderData, takerProofArrays, takerOrder.orderIndex,
    //     new BN(fillAmount)
    //   )
    //   .accounts({
    //     orderBook: this.orderBookAddress,
    //     makerEpoch: epochPda,
    //     takerEpoch: takerEpochPda,
    //     makerChunk: makerChunkPda,
    //     takerChunk: takerChunkPda,
    //     baseVault: baseVaultPda,
    //     quoteVault: quoteVaultPda,
    //     ...
    //   })
    //   .signers([this.crankerKeypair])
    //   .rpc();

    return `settle_${makerOrder.orderId}_${takerOrder.orderId}_${fillAmount}`;
  }

  /**
   * Submit a batch of settlements
   */
  async submitBatch(
    matches: MatchResult[],
    orderStore: OrderStore
  ): Promise<string[]> {
    const signatures: string[] = [];

    for (const match of matches) {
      try {
        const sig = await this.submitSettlement(match, orderStore);
        signatures.push(sig);
      } catch (err) {
        console.error(
          `Settlement failed for match ` +
            `${match.makerOrder.orderId} x ${match.takerOrder.orderId}:`,
          err
        );
      }
    }

    return signatures;
  }

  // --- PDA derivation helpers ---

  private deriveEpochPda(epochIndex: number): [PublicKey, number] {
    const epochIndexBuf = Buffer.alloc(4);
    epochIndexBuf.writeUInt32LE(epochIndex);

    return PublicKey.findProgramAddressSync(
      [
        Buffer.from('epoch'),
        this.orderBookAddress.toBuffer(),
        epochIndexBuf,
      ],
      this.programId
    );
  }

  private deriveOrderChunkPda(
    epochPda: PublicKey,
    chunkIndex: number
  ): [PublicKey, number] {
    const chunkIndexBuf = Buffer.alloc(4);
    chunkIndexBuf.writeUInt32LE(chunkIndex);

    return PublicKey.findProgramAddressSync(
      [
        Buffer.from('order_chunk'),
        epochPda.toBuffer(),
        chunkIndexBuf,
      ],
      this.programId
    );
  }

  private deriveVaultPda(seed: string): [PublicKey, number] {
    return PublicKey.findProgramAddressSync(
      [Buffer.from(seed), this.orderBookAddress.toBuffer()],
      this.programId
    );
  }
}
