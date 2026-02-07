# Stratum

State primitives for Solana programs built with [Anchor](https://www.anchor-lang.com/).

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
