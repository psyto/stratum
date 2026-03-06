/**
 * @stratum/core — Bitfield Claim Tracking Example
 *
 * Demonstrates using a compact bitfield to track which items have been
 * claimed/processed. Each bit represents one slot — 256 bytes tracks
 * 2048 items with O(1) set/check operations.
 *
 * Use case: Airdrop claim tracking, vote deduplication, order settlement
 * tracking, coupon redemption.
 */
import { Bitfield, splitIndex, globalIndex, chunksNeeded, BITS_PER_CHUNK } from '@stratum/core';

// ---------------------------------------------------------------------------
// 1. Create a bitfield for tracking 500 airdrop claims
// ---------------------------------------------------------------------------

const totalRecipients = 500;
const chunks = chunksNeeded(totalRecipients);
console.log(`Need ${chunks} chunk(s) for ${totalRecipients} recipients`);
console.log(`Each chunk tracks ${BITS_PER_CHUNK} bits\n`);

const claims = new Bitfield(); // default: 256 bytes = 2048 bits

// ---------------------------------------------------------------------------
// 2. Record claims
// ---------------------------------------------------------------------------

// Users claim at their assigned indices
claims.set(0);   // Alice claims
claims.set(42);  // Bob claims
claims.set(199); // Carol claims

console.log('Claims so far:', claims.setCount);
console.log('Alice claimed?', claims.isSet(0));    // true
console.log('Dave claimed?', claims.isSet(100));    // false

// Attempting to double-claim returns false
const newClaim = claims.set(42);
console.log('\nBob double-claim (newly set?):', newClaim); // false

// ---------------------------------------------------------------------------
// 3. Inspect fill rate and capacity
// ---------------------------------------------------------------------------

console.log('\nCapacity:', claims.capacity);
console.log('Fill rate:', claims.fillRateBps(), 'bps');
console.log('Is full?', claims.isFull());
console.log('Is empty?', claims.isEmpty());

// ---------------------------------------------------------------------------
// 4. Work with chunk indices (for multi-account Solana storage)
// ---------------------------------------------------------------------------

const idx = 3000; // global index across chunks
const { chunkIndex, localIndex } = splitIndex(idx);
console.log(`\nGlobal index ${idx} → chunk ${chunkIndex}, local ${localIndex}`);

const reconstructed = globalIndex(chunkIndex, localIndex);
console.log(`Reconstructed: ${reconstructed}`); // 3000

// ---------------------------------------------------------------------------
// 5. Serialize / deserialize (for on-chain storage)
// ---------------------------------------------------------------------------

const bytes = claims.toBytes();
console.log('\nSerialized size:', bytes.length, 'bytes');

// Reconstruct from on-chain account data
const restored = Bitfield.fromBytes(bytes);
console.log('Restored claims:', restored.setCount);
console.log('Alice still claimed?', restored.isSet(0)); // true

// ---------------------------------------------------------------------------
// 6. List all claimed indices
// ---------------------------------------------------------------------------

console.log('\nAll claimed indices:', claims.getSetIndices());
