# Stratum

Multi-chain state primitives achieving 800x state reduction through 5 composable patterns.

Built for **Solana** (Anchor) and **EVM** (Solidity/Foundry).

## Motivation

Stratum is inspired by Vitalik Buterin's [Hyper-scaling state by creating new forms of state](https://ethresear.ch/t/hyper-scaling-state-by-creating-new-forms-of-state/22077). The core insight is that while execution and data have clear scaling paths (ZK-EVMs, PeerDAS), **state has no magic bullet**. The proposed solution is a "barbell approach": keep existing permanent storage but introduce new, cheaper, more restrictive forms of state alongside it.

On Solana, accounts charge rent for on-chain storage. On EVM, `SSTORE` costs 20,000+ gas with no rent/cleanup mechanism. Stratum provides the same 5 primitives on both chains, letting developers minimize permanent state while preserving chain-native patterns.

## Primitives

| Primitive | What it does | Solana | EVM |
|-----------|-------------|--------|-----|
| **Bitfield** | Compact bit tracking (claims, spent flags) | 256-byte PDA chunks | `mapping(uint256 => uint256)` |
| **Merkle** | Commit to large datasets in 32 bytes | Custom hash | keccak256 with domain separation |
| **Expiry** | TTL + incentivized cleanup | Rent-based | Deposit-based (ETH deposits, cleaner rewards) |
| **Events** | History summarization without state bloat | `emit!()` macro | LOG events (8-13x cheaper than storage) |
| **Resurrection** | Archive off-chain, restore with proofs | PDA accounts | Merkle + Bitfield tracking |

## Monorepo Structure

```
stratum/
├── packages/
│   ├── core/              # @stratum/core — chain-agnostic TypeScript
│   │                      #   MerkleTree, Bitfield, OrderMatcher, types
│   ├── solana/            # @stratum/solana — Solana SDK
│   │                      #   PDA derivation, OrderBookClient, solanaHash
│   ├── evm/               # @stratum/evm — EVM SDK
│   │                      #   EvmMerkleTree, event parser, archive manager
│   └── qn-addon/          # Fabrknt Data Optimization — QuickNode Marketplace add-on
├── contracts/
│   ├── solana/            # Rust/Anchor programs
│   │   └── programs/
│   │       ├── stratum/           # Core primitives library
│   │       ├── airdrop-example/   # Merkle airdrop example
│   │       └── stratum-orderbook/ # State-optimized order book
│   └── evm/               # Solidity/Foundry contracts
│       ├── src/
│       │   ├── StratumBitfield.sol
│       │   ├── StratumMerkle.sol
│       │   ├── StratumExpiry.sol
│       │   ├── StratumEvents.sol
│       │   ├── StratumResurrection.sol
│       │   └── Stratum.sol         # Unified abstract contract
│       ├── examples/
│       │   ├── MerkleAirdrop.sol
│       │   └── StratumOrderBook.sol
│       └── test/
│           ├── benchmarks/         # Gas benchmarks
│           └── fuzz/               # Fuzz tests
└── apps/
    └── orderbook-cranker/  # Off-chain matching engine
```

## Quick Start

### TypeScript SDK

```typescript
// Chain-agnostic merkle tree
import { MerkleTree, Bitfield } from '@stratum/core';

// Solana
import { solanaHash } from '@stratum/solana';
const tree = new MerkleTree(leaves, solanaHash);

// EVM — uses EvmMerkleTree for Solidity-compatible hashing
import { EvmMerkleTree, evmHashLeaf } from '@stratum/evm';
const evmTree = new EvmMerkleTree(['order0', 'order1']);
const proof = evmTree.getProof(0);
// Submit evmTree.root + proof to Solidity StratumMerkle.verify()

// Event reconstruction
import { rebuildSummary, verifyHashChain, fetchRecordAddedEvents } from '@stratum/evm';
const events = await fetchRecordAddedEvents(provider, contractAddr, summaryId, fromBlock);
const summary = rebuildSummary(events);

// Archive management
import { buildArchive, generateRestoreProof, ArchiveStore } from '@stratum/evm';
const archive = buildArchive(archiveId, entries);
const restoreProof = generateRestoreProof(archive, entryIndex);
```

### Solidity

