# Stratum

State primitives for Solana programs built with [Anchor](https://www.anchor-lang.com/).

## Motivation

Stratum is inspired by Vitalik Buterin's [Hyper-scaling state by creating new forms of state](https://ethresear.ch/t/hyper-scaling-state-by-creating-new-forms-of-state/22077). The core insight is that while execution and data have clear scaling paths (ZK-EVMs, PeerDAS), **state has no magic bullet**. The proposed solution is a "barbell approach": keep existing permanent storage but introduce new, cheaper, more restrictive forms of state alongside it.

The key ideas from the paper that Stratum brings to Solana:

- **Tiered state** — Not all state deserves the same treatment. Permanent storage (account balances, contract code) coexists with temporary and archivable state (individual claims, event participation, short-lived game state). Developers choose the right tier for each piece of data.
- **Bitfields for compact boolean state** — Rather than allocating a full account per flag, a single bitfield chunk tracks 2,048 boolean values in 256 bytes. This maps directly to the paper's concept of using bitfields to track spent/unspent UTXOs and claim status.
- **Merkle commitments for off-chain data** — Commit to 100k entries in 32 bytes on-chain, then verify inclusion via proofs. This enables the pattern of moving bulk data off-chain while retaining on-chain verifiability.
- **State resurrection** — Archive state off-chain and restore it later with merkle proofs, preventing double-use via bitfield tracking. This mirrors the paper's resurrection mechanism where historical state can be recovered while a bitfield prevents replaying the same proof twice.
- **Expiry with incentivized cleanup** — Temporary state comes with TTLs and cleanup rewards, so anyone can reclaim expired state and earn a reward. This keeps on-chain state lean without relying on altruistic actors.
- **Events over storage** — Instead of storing every detail on-chain, emit rich events and keep only aggregate summaries in state. This is the "history summarization without state bloat" pattern.

### Why this matters on Solana

Solana's account model charges rent for on-chain storage, making state costs a first-class concern for developers. As Solana scales transaction throughput, the cost of state relative to execution will shift — creating a new account may become more expensive relative to computation, just as the paper predicts for Ethereum. Stratum gives Solana developers the primitives to build applications that minimize permanent state while preserving the developer-friendly account model. Developers can continue using standard accounts for core program logic while offloading bulk state (token balances, claim tracking, participation records) to cheaper patterns built on bitfields, merkle trees, and event-based history.

## Components

- **Bitfield** — Compact bit tracking for claims, spent flags, and boolean state. Each chunk tracks 2,048 flags in 256 bytes.
- **Merkle** — Merkle tree commitments and proof verification. Commit to large datasets (e.g., 100k addresses) in 32 bytes on-chain.
- **Expiry** — TTL and cleanup crank patterns with configurable grace periods and cleanup rewards.
- **Events** — History summarization without state bloat. Track aggregate statistics on-chain while emitting detailed events.
- **Resurrection** — Archive state off-chain and restore it later with merkle proofs.

## Programs

### airdrop-example

Demonstrates all primitives working together:

- Merkle tree whitelist for eligible recipients
- Bitfield claim tracking (2,048 claims per chunk at ~0.003 SOL)
- Expiry with cleanup rewards for reclaiming unused tokens
- Event-based claim history

### stratum-orderbook

A state-optimized on-chain order book that uses Stratum's primitives to reduce state costs by 99%+ compared to traditional on-chain order storage.

**How it works:**
1. Orders are collected off-chain by a cranker and batched into epochs
2. Each epoch gets an immutable merkle root (32 bytes for the entire batch)
3. Bitfield chunks track order state (active/filled/cancelled) at 0.13 bytes per order
4. Settlement verifies merkle proofs for both maker and taker, checks bitfields, validates price constraints, and transfers tokens — all in a single instruction
5. Expired orders and settlement receipts can be cleaned up by anyone for a crank reward

**State cost comparison (10,000 orders):**
| Approach | State Size | Rent Cost |
|----------|-----------|-----------|
| Traditional (account per order) | ~2 MB | ~6.9 SOL |
| Stratum-optimized (merkle + bitfield) | ~2.5 KB | ~0.02 SOL |

**Instructions:**
- `create_order_book` — Initialize an order book for a trading pair
- `create_epoch` / `finalize_epoch` — Epoch lifecycle
- `submit_epoch_root` — Cranker submits computed merkle root
- `create_order_chunk` — Create bitfield chunk for order state tracking
- `settle_match` — Verify merkle proofs + check bitfields + validate price + transfer tokens
- `cancel_order` — Maker cancels with proof verification + refund
- `cleanup_expired_orders` / `cleanup_settlement` — Incentivized state reclamation

## Off-Chain Cranker

The `app/orderbook-cranker` package provides the off-chain matching engine:

- **OrderStore** — Maintains sorted bid/ask books in memory, builds merkle trees per epoch
- **OrderMatcher** — Price-time priority matching (fills at maker's price when bid >= ask)
- **EpochCranker** — Collects orders, builds merkle tree, submits root on-chain, finalizes epoch
- **SettlementSubmitter** — Builds and submits settlement transactions with merkle proofs

```bash
# Run the cranker
cd app/orderbook-cranker
export CRANKER_KEYPAIR_PATH=~/.config/solana/id.json
export ORDER_BOOK_ADDRESS=<order-book-pubkey>
export RPC_URL=http://127.0.0.1:8899
yarn dev
```

## SDK

The TypeScript SDK (`@stratum/sdk`) provides client-side utilities:

- **MerkleTree** — Build trees, generate proofs, verify proofs. Factory methods: `fromPubkeys()`, `fromPubkeyAmounts()`, `fromOrderLeaves()`
- **Bitfield** — Client-side bitfield simulation, index splitting, PDA derivation
- **OrderBookClient** — PDA derivation, order leaf serialization/hashing, on-chain state reads

```typescript
import { MerkleTree, OrderBookClient, Bitfield } from '@stratum/sdk';
import { Connection, PublicKey } from '@solana/web3.js';

// Build a merkle tree for an airdrop
const tree = MerkleTree.fromPubkeys(recipients);
const proof = tree.getProofArray(index); // For Anchor

// Order book client
const client = new OrderBookClient(connection, programId);
const [orderBookPda] = client.deriveOrderBookPda(authority, baseMint, quoteMint);
const orderHash = client.hashOrderLeaf(order);
const tree = client.buildOrderMerkleTree(orders);
```

## Project Structure

```
programs/
  stratum/              # Core state primitives library
  airdrop-example/      # Example: airdrop with all primitives
  stratum-orderbook/    # State-optimized on-chain order book
sdk/                    # TypeScript SDK (@stratum/sdk)
app/
  orderbook-cranker/    # Off-chain matching engine
tests/                  # Integration tests
```

## Development

### Prerequisites

- [Rust](https://rustup.rs/)
- [Solana CLI](https://docs.solanalabs.com/cli/install)
- [Anchor](https://www.anchor-lang.com/docs/installation)
- [Node.js](https://nodejs.org/) and [Yarn](https://yarnpkg.com/)

### Build

```sh
anchor build
```

### Test

```sh
anchor test
```

## License

ISC
