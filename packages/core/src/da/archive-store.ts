import type { DAProvider, DACommitment } from './types';

/** Serialized archive entry format */
export interface ArchiveRecord {
  archiveId: string;
  commitment: DACommitment;
  entryCount: number;
}

/**
 * DA-backed archive store with local LRU cache.
 * Replaces in-memory-only ArchiveStore for production use.
 */
export class PersistentArchiveStore {
  private provider: DAProvider;
  private cache: Map<string, Uint8Array[]>;
  private commitments: Map<string, DACommitment>;
  private maxCacheSize: number;

  constructor(provider: DAProvider, maxCacheSize: number = 100) {
    this.provider = provider;
    this.cache = new Map();
    this.commitments = new Map();
    this.maxCacheSize = maxCacheSize;
  }

  /**
   * Store entries to DA layer.
   * Returns the DA commitment for on-chain reference.
   */
  async store(archiveId: string, entries: Uint8Array[]): Promise<DACommitment> {
    const serialized = serializeEntries(entries);
    const commitment = await this.provider.submit(serialized, archiveId);

    // Cache locally
    this.evictIfNeeded();
    this.cache.set(archiveId, entries);
    this.commitments.set(archiveId, commitment);

    return commitment;
  }

  /**
   * Retrieve entries, checking local cache first, then DA layer.
   */
  async retrieve(archiveId: string): Promise<Uint8Array[] | null> {
    // Check cache
    const cached = this.cache.get(archiveId);
    if (cached) return cached;

    // Check DA
    const commitment = this.commitments.get(archiveId);
    if (!commitment) return null;

    const data = await this.provider.retrieve(commitment);
    if (!data) return null;

    const entries = deserializeEntries(data);

    // Re-cache
    this.evictIfNeeded();
    this.cache.set(archiveId, entries);

    return entries;
  }

  /**
   * Retrieve using an external commitment (e.g., from on-chain data).
   */
  async retrieveByCommitment(
    archiveId: string,
    commitment: DACommitment,
  ): Promise<Uint8Array[] | null> {
    this.commitments.set(archiveId, commitment);
    return this.retrieve(archiveId);
  }

  /**
   * Verify that stored data matches a commitment.
   */
  async verify(archiveId: string, entries: Uint8Array[]): Promise<boolean> {
    const commitment = this.commitments.get(archiveId);
    if (!commitment) return false;
    const serialized = serializeEntries(entries);
    return this.provider.verify(commitment, serialized);
  }

  /** Get the DA commitment for an archive */
  getCommitment(archiveId: string): DACommitment | undefined {
    return this.commitments.get(archiveId);
  }

  /** Check if archive exists in cache or commitments */
  has(archiveId: string): boolean {
    return this.cache.has(archiveId) || this.commitments.has(archiveId);
  }

  /** List all known archive IDs */
  keys(): string[] {
    return [...new Set([...this.cache.keys(), ...this.commitments.keys()])];
  }

  private evictIfNeeded(): void {
    if (this.cache.size >= this.maxCacheSize) {
      // Evict oldest entry (first key in insertion order)
      const firstKey = this.cache.keys().next().value;
      if (firstKey !== undefined) {
        this.cache.delete(firstKey);
      }
    }
  }
}

/**
 * Serialize entries into deterministic binary format.
 * Format: u32 entryCount + for each entry: u32 length + bytes
 */
export function serializeEntries(entries: Uint8Array[]): Uint8Array {
  let totalSize = 4; // entry count
  for (const entry of entries) {
    totalSize += 4 + entry.length; // length prefix + data
  }

  const result = new Uint8Array(totalSize);
  const view = new DataView(result.buffer);
  let offset = 0;

  view.setUint32(offset, entries.length, true);
  offset += 4;

  for (const entry of entries) {
    view.setUint32(offset, entry.length, true);
    offset += 4;
    result.set(entry, offset);
    offset += entry.length;
  }

  return result;
}

/**
 * Deserialize entries from binary format.
 */
export function deserializeEntries(data: Uint8Array): Uint8Array[] {
  const view = new DataView(data.buffer, data.byteOffset);
  let offset = 0;

  const count = view.getUint32(offset, true);
  offset += 4;

  const entries: Uint8Array[] = [];
  for (let i = 0; i < count; i++) {
    const length = view.getUint32(offset, true);
    offset += 4;
    entries.push(data.slice(offset, offset + length));
    offset += length;
  }

  return entries;
}
