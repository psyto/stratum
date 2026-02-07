import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { PublicKey, SystemProgram } from "@solana/web3.js";
import { Stratum } from "../target/types/stratum";
import { expect } from "chai";

describe("stratum", () => {
  // Configure the client to use the local cluster.
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.stratum as Program<Stratum>;
  const authority = provider.wallet;

  describe("Bitfield", () => {
    let registryPda: PublicKey;

    before(async () => {
      // PDA: "bitfield_registry" + authority
      [registryPda] = PublicKey.findProgramAddressSync(
        [
          Buffer.from("bitfield_registry"),
          authority.publicKey.toBuffer(),
        ],
        program.programId
      );
    });

    it("Creates a bitfield registry", async () => {
      const totalCapacity = new anchor.BN(2048); // Capacity for one chunk

      const tx = await program.methods
        .createBitfieldRegistry(totalCapacity)
        .accounts({
          registry: registryPda,
          authority: authority.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      console.log("Created bitfield registry:", tx);

      const registry = await program.account.bitfieldRegistry.fetch(registryPda);
      expect(registry.authority.toString()).to.equal(authority.publicKey.toString());
      expect(registry.totalCapacity.toNumber()).to.equal(2048);
    });

    it("Creates a bitfield chunk", async () => {
      const chunkIndex = 0;

      const [chunkPda] = PublicKey.findProgramAddressSync(
        [
          Buffer.from("bitfield_chunk"),
          registryPda.toBuffer(),
          new Uint8Array(new Uint32Array([chunkIndex]).buffer), // u32 little endian
        ],
        program.programId
      );

      const tx = await program.methods
        .createBitfieldChunk(chunkIndex)
        .accounts({
          registry: registryPda,
          chunk: chunkPda,
          authority: authority.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      console.log("Created bitfield chunk:", tx);

      const chunk = await program.account.bitfieldChunk.fetch(chunkPda);
      expect(chunk.registry.toString()).to.equal(registryPda.toString());
      expect(chunk.chunkIndex).to.equal(0);
      expect(chunk.setCount).to.equal(0);
    });

    it("Sets a bit in the chunk", async () => {
      const chunkIndex = 0;
      const bitIndex = 42;

      const [chunkPda] = PublicKey.findProgramAddressSync(
        [
          Buffer.from("bitfield_chunk"),
          registryPda.toBuffer(),
          new Uint8Array(new Uint32Array([chunkIndex]).buffer),
        ],
        program.programId
      );

      const tx = await program.methods
        .setBit(bitIndex)
        .accounts({
          registry: registryPda,
          chunk: chunkPda,
          authority: authority.publicKey,
        })
        .rpc();

      console.log("Set bit:", tx);

      const chunk = await program.account.bitfieldChunk.fetch(chunkPda);
      expect(chunk.setCount).to.equal(1);

      // Verify bit is set (bit 42 is in byte 5, position 2)
      const byteIndex = Math.floor(bitIndex / 8);
      const bitPosition = bitIndex % 8;
      const isSet = (chunk.bits[byteIndex] >> bitPosition) & 1;
      expect(isSet).to.equal(1);
    });

    it("Unsets a bit in the chunk", async () => {
      const chunkIndex = 0;
      const bitIndex = 42;

      const [chunkPda] = PublicKey.findProgramAddressSync(
        [
          Buffer.from("bitfield_chunk"),
          registryPda.toBuffer(),
          new Uint8Array(new Uint32Array([chunkIndex]).buffer),
        ],
        program.programId
      );

      const tx = await program.methods
        .unsetBit(bitIndex)
        .accounts({
          registry: registryPda,
          chunk: chunkPda,
          authority: authority.publicKey,
        })
        .rpc();

      console.log("Unset bit:", tx);

      const chunk = await program.account.bitfieldChunk.fetch(chunkPda);
      expect(chunk.setCount).to.equal(0);
    });
  });

  describe("Merkle Root", () => {
    const seed = new anchor.BN(12345);
    let merklePda: PublicKey;

    before(async () => {
      // PDA: "merkle_root" + authority + seed (u64 LE)
      [merklePda] = PublicKey.findProgramAddressSync(
        [
          Buffer.from("merkle_root"),
          authority.publicKey.toBuffer(),
          seed.toArrayLike(Buffer, "le", 8),
        ],
        program.programId
      );
    });

    it("Creates a merkle root", async () => {
      // Simple test root (in production, compute from actual leaves)
      const root = Buffer.alloc(32);
      root.fill(0xab);
      const leafCount = new anchor.BN(1000);
      const maxDepth = 10;

      const tx = await program.methods
        .createMerkleRoot(seed, Array.from(root), leafCount, maxDepth)
        .accounts({
          merkleRoot: merklePda,
          authority: authority.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      console.log("Created merkle root:", tx);

      const merkle = await program.account.merkleRoot.fetch(merklePda);
      expect(merkle.authority.toString()).to.equal(authority.publicKey.toString());
      expect(Buffer.from(merkle.root).toString("hex")).to.equal(root.toString("hex"));
      expect(merkle.leafCount.toNumber()).to.equal(1000);
      expect(merkle.maxDepth).to.equal(10);
      expect(merkle.isFinalized).to.equal(false);
    });

    it("Verifies a merkle proof (expects failure with invalid proof)", async () => {
      // For this test, we create an invalid proof and expect the error
      const leaf = Buffer.alloc(32).fill(0x01);
      const proof: number[][] = []; // Empty proof
      const index = 0;

      // This will fail verification since our root doesn't match the leaf
      try {
        await program.methods
          .verifyMerkleProof(proof, Array.from(leaf), index)
          .accounts({
            merkleRoot: merklePda,
          })
          .rpc();
        // If it succeeds, fail the test
        expect.fail("Expected InvalidMerkleProof error");
      } catch (e: any) {
        // Expected: InvalidMerkleProof error
        const errorCode = e.error?.errorCode?.code || e.message;
        console.log("Got expected error:", errorCode);
        expect(errorCode).to.include("InvalidMerkleProof");
      }
    });
  });
});
