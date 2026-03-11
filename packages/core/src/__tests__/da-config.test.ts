import { describe, it, expect } from 'vitest';
import { loadDAConfigFromEnv, validateDAConfig } from '../da/config';

describe('loadDAConfigFromEnv', () => {
  it('defaults to memory provider', () => {
    const config = loadDAConfigFromEnv({});
    expect(config.provider).toBe('memory');
  });

  it('loads celestia config from env', () => {
    const config = loadDAConfigFromEnv({
      DA_PROVIDER: 'celestia',
      CELESTIA_RPC_URL: 'http://localhost:26658',
      CELESTIA_AUTH_TOKEN: 'test-token',
      CELESTIA_NAMESPACE: 'stratum',
    });
    expect(config.provider).toBe('celestia');
    expect(config.celestia!.rpcUrl).toBe('http://localhost:26658');
    expect(config.celestia!.authToken).toBe('test-token');
    expect(config.celestia!.namespace).toBe('stratum');
  });

  it('throws when celestia rpcUrl is missing', () => {
    expect(() =>
      loadDAConfigFromEnv({
        DA_PROVIDER: 'celestia',
        CELESTIA_AUTH_TOKEN: 'token',
        CELESTIA_NAMESPACE: 'ns',
      })
    ).toThrow('CELESTIA_RPC_URL is required');
  });

  it('throws when celestia authToken is missing', () => {
    expect(() =>
      loadDAConfigFromEnv({
        DA_PROVIDER: 'celestia',
        CELESTIA_RPC_URL: 'http://localhost',
        CELESTIA_NAMESPACE: 'ns',
      })
    ).toThrow('CELESTIA_AUTH_TOKEN is required');
  });

  it('loads avail config from env', () => {
    const config = loadDAConfigFromEnv({
      DA_PROVIDER: 'avail',
      AVAIL_RPC_URL: 'http://localhost:7000',
      AVAIL_APP_ID: '42',
    });
    expect(config.provider).toBe('avail');
    expect(config.avail!.rpcUrl).toBe('http://localhost:7000');
    expect(config.avail!.appId).toBe(42);
  });

  it('throws for non-numeric avail app ID', () => {
    expect(() =>
      loadDAConfigFromEnv({
        DA_PROVIDER: 'avail',
        AVAIL_RPC_URL: 'http://localhost',
        AVAIL_APP_ID: 'abc',
      })
    ).toThrow('AVAIL_APP_ID must be a number');
  });

  it('loads eigenda config from env', () => {
    const config = loadDAConfigFromEnv({
      DA_PROVIDER: 'eigenda',
      EIGENDA_DISPERSER_URL: 'http://disperser:8080',
      EIGENDA_QUORUM_IDS: '0,1,2',
    });
    expect(config.provider).toBe('eigenda');
    expect(config.eigenda!.disperserUrl).toBe('http://disperser:8080');
    expect(config.eigenda!.quorumIds).toEqual([0, 1, 2]);
  });

  it('eigenda defaults quorum IDs to [0]', () => {
    const config = loadDAConfigFromEnv({
      DA_PROVIDER: 'eigenda',
      EIGENDA_DISPERSER_URL: 'http://disperser:8080',
    });
    expect(config.eigenda!.quorumIds).toEqual([0]);
  });

  it('throws for unknown provider', () => {
    expect(() =>
      loadDAConfigFromEnv({ DA_PROVIDER: 'unknown' })
    ).toThrow('Unknown DA_PROVIDER: unknown');
  });
});

describe('validateDAConfig', () => {
  it('validates memory config (always valid)', () => {
    expect(() => validateDAConfig({ provider: 'memory' })).not.toThrow();
  });

  it('validates complete celestia config', () => {
    expect(() =>
      validateDAConfig({
        provider: 'celestia',
        celestia: {
          rpcUrl: 'http://localhost',
          authToken: 'token',
          namespace: 'ns',
        },
      })
    ).not.toThrow();
  });

  it('rejects celestia without config object', () => {
    expect(() => validateDAConfig({ provider: 'celestia' })).toThrow(
      'Celestia config required'
    );
  });

  it('validates complete avail config', () => {
    expect(() =>
      validateDAConfig({
        provider: 'avail',
        avail: { rpcUrl: 'http://localhost', appId: 1 },
      })
    ).not.toThrow();
  });

  it('rejects avail without config object', () => {
    expect(() => validateDAConfig({ provider: 'avail' })).toThrow(
      'Avail config required'
    );
  });

  it('validates complete eigenda config', () => {
    expect(() =>
      validateDAConfig({
        provider: 'eigenda',
        eigenda: { disperserUrl: 'http://disperser', quorumIds: [0] },
      })
    ).not.toThrow();
  });

  it('rejects eigenda without config object', () => {
    expect(() => validateDAConfig({ provider: 'eigenda' })).toThrow(
      'EigenDA config required'
    );
  });
});
