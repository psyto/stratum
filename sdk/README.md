# @stratum/sdk

TypeScript SDK for Stratum - State primitives for Solana (Merkle trees, bitfields, orderbook).

## Installation

```bash
npm install @stratum/sdk
# or
yarn add @stratum/sdk
```

## Quick Start

```typescript
import { MerkleTree, Bitfield, OrderBookClient } from "@stratum/sdk";
```

## Features

### Merkle Tree

Incremental Merkle tree for on-chain state proofs:

```typescript
import { MerkleTree } from "@stratum/sdk";

// Create a tree with depth 20
const tree = new MerkleTree(20);

// Insert leaves
tree.insert(leaf1);
tree.insert(leaf2);

// Generate inclusion proof
const proof = tree.getProof(0);

// Verify proof
const valid = MerkleTree.verify(proof, leaf1, tree.root);
```

### Bitfield

Compact boolean array for on-chain state tracking:

```typescript
import { Bitfield } from "@stratum/sdk";

// Create a bitfield with 256 bits
const bf = new Bitfield(256);

// Set and check bits
bf.set(42);
bf.set(100);
console.log(bf.get(42));  // true
console.log(bf.get(43));  // false

// Count set bits
console.log(bf.count());  // 2

// Serialize for on-chain storage
const bytes = bf.toBuffer();
```

### OrderBook Client

Interact with on-chain orderbooks:

```typescript
import { OrderBookClient } from "@stratum/sdk";
import { AnchorProvider } from "@coral-xyz/anchor";

const provider = AnchorProvider.env();
const client = new OrderBookClient(provider);

// Place a limit order
await client.placeLimitOrder(market, side, price, size);

// Cancel an order
await client.cancelOrder(market, orderId);

// Crank the orderbook (match orders)
await client.crankOrderbook(market);
```

## Types

```typescript
import type {
  MerkleProof,
  OrderSide,
  OrderType,
  MarketState,
} from "@stratum/sdk";
```

## License

MIT
