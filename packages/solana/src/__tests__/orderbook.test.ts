import { describe, it, expect } from 'vitest';
import { PublicKey } from '@solana/web3.js';
import { OrderBookClient, OrderSide } from '../orderbook';
import type { OrderLeaf } from '../orderbook';

// Use a fake program ID (no live connection needed for PDA/serialization tests)
const PROGRAM_ID = new PublicKey('11111111111111111111111111111111');
// @ts-expect-error — null connection is fine for offline tests
const client = new OrderBookClient(null, PROGRAM_ID);

describe('OrderBookClient PDA derivation', () => {
  const authority = PublicKey.unique();
  const baseMint = PublicKey.unique();
  const quoteMint = PublicKey.unique();

  it('derives deterministic order book PDA', () => {
    const [pda1, bump1] = client.deriveOrderBookPda(authority, baseMint, quoteMint);
    const [pda2, bump2] = client.deriveOrderBookPda(authority, baseMint, quoteMint);

    expect(pda1.equals(pda2)).toBe(true);
    expect(bump1).toBe(bump2);
  });

  it('different mints produce different PDAs', () => {
    const otherMint = PublicKey.unique();
    const [pda1] = client.deriveOrderBookPda(authority, baseMint, quoteMint);
    const [pda2] = client.deriveOrderBookPda(authority, otherMint, quoteMint);

    expect(pda1.equals(pda2)).toBe(false);
  });

  it('derives deterministic epoch PDA', () => {
    const orderBook = PublicKey.unique();
    const [pda1] = client.deriveEpochPda(orderBook, 0);
    const [pda2] = client.deriveEpochPda(orderBook, 0);

    expect(pda1.equals(pda2)).toBe(true);
  });

  it('different epoch indices produce different PDAs', () => {
    const orderBook = PublicKey.unique();
    const [pda0] = client.deriveEpochPda(orderBook, 0);
    const [pda1] = client.deriveEpochPda(orderBook, 1);

    expect(pda0.equals(pda1)).toBe(false);
  });

  it('derives deterministic order chunk PDA', () => {
    const epoch = PublicKey.unique();
    const [pda1] = client.deriveOrderChunkPda(epoch, 0);
    const [pda2] = client.deriveOrderChunkPda(epoch, 0);

    expect(pda1.equals(pda2)).toBe(true);
  });

  it('different chunk indices produce different PDAs', () => {
    const epoch = PublicKey.unique();
    const [pda0] = client.deriveOrderChunkPda(epoch, 0);
    const [pda1] = client.deriveOrderChunkPda(epoch, 1);

    expect(pda0.equals(pda1)).toBe(false);
  });

  it('derives deterministic settlement PDA', () => {
    const orderBook = PublicKey.unique();
    const [pda1] = client.deriveSettlementPda(orderBook, 1, 2);
    const [pda2] = client.deriveSettlementPda(orderBook, 1, 2);

    expect(pda1.equals(pda2)).toBe(true);
  });

  it('different order IDs produce different settlement PDAs', () => {
    const orderBook = PublicKey.unique();
    const [pda1] = client.deriveSettlementPda(orderBook, 1, 2);
    const [pda2] = client.deriveSettlementPda(orderBook, 2, 1);

    expect(pda1.equals(pda2)).toBe(false);
  });

  it('derives vault PDAs', () => {
    const orderBook = PublicKey.unique();
    const [basePda] = client.deriveBaseVaultPda(orderBook);
    const [quotePda] = client.deriveQuoteVaultPda(orderBook);

    expect(basePda).toBeInstanceOf(PublicKey);
    expect(quotePda).toBeInstanceOf(PublicKey);
    expect(basePda.equals(quotePda)).toBe(false);
  });
});

