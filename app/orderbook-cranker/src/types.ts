import { PublicKey } from '@solana/web3.js';

/** Order side */
export enum OrderSide {
  Bid = 0,
  Ask = 1,
}

/** An order as submitted by a maker */
export interface Order {
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

/** A matched trade between two orders */
export interface MatchResult {
  makerOrder: Order;
  takerOrder: Order;
  fillAmount: number;
  fillPrice: number;
}

/** Epoch state tracked by the cranker */
export interface EpochState {
  epochIndex: number;
  orders: Order[];
  merkleRoot: Buffer | null;
  orderCount: number;
  isFinalized: boolean;
  isRootSubmitted: boolean;
}

/** Cranker configuration */
export interface CrankerConfig {
  /** RPC endpoint */
  rpcUrl: string;
  /** Cranker keypair path */
  keypairPath: string;
  /** Order book PDA */
  orderBookAddress: PublicKey;
  /** Maximum orders per epoch before rotation */
  maxOrdersPerEpoch: number;
  /** Epoch rotation interval in seconds */
  epochRotationIntervalSec: number;
  /** How often to check for matches (ms) */
  matchIntervalMs: number;
  /** How often to submit settlements (ms) */
  settlementIntervalMs: number;
}
