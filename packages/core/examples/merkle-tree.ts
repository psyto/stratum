/**
 * @stratum/core — Merkle Tree Example
 *
 * Demonstrates building a merkle tree from a whitelist of addresses,
 * generating proofs, and verifying them off-chain.
 *
 * Use case: Airdrop eligibility, on-chain whitelist verification,
 * order book commitment schemes.
 */
import { MerkleTree, hashLeaf } from '@stratum/core';

// ---------------------------------------------------------------------------
// 1. Build a merkle tree from a list of eligible addresses
// ---------------------------------------------------------------------------

const recipients = [
  'Alice:1000',   // address:amount pairs as leaves
  'Bob:2000',
  'Carol:500',
  'Dave:1500',
  'Eve:3000',
];

const tree = new MerkleTree(recipients);

console.log('Root:', Buffer.from(tree.root).toString('hex'));
console.log('Leaf count:', tree.leafCount);
console.log('Depth:', tree.depth);

// ---------------------------------------------------------------------------
// 2. Generate a proof for Carol (index 2)
// ---------------------------------------------------------------------------

const carolIndex = 2;
const proof = tree.getProof(carolIndex);
const carolLeaf = tree.getLeaf(carolIndex);

console.log('\nCarol proof length:', proof.length);
console.log('Carol leaf hash:', Buffer.from(carolLeaf).toString('hex'));

// ---------------------------------------------------------------------------
// 3. Verify the proof off-chain
// ---------------------------------------------------------------------------

const isValid = MerkleTree.verifyProof(proof, tree.root, carolLeaf, carolIndex);
console.log('Proof valid:', isValid); // true

// Tampered proof should fail
const fakeLeaf = hashLeaf(new TextEncoder().encode('Mallory:9999'));
const isFake = MerkleTree.verifyProof(proof, tree.root, fakeLeaf, carolIndex);
console.log('Fake proof valid:', isFake); // false

// ---------------------------------------------------------------------------
// 4. Find a leaf by its original data
// ---------------------------------------------------------------------------

const bobIndex = tree.findLeafIndex('Bob:2000');
console.log('\nBob index:', bobIndex); // 1

// ---------------------------------------------------------------------------
// 5. Get proof as number arrays (ready for Anchor/ABI encoding)
// ---------------------------------------------------------------------------

const proofArray = tree.getProofArray(carolIndex);
console.log('Proof for on-chain (number[][]):', proofArray.length, 'siblings');
console.log('Root for on-chain (number[]):', tree.rootArray.length, 'bytes');