describe('OrderBookClient serialization', () => {
  const maker = PublicKey.unique();

  function makeOrder(overrides: Partial<OrderLeaf> = {}): OrderLeaf {
    return {
      maker,
      orderId: 1,
      side: OrderSide.Bid,
      price: 1000,
      amount: 500,
      epochIndex: 0,
      orderIndex: 0,
      createdAt: 1700000000,
      expiresAt: 1700003600,
      ...overrides,
    };
  }

  it('serializes to correct byte length', () => {
    const buf = client.serializeOrderLeaf(makeOrder());
    // 32 (maker) + 8 (orderId) + 1 (side) + 8 (price) + 8 (amount)
    // + 4 (epochIndex) + 4 (orderIndex) + 8 (createdAt) + 8 (expiresAt) = 81
    expect(buf.length).toBe(81);
  });

  it('encodes maker pubkey at offset 0', () => {
    const order = makeOrder();
    const buf = client.serializeOrderLeaf(order);
    expect(buf.subarray(0, 32).equals(maker.toBuffer())).toBe(true);
  });

  it('encodes orderId as u64 LE at offset 32', () => {
    const buf = client.serializeOrderLeaf(makeOrder({ orderId: 42 }));
    expect(buf.readBigUInt64LE(32)).toBe(42n);
  });

  it('encodes side at offset 40', () => {
    const bidBuf = client.serializeOrderLeaf(makeOrder({ side: OrderSide.Bid }));
    const askBuf = client.serializeOrderLeaf(makeOrder({ side: OrderSide.Ask }));
    expect(bidBuf[40]).toBe(0);
    expect(askBuf[40]).toBe(1);
  });

  it('encodes price as u64 LE at offset 41', () => {
    const buf = client.serializeOrderLeaf(makeOrder({ price: 99999 }));
    expect(buf.readBigUInt64LE(41)).toBe(99999n);
  });

  it('encodes amount as u64 LE at offset 49', () => {
    const buf = client.serializeOrderLeaf(makeOrder({ amount: 12345 }));
    expect(buf.readBigUInt64LE(49)).toBe(12345n);
  });

  it('encodes epochIndex as u32 LE at offset 57', () => {
    const buf = client.serializeOrderLeaf(makeOrder({ epochIndex: 7 }));
    expect(buf.readUInt32LE(57)).toBe(7);
  });

  it('encodes orderIndex as u32 LE at offset 61', () => {
    const buf = client.serializeOrderLeaf(makeOrder({ orderIndex: 15 }));
    expect(buf.readUInt32LE(61)).toBe(15);
  });

  it('encodes timestamps at offsets 65 and 73', () => {
    const buf = client.serializeOrderLeaf(
      makeOrder({ createdAt: 1700000000, expiresAt: 1700003600 }),
    );
    expect(buf.readBigInt64LE(65)).toBe(1700000000n);
    expect(buf.readBigInt64LE(73)).toBe(1700003600n);
  });

  it('different orders produce different serializations', () => {
    const buf1 = client.serializeOrderLeaf(makeOrder({ price: 100 }));
    const buf2 = client.serializeOrderLeaf(makeOrder({ price: 200 }));
    expect(buf1.equals(buf2)).toBe(false);
  });
});

describe('OrderBookClient hashing', () => {
  const maker = PublicKey.unique();

  function makeOrder(overrides: Partial<OrderLeaf> = {}): OrderLeaf {
    return {
      maker,
      orderId: 1,
      side: OrderSide.Bid,
      price: 1000,
      amount: 500,
      epochIndex: 0,
      orderIndex: 0,
      createdAt: 1700000000,
      expiresAt: 1700003600,
      ...overrides,
    };
  }

  it('hashes order leaf to 32 bytes', () => {
    const hash = client.hashOrderLeaf(makeOrder());
    expect(hash).toBeInstanceOf(Uint8Array);
    expect(hash.length).toBe(32);
  });

  it('hash is deterministic', () => {
    const order = makeOrder();
    const hash1 = client.hashOrderLeaf(order);
    const hash2 = client.hashOrderLeaf(order);
    expect(Buffer.from(hash1).equals(Buffer.from(hash2))).toBe(true);
  });

  it('different orders produce different hashes', () => {
    const hash1 = client.hashOrderLeaf(makeOrder({ price: 100 }));
    const hash2 = client.hashOrderLeaf(makeOrder({ price: 200 }));
    expect(Buffer.from(hash1).equals(Buffer.from(hash2))).toBe(false);
  });
});

