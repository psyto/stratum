import { describe, it, expect } from 'vitest';
import { solanaHash } from '../hash';

describe('solanaHash', () => {
  it('returns 32-byte output', () => {
    const result = solanaHash(new Uint8Array([1, 2, 3]));
    expect(result).toBeInstanceOf(Uint8Array);
    expect(result.length).toBe(32);
  });

  it('is deterministic', () => {
    const data = new TextEncoder().encode('hello world');
    const hash1 = solanaHash(data);
    const hash2 = solanaHash(data);

    expect(Buffer.from(hash1).equals(Buffer.from(hash2))).toBe(true);
  });

  it('produces different hashes for different inputs', () => {
    const hash1 = solanaHash(new TextEncoder().encode('hello'));
    const hash2 = solanaHash(new TextEncoder().encode('world'));

    expect(Buffer.from(hash1).equals(Buffer.from(hash2))).toBe(false);
  });

  it('handles empty input', () => {
    const result = solanaHash(new Uint8Array(0));
    expect(result.length).toBe(32);
    // Empty input should still produce a non-zero hash (from initial state mixing)
    expect(result.some((b) => b !== 0)).toBe(true);
  });

  it('handles single byte', () => {
    const hash0 = solanaHash(new Uint8Array([0]));
    const hash1 = solanaHash(new Uint8Array([1]));
    const hash255 = solanaHash(new Uint8Array([255]));

    expect(hash0.length).toBe(32);
    expect(Buffer.from(hash0).equals(Buffer.from(hash1))).toBe(false);
    expect(Buffer.from(hash1).equals(Buffer.from(hash255))).toBe(false);
  });

  it('handles large input', () => {
    const large = new Uint8Array(10000);
    for (let i = 0; i < large.length; i++) {
      large[i] = i % 256;
    }
    const result = solanaHash(large);
    expect(result.length).toBe(32);
  });

  it('is sensitive to byte order', () => {
    const hash1 = solanaHash(new Uint8Array([1, 2]));
    const hash2 = solanaHash(new Uint8Array([2, 1]));

    expect(Buffer.from(hash1).equals(Buffer.from(hash2))).toBe(false);
  });

  it('conforms to HashFunction interface', () => {
    // HashFunction = (data: Uint8Array) => Uint8Array
    const fn: (data: Uint8Array) => Uint8Array = solanaHash;
    const result = fn(new Uint8Array([42]));
    expect(result.length).toBe(32);
  });
});
