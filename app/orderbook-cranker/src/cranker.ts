import { Connection, Keypair, PublicKey, SystemProgram } from '@solana/web3.js';
import { AnchorProvider, Program, Wallet, BN } from '@coral-xyz/anchor';
import { TOKEN_PROGRAM_ID, getAssociatedTokenAddress } from '@solana/spl-token';
import { MerkleTree } from '@stratum/sdk';
import { OrderStore } from './order-store';
import { OrderMatcher } from './matcher';
import type { CrankerConfig, EpochState, MatchResult, Order, OrderSide } from './types';
import type { StratumOrderbook } from '../../../target/types/stratum_orderbook';
import idl from '../../../target/idl/stratum_orderbook.json';

/**
 * Epoch lifecycle manager.
 *
 * Responsibilities:
 * 1. Collect orders from makers (via API or event subscription)
 * 2. Build merkle trees per epoch
 * 3. Submit merkle roots on-chain
 * 4. Finalize epochs
 * 5. Create new epochs
 * 6. Trigger settlement for matched orders
 */
export class EpochCranker {
  private connection: Connection;
  private wallet: Wallet;
  private provider: AnchorProvider;
  private program: Program<StratumOrderbook>;
  private orderStore: OrderStore;
  private matcher: OrderMatcher;
  private config: CrankerConfig;
  private isRunning: boolean = false;

  constructor(config: CrankerConfig) {
    this.config = config;

    const keypairJson = require(config.keypairPath);
    const keypair = Keypair.fromSecretKey(new Uint8Array(keypairJson));

    this.connection = new Connection(config.rpcUrl, 'confirmed');
    this.wallet = new Wallet(keypair);
    this.provider = new AnchorProvider(this.connection, this.wallet, {
      commitment: 'confirmed',
    });
    this.program = new Program<StratumOrderbook>(
      idl as StratumOrderbook,
      this.provider
    );
    this.orderStore = new OrderStore(config.maxOrdersPerEpoch);
    this.matcher = new OrderMatcher();
  }

  /**
   * Start the cranker service
   */
  async start(): Promise<void> {
    console.log('Starting Epoch Cranker...');
    console.log(`Order book: ${this.config.orderBookAddress.toBase58()}`);
    console.log(`Cranker: ${this.wallet.publicKey.toBase58()}`);

    this.isRunning = true;

    // Run match loop and epoch rotation in parallel
    const matchLoop = this.runMatchLoop();
    const epochLoop = this.runEpochLoop();

    await Promise.all([matchLoop, epochLoop]);
  }

  /**
   * Stop the cranker
   */
  stop(): void {
    console.log('Stopping cranker...');
    this.isRunning = false;
  }

  /**
   * Get the order store (for external API to submit orders)
   */
  getOrderStore(): OrderStore {
    return this.orderStore;
  }

  /**
   * Get the matcher
   */
  getMatcher(): OrderMatcher {
    return this.matcher;
  }

  /**
   * Process current epoch: build tree, submit root, finalize
   */
  async processCurrentEpoch(): Promise<void> {
    const epoch = this.orderStore.getCurrentEpoch();

    if (epoch.orders.length === 0) {
      return;
    }

    // Build merkle tree
    const tree = this.orderStore.buildMerkleTree(epoch.epochIndex);
    if (!tree) return;

    console.log(
      `Epoch ${epoch.epochIndex}: ${epoch.orders.length} orders, root=${tree.root.toString('hex').slice(0, 16)}...`
    );

    // Submit root on-chain
    await this.submitEpochRoot(epoch.epochIndex, tree.root, epoch.orders.length);

    // Finalize epoch on-chain
    await this.finalizeEpoch(epoch.epochIndex);

    epoch.isRootSubmitted = true;
    epoch.isFinalized = true;
  }

  /**
   * Run one matching cycle
   */
  async runMatchCycle(): Promise<void> {
    const bids = this.orderStore.getBids();
    const asks = this.orderStore.getAsks();

    const matches = this.matcher.findMatches(bids, asks);

    if (matches.length === 0) return;

    console.log(`Found ${matches.length} matches`);

    for (const match of matches) {
      try {
        await this.submitSettlement(match);

        // Remove fully filled orders from books
        if (match.fillAmount >= match.makerOrder.amount) {
          this.orderStore.removeOrder(match.makerOrder.orderId);
        }
        if (match.fillAmount >= match.takerOrder.amount) {
          this.orderStore.removeOrder(match.takerOrder.orderId);
        }
      } catch (err) {
        console.error(
          `Failed to settle match ${match.makerOrder.orderId} x ${match.takerOrder.orderId}:`,
          err
        );
      }
    }
  }

  // --- On-chain transaction builders ---

  private async submitEpochRoot(
    epochIndex: number,
    root: Buffer,
    orderCount: number
  ): Promise<string> {
    console.log(
      `Submitting epoch root: epoch=${epochIndex}, orders=${orderCount}`
    );

    const orderBookAddress = this.config.orderBookAddress;
    const [epochPda] = this.deriveEpochPda(epochIndex);

    const rootArray = Array.from(root) as number[];

    const tx = await this.program.methods
      .submitEpochRoot(rootArray, orderCount)
      .accounts({
        orderBook: orderBookAddress,
        epoch: epochPda,
        authority: this.wallet.publicKey,
      })
      .rpc();

    console.log(`Epoch root submitted: tx=${tx}`);
    return tx;
  }

