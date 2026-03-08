/** Order side — chain-agnostic enum */
export enum OrderSide {
  Bid = 0,
  Ask = 1,
}

/** Chain-agnostic order leaf data */
export interface OrderLeaf {
  /** Maker identifier (address bytes) */
  maker: Uint8Array;
  orderId: number;
  side: OrderSide;
  price: number;
  amount: number;
  epochIndex: number;
  orderIndex: number;
  createdAt: number;
  expiresAt: number;
}

// MatchResult is exported from matcher.ts

/** Merkle proof type */
export type MerkleProof = Uint8Array[];

/** Hash function signature — injectable for chain-specific hashing */
export type HashFunction = (data: Uint8Array) => Uint8Array;
