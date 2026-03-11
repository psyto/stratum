import type { DAProvider, DACommitment, EigenDAConfig } from './types';

/**
 * EigenDA provider.
 * Disperses blobs via the EigenDA disperser HTTP API.
 */
export class EigenDAProvider implements DAProvider {
  readonly name = 'eigenda';
  private config: EigenDAConfig;

  constructor(config: EigenDAConfig) {
    this.config = config;
  }

  async submit(data: Uint8Array, _namespace?: string): Promise<DACommitment> {
    const response = await fetch(`${this.config.disperserUrl}/v1/disperse`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        data: toBase64(data),
        quorum_ids: this.config.quorumIds,
      }),
    });

    if (!response.ok) {
      throw new Error(`EigenDA disperse failed: ${response.status} ${response.statusText}`);
    }

    const result = await response.json() as {
      request_id: string;
      status: string;
    };

    // Poll for confirmation
    const confirmed = await this.pollStatus(result.request_id);

    return {
      provider: this.name,
      blockHeight: confirmed.batchId,
      txHash: confirmed.batchHeaderHash,
      dataRoot: confirmed.blobCommitment,
      metadata: {
        requestId: result.request_id,
        blobIndex: confirmed.blobIndex,
        quorumIds: this.config.quorumIds,
      },
    };
  }

  async retrieve(commitment: DACommitment): Promise<Uint8Array | null> {
    const blobIndex = (commitment.metadata as { blobIndex?: number })?.blobIndex;
    if (blobIndex === undefined) return null;

    const response = await fetch(
      `${this.config.disperserUrl}/v1/retrieve?` +
      `batch_header_hash=${commitment.txHash}&blob_index=${blobIndex}`,
      { headers: { 'Content-Type': 'application/json' } },
    );

    if (!response.ok) return null;

    const result = await response.json() as { data?: string };
    if (!result.data) return null;

    return fromBase64(result.data);
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

  private async pollStatus(
    requestId: string,
    maxAttempts: number = 30,
    intervalMs: number = 2000,
  ): Promise<{ batchId: number; batchHeaderHash: string; blobCommitment: string; blobIndex: number }> {
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const response = await fetch(
        `${this.config.disperserUrl}/v1/status?request_id=${requestId}`,
        { headers: { 'Content-Type': 'application/json' } },
      );

      if (response.ok) {
        const result = await response.json() as {
          status: string;
          info?: {
            batch_id: number;
            batch_header_hash: string;
            blob_commitment: string;
            blob_index: number;
          };
        };

        if (result.status === 'CONFIRMED' && result.info) {
          return {
            batchId: result.info.batch_id,
            batchHeaderHash: result.info.batch_header_hash,
            blobCommitment: result.info.blob_commitment,
            blobIndex: result.info.blob_index,
          };
        }

        if (result.status === 'FAILED') {
          throw new Error(`EigenDA dispersal failed for request ${requestId}`);
        }
      }

      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }

    throw new Error(`EigenDA dispersal timed out after ${maxAttempts} attempts`);
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
