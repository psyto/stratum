import { describe, it, expect } from 'vitest';
import { MemoryProvider } from '../da/memory';
import { PersistentArchiveStore, serializeEntries, deserializeEntries } from '../da/archive-store';

const enc = (s: string) => new TextEncoder().encode(s);

describe('serializeEntries / deserializeEntries', () => {
  it('roundtrips empty array', () => {
    const serialized = serializeEntries([]);
    const result = deserializeEntries(serialized);
    expect(result).toEqual([]);
  });

  it('roundtrips single entry', () => {
    const entries = [enc('hello world')];
    const serialized = serializeEntries(entries);
    const result = deserializeEntries(serialized);
    expect(result.length).toBe(1);
    expect(result[0]).toEqual(entries[0]);
  });

  it('roundtrips multiple entries of different sizes', () => {
    const entries = [enc('short'), enc('a longer entry here'), new Uint8Array(0), new Uint8Array(256).fill(0xab)];
    const serialized = serializeEntries(entries);
    const result = deserializeEntries(serialized);
    expect(result.length).toBe(4);
    for (let i = 0; i < entries.length; i++) {
      expect(result[i]).toEqual(entries[i]);
    }
  });

  it('serialized format has correct header', () => {
    const entries = [enc('a'), enc('bb')];
    const serialized = serializeEntries(entries);
    const view = new DataView(serialized.buffer);
    // First 4 bytes: count = 2
    expect(view.getUint32(0, true)).toBe(2);
    // Next 4 bytes: length of first entry = 1
    expect(view.getUint32(4, true)).toBe(1);
  });
});

describe('MemoryProvider', () => {
  it('submit and retrieve roundtrips', async () => {
    const provider = new MemoryProvider();
    const data = enc('test blob data');
    const commitment = await provider.submit(data, 'test-ns');

    expect(commitment.provider).toBe('memory');
    expect(commitment.blockHeight).toBe(1);
    expect(commitment.namespace).toBe('test-ns');

    const retrieved = await provider.retrieve(commitment);
    expect(retrieved).toEqual(data);
  });

  it('retrieve returns null for unknown commitment', async () => {
    const provider = new MemoryProvider();
    const result = await provider.retrieve({
      provider: 'memory',
      blockHeight: 999,
      txHash: 'nonexistent',
    });
    expect(result).toBeNull();
  });

  it('verify returns true for matching data', async () => {
    const provider = new MemoryProvider();
    const data = enc('verify me');
    const commitment = await provider.submit(data);
    expect(await provider.verify(commitment, data)).toBe(true);
  });

  it('verify returns false for mismatched data', async () => {
    const provider = new MemoryProvider();
    const data = enc('original');
    const commitment = await provider.submit(data);
    expect(await provider.verify(commitment, enc('tampered'))).toBe(false);
  });

  it('verify returns false for unknown commitment', async () => {
    const provider = new MemoryProvider();
    const result = await provider.verify(
      { provider: 'memory', blockHeight: 1, txHash: 'fake' },
      enc('data'),
    );
    expect(result).toBe(false);
  });

  it('increments block height per submission', async () => {
    const provider = new MemoryProvider();
    const c1 = await provider.submit(enc('a'));
    const c2 = await provider.submit(enc('b'));
    const c3 = await provider.submit(enc('c'));
    expect(c1.blockHeight).toBe(1);
    expect(c2.blockHeight).toBe(2);
    expect(c3.blockHeight).toBe(3);
  });

  it('size tracks stored blobs', async () => {
    const provider = new MemoryProvider();
    expect(provider.size).toBe(0);
    await provider.submit(enc('a'));
    expect(provider.size).toBe(1);
    await provider.submit(enc('b'));
    expect(provider.size).toBe(2);
  });

  it('clear resets state', async () => {
    const provider = new MemoryProvider();
    await provider.submit(enc('a'));
    provider.clear();
    expect(provider.size).toBe(0);
  });
});

