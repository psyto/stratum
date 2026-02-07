import { describe, it, expect } from 'vitest';
import {
  Bitfield,
  splitIndex,
  globalIndex,
  chunksNeeded,
  BITS_PER_CHUNK,
} from './bitfield';

describe('Bitfield', () => {
  it('should set and get bits', () => {
    const bf = new Bitfield();

    expect(bf.isSet(0)).toBe(false);
    expect(bf.isSet(100)).toBe(false);
    expect(bf.isSet(2047)).toBe(false);

    bf.set(0);
    bf.set(100);
    bf.set(2047);

    expect(bf.isSet(0)).toBe(true);
    expect(bf.isSet(100)).toBe(true);
    expect(bf.isSet(2047)).toBe(true);
    expect(bf.isSet(1)).toBe(false);

    expect(bf.setCount).toBe(3);
  });

  it('should unset bits', () => {
    const bf = new Bitfield();

    bf.set(5);
    expect(bf.isSet(5)).toBe(true);
    expect(bf.setCount).toBe(1);

    bf.unset(5);
    expect(bf.isSet(5)).toBe(false);
    expect(bf.setCount).toBe(0);
  });

  it('should return correct value for set/unset operations', () => {
    const bf = new Bitfield();

    // First set returns true (newly set)
    expect(bf.set(10)).toBe(true);
    // Second set returns false (already set)
    expect(bf.set(10)).toBe(false);

    // First unset returns true (was set)
    expect(bf.unset(10)).toBe(true);
    // Second unset returns false (wasn't set)
    expect(bf.unset(10)).toBe(false);
  });

  it('should calculate fill rate', () => {
    const bf = new Bitfield(32); // 256 bits

    bf.set(0);
    bf.set(1);
    // 2/256 = 0.78125% ≈ 78 bps
    expect(bf.fillRateBps()).toBe(78);
  });

  it('should convert to/from bytes', () => {
    const bf = new Bitfield();
    bf.set(0);
    bf.set(8);
    bf.set(16);

    const bytes = bf.toBytes();
    const bf2 = Bitfield.fromBytes(bytes);

    expect(bf2.isSet(0)).toBe(true);
    expect(bf2.isSet(8)).toBe(true);
    expect(bf2.isSet(16)).toBe(true);
    expect(bf2.isSet(1)).toBe(false);
  });

  it('should get set/unset indices', () => {
    const bf = new Bitfield(4); // 32 bits for faster test

    bf.set(0);
    bf.set(5);
    bf.set(31);

    const setIndices = bf.getSetIndices();
    expect(setIndices).toEqual([0, 5, 31]);

    expect(bf.getUnsetIndices().length).toBe(32 - 3);
  });
});

describe('splitIndex and globalIndex', () => {
  it('should split indices correctly', () => {
    expect(splitIndex(0)).toEqual({ chunkIndex: 0, localIndex: 0 });
    expect(splitIndex(2047)).toEqual({ chunkIndex: 0, localIndex: 2047 });
    expect(splitIndex(2048)).toEqual({ chunkIndex: 1, localIndex: 0 });
    expect(splitIndex(4096)).toEqual({ chunkIndex: 2, localIndex: 0 });
  });

  it('should combine indices correctly', () => {
    expect(globalIndex(0, 0)).toBe(0);
    expect(globalIndex(0, 2047)).toBe(2047);
    expect(globalIndex(1, 0)).toBe(2048);
    expect(globalIndex(2, 0)).toBe(4096);
  });

  it('should roundtrip correctly', () => {
    for (const idx of [0, 100, 2047, 2048, 5000, 10000]) {
      const { chunkIndex, localIndex } = splitIndex(idx);
      expect(globalIndex(chunkIndex, localIndex)).toBe(idx);
    }
  });
});

describe('chunksNeeded', () => {
  it('should calculate chunks correctly', () => {
    expect(chunksNeeded(1)).toBe(1);
    expect(chunksNeeded(2048)).toBe(1);
    expect(chunksNeeded(2049)).toBe(2);
    expect(chunksNeeded(10000)).toBe(5);
  });
});
