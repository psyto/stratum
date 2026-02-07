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

## Example

The `airdrop-example` program demonstrates all primitives working together:

- Merkle tree whitelist for eligible recipients
- Bitfield claim tracking (2,048 claims per chunk at ~0.003 SOL)
- Expiry with cleanup rewards for reclaiming unused tokens
- Event-based claim history

## Project Structure

```
programs/
  stratum/          # Core state primitives library
  airdrop-example/  # Example program using Stratum
sdk/                # TypeScript SDK (merkle tree, bitfield utilities)
tests/              # Integration tests
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
