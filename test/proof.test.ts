import { describe, expect, it } from "vitest";
import { recoverTypedDataAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { proofIsFresh, signTakerControl } from "../src/feeds/proof.js";

// Throwaway test key only. Never a real wallet.
const TEST_KEY =
  "0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef" as const;

describe("TakerControl proof", () => {
  it("signs the exact Textile schema and recovers to the taker", async () => {
    const account = privateKeyToAccount(TEST_KEY);
    const proof = await signTakerControl(account, 42220);
    expect(proof.nonce).toMatch(/^0x[0-9a-f]{64}$/);
    expect(typeof proof.issuedAt).toBe("number");
    expect(proof.signature).toMatch(/^0x[0-9a-f]+$/);
    const recovered = await recoverTypedDataAddress({
      domain: { name: "Textile Taker Control", version: "1", chainId: 42220 },
      types: {
        TakerControl: [
          { name: "taker", type: "address" },
          { name: "chainId", type: "uint256" },
          { name: "nonce", type: "bytes32" },
          { name: "issuedAt", type: "uint256" },
        ],
      },
      primaryType: "TakerControl",
      message: {
        taker: account.address,
        chainId: 42220n,
        nonce: proof.nonce,
        issuedAt: BigInt(proof.issuedAt),
      },
      signature: proof.signature,
    });
    expect(recovered.toLowerCase()).toBe(account.address.toLowerCase());
  });

  it("a fresh proof is fresh, a 61-second-old proof is not", () => {
    const proof = { nonce: "0x00" as `0x${string}`, issuedAt: Date.now(), signature: "0x00" as `0x${string}` };
    expect(proofIsFresh(proof)).toBe(true);
    expect(proofIsFresh({ ...proof, issuedAt: Date.now() - 61_000 })).toBe(false);
    expect(proofIsFresh({ ...proof, issuedAt: Date.now() + 61_000 })).toBe(false);
    expect(proofIsFresh({ ...proof, issuedAt: Date.now() - 59_000 })).toBe(true);
  });
});
