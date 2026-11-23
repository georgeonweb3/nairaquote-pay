import { describe, expect, it } from "vitest";
import { approvalNeeded, takeDecision, type TakeCheck } from "../src/engine/taker.js";

const base: TakeCheck = {
  firmRate: 1410,
  fairMid: 1380,
  refRate: 1370,
  feeUsd: 0.002,
  gasUsd: 0.05,
  sizeUsdt: 10,
  minEdgeUsd: 0.05,
  refDivergenceHaltBps: 1000,
  maxTradeUsd: 500,
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
  expirySafetyMs: 5_000,
};

describe("takeDecision", () => {
  it("takes when the firm edge beats fee + gas + min edge", () => {
    const d = takeDecision(base);
    expect(d.take).toBe(true);
    expect(d.reason).toContain("take:");
    // Edge (1410-1380)/1380 = 217.4 bps; cost (0.102/10) = 102 bps.
    expect(d.edgeBps).toBeCloseTo(217.39, 1);
    expect(d.costBps).toBeCloseTo(102, 1);
  });

  it("halts when the firm price is worse than fair value", () => {
    const d = takeDecision({ ...base, firmRate: 1370 });
    expect(d.take).toBe(false);
    expect(d.reason).toContain("halt:");
  });

  it("halts when the edge is positive but smaller than the cost", () => {
    // Firm 1381 vs mid 1380: edge 7.2 bps, cost 102 bps.
    const d = takeDecision({ ...base, firmRate: 1381 });
    expect(d.take).toBe(false);
    expect(d.reason).toContain("does not beat");
  });

  it("halts when the mid diverges sharply from the reference", () => {
    const d = takeDecision({ ...base, refRate: 1100 }); // ~25% away
    expect(d.take).toBe(false);
    expect(d.reason).toContain("divergence");
  });

  it("still takes when the reference is a typical ~1% away", () => {
    const d = takeDecision({ ...base, refRate: 1366 });
    expect(d.take).toBe(true);
  });

  it("halts when the quote is too close to expiry to broadcast safely", () => {
    const d = takeDecision({
      ...base,
      expiresAt: new Date(Date.now() + 2_000).toISOString(),
    });
    expect(d.take).toBe(false);
    expect(d.reason).toContain("expiry");
  });

  it("halts below the $1 RFQ floor and above the max trade", () => {
    expect(takeDecision({ ...base, sizeUsdt: 0.5 }).take).toBe(false);
    expect(takeDecision({ ...base, sizeUsdt: 501 }).take).toBe(false);
    // At $1 the fixed costs (fee + gas + min edge = $0.102) are 1020 bps of
    // the size, dwarfing a 217 bps edge — the halt is correct, not a bug.
    expect(takeDecision({ ...base, sizeUsdt: 1 }).take).toBe(false);
    expect(takeDecision({ ...base, sizeUsdt: 1 }).reason).toContain("does not beat");
  });

  it("halts on an unusable firm rate or mid", () => {
    expect(takeDecision({ ...base, firmRate: 0 }).take).toBe(false);
    expect(takeDecision({ ...base, fairMid: Number.NaN }).take).toBe(false);
  });
});

describe("approvalNeeded", () => {
  it("approves exactly when the allowance is short, reset first only when positive", () => {
    expect(approvalNeeded(0n, 10_000_000n)).toEqual({ needed: true, resetFirst: false });
    expect(approvalNeeded(5_000_000n, 10_000_000n)).toEqual({ needed: true, resetFirst: true });
    expect(approvalNeeded(10_000_000n, 10_000_000n)).toEqual({ needed: false, resetFirst: false });
    expect(approvalNeeded(99_000_000n, 10_000_000n)).toEqual({ needed: false, resetFirst: false });
  });
});
