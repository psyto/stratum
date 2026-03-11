import { describe, it, expect } from 'vitest';
import { PublicKey } from '@solana/web3.js';
import { deriveBitfieldRegistryPDA, deriveBitfieldChunkPDA } from '../pda';

const PROGRAM_ID = new PublicKey('11111111111111111111111111111111');

describe('deriveBitfieldRegistryPDA', () => {
  it('derives deterministic PDA from authority', () => {
    const authority = PublicKey.unique();
    const [pda, bump] = deriveBitfieldRegistryPDA(authority, PROGRAM_ID);

    expect(pda).toBeInstanceOf(PublicKey);
    expect(bump).toBeGreaterThanOrEqual(0);
    expect(bump).toBeLessThanOrEqual(255);
  });

  it('produces same PDA for same inputs', () => {
    const authority = PublicKey.unique();
    const [pda1] = deriveBitfieldRegistryPDA(authority, PROGRAM_ID);
    const [pda2] = deriveBitfieldRegistryPDA(authority, PROGRAM_ID);

    expect(pda1.equals(pda2)).toBe(true);
  });

  it('produces different PDAs for different authorities', () => {
    const auth1 = PublicKey.unique();
    const auth2 = PublicKey.unique();
    const [pda1] = deriveBitfieldRegistryPDA(auth1, PROGRAM_ID);
    const [pda2] = deriveBitfieldRegistryPDA(auth2, PROGRAM_ID);

    expect(pda1.equals(pda2)).toBe(false);
  });

  it('produces different PDAs for different programs', () => {
    const authority = PublicKey.unique();
    const program2 = PublicKey.unique();
    const [pda1] = deriveBitfieldRegistryPDA(authority, PROGRAM_ID);
    const [pda2] = deriveBitfieldRegistryPDA(authority, program2);

    expect(pda1.equals(pda2)).toBe(false);
  });
});

describe('deriveBitfieldChunkPDA', () => {
  it('derives deterministic PDA from registry and chunk index', () => {
    const registry = PublicKey.unique();
    const [pda, bump] = deriveBitfieldChunkPDA(registry, 0, PROGRAM_ID);

    expect(pda).toBeInstanceOf(PublicKey);
    expect(bump).toBeGreaterThanOrEqual(0);
    expect(bump).toBeLessThanOrEqual(255);
  });

  it('produces different PDAs for different chunk indices', () => {
    const registry = PublicKey.unique();
    const [pda0] = deriveBitfieldChunkPDA(registry, 0, PROGRAM_ID);
    const [pda1] = deriveBitfieldChunkPDA(registry, 1, PROGRAM_ID);
    const [pda2] = deriveBitfieldChunkPDA(registry, 2, PROGRAM_ID);

    expect(pda0.equals(pda1)).toBe(false);
    expect(pda1.equals(pda2)).toBe(false);
    expect(pda0.equals(pda2)).toBe(false);
  });

  it('produces same PDA for same inputs', () => {
    const registry = PublicKey.unique();
    const [pda1] = deriveBitfieldChunkPDA(registry, 5, PROGRAM_ID);
    const [pda2] = deriveBitfieldChunkPDA(registry, 5, PROGRAM_ID);

    expect(pda1.equals(pda2)).toBe(true);
  });
});