  private async finalizeEpoch(epochIndex: number): Promise<string> {
    console.log(`Finalizing epoch ${epochIndex}`);

    const orderBookAddress = this.config.orderBookAddress;
    const [epochPda] = this.deriveEpochPda(epochIndex);

    const tx = await this.program.methods
      .finalizeEpoch()
      .accounts({
        orderBook: orderBookAddress,
        epoch: epochPda,
        authority: this.wallet.publicKey,
      })
      .rpc();

    console.log(`Epoch finalized: tx=${tx}`);
    return tx;
  }

  private async submitSettlement(match: MatchResult): Promise<string> {
    const { makerOrder, takerOrder, fillAmount } = match;

    // Get merkle proofs for both orders
    const makerProof = this.orderStore.getMerkleProof(
      makerOrder.epochIndex,
      makerOrder.orderIndex
    );
    const takerProof = this.orderStore.getMerkleProof(
      takerOrder.epochIndex,
      takerOrder.orderIndex
    );

    if (!makerProof || !takerProof) {
      throw new Error('Cannot generate merkle proofs for settlement');
    }

    console.log(
      `Settling: maker=${makerOrder.orderId} x taker=${takerOrder.orderId}, ` +
        `amount=${fillAmount}, price=${match.fillPrice}`
    );

    const orderBookAddress = this.config.orderBookAddress;

    // Derive epoch PDAs
    const [makerEpochPda] = this.deriveEpochPda(makerOrder.epochIndex);
    const [takerEpochPda] = this.deriveEpochPda(takerOrder.epochIndex);

    // Derive chunk PDAs
    const makerChunkIndex = Math.floor(makerOrder.orderIndex / 2048);
    const takerChunkIndex = Math.floor(takerOrder.orderIndex / 2048);
    const [makerChunkPda] = this.deriveOrderChunkPda(makerEpochPda, makerChunkIndex);
    const [takerChunkPda] = this.deriveOrderChunkPda(takerEpochPda, takerChunkIndex);

    // Derive vault PDAs
    const [baseVaultPda] = this.deriveVaultPda('base_vault');
    const [quoteVaultPda] = this.deriveVaultPda('quote_vault');

    // Derive settlement receipt PDA
    const makerOrderIdBuf = Buffer.alloc(8);
    makerOrderIdBuf.writeBigUInt64LE(BigInt(makerOrder.orderId));
    const takerOrderIdBuf = Buffer.alloc(8);
    takerOrderIdBuf.writeBigUInt64LE(BigInt(takerOrder.orderId));
    const [settlementReceiptPda] = PublicKey.findProgramAddressSync(
      [
        Buffer.from('settlement'),
        orderBookAddress.toBuffer(),
        makerOrderIdBuf,
        takerOrderIdBuf,
      ],
      this.program.programId
    );

    // Fetch order book state to get fee_vault
    const orderBookAccount = await this.program.account.orderBook.fetch(orderBookAddress);

    // Convert proofs to arrays of 32-byte arrays
    const makerProofArrays = makerProof.proof.map((p) => Array.from(p) as number[]);
    const takerProofArrays = takerProof.proof.map((p) => Array.from(p) as number[]);

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
        orderBook: orderBookAddress,
        makerEpoch: makerEpochPda,
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
        cranker: this.wallet.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    console.log(`Settlement submitted: tx=${tx}`);
    return tx;
  }

  // --- PDA derivation helpers ---

  private deriveEpochPda(epochIndex: number): [PublicKey, number] {
    const epochIndexBuf = Buffer.alloc(4);
    epochIndexBuf.writeUInt32LE(epochIndex);
    return PublicKey.findProgramAddressSync(
      [Buffer.from('epoch'), this.config.orderBookAddress.toBuffer(), epochIndexBuf],
      this.program.programId
    );
  }

  private deriveOrderChunkPda(
    epochPda: PublicKey,
    chunkIndex: number
  ): [PublicKey, number] {
    const chunkIndexBuf = Buffer.alloc(4);
    chunkIndexBuf.writeUInt32LE(chunkIndex);
    return PublicKey.findProgramAddressSync(
      [Buffer.from('order_chunk'), epochPda.toBuffer(), chunkIndexBuf],
      this.program.programId
    );
  }

  private deriveVaultPda(seed: string): [PublicKey, number] {
    return PublicKey.findProgramAddressSync(
      [Buffer.from(seed), this.config.orderBookAddress.toBuffer()],
      this.program.programId
    );
  }

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

  private async runMatchLoop(): Promise<void> {
    while (this.isRunning) {
      try {
        await this.runMatchCycle();
      } catch (err) {
        console.error('Match cycle error:', err);
      }
      await this.sleep(this.config.matchIntervalMs);
    }
  }

  private async runEpochLoop(): Promise<void> {
    while (this.isRunning) {
      try {
        await this.processCurrentEpoch();
      } catch (err) {
        console.error('Epoch processing error:', err);
      }
      await this.sleep(this.config.epochRotationIntervalSec * 1000);
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
