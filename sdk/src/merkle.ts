// Domain separation prefixes (must match Rust implementation)
const LEAF_PREFIX = 0x00;
const NODE_PREFIX = 0x01;

/**
 * Simple hash function that matches the on-chain implementation
 * Uses FNV-1a variant expanded to 256 bits with mixing
 *
 * Note: For production, use a proper cryptographic hash like keccak256
 */
function hash256(data: Uint8Array): Buffer {
  const state = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
    0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);

  for (let i = 0; i < data.length; i++) {
    const idx = i % 8;
    state[idx] = Math.imul(state[idx], 0x01000193) + data[i];
    // Mix
    state[(idx + 1) % 8] ^= rotateLeft32(state[idx], 5);
  }

  // Final mixing
  for (let round = 0; round < 4; round++) {
    for (let i = 0; i < 8; i++) {
      state[i] = Math.imul(state[i], 0x01000193) ^ state[(i + 1) % 8];
    }
  }

  const result = Buffer.alloc(32);
  for (let i = 0; i < 8; i++) {
    result.writeUInt32LE(state[i] >>> 0, i * 4);
  }
  return result;
}

function rotateLeft32(value: number, bits: number): number {
  return ((value << bits) | (value >>> (32 - bits))) >>> 0;
}

/**
 * Hash a leaf with domain separation
 */
export function hashLeaf(data: Buffer | Uint8Array): Buffer {
  const prefixed = Buffer.concat([Buffer.from([LEAF_PREFIX]), Buffer.from(data)]);
  return hash256(prefixed);
}

/**
 * Hash two nodes together with domain separation
 */
export function hashNodes(left: Buffer, right: Buffer): Buffer {
  const combined = Buffer.concat([Buffer.from([NODE_PREFIX]), left, right]);
  return hash256(combined);
}

/**
 * Merkle tree builder for creating proofs client-side
 */
export class MerkleTree {
  private leaves: Buffer[];
  private layers: Buffer[][];

  constructor(leaves: (Buffer | Uint8Array | string)[]) {
    // Hash all leaves
    this.leaves = leaves.map((leaf) => {
      if (typeof leaf === 'string') {
        return hashLeaf(Buffer.from(leaf));
      }
      return hashLeaf(Buffer.from(leaf));
    });

    // Build tree layers
    this.layers = this.buildLayers();
  }

  /**
   * Create tree from raw leaf hashes (already hashed)
   */
  static fromHashes(hashes: Buffer[]): MerkleTree {
    const tree = new MerkleTree([]);
    tree.leaves = hashes;
    tree.layers = tree.buildLayers();
    return tree;
  }

  /**
   * Create tree from public keys (common for airdrops)
   */
  static fromPubkeys(pubkeys: { toBuffer(): Buffer }[]): MerkleTree {
    return new MerkleTree(pubkeys.map((pk) => pk.toBuffer()));
  }

  /**
   * Create tree from pubkey + amount pairs (for variable airdrops)
   */
  static fromPubkeyAmounts(
    entries: { pubkey: { toBuffer(): Buffer }; amount: bigint }[]
  ): MerkleTree {
    const leaves = entries.map((entry) => {
      const pubkeyBuf = entry.pubkey.toBuffer();
      const amountBuf = Buffer.alloc(8);
      amountBuf.writeBigUInt64LE(entry.amount);
      return Buffer.concat([pubkeyBuf, amountBuf]);
    });
    return new MerkleTree(leaves);
  }

  private buildLayers(): Buffer[][] {
    if (this.leaves.length === 0) {
      return [[Buffer.alloc(32)]];
    }

    const layers: Buffer[][] = [this.leaves];

    while (layers[layers.length - 1].length > 1) {
      const currentLayer = layers[layers.length - 1];
      const nextLayer: Buffer[] = [];

      for (let i = 0; i < currentLayer.length; i += 2) {
        const left = currentLayer[i];
        // If odd number, duplicate the last node
        const right = currentLayer[i + 1] || left;
        nextLayer.push(hashNodes(left, right));
      }

      layers.push(nextLayer);
    }

    return layers;
  }

  /**
   * Get the merkle root
   */
  get root(): Buffer {
    return this.layers[this.layers.length - 1][0];
  }

  /**
   * Get root as Uint8Array (for Anchor)
   */
  get rootArray(): number[] {
    return Array.from(this.root);
  }

  /**
   * Get the number of leaves
   */
  get leafCount(): number {
    return this.leaves.length;
  }

  /**
   * Get the depth of the tree
   */
  get depth(): number {
    return this.layers.length - 1;
  }

  /**
   * Get proof for a leaf at given index
   */
  getProof(index: number): Buffer[] {
    if (index < 0 || index >= this.leaves.length) {
      throw new Error(`Index ${index} out of bounds (0-${this.leaves.length - 1})`);
    }

    const proof: Buffer[] = [];
    let idx = index;

    for (let i = 0; i < this.layers.length - 1; i++) {
      const layer = this.layers[i];
      const siblingIdx = idx % 2 === 0 ? idx + 1 : idx - 1;

      if (siblingIdx < layer.length) {
        proof.push(layer[siblingIdx]);
      } else {
        // Odd number of nodes, sibling is self
        proof.push(layer[idx]);
      }

      idx = Math.floor(idx / 2);
    }

    return proof;
  }

  /**
   * Get proof as array of number arrays (for Anchor)
   */
  getProofArray(index: number): number[][] {
    return this.getProof(index).map((buf) => Array.from(buf));
  }

  /**
   * Verify a proof
   */
  static verifyProof(
    proof: Buffer[],
    root: Buffer,
    leaf: Buffer,
    index: number
  ): boolean {
    let computedHash = leaf;
    let idx = index;

    for (const sibling of proof) {
      if (idx % 2 === 0) {
        computedHash = hashNodes(computedHash, sibling);
      } else {
        computedHash = hashNodes(sibling, computedHash);
      }
      idx = Math.floor(idx / 2);
    }

    return computedHash.equals(root);
  }

  /**
   * Get leaf hash at index
   */
  getLeaf(index: number): Buffer {
    return this.leaves[index];
  }

  /**
   * Find index of a leaf by its original data
   */
  findLeafIndex(data: Buffer | Uint8Array | string): number {
    const targetHash =
      typeof data === 'string' ? hashLeaf(Buffer.from(data)) : hashLeaf(Buffer.from(data));

    return this.leaves.findIndex((leaf) => leaf.equals(targetHash));
  }
}
