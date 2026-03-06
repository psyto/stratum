/**
 * @stratum/core — Order Matching Example
 *
 * Demonstrates price-time priority order matching for an off-chain
 * order book. The matcher finds crosses between bids and asks,
 * filling at the maker's price.
 *
 * Use case: DEX order books, RFQ systems, dark pool matching,
 * off-chain cranker settlement.
 */
import { OrderMatcher } from '@stratum/core';
import type { Matchable } from '@stratum/core';

// ---------------------------------------------------------------------------
// 1. Define some orders
// ---------------------------------------------------------------------------

interface Order extends Matchable {
  id: string;
  price: number;
  amount: number;
  createdAt: number;
  expiresAt: number;
}

const now = Math.floor(Date.now() / 1000);
const oneHour = 3600;

// Bids sorted descending by price, then ascending by time
const bids: Order[] = [
  { id: 'bid-1', price: 105, amount: 10, createdAt: now - 60, expiresAt: now + oneHour },
  { id: 'bid-2', price: 103, amount: 5,  createdAt: now - 30, expiresAt: now + oneHour },
  { id: 'bid-3', price: 100, amount: 20, createdAt: now - 10, expiresAt: now + oneHour },
];

// Asks sorted ascending by price, then ascending by time
const asks: Order[] = [
  { id: 'ask-1', price: 101, amount: 8,  createdAt: now - 45, expiresAt: now + oneHour },
  { id: 'ask-2', price: 104, amount: 12, createdAt: now - 20, expiresAt: now + oneHour },
  { id: 'ask-3', price: 110, amount: 15, createdAt: now - 5,  expiresAt: now + oneHour },
];

// ---------------------------------------------------------------------------
// 2. Find matches
// ---------------------------------------------------------------------------

const matcher = new OrderMatcher();
const matches = matcher.findMatches(bids, asks);

console.log(`Found ${matches.length} match(es):\n`);
for (const m of matches) {
  const maker = m.makerOrder as Order;
  const taker = m.takerOrder as Order;
  console.log(
    `  ${maker.id} <-> ${taker.id}: ${m.fillAmount} @ ${m.fillPrice}`,
  );
}

// ---------------------------------------------------------------------------
// 3. Market metrics
// ---------------------------------------------------------------------------

const spread = matcher.getSpread(bids, asks);
const midPrice = matcher.getMidPrice(bids, asks);

console.log(`\nBest bid: ${bids[0].price}`);
console.log(`Best ask: ${asks[0].price}`);
console.log(`Spread: ${spread}`);
console.log(`Mid price: ${midPrice}`);

// ---------------------------------------------------------------------------
// 4. Depth at a price level
// ---------------------------------------------------------------------------

const depthAt103 = matcher.getDepthAtPrice(bids, 103);
console.log(`\nDepth at bid 103: ${depthAt103}`);
