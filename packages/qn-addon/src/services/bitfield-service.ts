import { Bitfield } from '@stratum/core';

export interface BitfieldStats {
  setCount: number;
  capacity: number;
  fillRateBps: number;
  isFull: boolean;
  isEmpty: boolean;
}

/**
 * Create a new empty bitfield of the given size.
 */
export function create(size: number): Uint8Array {
  const bf = new Bitfield(size);
  return new Uint8Array(bf.toBytes());
}

/**
 * Load a bitfield from bytes and return basic stats.
 */
export function fromBytes(bytes: Uint8Array): { setCount: number; capacity: number; fillRateBps: number } {
  const bf = Bitfield.fromBytes(bytes);
  const capacity = bf.capacity;
  const setCount = bf.setCount;
  const fillRateBps = capacity > 0 ? Math.round((setCount / capacity) * 10000) : 0;
  return { setCount, capacity, fillRateBps };
}

/**
 * Set a bit at the given index and return updated bytes + whether it was newly set.
 */
export function set(bytes: Uint8Array, index: number): { bytes: Uint8Array; wasNewlySet: boolean } {
  const bf = Bitfield.fromBytes(bytes);
  const wasPreviouslySet = bf.check(index);
  bf.set(index);
  return {
    bytes: new Uint8Array(bf.toBytes()),
    wasNewlySet: !wasPreviouslySet,
  };
}

/**
 * Check if a bit is set at the given index.
 */
export function check(bytes: Uint8Array, index: number): boolean {
  const bf = Bitfield.fromBytes(bytes);
  return bf.check(index);
}

/**
 * Get full stats for a bitfield.
 */
export function stats(bytes: Uint8Array): BitfieldStats {
  const bf = Bitfield.fromBytes(bytes);
  const capacity = bf.capacity;
  const setCount = bf.setCount;
  const fillRateBps = capacity > 0 ? Math.round((setCount / capacity) * 10000) : 0;
  return {
    setCount,
    capacity,
    fillRateBps,
    isFull: setCount === capacity,
    isEmpty: setCount === 0,
  };
}
