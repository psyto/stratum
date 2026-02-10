import { Connection, PublicKey, Keypair } from '@solana/web3.js';
import { MerkleTree, hashLeaf } from './merkle';
import { splitIndex, BITS_PER_CHUNK } from './bitfield';

/** Order side matching the on-chain enum */
export enum OrderSide {
  Bid = 0,
  Ask = 1,
}

/** Order leaf data matching the on-chain OrderLeaf struct */
export interface OrderLeaf {
  maker: PublicKey;
  orderId: number;
  side: OrderSide;
  price: number;
  amount: number;
  epochIndex: number;
  orderIndex: number;
  createdAt: number;
  expiresAt: number;
}

/** Order book state from on-chain */
export interface OrderBookState {
  authority: PublicKey;
  baseMint: PublicKey;
  quoteMint: PublicKey;
  currentEpoch: number;
  totalOrders: number;
  totalSettlements: number;
  tickSize: number;
  feeBps: number;
  isActive: boolean;
}

/** Epoch state from on-chain */
export interface EpochInfo {
  orderBook: PublicKey;
  epochIndex: number;
  merkleRoot: Uint8Array;
  orderCount: number;
  isFinalized: boolean;
  rootSubmitted: boolean;
}

const ORDER_BOOK_SEED = Buffer.from('order_book');
const EPOCH_SEED = Buffer.from('epoch');
const ORDER_CHUNK_SEED = Buffer.from('order_chunk');
const SETTLEMENT_SEED = Buffer.from('settlement');
const BASE_VAULT_SEED = Buffer.from('base_vault');
const QUOTE_VAULT_SEED = Buffer.from('quote_vault');

/**
 * Client for interacting with the Stratum Order Book program.
 */
export class OrderBookClient {
  private connection: Connection;
  private programId: PublicKey;

  constructor(connection: Connection, programId: PublicKey) {
    this.connection = connection;
    this.programId = programId;
  }

  // --- PDA Derivation ---

  deriveOrderBookPda(
    authority: PublicKey,
    baseMint: PublicKey,
    quoteMint: PublicKey
  ): [PublicKey, number] {
    return PublicKey.findProgramAddressSync(
      [
        ORDER_BOOK_SEED,
        authority.toBuffer(),
        baseMint.toBuffer(),
        quoteMint.toBuffer(),
      ],
      this.programId
    );
  }

  deriveEpochPda(
    orderBook: PublicKey,
    epochIndex: number
  ): [PublicKey, number] {
    const epochBuf = Buffer.alloc(4);
    epochBuf.writeUInt32LE(epochIndex);
    return PublicKey.findProgramAddressSync(
      [EPOCH_SEED, orderBook.toBuffer(), epochBuf],
      this.programId
    );
  }

  deriveOrderChunkPda(
    epoch: PublicKey,
    chunkIndex: number
  ): [PublicKey, number] {
    const chunkBuf = Buffer.alloc(4);
    chunkBuf.writeUInt32LE(chunkIndex);
    return PublicKey.findProgramAddressSync(
      [ORDER_CHUNK_SEED, epoch.toBuffer(), chunkBuf],
      this.programId
    );
  }

  deriveSettlementPda(
    orderBook: PublicKey,
    makerOrderId: number,
    takerOrderId: number
  ): [PublicKey, number] {
    const makerBuf = Buffer.alloc(8);
    makerBuf.writeBigUInt64LE(BigInt(makerOrderId));
    const takerBuf = Buffer.alloc(8);
    takerBuf.writeBigUInt64LE(BigInt(takerOrderId));
    return PublicKey.findProgramAddressSync(
      [SETTLEMENT_SEED, orderBook.toBuffer(), makerBuf, takerBuf],
      this.programId
    );
  }

  deriveBaseVaultPda(orderBook: PublicKey): [PublicKey, number] {
    return PublicKey.findProgramAddressSync(
      [BASE_VAULT_SEED, orderBook.toBuffer()],
      this.programId
    );
  }

  deriveQuoteVaultPda(orderBook: PublicKey): [PublicKey, number] {
    return PublicKey.findProgramAddressSync(
      [QUOTE_VAULT_SEED, orderBook.toBuffer()],
      this.programId
    );
  }

  // --- Serialization ---

