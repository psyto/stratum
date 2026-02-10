import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import { AnchorProvider, Wallet } from '@coral-xyz/anchor';
import { MerkleTree } from '@stratum/sdk';
import { OrderStore } from './order-store';
import { OrderMatcher } from './matcher';
import type { CrankerConfig, EpochState } from './types';

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
    // Build and send submit_epoch_root transaction
    console.log(
      `Submitting epoch root: epoch=${epochIndex}, orders=${orderCount}`
    );

    // In production: build Anchor instruction for submit_epoch_root
    // const tx = await program.methods
    //   .submitEpochRoot(Array.from(root), orderCount)
    //   .accounts({ ... })
    //   .rpc();
    return `submit_root_${epochIndex}`;
  }

  private async finalizeEpoch(epochIndex: number): Promise<string> {
    console.log(`Finalizing epoch ${epochIndex}`);

    // In production: build Anchor instruction for finalize_epoch
    // const tx = await program.methods
    //   .finalizeEpoch()
    //   .accounts({ ... })
    //   .rpc();
    return `finalize_${epochIndex}`;
  }

  private async submitSettlement(match: {
    makerOrder: { orderId: number; epochIndex: number; orderIndex: number };
    takerOrder: { orderId: number; epochIndex: number; orderIndex: number };
    fillAmount: number;
    fillPrice: number;
  }): Promise<string> {
    // Get merkle proofs for both orders
    const makerProof = this.orderStore.getMerkleProof(
      match.makerOrder.epochIndex,
      match.makerOrder.orderIndex
    );
    const takerProof = this.orderStore.getMerkleProof(
      match.takerOrder.epochIndex,
      match.takerOrder.orderIndex
    );

    if (!makerProof || !takerProof) {
      throw new Error('Cannot generate merkle proofs for settlement');
    }

    console.log(
      `Settling: maker=${match.makerOrder.orderId} x taker=${match.takerOrder.orderId}, ` +
        `amount=${match.fillAmount}, price=${match.fillPrice}`
    );

    // In production: build Anchor instruction for settle_match
    // const tx = await program.methods
    //   .settleMatch(makerOrder, makerProofArray, makerIndex, ...)
    //   .accounts({ ... })
    //   .rpc();
    return `settle_${match.makerOrder.orderId}_${match.takerOrder.orderId}`;
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
