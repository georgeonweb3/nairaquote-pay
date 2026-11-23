import { describe, expect, it, vi } from "vitest";
import { effectiveRate, RfqClient } from "../src/feeds/rfq.js";

const USDT = "0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e";
const CNGN = "0xF6829D7393dAe24509eb1E52eE8e572e2E271a4f";
const TAKER = "0x77fBd73F31ab04334e7BF7a9027e08fc81686cE2";
const REACTOR = "0xa9AA0a64769cBed4d3B1Ceb4Df01CdE915C235b3";

type Json = Record<string, unknown>;
function res(status: number, body: Json) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    clone: () => ({ json: async () => body }),
  };
}

const previewBody = {
  data: {
    status: "preview",
    sellAmount: "10000000", // 10 USDT
    buyAmount: "14075684000", // 14,075.684 cNGN (6 decimals)
    feeAmount: "2000", // 0.002 USDT
    takerPays: "10000000",
    rateRay: "1407568400000000000000000000000",
    availableSellAmount: "50000000000",
    routing: {},
  },
};

const firmBody = {
  data: {
    rfqId: "rfq_test_1",
    claimToken: "rfqc_test_1",
    status: "quoted",
    quote: {
      sellAmount: "10000000",
      buyAmount: "14075684000",
      feeAmount: "2000",
      takerPays: "10000000",
      rateRay: "1407568400000000000000000000000",
      expiresAt: "2026-11-23T13:00:27.000Z",
      orderDeadline: "2026-11-23T13:00:30.000Z",
      latestOrderDeadline: "2026-11-23T13:00:30.000Z",
      reactor: REACTOR,
      taker: TAKER,
      encodedOrder: "0x1234",
      signature: "0x5678",
      orders: [],
    },
    transactions: {
      approval: { to: USDT, data: "0x095ea7b3", value: "0", chainId: 42220 },
      swap: { to: REACTOR, data: "0xabcdef", value: "0", chainId: 42220 },
    },
    routing: {},
  },
};

describe("RfqClient preview", () => {
  it("parses a live-shaped preview (sell 10 USDT -> buy cNGN)", async () => {
    const seen: Array<{ body?: string }> = [];
    const fetchImpl = vi.fn(async (_url: string, init: { body?: string }) => {
      seen.push({ body: init.body });
      return res(200, previewBody);
    });
    const client = new RfqClient({ fetchImpl: fetchImpl as unknown as typeof fetch });
    const p = await client.preview({
      chainId: 42220,
      sellToken: USDT as `0x${string}`,
      buyToken: CNGN as `0x${string}`,
      sellAmount: 10_000_000n,
    });
    expect(p.status).toBe("preview");
    if (p.status !== "preview") throw new Error("unreachable");
    expect(p.buyAmount).toBe(14_075_684_000n);
    expect(p.takerPays).toBe(10_000_000n);
    expect(p.feeAmount).toBe(2000n);
    expect(effectiveRate(p, 6, 6)).toBeCloseTo(1407.5684, 3);
    const body = JSON.parse(seen[0].body as string) as Json;
    expect(body.sellAmount).toBe("10000000");
    expect(body.chainId).toBe(42220);
    expect(body).not.toHaveProperty("taker"); // preview needs no taker, no proof
  });

  it("returns no_quote with its reason and retry hint, not an error", async () => {
    const fetchImpl = vi.fn(async () =>
      res(200, {
        data: { status: "no_quote", reason: "no_valid_quote", retryAfterMs: 5000 },
      }),
    );
    const client = new RfqClient({ fetchImpl: fetchImpl as unknown as typeof fetch });
    const p = await client.preview({
      chainId: 42220,
      sellToken: USDT as `0x${string}`,
      buyToken: CNGN as `0x${string}`,
      sellAmount: 10_000_000n,
    });
    expect(p.status).toBe("no_quote");
    if (p.status !== "no_quote") throw new Error("unreachable");
    expect(p.reason).toBe("no_valid_quote");
    expect(p.retryAfterMs).toBe(5000);
  });

  it("rejects a malformed preview instead of passing bad numbers on", async () => {
    const fetchImpl = vi.fn(async () =>
      res(200, { data: { status: "preview", sellAmount: "10000000" } }),
    );
    const client = new RfqClient({ fetchImpl: fetchImpl as unknown as typeof fetch });
    await expect(
      client.preview({
        chainId: 42220,
        sellToken: USDT as `0x${string}`,
        buyToken: CNGN as `0x${string}`,
        sellAmount: 10_000_000n,
      }),
    ).rejects.toThrow(/malformed preview/);
  });

  it("throws on an HTTP error instead of returning a fake price", async () => {
    const fetchImpl = vi.fn(async () => res(500, { error: "boom" }));
    const client = new RfqClient({ fetchImpl: fetchImpl as unknown as typeof fetch });
    await expect(
      client.preview({
        chainId: 42220,
        sellToken: USDT as `0x${string}`,
        buyToken: CNGN as `0x${string}`,
        sellAmount: 10_000_000n,
      }),
    ).rejects.toThrow(/rfq preview 500/);
  });
});

