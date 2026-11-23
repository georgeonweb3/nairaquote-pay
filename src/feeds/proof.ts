import { randomBytes } from "node:crypto";
import { toHex, type Hex } from "viem";
import type { Account } from "viem/accounts";

/**
 * EIP-712 TakerControl proof of control, per Textile's Proof-of-control doc.
 * Keyless callers sign this once per wallet + chain; a verified proof covers
 * firm requests for about 12 hours, and a 401 proof_of_control_required
 * tells you to sign again. Do not track the window client-side: send the
 * request unsigned first and sign only when asked.
 *
 * Exact schema (do not guess the fields):
 *   domain:  { name: "Textile Taker Control", version: "1", chainId }
 *   type:    TakerControl { taker: address, chainId: uint256,
 *                           nonce: bytes32, issuedAt: uint256 }
 *   message: taker = the wallet the request names
 *            chainId = the chain the request names
 *            nonce = 32 random bytes
 *            issuedAt = Unix milliseconds now (must be within 60 s of the
 *            server clock when the proof is presented)
 */
export interface TakerProof {
  nonce: Hex;
  issuedAt: number;
  signature: Hex;
}

export async function signTakerControl(
  account: Account,
  chainId: number,
): Promise<TakerProof> {
  const nonce = toHex(randomBytes(32));
  const issuedAt = Date.now();
  if (!account.signTypedData) {
    throw new Error("account cannot sign typed data (no signTypedData)");
  }
  const signature = await account.signTypedData({
    domain: { name: "Textile Taker Control", version: "1", chainId },
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
      chainId: BigInt(chainId),
      nonce,
      issuedAt: BigInt(issuedAt),
    },
  });
  return { nonce, issuedAt, signature };
}

/** A proof is only presentable inside its 60 s window. */
export function proofIsFresh(proof: TakerProof, nowMs = Date.now()): boolean {
  return Math.abs(nowMs - proof.issuedAt) <= 60_000;
}
