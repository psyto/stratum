import { MerkleTree, hashLeaf } from '@stratum/core';

export interface BuildTreeResult {
  root: Uint8Array;
  leafCount: number;
  depth: number;
}

export interface ProofResult {
  proof: Uint8Array[];
}

/**
 * Build a Merkle tree from hex-encoded leaf strings.
 */
export function buildTree(leaves: string[]): BuildTreeResult {
  const leafBuffers = leaves.map((l) => Buffer.from(l.replace(/^0x/, ''), 'hex'));
  const tree = new MerkleTree(leafBuffers);
  return {
    root: new Uint8Array(tree.root),
    leafCount: leaves.length,
    depth: tree.depth,
  };
}

/**
 * Get a Merkle proof for a leaf at the given index.
 */
export function getProof(leaves: string[], index: number): ProofResult {
  const leafBuffers = leaves.map((l) => Buffer.from(l.replace(/^0x/, ''), 'hex'));
  const tree = new MerkleTree(leafBuffers);
  const proof = tree.getProof(index);
  return {
    proof: proof.map((p: Buffer | Uint8Array) => new Uint8Array(p)),
  };
}

/**
 * Verify a Merkle proof.
 */
export function verifyProof(
  proof: Uint8Array[],
  root: Uint8Array,
  leaf: Uint8Array,
  index: number
): boolean {
  return MerkleTree.verify(proof, root, leaf, index);
}

/**
 * Hash a single leaf using the Merkle tree's hashing function.
 */
export function hashLeafData(data: Uint8Array): Uint8Array {
  return new Uint8Array(hashLeaf(data));
}
