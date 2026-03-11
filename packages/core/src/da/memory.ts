import type { DAProvider, DACommitment } from './types';

/**
 * In-memory DA provider for testing and development.
 * Stores blobs in a Map keyed by transaction hash.
 */
export class MemoryProvider implements DAProvider {
  readonly name = 'memory';
  private store = new Map<string, Uint8Array>();
  private blockHeight = 0;

  async submit(data: Uint8Array, namespace?: string): Promise<DACommitment> {
    this.blockHeight++;
    const txHash = this.computeHash(data);

    this.store.set(txHash, new Uint8Array(data));

    return {
      provider: this.name,
      blockHeight: this.blockHeight,
      txHash,
      namespace,
      dataRoot: txHash,
    };
  }

  async retrieve(commitment: DACommitment): Promise<Uint8Array | null> {
    return this.store.get(commitment.txHash) ?? null;
  }

  async verify(commitment: DACommitment, data: Uint8Array): Promise<boolean> {
    const stored = this.store.get(commitment.txHash);
    if (!stored) return false;
    if (stored.length !== data.length) return false;
    for (let i = 0; i < stored.length; i++) {
      if (stored[i] !== data[i]) return false;
    }
    return true;
  }

  /** Get number of stored blobs */
  get size(): number {
    return this.store.size;
  }

  /** Clear all stored data */
  clear(): void {
    this.store.clear();
    this.blockHeight = 0;
  }

  private computeHash(data: Uint8Array): string {
    // Simple FNV-1a hash for deterministic test IDs
    let hash = 0x811c9dc5;
    for (let i = 0; i < data.length; i++) {
      hash ^= data[i];
      hash = Math.imul(hash, 0x01000193);
    }
    return '0x' + (hash >>> 0).toString(16).padStart(8, '0') +
      this.blockHeight.toString(16).padStart(8, '0');
  }
}