```solidity
import {Stratum} from "stratum/Stratum.sol";

contract MyApp is Stratum {
    // All 5 primitives available via `using...for` directives
    StratumBitfield.Bitfield internal claims;
    StratumEvents.HistorySummary public history;
    StratumExpiry.ExpiryRegistry internal expiry;
    StratumResurrection.ArchiveRegistry internal archives;

    function claim(uint256 index, bytes32[] memory proof) external {
        // Verify merkle proof + mark claimed in one call
        require(
            StratumMerkle.verifyAndMark(proof, merkleRoot, leaf, index, claims),
            "Invalid proof or already claimed"
        );
        // ...
    }
}
```

## EVM Gas Benchmarks

| Operation | Naive Approach | Stratum | Savings |
|-----------|---------------|---------|---------|
| 256 boolean sets | 6.0M gas (`mapping(uint256 => bool)`) | 439K gas (Bitfield) | **13.7x** |
| 10 record writes | 1.19M gas (struct per record) | 147K gas (Events) | **8.1x** |
| Merkle verify (100k entries) | N/A | ~6,154 gas | — |

## EVM Examples

### MerkleAirdrop

Port of the Solana airdrop example. Merkle whitelist + Bitfield claim tracking + Expiry for campaign TTL + Events for claim history.

### StratumOrderBook

Port of the Solana order book. Epoch-based order management with merkle root submission, dual-proof settlement verification, and bot-incentivized cleanup.

## Solana Programs

### airdrop-example

Demonstrates all primitives working together:
- Merkle tree whitelist for eligible recipients
- Bitfield claim tracking (2,048 claims per chunk at ~0.003 SOL)
- Expiry with cleanup rewards for reclaiming unused tokens
- Event-based claim history

### stratum-orderbook

State-optimized on-chain order book using Stratum's primitives to reduce state costs by 99%+.

**State cost comparison (10,000 orders):**
| Approach | State Size | Rent Cost |
|----------|-----------|-----------|
| Traditional (account per order) | ~2 MB | ~6.9 SOL |
| Stratum-optimized (merkle + bitfield) | ~2.5 KB | ~0.02 SOL |

## Off-Chain Cranker

The `apps/orderbook-cranker` package provides the off-chain matching engine:
- **OrderStore** — Sorted bid/ask books, merkle tree building per epoch
- **OrderMatcher** — Price-time priority matching
- **EpochCranker** — Collects orders, builds merkle tree, submits root on-chain
- **SettlementSubmitter** — Builds settlement transactions with merkle proofs

## QuickNode Marketplace Add-on

The **Fabrknt Data Optimization** add-on (`fabrknt-data-optimization`) exposes Stratum's Merkle and Bitfield primitives as a hosted API on the [QuickNode Marketplace](https://marketplace.quicknode.com/). Source lives in `packages/qn-addon/`.

### Endpoints

**Merkle**

- `POST /v1/merkle/build` — Build a Merkle tree from a set of leaves
- `POST /v1/merkle/proof` — Generate an inclusion proof for a leaf
- `POST /v1/merkle/verify` — Verify a proof against a root
- `POST /v1/merkle/hash` — Hash a value using the tree's hash function

**Bitfield**

- `POST /v1/bitfield/create` — Create a new bitfield
- `POST /v1/bitfield/set` — Set a bit in a bitfield
- `POST /v1/bitfield/check` — Check whether a bit is set
- `POST /v1/bitfield/stats` — Get bitfield statistics

### Plans

| Plan | Price | Access |
|------|-------|--------|
| **Starter** | Free | All endpoints |
| **Pro** | TBD | All endpoints + future on-chain operations |

## Development

### Prerequisites

- [Node.js](https://nodejs.org/) and [Yarn](https://yarnpkg.com/) — TypeScript packages
- [Foundry](https://book.getfoundry.sh/) — EVM contracts
- [Rust](https://rustup.rs/) + [Anchor](https://www.anchor-lang.com/) — Solana contracts

### Install

```sh
yarn install
```

### Test

```sh
# All TypeScript packages
yarn test

# Core (chain-agnostic)
cd packages/core && yarn test

# EVM SDK
cd packages/evm && yarn test

# EVM contracts (Foundry)
cd contracts/evm && forge test -vvv

# EVM fuzz tests (10,000 runs)
cd contracts/evm && forge test --fuzz-runs 10000

# Solana contracts
cd contracts/solana && anchor test
```

### Build

```sh
# TypeScript packages
yarn build

# EVM contracts
cd contracts/evm && forge build

# Solana contracts
cd contracts/solana && anchor build
```

## License

ISC
