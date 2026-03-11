import type { DAProvider, DACommitment, AvailConfig } from './types';

/**
 * Avail DA provider.
 * Submits data via the Avail light client HTTP API.
 */
export class AvailProvider implements DAProvider {
  readonly name = 'avail';
  private config: AvailConfig;

  constructor(config: AvailConfig) {
    this.config = config;
  }

  async submit(data: Uint8Array, _namespace?: string): Promise<DACommitment> {
    const response = await fetch(`${this.config.rpcUrl}/v2/submit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        data: toHex(data),
        app_id: this.config.appId,
      }),
    });

    if (!response.ok) {
      throw new Error(`Avail submit failed: ${response.status} ${response.statusText}`);
    }

    const result = await response.json() as {
      block_number: number;
      block_hash: string;
      hash: string;
      index: number;
    };

    return {
      provider: this.name,
      blockHeight: result.block_number,
      txHash: result.hash,
      dataRoot: result.block_hash,
      metadata: {
        appId: this.config.appId,
        txIndex: result.index,
      },
    };
  }

  async retrieve(commitment: DACommitment): Promise<Uint8Array | null> {
    const txIndex = (commitment.metadata as { txIndex?: number })?.txIndex;
    if (txIndex === undefined) return null;

    const response = await fetch(
      `${this.config.rpcUrl}/v2/blocks/${commitment.blockHeight}/data?fields=data`,
      { headers: { 'Content-Type': 'application/json' } },
    );

    if (!response.ok) return null;

    const result = await response.json() as {
      data_transactions?: { data: string; tx_index: number }[];
    };

    if (!result.data_transactions) return null;

    const tx = result.data_transactions.find((t) => t.tx_index === txIndex);
    if (!tx) return null;

    return fromHex(tx.data);
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

function toHex(data: Uint8Array): string {
  let hex = '0x';
  for (let i = 0; i < data.length; i++) {
    hex += data[i].toString(16).padStart(2, '0');
  }
  return hex;
}

function fromHex(hex: string): Uint8Array {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex;
  const bytes = new Uint8Array(clean.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}
