import type { DAConfig, CelestiaConfig, AvailConfig, EigenDAConfig } from './types';

/**
 * Load DA provider configuration from environment variables.
 *
 * Environment variables:
 *   DA_PROVIDER          - Provider name: 'celestia' | 'avail' | 'eigenda' | 'memory'
 *
 * Celestia:
 *   CELESTIA_RPC_URL     - Celestia node RPC endpoint
 *   CELESTIA_AUTH_TOKEN  - Authentication token for Celestia node
 *   CELESTIA_NAMESPACE   - Namespace for blob submissions
 *
 * Avail:
 *   AVAIL_RPC_URL        - Avail light client RPC endpoint
 *   AVAIL_APP_ID         - Application ID for Avail submissions
 *
 * EigenDA:
 *   EIGENDA_DISPERSER_URL - EigenDA disperser gRPC endpoint
 *   EIGENDA_QUORUM_IDS    - Comma-separated quorum IDs (e.g. "0,1")
 */
export function loadDAConfigFromEnv(env: Record<string, string | undefined> = process.env): DAConfig {
  const provider = (env.DA_PROVIDER ?? 'memory') as DAConfig['provider'];

  const config: DAConfig = { provider };

  switch (provider) {
    case 'celestia': {
      const rpcUrl = env.CELESTIA_RPC_URL;
      const authToken = env.CELESTIA_AUTH_TOKEN;
      const namespace = env.CELESTIA_NAMESPACE;

      if (!rpcUrl) throw new Error('CELESTIA_RPC_URL is required');
      if (!authToken) throw new Error('CELESTIA_AUTH_TOKEN is required');
      if (!namespace) throw new Error('CELESTIA_NAMESPACE is required');

      config.celestia = { rpcUrl, authToken, namespace };
      break;
    }

    case 'avail': {
      const rpcUrl = env.AVAIL_RPC_URL;
      const appIdStr = env.AVAIL_APP_ID;

      if (!rpcUrl) throw new Error('AVAIL_RPC_URL is required');
      if (!appIdStr) throw new Error('AVAIL_APP_ID is required');

      const appId = parseInt(appIdStr, 10);
      if (isNaN(appId)) throw new Error('AVAIL_APP_ID must be a number');

      config.avail = { rpcUrl, appId };
      break;
    }

    case 'eigenda': {
      const disperserUrl = env.EIGENDA_DISPERSER_URL;
      const quorumStr = env.EIGENDA_QUORUM_IDS;

      if (!disperserUrl) throw new Error('EIGENDA_DISPERSER_URL is required');

      const quorumIds = quorumStr
        ? quorumStr.split(',').map((s) => parseInt(s.trim(), 10))
        : [0];

      config.eigenda = { disperserUrl, quorumIds };
      break;
    }

    case 'memory':
      break;

    default:
      throw new Error(`Unknown DA_PROVIDER: ${provider}`);
  }

  return config;
}

/**
 * Validate a DA config object has all required fields.
 * Throws descriptive errors for missing fields.
 */
export function validateDAConfig(config: DAConfig): void {
  switch (config.provider) {
    case 'celestia':
      if (!config.celestia) throw new Error('Celestia config required');
      if (!config.celestia.rpcUrl) throw new Error('Celestia rpcUrl required');
      if (!config.celestia.authToken) throw new Error('Celestia authToken required');
      if (!config.celestia.namespace) throw new Error('Celestia namespace required');
      break;
    case 'avail':
      if (!config.avail) throw new Error('Avail config required');
      if (!config.avail.rpcUrl) throw new Error('Avail rpcUrl required');
      if (config.avail.appId == null) throw new Error('Avail appId required');
      break;
    case 'eigenda':
      if (!config.eigenda) throw new Error('EigenDA config required');
      if (!config.eigenda.disperserUrl) throw new Error('EigenDA disperserUrl required');
      break;
    case 'memory':
      break;
    default:
      throw new Error(`Unknown DA provider: ${config.provider}`);
  }
}
