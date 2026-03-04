import { Connection, PublicKey, Keypair, Transaction, SystemProgram } from '@solana/web3.js';
import { AnchorProvider, Program, Wallet, BN } from '@coral-xyz/anchor';
import { TOKEN_PROGRAM_ID, getAssociatedTokenAddress } from '@solana/spl-token';
import { MerkleTree } from '@stratum/sdk';
import type { Order, MatchResult, OrderSide } from './types';
import { OrderStore } from './order-store';
import type { StratumOrderbook } from '../../../target/types/stratum_orderbook';
import idl from '../../../target/idl/stratum_orderbook.json';

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
  private program: Program<StratumOrderbook>;

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

    const wallet = new Wallet(crankerKeypair);
    const provider = new AnchorProvider(connection, wallet, {
      commitment: 'confirmed',
    });
    this.program = new Program<StratumOrderbook>(
      idl as StratumOrderbook,
      provider
    );
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

    // Derive settlement receipt PDA
    const makerOrderIdBuf = Buffer.alloc(8);
    makerOrderIdBuf.writeBigUInt64LE(BigInt(makerOrder.orderId));
    const takerOrderIdBuf = Buffer.alloc(8);
    takerOrderIdBuf.writeBigUInt64LE(BigInt(takerOrder.orderId));
    const [settlementReceiptPda] = PublicKey.findProgramAddressSync(
      [
        Buffer.from('settlement'),
        this.orderBookAddress.toBuffer(),
        makerOrderIdBuf,
        takerOrderIdBuf,
      ],
      this.programId
    );

    // Fetch order book state to get fee_vault and mints
    const orderBookAccount = await this.program.account.orderBook.fetch(
      this.orderBookAddress
    );

    // Build OrderLeaf structs for the instruction
    const makerOrderLeaf = this.buildOrderLeaf(makerOrder);
    const takerOrderLeaf = this.buildOrderLeaf(takerOrder);

    // Resolve maker/taker token accounts
    const makerBaseAccount = await getAssociatedTokenAddress(
      orderBookAccount.baseMint,
      makerOrder.maker
    );
    const makerQuoteAccount = await getAssociatedTokenAddress(
      orderBookAccount.quoteMint,
      makerOrder.maker
    );
    const takerBaseAccount = await getAssociatedTokenAddress(
      orderBookAccount.baseMint,
      takerOrder.maker
    );
    const takerQuoteAccount = await getAssociatedTokenAddress(
      orderBookAccount.quoteMint,
      takerOrder.maker
    );

    const tx = await this.program.methods
      .settleMatch(
        makerOrderLeaf,
        makerProofArrays,
        makerOrder.orderIndex,
        takerOrderLeaf,
        takerProofArrays,
        takerOrder.orderIndex,
        new BN(fillAmount)
      )
      .accounts({
        orderBook: this.orderBookAddress,
        makerEpoch: epochPda,
        takerEpoch: takerEpochPda,
        makerChunk: makerChunkPda,
        takerChunk: takerChunkPda,
        settlementReceipt: settlementReceiptPda,
        baseVault: baseVaultPda,
        quoteVault: quoteVaultPda,
        feeVault: orderBookAccount.feeVault,
        makerBaseAccount,
        makerQuoteAccount,
        takerBaseAccount,
        takerQuoteAccount,
        cranker: this.crankerKeypair.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([this.crankerKeypair])
      .rpc();

    console.log(`Settlement submitted: tx=${tx}`);
    return tx;
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

  // --- Helpers ---

  private buildOrderLeaf(order: Order): {
    maker: PublicKey;
    orderId: BN;
    side: { bid: {} } | { ask: {} };
    price: BN;
    amount: BN;
    epochIndex: number;
    orderIndex: number;
    createdAt: BN;
    expiresAt: BN;
  } {
    return {
      maker: order.maker,
      orderId: new BN(order.orderId),
      side: order.side === 0 ? { bid: {} } : { ask: {} },
      price: new BN(order.price),
      amount: new BN(order.amount),
      epochIndex: order.epochIndex,
      orderIndex: order.orderIndex,
      createdAt: new BN(order.createdAt),
      expiresAt: new BN(order.expiresAt),
    };
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
