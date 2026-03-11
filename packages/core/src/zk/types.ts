/** ZK proof system identifiers */
export enum ZKProofSystem {
  Groth16 = 'groth16',
  PlonK = 'plonk',
  STARK = 'stark',
}

/** A zero-knowledge proof */
export interface ZKProof {
  proofBytes: Uint8Array;
  publicInputs: Uint8Array[];
  system: ZKProofSystem;
}

/** Compiled circuit artifacts */
export interface ZKArtifact {
  circuitId: string;
  provingKey: Uint8Array;
  verificationKey: Uint8Array;
}

/** Witness for proof generation */
export interface ZKWitness {
  publicInputs: Uint8Array[];
  privateInputs: Uint8Array[];
}

/** Abstract circuit interface */
export interface ZKCircuit {
  readonly circuitId: string;
  compile(): Promise<ZKArtifact>;
  generateProof(witness: ZKWitness): Promise<ZKProof>;
  verify(proof: ZKProof): Promise<boolean>;
}

/** On-chain verifier interface */
export interface ZKVerifier {
  verify(proof: ZKProof, publicInputs: Uint8Array[]): Promise<boolean>;
}

/** Backend for actual proof computation — pluggable */
export interface ZKBackend {
  readonly name: string;
  compile(circuitId: string, constraints: Uint8Array): Promise<ZKArtifact>;
  prove(artifact: ZKArtifact, witness: ZKWitness): Promise<ZKProof>;
  verify(artifact: ZKArtifact, proof: ZKProof): Promise<boolean>;
}

/** State operation for transition circuits */
export interface StateOp {
  type: 'insert' | 'update' | 'delete';
  index: number;
  oldValue?: Uint8Array;
  newValue?: Uint8Array;
}
