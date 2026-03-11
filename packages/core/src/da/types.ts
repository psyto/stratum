/** DA layer provider interface */
export interface DAProvider {
  readonly name: string;
  submit(data: Uint8Array, namespace?: string): Promise<DACommitment>;
  retrieve(commitment: DACommitment): Promise<Uint8Array | null>;
  verify(commitment: DACommitment, data: Uint8Array): Promise<boolean>;
}

/** Commitment returned after successful DA submission */
export interface DACommitment {
  provider: string;
  blockHeight: number;
  txHash: string;
  namespace?: string;
  dataRoot?: string;
  metadata?: Record<string, unknown>;
}

/** Configuration for DA provider factory */
export interface DAConfig {
  provider: 'celestia' | 'avail' | 'eigenda' | 'memory';
  celestia?: CelestiaConfig;
  avail?: AvailConfig;
  eigenda?: EigenDAConfig;
}

export interface CelestiaConfig {
  rpcUrl: string;
  authToken: string;
  namespace: string;
}

export interface AvailConfig {
  rpcUrl: string;
  appId: number;
}

export interface EigenDAConfig {
  disperserUrl: string;
  quorumIds: number[];
}