describe('PersistentArchiveStore', () => {
  it('store and retrieve roundtrips', async () => {
    const provider = new MemoryProvider();
    const store = new PersistentArchiveStore(provider);

    const entries = [enc('entry1'), enc('entry2'), enc('entry3')];
    const commitment = await store.store('archive-1', entries);

    expect(commitment.provider).toBe('memory');

    const retrieved = await store.retrieve('archive-1');
    expect(retrieved).not.toBeNull();
    expect(retrieved!.length).toBe(3);
    for (let i = 0; i < entries.length; i++) {
      expect(retrieved![i]).toEqual(entries[i]);
    }
  });

  it('retrieve returns null for unknown archive', async () => {
    const provider = new MemoryProvider();
    const store = new PersistentArchiveStore(provider);
    expect(await store.retrieve('unknown')).toBeNull();
  });

  it('serves from cache on second retrieve', async () => {
    const provider = new MemoryProvider();
    const store = new PersistentArchiveStore(provider);

    const entries = [enc('cached')];
    await store.store('cached-archive', entries);

    // Clear the DA provider to prove cache is used
    provider.clear();

    const retrieved = await store.retrieve('cached-archive');
    expect(retrieved).not.toBeNull();
    expect(retrieved![0]).toEqual(entries[0]);
  });

  it('falls back to DA when cache is evicted', async () => {
    const provider = new MemoryProvider();
    const store = new PersistentArchiveStore(provider, 2); // tiny cache

    // Fill cache beyond capacity
    await store.store('a1', [enc('data1')]);
    await store.store('a2', [enc('data2')]);
    await store.store('a3', [enc('data3')]); // evicts a1 from cache

    // a1 should still be retrievable from DA
    const retrieved = await store.retrieve('a1');
    expect(retrieved).not.toBeNull();
    expect(retrieved![0]).toEqual(enc('data1'));
  });

  it('verify checks against DA commitment', async () => {
    const provider = new MemoryProvider();
    const store = new PersistentArchiveStore(provider);

    const entries = [enc('verifiable')];
    await store.store('v1', entries);

    expect(await store.verify('v1', entries)).toBe(true);
    expect(await store.verify('v1', [enc('wrong')])).toBe(false);
  });

  it('verify returns false for unknown archive', async () => {
    const provider = new MemoryProvider();
    const store = new PersistentArchiveStore(provider);
    expect(await store.verify('unknown', [enc('data')])).toBe(false);
  });

  it('getCommitment returns stored commitment', async () => {
    const provider = new MemoryProvider();
    const store = new PersistentArchiveStore(provider);

    const commitment = await store.store('c1', [enc('data')]);
    expect(store.getCommitment('c1')).toEqual(commitment);
    expect(store.getCommitment('unknown')).toBeUndefined();
  });

  it('has checks both cache and commitments', async () => {
    const provider = new MemoryProvider();
    const store = new PersistentArchiveStore(provider);

    expect(store.has('x')).toBe(false);
    await store.store('x', [enc('data')]);
    expect(store.has('x')).toBe(true);
  });

  it('keys returns all known archive IDs', async () => {
    const provider = new MemoryProvider();
    const store = new PersistentArchiveStore(provider);

    await store.store('k1', [enc('a')]);
    await store.store('k2', [enc('b')]);
    const keys = store.keys();
    expect(keys).toContain('k1');
    expect(keys).toContain('k2');
  });

  it('retrieveByCommitment works with external commitment', async () => {
    const provider = new MemoryProvider();
    const store = new PersistentArchiveStore(provider);

    // Store via provider directly
    const entries = [enc('external')];
    const serialized = serializeEntries(entries);
    const commitment = await provider.submit(serialized, 'ext');

    // Retrieve using external commitment
    const retrieved = await store.retrieveByCommitment('ext-archive', commitment);
    expect(retrieved).not.toBeNull();
    expect(retrieved![0]).toEqual(entries[0]);
  });
});
