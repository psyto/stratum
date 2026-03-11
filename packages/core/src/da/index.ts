export * from './types';
export { MemoryProvider } from './memory';
export { CelestiaProvider } from './celestia';
export { AvailProvider } from './avail';
export { EigenDAProvider } from './eigenda';
export {
  PersistentArchiveStore,
  serializeEntries,
  deserializeEntries,
} from './archive-store';
export { loadDAConfigFromEnv, validateDAConfig } from './config';

import type { DAProvider, DAConfig } from './types';
import { MemoryProvider } from './memory';
import { CelestiaProvider } from './celestia';
import { AvailProvider } from './avail';
import { EigenDAProvider } from './eigenda';

/** Factory: create a DA provider from config */
export function createDAProvider(config: DAConfig): DAProvider {
  switch (config.provider) {
    case 'celestia':
      if (!config.celestia) throw new Error('Celestia config required');
      return new CelestiaProvider(config.celestia);
    case 'avail':
      if (!config.avail) throw new Error('Avail config required');
      return new AvailProvider(config.avail);
    case 'eigenda':
      if (!config.eigenda) throw new Error('EigenDA config required');
      return new EigenDAProvider(config.eigenda);
    case 'memory':
      return new MemoryProvider();
    default:
      throw new Error(`Unknown DA provider: ${config.provider}`);
  }
}
