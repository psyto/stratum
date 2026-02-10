import { PublicKey } from '@solana/web3.js';
import { MerkleTree, hashLeaf } from '@stratum/sdk';
import { Order, OrderSide, EpochState } from './types';

/**
 * In-memory order storage and merkle tree builder.
 *
 * Maintains sorted bid/ask books and builds per-epoch merkle trees.
 * Orders are stored off-chain; only the merkle root goes on-chain.
 */
export class OrderStore {
  /** All orders grouped by epoch */
  private epochs: Map<number, EpochState> = new Map();

  /** Sorted bids (descending by price, then ascending by time) */
  private bids: Order[] = [];

  /** Sorted asks (ascending by price, then ascending by time) */
  private asks: Order[] = [];

  /** Next order ID counter */
  private nextOrderId: number = 1;

  /** Current active epoch index */
  private currentEpochIndex: number = 0;

  /** Maximum orders per epoch */
  private maxOrdersPerEpoch: number;

  constructor(maxOrdersPerEpoch: number = 2048) {
    this.maxOrdersPerEpoch = maxOrdersPerEpoch;
    this.initializeEpoch(0);
  }

  /**
   * Add an order to the current epoch
   */
  addOrder(
    maker: PublicKey,
    side: OrderSide,
    price: number,
    amount: number,
    expiresAt: number = 0
  ): Order {
    const epoch = this.getCurrentEpoch();

    // Rotate epoch if full
    if (epoch.orders.length >= this.maxOrdersPerEpoch) {
      this.rotateEpoch();
    }

    const activeEpoch = this.getCurrentEpoch();
    const orderIndex = activeEpoch.orders.length;

    const order: Order = {
      maker,
      orderId: this.nextOrderId++,
      side,
      price,
      amount,
      epochIndex: this.currentEpochIndex,
      orderIndex,
      createdAt: Math.floor(Date.now() / 1000),
      expiresAt,
    };

    activeEpoch.orders.push(order);
    activeEpoch.orderCount = activeEpoch.orders.length;

    // Insert into sorted book
    if (side === OrderSide.Bid) {
      this.insertBid(order);
    } else {
      this.insertAsk(order);
    }

    return order;
  }

  /**
   * Build merkle tree for an epoch's orders
   */
  buildMerkleTree(epochIndex: number): MerkleTree | null {
    const epoch = this.epochs.get(epochIndex);
    if (!epoch || epoch.orders.length === 0) return null;

    const leaves = epoch.orders.map((order) => this.serializeOrder(order));
    const tree = new MerkleTree(leaves);

    epoch.merkleRoot = tree.root;
    epoch.isRootSubmitted = false;

    return tree;
  }

  /**
   * Get merkle proof for a specific order
   */
  getMerkleProof(
    epochIndex: number,
    orderIndex: number
  ): { proof: Buffer[]; root: Buffer } | null {
    const epoch = this.epochs.get(epochIndex);
    if (!epoch || !epoch.merkleRoot) return null;

    const leaves = epoch.orders.map((order) => this.serializeOrder(order));
    const tree = new MerkleTree(leaves);

    return {
      proof: tree.getProof(orderIndex),
      root: tree.root,
    };
  }

  /**
   * Get all orders in the current epoch
   */
  getCurrentEpoch(): EpochState {
    return this.epochs.get(this.currentEpochIndex)!;
  }

  /**
   * Get epoch by index
   */
  getEpoch(index: number): EpochState | undefined {
    return this.epochs.get(index);
  }

  /**
   * Get sorted bids (best price first)
   */
  getBids(): Order[] {
    return [...this.bids];
  }

  /**
   * Get sorted asks (best price first)
   */
  getAsks(): Order[] {
    return [...this.asks];
  }

  /**
   * Get current epoch index
   */
  get activeEpochIndex(): number {
    return this.currentEpochIndex;
  }

  /**
   * Get total order count across all epochs
   */
  get totalOrders(): number {
    let total = 0;
    for (const epoch of this.epochs.values()) {
      total += epoch.orderCount;
    }
    return total;
  }

  /**
   * Remove an order from the sorted books (after fill or cancel)
   */
  removeOrder(orderId: number): void {
    this.bids = this.bids.filter((o) => o.orderId !== orderId);
    this.asks = this.asks.filter((o) => o.orderId !== orderId);
  }

  /**
   * Serialize an order into bytes matching the on-chain OrderLeaf format.
   * Must match Rust's AnchorSerialize output exactly.
   */
  serializeOrder(order: Order): Buffer {
    const buf = Buffer.alloc(
      32 + // maker (Pubkey)
      8 +  // order_id (u64)
      1 +  // side (enum)
      8 +  // price (u64)
      8 +  // amount (u64)
      4 +  // epoch_index (u32)
      4 +  // order_index (u32)
      8 +  // created_at (i64)
      8    // expires_at (i64)
    );

    let offset = 0;

    // maker (32 bytes)
    order.maker.toBuffer().copy(buf, offset);
    offset += 32;

    // order_id (u64 LE)
    buf.writeBigUInt64LE(BigInt(order.orderId), offset);
    offset += 8;

    // side (1 byte enum)
    buf[offset] = order.side;
    offset += 1;

    // price (u64 LE)
    buf.writeBigUInt64LE(BigInt(order.price), offset);
    offset += 8;

    // amount (u64 LE)
    buf.writeBigUInt64LE(BigInt(order.amount), offset);
    offset += 8;

    // epoch_index (u32 LE)
    buf.writeUInt32LE(order.epochIndex, offset);
    offset += 4;

    // order_index (u32 LE)
    buf.writeUInt32LE(order.orderIndex, offset);
    offset += 4;

    // created_at (i64 LE)
    buf.writeBigInt64LE(BigInt(order.createdAt), offset);
    offset += 8;

    // expires_at (i64 LE)
    buf.writeBigInt64LE(BigInt(order.expiresAt), offset);

    return buf;
  }

  private initializeEpoch(index: number): void {
    this.epochs.set(index, {
      epochIndex: index,
      orders: [],
      merkleRoot: null,
      orderCount: 0,
      isFinalized: false,
      isRootSubmitted: false,
    });
  }

  private rotateEpoch(): void {
    // Finalize current epoch
    const current = this.getCurrentEpoch();
    current.isFinalized = true;

    // Build merkle tree for the finalized epoch
    this.buildMerkleTree(this.currentEpochIndex);

    // Create new epoch
    this.currentEpochIndex++;
    this.initializeEpoch(this.currentEpochIndex);
  }

  private insertBid(order: Order): void {
    // Sorted descending by price, then ascending by createdAt (time priority)
    const idx = this.bids.findIndex(
      (o) => order.price > o.price || (order.price === o.price && order.createdAt < o.createdAt)
    );
    if (idx === -1) {
      this.bids.push(order);
    } else {
      this.bids.splice(idx, 0, order);
    }
  }

  private insertAsk(order: Order): void {
    // Sorted ascending by price, then ascending by createdAt (time priority)
    const idx = this.asks.findIndex(
      (o) => order.price < o.price || (order.price === o.price && order.createdAt < o.createdAt)
    );
    if (idx === -1) {
      this.asks.push(order);
    } else {
      this.asks.splice(idx, 0, order);
    }
  }
}