describe("RfqClient requestFirm", () => {
  it("parses a quoted firm response with claim token and both transactions", async () => {
    const fetchImpl = vi.fn(async () => res(200, firmBody));
    const client = new RfqClient({ fetchImpl: fetchImpl as unknown as typeof fetch });
    const f = await client.requestFirm({
      chainId: 42220,
      sellToken: USDT as `0x${string}`,
      buyToken: CNGN as `0x${string}`,
      sellAmount: 10_000_000n,
      taker: TAKER as `0x${string}`,
    });
    expect(f.status).toBe("quoted");
    if (f.status !== "quoted") throw new Error("unreachable");
    expect(f.rfqId).toBe("rfq_test_1");
    expect(f.claimToken).toBe("rfqc_test_1");
    expect(f.reactor).toBe(REACTOR);
    expect(f.takerPays).toBe(10_000_000n);
    expect(f.swap.to).toBe(REACTOR);
    expect(f.approval.to).toBe(USDT);
    expect(f.expiresAt).toBe("2026-11-23T13:00:27.000Z");
  });

  it("returns no_quote from a firm request instead of throwing", async () => {
    const fetchImpl = vi.fn(async () =>
      res(200, { data: { status: "no_quote", reason: "no_makers_online" } }),
    );
    const client = new RfqClient({ fetchImpl: fetchImpl as unknown as typeof fetch });
    const f = await client.requestFirm({
      chainId: 42220,
      sellToken: USDT as `0x${string}`,
      buyToken: CNGN as `0x${string}`,
      sellAmount: 10_000_000n,
      taker: TAKER as `0x${string}`,
    });
    expect(f.status).toBe("no_quote");
    if (f.status !== "no_quote") throw new Error("unreachable");
    expect(f.reason).toBe("no_makers_online");
  });

  it("signs TakerControl only after a 401 proof_of_control_required, then retries once", async () => {
    const calls: Array<Json> = [];
    const fetchImpl = vi.fn(async (_url: string, init: { body?: string }) => {
      calls.push(JSON.parse(init.body ?? "{}") as Json);
      if (calls.length === 1) {
        return res(401, { error: { details: { reason: "proof_of_control_required" } } });
      }
      return res(200, firmBody);
    });
    const signProof = vi.fn(async () => ({
      nonce: "0x0000000000000000000000000000000000000000000000000000000000000001" as `0x${string}`,
      issuedAt: Date.now(),
      signature: "0x1234" as `0x${string}`,
    }));
    const client = new RfqClient({ fetchImpl: fetchImpl as unknown as typeof fetch });
    const f = await client.requestFirm({
      chainId: 42220,
      sellToken: USDT as `0x${string}`,
      buyToken: CNGN as `0x${string}`,
      sellAmount: 10_000_000n,
      taker: TAKER as `0x${string}`,
      signProof,
    });
    expect(f.status).toBe("quoted");
    expect(signProof).toHaveBeenCalledTimes(1);
    expect(calls[0]).not.toHaveProperty("takerProof"); // first attempt unsigned
    expect(calls[1]).toHaveProperty("takerProof");
  });

  it("fails loud when a proof is needed but no signer was provided", async () => {
    const fetchImpl = vi.fn(async () =>
      res(401, { error: { details: { reason: "proof_of_control_required" } } }),
    );
    const client = new RfqClient({ fetchImpl: fetchImpl as unknown as typeof fetch });
    await expect(
      client.requestFirm({
        chainId: 42220,
        sellToken: USDT as `0x${string}`,
        buyToken: CNGN as `0x${string}`,
        sellAmount: 10_000_000n,
        taker: TAKER as `0x${string}`,
      }),
    ).rejects.toThrow(/no signer was provided/);
  });

  it("rejects a firm quote missing its transactions", async () => {
    const bad = {
      data: { ...firmBody.data, transactions: undefined },
    };
    const fetchImpl = vi.fn(async () => res(200, bad));
    const client = new RfqClient({ fetchImpl: fetchImpl as unknown as typeof fetch });
    await expect(
      client.requestFirm({
        chainId: 42220,
        sellToken: USDT as `0x${string}`,
        buyToken: CNGN as `0x${string}`,
        sellAmount: 10_000_000n,
        taker: TAKER as `0x${string}`,
      }),
    ).rejects.toThrow(/malformed firm quote/);
  });
});

describe("RfqClient submit/status", () => {
  it("submit sends the claim token header and returns the status", async () => {
    let headers: Record<string, string> = {};
    const fetchImpl = vi.fn(async (_url: string, init: { headers?: Record<string, string> }) => {
      headers = init.headers ?? {};
      return res(200, { data: { rfqId: "rfq_test_1", status: "submitted" } });
    });
    const client = new RfqClient({ fetchImpl: fetchImpl as unknown as typeof fetch });
    const s = await client.submit(
      "rfq_test_1",
      "rfqc_test_1",
      "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    );
    expect(headers["X-Rfq-Claim"]).toBe("rfqc_test_1");
    expect(s.status).toBe("submitted");
  });

  it("status reads an RFQ by id", async () => {
    const fetchImpl = vi.fn(async () =>
      res(200, { data: { rfqId: "rfq_test_1", status: "filled", txHash: "0xabc" } }),
    );
    const client = new RfqClient({ fetchImpl: fetchImpl as unknown as typeof fetch });
    const s = await client.status("rfq_test_1", "rfqc_test_1");
    expect(s.status).toBe("filled");
    expect(s.txHash).toBe("0xabc");
  });
});
