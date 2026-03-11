import { describe, it, expect } from 'vitest';
import { MerkleTree, hashLeaf } from '../merkle';
import {
  ZKProofSystem,
  MockZKBackend,
  MerkleInclusionCircuit,
  BatchMerkleCircuit,
  StateTransitionCircuit,
  buildMerkleWitness,
  buildBatchWitness,
  buildStateTransitionWitness,
} from '../zk';

const enc = (s: string) => new TextEncoder().encode(s);

describe('ZK Witness Builders', () => {
  it('buildMerkleWitness produces correct public inputs', () => {
    const tree = new MerkleTree(['a', 'b', 'c', 'd']);
    const witness = buildMerkleWitness(tree, 2);

    expect(witness.publicInputs.length).toBe(2);
    expect(witness.publicInputs[0]).toEqual(tree.root);
    expect(witness.publicInputs[1]).toEqual(tree.getLeaf(2));

    // Private inputs: proof path siblings + index
    expect(witness.privateInputs.length).toBeGreaterThan(0);
    // Last private input is the 4-byte index
    const lastInput = witness.privateInputs[witness.privateInputs.length - 1];
    expect(lastInput.length).toBe(4);
    const idx = new DataView(lastInput.buffer, lastInput.byteOffset).getUint32(0, true);
    expect(idx).toBe(2);
  });

  it('buildBatchWitness includes all leaf hashes as public inputs', () => {
    const tree = new MerkleTree(['x', 'y', 'z', 'w']);
    const witness = buildBatchWitness(tree, [0, 2, 3]);

    // Public: root + 3 leaf hashes
    expect(witness.publicInputs.length).toBe(4);
    expect(witness.publicInputs[0]).toEqual(tree.root);
    expect(witness.publicInputs[1]).toEqual(tree.getLeaf(0));
    expect(witness.publicInputs[2]).toEqual(tree.getLeaf(2));
    expect(witness.publicInputs[3]).toEqual(tree.getLeaf(3));

    // First private input is count (4 bytes)
    const countBytes = witness.privateInputs[0];
    expect(countBytes.length).toBe(4);
    const count = new DataView(countBytes.buffer, countBytes.byteOffset).getUint32(0, true);
    expect(count).toBe(3);
  });

  it('buildStateTransitionWitness encodes operations', () => {
    const oldRoot = new Uint8Array(32).fill(0xaa);
    const newRoot = new Uint8Array(32).fill(0xbb);
    const ops = [
      { type: 'insert' as const, index: 0, newValue: enc('new') },
      { type: 'delete' as const, index: 5 },
    ];

    const witness = buildStateTransitionWitness(oldRoot, newRoot, ops);

    expect(witness.publicInputs.length).toBe(3);
    expect(witness.publicInputs[0]).toEqual(oldRoot);
    expect(witness.publicInputs[1]).toEqual(newRoot);
    // Third is op count (32-byte padded)
    expect(witness.publicInputs[2].length).toBe(32);

    // Private inputs contain op types and indices
    expect(witness.privateInputs.length).toBeGreaterThan(0);
    // First op type byte: 0 = insert
    expect(witness.privateInputs[0][0]).toBe(0);
  });
});

describe('MockZKBackend', () => {
  it('compile returns artifact with circuit ID', async () => {
    const backend = new MockZKBackend();
    const artifact = await backend.compile('test-circuit', new Uint8Array(0));

    expect(artifact.circuitId).toBe('test-circuit');
    expect(artifact.provingKey).toBeDefined();
    expect(artifact.verificationKey).toBeDefined();
  });

  it('prove returns proof with correct system', async () => {
    const backend = new MockZKBackend();
    const artifact = await backend.compile('test', new Uint8Array(0));
    const witness = {
      publicInputs: [new Uint8Array(32).fill(1)],
      privateInputs: [new Uint8Array(32).fill(2)],
    };

    const proof = await backend.prove(artifact, witness);

    expect(proof.system).toBe(ZKProofSystem.Groth16);
    expect(proof.publicInputs).toEqual(witness.publicInputs);
    expect(proof.proofBytes.length).toBeGreaterThan(0);
  });

  it('verify returns true for valid mock proof', async () => {
    const backend = new MockZKBackend();
    const artifact = await backend.compile('test', new Uint8Array(0));
    const proof = {
      proofBytes: new Uint8Array(32).fill(1),
      publicInputs: [new Uint8Array(32)],
      system: ZKProofSystem.Groth16,
    };

    expect(await backend.verify(artifact, proof)).toBe(true);
  });
});

describe('MerkleInclusionCircuit', () => {
  it('prove and verify roundtrip succeeds', async () => {
    const tree = new MerkleTree(['leaf0', 'leaf1', 'leaf2', 'leaf3']);
    const circuit = new MerkleInclusionCircuit(undefined as any); // uses default hash

    const proof = await circuit.proveInclusion(tree, 2);

    expect(proof.publicInputs.length).toBe(2);
    expect(proof.publicInputs[0]).toEqual(tree.root);
    expect(proof.publicInputs[1]).toEqual(tree.getLeaf(2));

    const valid = await circuit.verify(proof);
    expect(valid).toBe(true);
  });

  it('verify fails with wrong leaf', async () => {
    const tree = new MerkleTree(['a', 'b', 'c', 'd']);
    const circuit = new MerkleInclusionCircuit(undefined as any);

    const proof = await circuit.proveInclusion(tree, 0);

    // Tamper with the leaf hash
    proof.publicInputs[1] = new Uint8Array(32).fill(0xff);

    const valid = await circuit.verify(proof);
    expect(valid).toBe(false);
  });
});

describe('BatchMerkleCircuit', () => {
  it('prove and verify batch succeeds', async () => {
    const tree = new MerkleTree(['a', 'b', 'c', 'd']);
    const circuit = new BatchMerkleCircuit(undefined as any);

    const proof = await circuit.proveBatch(tree, [0, 1, 3]);

    expect(proof.publicInputs.length).toBe(4); // root + 3 leaves

    const valid = await circuit.verify(proof);
    expect(valid).toBe(true);
  });
});

describe('StateTransitionCircuit', () => {
  it('prove and verify roundtrip succeeds', async () => {
    const circuit = new StateTransitionCircuit();
    const oldRoot = new Uint8Array(32).fill(0x01);
    const newRoot = new Uint8Array(32).fill(0x02);
    const ops = [{ type: 'insert' as const, index: 0, newValue: enc('val') }];

    const proof = await circuit.proveTransition(oldRoot, newRoot, ops);

    expect(proof.publicInputs.length).toBe(3);

    const valid = await circuit.verify(proof);
    expect(valid).toBe(true);
  });
});
