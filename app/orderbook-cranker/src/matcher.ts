import { Order, OrderSide, MatchResult } from './types';

/**
 * Price-time priority order matcher.
 *
 * Walks sorted bids (desc) and asks (asc) to find crosses.
 * On-chain only validates: merkle proofs correct, bitfield bits set,
 * price constraints hold (bid >= ask). The actual matching is off-chain.
 */
export class OrderMatcher {
  /**
   * Find all possible matches between bids and asks.
   * Returns matches in price-time priority order.
   */
  findMatches(bids: Order[], asks: Order[]): MatchResult[] {
    const matches: MatchResult[] = [];

    // Working copies with remaining amounts
    const workingBids = bids.map((b) => ({ ...b, remaining: b.amount }));
    const workingAsks = asks.map((a) => ({ ...a, remaining: a.amount }));

    let bidIdx = 0;
    let askIdx = 0;

    while (bidIdx < workingBids.length && askIdx < workingAsks.length) {
      const bid = workingBids[bidIdx];
      const ask = workingAsks[askIdx];

      // No cross: best bid < best ask
      if (bid.price < ask.price) {
        break;
      }

      // Skip expired orders
      const now = Math.floor(Date.now() / 1000);
      if (bid.remaining <= 0 || (bid.expiresAt > 0 && now > bid.expiresAt)) {
        bidIdx++;
        continue;
      }
      if (ask.remaining <= 0 || (ask.expiresAt > 0 && now > ask.expiresAt)) {
        askIdx++;
        continue;
      }

      // Match at the maker's price (resting order)
      // The first order to arrive is the maker
      const isBidMaker = bid.createdAt <= ask.createdAt;
      const fillPrice = isBidMaker ? bid.price : ask.price;
      const fillAmount = Math.min(bid.remaining, ask.remaining);

      if (fillAmount > 0) {
        matches.push({
          makerOrder: isBidMaker ? bid : ask,
          takerOrder: isBidMaker ? ask : bid,
          fillAmount,
          fillPrice,
        });

        bid.remaining -= fillAmount;
        ask.remaining -= fillAmount;
      }

      if (bid.remaining <= 0) bidIdx++;
      if (ask.remaining <= 0) askIdx++;
    }

    return matches;
  }

  /**
   * Get the current spread (best bid - best ask).
   * Negative means no cross, positive means executable spread.
   */
  getSpread(bids: Order[], asks: Order[]): number | null {
    if (bids.length === 0 || asks.length === 0) return null;
    return bids[0].price - asks[0].price;
  }

  /**
   * Get the mid-price between best bid and best ask
   */
  getMidPrice(bids: Order[], asks: Order[]): number | null {
    if (bids.length === 0 || asks.length === 0) return null;
    return (bids[0].price + asks[0].price) / 2;
  }

  /**
   * Get depth at a given price level
   */
  getDepthAtPrice(orders: Order[], price: number): number {
    return orders
      .filter((o) => o.price === price)
      .reduce((sum, o) => sum + o.amount, 0);
  }
}
