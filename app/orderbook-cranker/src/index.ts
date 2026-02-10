import { PublicKey } from '@solana/web3.js';
import { EpochCranker } from './cranker';
import type { CrankerConfig } from './types';

export { EpochCranker } from './cranker';
export { OrderStore } from './order-store';
export { OrderMatcher } from './matcher';
export { SettlementSubmitter } from './settlement';
export type { Order, OrderSide, MatchResult, EpochState, CrankerConfig } from './types';

/**
 * Create cranker configuration from environment variables
 */
function createConfig(): CrankerConfig {
  const keypairPath = process.env.CRANKER_KEYPAIR_PATH;
  if (!keypairPath) {
    throw new Error('CRANKER_KEYPAIR_PATH environment variable required');
  }

  const orderBookAddress = process.env.ORDER_BOOK_ADDRESS;
  if (!orderBookAddress) {
    throw new Error('ORDER_BOOK_ADDRESS environment variable required');
  }

  return {
    rpcUrl: process.env.RPC_URL || 'http://127.0.0.1:8899',
    keypairPath,
    orderBookAddress: new PublicKey(orderBookAddress),
    maxOrdersPerEpoch: parseInt(process.env.MAX_ORDERS_PER_EPOCH || '2048'),
    epochRotationIntervalSec: parseInt(
      process.env.EPOCH_ROTATION_INTERVAL_SEC || '60'
    ),
    matchIntervalMs: parseInt(process.env.MATCH_INTERVAL_MS || '1000'),
    settlementIntervalMs: parseInt(process.env.SETTLEMENT_INTERVAL_MS || '5000'),
  };
}

async function main() {
  const config = createConfig();
  const cranker = new EpochCranker(config);

  process.on('SIGINT', () => {
    cranker.stop();
    process.exit(0);
  });
  process.on('SIGTERM', () => {
    cranker.stop();
    process.exit(0);
  });

  await cranker.start();
}

// Only run if executed directly
if (require.main === module) {
  main().catch((err) => {
    console.error('Cranker failed:', err);
    process.exit(1);
  });
}
