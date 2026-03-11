import { MerkleTree, hashLeaf, hashNodes } from '../merkle';
import type { HashFunction } from '../types';
import type { ZKProof, ZKCircuit, ZKArtifact, ZKWitness, ZKBackend } from './types';
import { ZKProofSystem } from './types';
import { buildMerkleWitness, buildBatchWitness, buildStateTransitionWitness } from './witness';
import type { StateOp } from './types';

/**
 * Mock ZK backend — performs actual Merkle verification as a stand-in
 * for real ZK proof generation. Useful for testing and development.
 */
export class MockZKBackend implements ZKBackend {
  readonly name = 'mock';

  async compile(circuitId: string, _constraints?: Uint8Array): Promise<ZKArtifact> {
    return {
      circuitId,
      provingKey: new Uint8Array(0),
      verificationKey: new Uint8Array(0),
    };
  }

  async prove(artifact: ZKArtifact, witness: ZKWitness): Promise<ZKProof> {
    // Pack witness into "proof" — mock backend just passes through
    const parts: Uint8Array[] = [...witness.publicInputs, ...witness.privateInputs];
    const totalLen = parts.reduce((s, p) => s + 4 + p.length, 0);
    const proofBytes = new Uint8Array(totalLen);
    let offset = 0;
    for (const part of parts) {
      new DataView(proofBytes.buffer).setUint32(offset, part.length, true);
      offset += 4;
      proofBytes.set(part, offset);
      offset += part.length;
    }

    return {
      proofBytes,
      publicInputs: witness.publicInputs,
      system: ZKProofSystem.Groth16,
    };
  }

  async verify(_artifact: ZKArtifact, proof: ZKProof): Promise<boolean> {
    // Mock: always valid if proof has data
    return proof.proofBytes.length > 0 && proof.publicInputs.length > 0;
  }
}