  /**
   * Serialize an OrderLeaf to bytes matching the Rust AnchorSerialize format
   */
  serializeOrderLeaf(order: OrderLeaf): Buffer {
    const buf = Buffer.alloc(32 + 8 + 1 + 8 + 8 + 4 + 4 + 8 + 8);
    let offset = 0;

    order.maker.toBuffer().copy(buf, offset);
    offset += 32;

    buf.writeBigUInt64LE(BigInt(order.orderId), offset);
    offset += 8;

    buf[offset] = order.side;
    offset += 1;

    buf.writeBigUInt64LE(BigInt(order.price), offset);
    offset += 8;

    buf.writeBigUInt64LE(BigInt(order.amount), offset);
    offset += 8;

    buf.writeUInt32LE(order.epochIndex, offset);
    offset += 4;

    buf.writeUInt32LE(order.orderIndex, offset);
    offset += 4;

    buf.writeBigInt64LE(BigInt(order.createdAt), offset);
    offset += 8;

    buf.writeBigInt64LE(BigInt(order.expiresAt), offset);

    return buf;
  }

  /**
   * Hash an OrderLeaf for merkle tree inclusion.
   * Uses hashLeaf from Stratum SDK for domain separation.
   */
  hashOrderLeaf(order: OrderLeaf): Buffer {
    return hashLeaf(this.serializeOrderLeaf(order));
  }

  /**
   * Build a merkle tree from order leaves (convenience wrapper)
   */
  buildOrderMerkleTree(orders: OrderLeaf[]): MerkleTree {
    const leaves = orders.map((order) => this.serializeOrderLeaf(order));
    return new MerkleTree(leaves);
  }

  // --- State Reads ---

  /**
   * Fetch order book state from on-chain
   */
  async getOrderBook(
    authority: PublicKey,
    baseMint: PublicKey,
    quoteMint: PublicKey
  ): Promise<OrderBookState | null> {
    const [pda] = this.deriveOrderBookPda(authority, baseMint, quoteMint);
    const info = await this.connection.getAccountInfo(pda);
    if (!info) return null;

    return this.deserializeOrderBook(info.data);
  }

  /**
   * Fetch epoch info from on-chain
   */
  async getEpoch(
    orderBook: PublicKey,
    epochIndex: number
  ): Promise<EpochInfo | null> {
    const [pda] = this.deriveEpochPda(orderBook, epochIndex);
    const info = await this.connection.getAccountInfo(pda);
    if (!info) return null;

    return this.deserializeEpoch(info.data);
  }

  // --- Chunk Index Helpers ---

  /**
   * Get chunk index and local index for a global order index
   */
  getChunkForOrder(orderIndex: number): {
    chunkIndex: number;
    localIndex: number;
  } {
    return splitIndex(orderIndex);
  }

  /**
   * Calculate how many chunks needed for an epoch
   */
  chunksNeeded(orderCount: number): number {
    return Math.ceil(orderCount / BITS_PER_CHUNK);
  }

  // --- Deserialization ---

  private deserializeOrderBook(data: Buffer): OrderBookState | null {
    try {
      let offset = 8; // skip discriminator

      const authority = new PublicKey(data.subarray(offset, offset + 32));
      offset += 32;

      const baseMint = new PublicKey(data.subarray(offset, offset + 32));
      offset += 32;

      const quoteMint = new PublicKey(data.subarray(offset, offset + 32));
      offset += 32;

      // Skip vaults (2 x 32)
      offset += 64;

      const currentEpoch = data.readUInt32LE(offset);
      offset += 4;

      const totalOrders = Number(data.readBigUInt64LE(offset));
      offset += 8;

      const totalSettlements = Number(data.readBigUInt64LE(offset));
      offset += 8;

      const tickSize = Number(data.readBigUInt64LE(offset));
      offset += 8;

      const feeBps = data.readUInt16LE(offset);
      offset += 2;

      // Skip fee_vault (32), history, expiry
      offset += 32 + (8 + 16 + 8 + 8 + 8 + 8 + 32) + (8 + 8 + 8 + 8);

      const isActive = data[offset] === 1;

      return {
        authority,
        baseMint,
        quoteMint,
        currentEpoch,
        totalOrders,
        totalSettlements,
        tickSize,
        feeBps,
        isActive,
      };
    } catch {
      return null;
    }
  }

  private deserializeEpoch(data: Buffer): EpochInfo | null {
    try {
      let offset = 8; // skip discriminator

      const orderBook = new PublicKey(data.subarray(offset, offset + 32));
      offset += 32;

      const epochIndex = data.readUInt32LE(offset);
      offset += 4;

      const merkleRoot = new Uint8Array(data.subarray(offset, offset + 32));
      offset += 32;

      const orderCount = data.readUInt32LE(offset);
      offset += 4;

      const isFinalized = data[offset] === 1;
      offset += 1;

      const rootSubmitted = data[offset] === 1;

      return {
        orderBook,
        epochIndex,
        merkleRoot,
        orderCount,
        isFinalized,
        rootSubmitted,
      };
    } catch {
      return null;
    }
  }
}
