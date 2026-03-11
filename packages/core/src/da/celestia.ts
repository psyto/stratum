import type { DAProvider, DACommitment, CelestiaConfig } from './types';

/**
 * Celestia DA provider.
 * Submits blobs as Pay For Blob (PFB) transactions via the Celestia Node API.
 */
export class CelestiaProvider implements DAProvider {
  readonly name = 'celestia';
  private config: CelestiaConfig;

  constructor(config: CelestiaConfig) {
    this.config = config;
  }

  async submit(data: Uint8Array, namespace?: string): Promise<DACommitment> {
    const ns = namespace ?? this.config.namespace;
    const blob = toBase64(data);

    const response = await fetch(`${this.config.rpcUrl}/blob.Submit`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.config.authToken}`,
      },
      body: JSON.stringify({
        id: 1,
        jsonrpc: '2.0',
        method: 'blob.Submit',
        params: [
          [{ namespace: ns, data: blob, share_version: 0 }],
          0.002, // gas price
        ],
      }),
    });

    if (!response.ok) {
      throw new Error(`Celestia submit failed: ${response.status} ${response.statusText}`);
    }

    const result = await response.json() as { result?: number; error?: { message: string } };

    if (result.error) {
      throw new Error(`Celestia submit error: ${result.error.message}`);
    }

    const blockHeight = result.result ?? 0;

    // Get the block to obtain data root and tx hash
    const blockResponse = await fetch(`${this.config.rpcUrl}/header.GetByHeight`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.config.authToken}`,
      },
      body: JSON.stringify({
        id: 1,
        jsonrpc: '2.0',
        method: 'header.GetByHeight',
        params: [blockHeight],
      }),
    });

    const blockResult = await blockResponse.json() as {
      result?: { dah?: { row_roots: string[] }; commit?: { block_id?: { hash: string } } };
    };

    return {
      provider: this.name,
      blockHeight,
      txHash: blockResult.result?.commit?.block_id?.hash ?? '',
      namespace: ns,
      dataRoot: blockResult.result?.dah?.row_roots?.[0] ?? '',
      metadata: { shareVersion: 0 },
    };
  }

  async retrieve(commitment: DACommitment): Promise<Uint8Array | null> {
    const ns = commitment.namespace ?? this.config.namespace;

    const response = await fetch(`${this.config.rpcUrl}/blob.GetAll`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.config.authToken}`,
      },
      body: JSON.stringify({
        id: 1,
        jsonrpc: '2.0',
        method: 'blob.GetAll',
        params: [commitment.blockHeight, [ns]],
      }),
    });

    if (!response.ok) return null;

    const result = await response.json() as {
      result?: { data: string }[];
    };

    if (!result.result || result.result.length === 0) return null;

    return fromBase64(result.result[0].data);
  }

  async verify(commitment: DACommitment, data: Uint8Array): Promise<boolean> {
    const retrieved = await this.retrieve(commitment);
    if (!retrieved) return false;
    if (retrieved.length !== data.length) return false;
    for (let i = 0; i < retrieved.length; i++) {
      if (retrieved[i] !== data[i]) return false;
    }
    return true;
  }
}

function toBase64(data: Uint8Array): string {
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(data).toString('base64');
  }
  let binary = '';
  for (let i = 0; i < data.length; i++) {
    binary += String.fromCharCode(data[i]);
  }
  return btoa(binary);
}

function fromBase64(str: string): Uint8Array {
  if (typeof Buffer !== 'undefined') {
    return new Uint8Array(Buffer.from(str, 'base64'));
  }
  const binary = atob(str);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}