describe('OrderBookClient merkle tree', () => {
  const maker = PublicKey.unique();

  function makeOrder(overrides: Partial<OrderLeaf> = {}): OrderLeaf {
    return {
      maker,
      orderId: 1,
      side: OrderSide.Bid,
      price: 1000,
      amount: 500,
      epochIndex: 0,
      orderIndex: 0,
      createdAt: 1700000000,
      expiresAt: 1700003600,
      ...overrides,
    };
  }

  it('builds merkle tree from orders', () => {
    const orders = [
      makeOrder({ orderId: 1, price: 100 }),
      makeOrder({ orderId: 2, price: 200 }),
      makeOrder({ orderId: 3, price: 300 }),
      makeOrder({ orderId: 4, price: 400 }),
    ];

    const tree = client.buildOrderMerkleTree(orders);
    expect(tree.root).toBeInstanceOf(Uint8Array);
    expect(tree.root.length).toBe(32);
  });

  it('tree root is deterministic', () => {
    const orders = [
      makeOrder({ orderId: 1 }),
      makeOrder({ orderId: 2 }),
    ];

    const tree1 = client.buildOrderMerkleTree(orders);
    const tree2 = client.buildOrderMerkleTree(orders);
    expect(Buffer.from(tree1.root).equals(Buffer.from(tree2.root))).toBe(true);
  });

  it('generates valid proofs', () => {
    const orders = [
      makeOrder({ orderId: 1, price: 100 }),
      makeOrder({ orderId: 2, price: 200 }),
      makeOrder({ orderId: 3, price: 300 }),
      makeOrder({ orderId: 4, price: 400 }),
    ];

    const tree = client.buildOrderMerkleTree(orders);

    for (let i = 0; i < orders.length; i++) {
      const proof = tree.getProof(i);
      expect(proof.length).toBeGreaterThan(0);
      expect(proof[0]).toBeInstanceOf(Uint8Array);
      expect(proof[0].length).toBe(32);
    }
  });

  it('different order sets produce different roots', () => {
    const orders1 = [makeOrder({ orderId: 1, price: 100 })];
    const orders2 = [makeOrder({ orderId: 1, price: 999 })];

    const tree1 = client.buildOrderMerkleTree(orders1);
    const tree2 = client.buildOrderMerkleTree(orders2);
    expect(Buffer.from(tree1.root).equals(Buffer.from(tree2.root))).toBe(false);
  });
});

describe('OrderBookClient chunk helpers', () => {
  it('getChunkForOrder splits correctly', () => {
    const { chunkIndex, localIndex } = client.getChunkForOrder(0);
    expect(chunkIndex).toBe(0);
    expect(localIndex).toBe(0);
  });

  it('getChunkForOrder handles cross-chunk boundary', () => {
    // BITS_PER_CHUNK = 2048
    const { chunkIndex, localIndex } = client.getChunkForOrder(2048);
    expect(chunkIndex).toBe(1);
    expect(localIndex).toBe(0);
  });

  it('getChunkForOrder handles mid-chunk index', () => {
    const { chunkIndex, localIndex } = client.getChunkForOrder(2049);
    expect(chunkIndex).toBe(1);
    expect(localIndex).toBe(1);
  });

  it('chunksNeeded calculates correctly', () => {
    expect(client.chunksNeeded(1)).toBe(1);
    expect(client.chunksNeeded(2048)).toBe(1);
    expect(client.chunksNeeded(2049)).toBe(2);
    expect(client.chunksNeeded(4096)).toBe(2);
    expect(client.chunksNeeded(4097)).toBe(3);
  });
});
