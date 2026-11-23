import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/feeds/textile.js", () => ({
  textileTicker: async () => ({
    ticker_id: "USDT_NGN",
    bid: 1380,
    ask: 1380.5,
    last: 1380.5,
    baseVolume24h: 1000,
  }),
}));
vi.mock("../src/feeds/reference.js", () => ({
  referenceNgnPerUsd: async () => ({ rate: 1370, source: "test" }),
}));
vi.mock("../src/feeds/balances.js", () => ({
  agentBalances: async () => ({ celo: 1, cngn: 0, usdt: 0 }),
}));

const PAYEE = "0x1111111111111111111111111111111111111111";

afterEach(() => {
  delete process.env.PAYEE_ADDRESS;
  vi.resetModules();
});

const fakePreviewRfq = {
  preview: vi.fn(async () => ({
    status: "preview" as const,
    sellAmount: 10_000_000n,
    buyAmount: 14_075_684_000n,
    feeAmount: 2000n,
    takerPays: 10_000_000n,
    rateRay: 1407568400000000000000000000000n,
  })),
};

describe("planPayout", () => {
  it("blocks the plan when PAYEE_ADDRESS is empty — and never previews", async () => {
    const { planPayout } = await import("../src/engine/payout.js");
    const plan = await planPayout({ rfq: fakePreviewRfq as never });
    expect(plan.blockedReason).toContain("PAYEE_ADDRESS");
    expect(fakePreviewRfq.preview).not.toHaveBeenCalled();
  });

  it("builds a dry-run plan from the live-shaped preview", async () => {
    process.env.PAYEE_ADDRESS = PAYEE;
    const { planPayout } = await import("../src/engine/payout.js");
    const plan = await planPayout({ rfq: fakePreviewRfq as never });
    expect(plan.blockedReason).toBeNull();
    expect(plan.mode).toBe("dry");
    expect(plan.payee).toBe(PAYEE);
    expect(plan.previewRate).toBeCloseTo(1407.5684, 3);
    expect(plan.fairMid).toBeCloseTo(1380.25, 2);
    expect(plan.refRate).toBe(1370);
  });
});

describe("runPayout", () => {
  it("dry mode logs the plan and signs/sends nothing", async () => {
    process.env.PAYEE_ADDRESS = PAYEE;
    const { planPayout, runPayout } = await import("../src/engine/payout.js");
    const plan = await planPayout({ rfq: fakePreviewRfq as never });
    const result = await runPayout(plan, { rfq: fakePreviewRfq as never });
    expect(result.outcome).toBe("dry");
    expect(result.reason).toContain("dry-run");
    expect(result.reason).toContain("Nothing signed");
    expect(result.reason).toContain("take:");
    expect(result.swapTxHash).toBeUndefined();
    expect(result.payoutTxHash).toBeUndefined();
  });

  it("returns blocked without doing anything for a blocked plan", async () => {
    const { runPayout } = await import("../src/engine/payout.js");
    const result = await runPayout({
      mode: "dry",
      sizeUsdt: 10,
      sellAmount: 10_000_000n,
      payee: "",
      fairMid: Number.NaN,
      refRate: Number.NaN,
      preview: null,
      previewRate: null,
      blockedReason: "blocked: PAYEE_ADDRESS not configured",
      inventorySource: "unknown",
      walletUsdt: 0,
      walletCelo: 0,
    });
    expect(result.outcome).toBe("blocked");
    expect(result.reason).toContain("PAYEE_ADDRESS");
  });
});
