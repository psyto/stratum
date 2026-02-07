import { PublicKey } from '@solana/web3.js';

/**
 * Constants matching Rust implementation
 */
export const BITS_PER_CHUNK = 2048; // 256 bytes * 8 bits
export const BYTES_PER_CHUNK = 256;

/**
 * Split a global index into chunk index and local bit index
 */
export function splitIndex(globalIndex: number): { chunkIndex: number; localIndex: number } {
  const chunkIndex = Math.floor(globalIndex / BITS_PER_CHUNK);
  const localIndex = globalIndex % BITS_PER_CHUNK;
  return { chunkIndex, localIndex };
}

/**
 * Combine chunk index and local index into global index
 */
export function globalIndex(chunkIndex: number, localIndex: number): number {
  return chunkIndex * BITS_PER_CHUNK + localIndex;
}

/**
 * Calculate how many chunks needed for a given capacity
 */
export function chunksNeeded(capacity: number): number {
  return Math.ceil(capacity / BITS_PER_CHUNK);
}

/**
 * Client-side bitfield for tracking/simulation
 */
export class Bitfield {
  private bits: Uint8Array;
  private _setCount: number = 0;

  constructor(size: number = BYTES_PER_CHUNK) {
    this.bits = new Uint8Array(size);
  }

  /**
   * Create from existing bytes
   */
  static fromBytes(bytes: Uint8Array | number[]): Bitfield {
    const bf = new Bitfield(bytes.length);
    bf.bits = new Uint8Array(bytes);
    bf._setCount = bf.countSet();
    return bf;
  }

  /**
   * Check if a bit is set
   */
  isSet(index: number): boolean {
    const byteIdx = Math.floor(index / 8);
    const bitIdx = index % 8;

    if (byteIdx >= this.bits.length) {
      return false;
    }

    return ((this.bits[byteIdx] >> bitIdx) & 1) === 1;
  }

  /**
   * Set a bit
   * @returns true if bit was newly set, false if already set
   */
  set(index: number): boolean {
    const byteIdx = Math.floor(index / 8);
    const bitIdx = index % 8;

    if (byteIdx >= this.bits.length) {
      throw new Error(`Index ${index} out of bounds`);
    }

    const wasSet = this.isSet(index);
    if (!wasSet) {
      this.bits[byteIdx] |= 1 << bitIdx;
      this._setCount++;
    }
    return !wasSet;
  }

  /**
   * Unset a bit
   * @returns true if bit was set before, false if already unset
   */
  unset(index: number): boolean {
    const byteIdx = Math.floor(index / 8);
    const bitIdx = index % 8;

    if (byteIdx >= this.bits.length) {
      throw new Error(`Index ${index} out of bounds`);
    }

    const wasSet = this.isSet(index);
    if (wasSet) {
      this.bits[byteIdx] &= ~(1 << bitIdx);
      this._setCount--;
    }
    return wasSet;
  }

  /**
   * Get count of set bits (cached)
   */
  get setCount(): number {
    return this._setCount;
  }

  /**
   * Get capacity (max bits)
   */
  get capacity(): number {
    return this.bits.length * 8;
  }

  /**
   * Count set bits (recalculate)
   */
  countSet(): number {
    let count = 0;
    for (const byte of this.bits) {
      // Brian Kernighan's algorithm
      let b = byte;
      while (b) {
        count++;
        b &= b - 1;
      }
    }
    return count;
  }

  /**
   * Get fill rate in basis points (0-10000)
   */
  fillRateBps(): number {
    return Math.floor((this._setCount * 10000) / this.capacity);
  }

  /**
   * Check if all bits are set
   */
  isFull(): boolean {
    return this._setCount >= this.capacity;
  }

  /**
   * Check if no bits are set
   */
  isEmpty(): boolean {
    return this._setCount === 0;
  }

  /**
   * Get the underlying bytes
   */
  toBytes(): Uint8Array {
    return this.bits;
  }

  /**
   * Get as number array (for Anchor)
   */
  toArray(): number[] {
    return Array.from(this.bits);
  }

  /**
   * Get all set indices
   */
  getSetIndices(): number[] {
    const indices: number[] = [];
    for (let i = 0; i < this.capacity; i++) {
      if (this.isSet(i)) {
        indices.push(i);
      }
    }
    return indices;
  }

  /**
   * Get all unset indices
   */
  getUnsetIndices(): number[] {
    const indices: number[] = [];
    for (let i = 0; i < this.capacity; i++) {
      if (!this.isSet(i)) {
        indices.push(i);
      }
    }
    return indices;
  }
}

/**
 * Derive PDA for bitfield registry
 */
export function deriveBitfieldRegistryPDA(
  authority: PublicKey,
  programId: PublicKey
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('bitfield_registry'), authority.toBuffer()],
    programId
  );
}

/**
 * Derive PDA for bitfield chunk
 */
export function deriveBitfieldChunkPDA(
  registry: PublicKey,
  chunkIndex: number,
  programId: PublicKey
): [PublicKey, number] {
  const chunkIndexBuf = Buffer.alloc(4);
  chunkIndexBuf.writeUInt32LE(chunkIndex);

  return PublicKey.findProgramAddressSync(
    [Buffer.from('bitfield_chunk'), registry.toBuffer(), chunkIndexBuf],
    programId
  );
}
