import type { MerkleTree } from '../merkle';
import type { ZKWitness, StateOp } from './types';

/**
 * Build a ZK witness for proving merkle inclusion of a single leaf.
 * Public inputs: [root, leafHash]
 * Private inputs: [proofPath..., leafIndex as 4-byte LE]
 */
export function buildMerkleWitness(tree: MerkleTree, leafIndex: number): ZKWitness {
  const proof = tree.getProof(leafIndex);
  const root = tree.root;
  const leafHash = tree.getLeaf(leafIndex);

  const indexBytes = new Uint8Array(4);
  new DataView(indexBytes.buffer).setUint32(0, leafIndex, true);

  return {
    publicInputs: [root, leafHash],
    privateInputs: [...proof, indexBytes],
  };
}

/**
 * Build a ZK witness for batch merkle inclusion (multiple leaves in one tree).
 * Public inputs: [root, leafHash0, leafHash1, ...]
 * Private inputs: [count(4B), idx0(4B), proof0..., idx1(4B), proof1..., ...]
 */
export function buildBatchWitness(tree: MerkleTree, leafIndices: number[]): ZKWitness {
  const root = tree.root;
  const publicInputs: Uint8Array[] = [root];
  const privateInputs: Uint8Array[] = [];

  const countBytes = new Uint8Array(4);
  new DataView(countBytes.buffer).setUint32(0, leafIndices.length, true);
  privateInputs.push(countBytes);

  for (const idx of leafIndices) {
    publicInputs.push(tree.getLeaf(idx));

    const indexBytes = new Uint8Array(4);
    new DataView(indexBytes.buffer).setUint32(0, idx, true);
    privateInputs.push(indexBytes);

    const proof = tree.getProof(idx);
    for (const sibling of proof) {
      privateInputs.push(sibling);
    }
  }

  return { publicInputs, privateInputs };
}

/**
 * Build a ZK witness for a state transition (old root -> new root).
 * Public inputs: [oldRoot, newRoot, opCount as 32-byte padded]
 * Private inputs: [for each op: type(1B), index(4B), oldValue?, newValue?]
 */
export function buildStateTransitionWitness(
  oldRoot: Uint8Array,
  newRoot: Uint8Array,
  operations: StateOp[],
): ZKWitness {
  const opCountBytes = new Uint8Array(32);
  new DataView(opCountBytes.buffer).setUint32(28, operations.length, false);

  const privateInputs: Uint8Array[] = [];

  for (const op of operations) {
    const typeByte = new Uint8Array([
      op.type === 'insert' ? 0 : op.type === 'update' ? 1 : 2,
    ]);
    privateInputs.push(typeByte);

    const indexBytes = new Uint8Array(4);
    new DataView(indexBytes.buffer).setUint32(0, op.index, true);
    privateInputs.push(indexBytes);

    if (op.oldValue) privateInputs.push(op.oldValue);
    if (op.newValue) privateInputs.push(op.newValue);
  }

  return {
    publicInputs: [oldRoot, newRoot, opCountBytes],
    privateInputs,
  };
}