function uint8ArrayEquals(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/**
 * Circuit proving a leaf is included in a Merkle tree.
 * Public inputs: [root, leafHash]
 * Verification reconstructs root from proof path and compares.
 */
export class MerkleInclusionCircuit implements ZKCircuit {
  readonly circuitId = 'merkle-inclusion-v1';
  private backend: ZKBackend;
  private hashFn: HashFunction;

  constructor(hashFn: HashFunction, backend: ZKBackend = new MockZKBackend()) {
    this.hashFn = hashFn;
    this.backend = backend;
  }

  async compile(): Promise<ZKArtifact> {
    return this.backend.compile(this.circuitId, new Uint8Array(0));
  }

  async generateProof(witness: ZKWitness): Promise<ZKProof> {
    const artifact = await this.compile();
    return this.backend.prove(artifact, witness);
  }

  async verify(proof: ZKProof): Promise<boolean> {
    if (proof.publicInputs.length < 2) return false;

    const [root, leafHash] = proof.publicInputs;

    // Extract proof path and index from private inputs encoded in proofBytes
    // For mock backend, we do actual Merkle verification
    const parts = decodeParts(proof.proofBytes);
    // Skip public inputs (first 2), then private inputs start
    const privateStart = 2;
    if (parts.length <= privateStart) return false;

    const proofPath: Uint8Array[] = [];
    let leafIndex = 0;

    // Last private input is the index (4 bytes)
    // Everything before it is the proof path
    for (let i = privateStart; i < parts.length - 1; i++) {
      proofPath.push(parts[i]);
    }

    const indexBytes = parts[parts.length - 1];
    if (indexBytes.length === 4) {
      leafIndex = new DataView(indexBytes.buffer, indexBytes.byteOffset).getUint32(0, true);
    }

    return MerkleTree.verifyProof(proofPath, root, leafHash, leafIndex, this.hashFn);
  }

  /** Convenience: generate proof directly from tree + index */
  async proveInclusion(tree: MerkleTree, leafIndex: number): Promise<ZKProof> {
    const witness = buildMerkleWitness(tree, leafIndex);
    return this.generateProof(witness);
  }
}

/**
 * Circuit aggregating N Merkle inclusion proofs into one.
 * Public inputs: [root, leafHash0, leafHash1, ...]
 */
export class BatchMerkleCircuit implements ZKCircuit {
  readonly circuitId = 'batch-merkle-v1';
  private hashFn: HashFunction;
  private backend: ZKBackend;

  constructor(hashFn: HashFunction, backend: ZKBackend = new MockZKBackend()) {
    this.hashFn = hashFn;
    this.backend = backend;
  }

  async compile(): Promise<ZKArtifact> {
    return this.backend.compile(this.circuitId, new Uint8Array(0));
  }

  async generateProof(witness: ZKWitness): Promise<ZKProof> {
    const artifact = await this.compile();
    return this.backend.prove(artifact, witness);
  }

  async verify(proof: ZKProof): Promise<boolean> {
    if (proof.publicInputs.length < 2) return false;

    const root = proof.publicInputs[0];
    const leafHashes = proof.publicInputs.slice(1);

    // For mock: decode private inputs and verify each proof
    const parts = decodeParts(proof.proofBytes);
    const privateStart = proof.publicInputs.length;
    if (parts.length <= privateStart) return false;

    // First private input is count
    const countBytes = parts[privateStart];
    const count = new DataView(countBytes.buffer, countBytes.byteOffset).getUint32(0, true);

    if (count !== leafHashes.length) return false;

    let partIdx = privateStart + 1;
    for (let i = 0; i < count; i++) {
      if (partIdx >= parts.length) return false;

      const indexBytes = parts[partIdx++];
      const leafIndex = new DataView(indexBytes.buffer, indexBytes.byteOffset).getUint32(0, true);

      // Collect proof siblings (32 bytes each until next 4-byte index or end)
      const proofPath: Uint8Array[] = [];
      while (partIdx < parts.length && parts[partIdx].length === 32) {
        proofPath.push(parts[partIdx++]);
      }

      if (!MerkleTree.verifyProof(proofPath, root, leafHashes[i], leafIndex, this.hashFn)) {
        return false;
      }
    }

    return true;
  }

  /** Convenience: prove batch from tree */
  async proveBatch(tree: MerkleTree, leafIndices: number[]): Promise<ZKProof> {
    const witness = buildBatchWitness(tree, leafIndices);
    return this.generateProof(witness);
  }
}

/**
 * Circuit proving valid state transition from old root to new root.
 * Public inputs: [oldRoot, newRoot, opCount]
 */
export class StateTransitionCircuit implements ZKCircuit {
  readonly circuitId = 'state-transition-v1';
  private backend: ZKBackend;

  constructor(backend: ZKBackend = new MockZKBackend()) {
    this.backend = backend;
  }

  async compile(): Promise<ZKArtifact> {
    return this.backend.compile(this.circuitId, new Uint8Array(0));
  }

  async generateProof(witness: ZKWitness): Promise<ZKProof> {
    const artifact = await this.compile();
    return this.backend.prove(artifact, witness);
  }

  async verify(proof: ZKProof): Promise<boolean> {
    if (proof.publicInputs.length < 3) return false;
    // For mock backend: proof is valid if it has the expected structure
    const artifact = await this.compile();
    return this.backend.verify(artifact, proof);
  }

  /** Convenience: prove state transition */
  async proveTransition(
    oldRoot: Uint8Array,
    newRoot: Uint8Array,
    operations: StateOp[],
  ): Promise<ZKProof> {
    const witness = buildStateTransitionWitness(oldRoot, newRoot, operations);
    return this.generateProof(witness);
  }
}

/** Decode length-prefixed parts from proof bytes */
function decodeParts(data: Uint8Array): Uint8Array[] {
  const parts: Uint8Array[] = [];
  let offset = 0;
  while (offset + 4 <= data.length) {
    const len = new DataView(data.buffer, data.byteOffset + offset).getUint32(0, true);
    offset += 4;
    if (offset + len > data.length) break;
    parts.push(data.slice(offset, offset + len));
    offset += len;
  }
  return parts;
}
