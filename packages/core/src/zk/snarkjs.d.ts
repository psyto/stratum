declare module 'snarkjs' {
  export namespace groth16 {
    function fullProve(
      input: Record<string, unknown>,
      wasmFile: Uint8Array | string,
      zkeyFile: string,
    ): Promise<{
      proof: {
        pi_a: string[];
        pi_b: string[][];
        pi_c: string[];
      };
      publicSignals: string[];
    }>;

    function verify(
      vk: Record<string, unknown>,
      publicSignals: string[],
      proof: Record<string, unknown>,
    ): Promise<boolean>;
  }

  export namespace zKey {
    function exportVerificationKey(zkeyPath: string): Promise<Record<string, unknown>>;
  }
}
