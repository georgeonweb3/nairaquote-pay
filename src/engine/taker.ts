/**
 * Taker decision rule — pure, unit-tested. Decides whether a firm Textile
 * quote is worth taking, and whether an approval is needed.
 *
 * The rule, from the taker fallback plan: take only if the firm price beats
 * the engine's fair value by more than fee + gas + MIN_EDGE. The agent
 * converts once, in the direction the job needs — it never round-trips, so
 * the edge here is a guard against a bad fill, not a trading signal.
 */
export interface TakeCheck {
  firmRate: number; // NGN per USDT the firm quote pays
  fairMid: number; // engine mid, NGN per USDT
  refRate?: number; // independent NGN/USD reference
  feeUsd: number; // protocol fee, USD
  gasUsd: number; // estimated gas for the conversion leg, USD
  sizeUsdt: number;
  minEdgeUsd: number;
  refDivergenceHaltBps: number;
  maxTradeUsd: number;
  expiresAt: string; // ISO accept cutoff
  expirySafetyMs: number;
  nowMs?: number;
}

export interface TakeDecision {
  take: boolean;
  reason: string;
  edgeBps: number;
  costBps: number;
}

export function takeDecision(c: TakeCheck): TakeDecision {
  const nowMs = c.nowMs ?? Date.now();
  if (!(c.sizeUsdt >= 1)) {
    return { take: false, reason: `halt: size ${c.sizeUsdt} USDT below the $1 RFQ floor`, edgeBps: 0, costBps: 0 };
  }
  if (c.sizeUsdt > c.maxTradeUsd) {
    return { take: false, reason: `halt: size ${c.sizeUsdt} USDT exceeds max trade ${c.maxTradeUsd} USDT`, edgeBps: 0, costBps: 0 };
  }
  if (!(c.firmRate > 0) || !(c.fairMid > 0)) {
    return { take: false, reason: "halt: unusable firm rate or fair mid", edgeBps: 0, costBps: 0 };
  }
  if (c.refRate) {
    const divBps = (Math.abs(c.fairMid - c.refRate) / c.refRate) * 1e4;
    if (divBps > c.refDivergenceHaltBps) {
      return { take: false, reason: `halt: mid/reference divergence ${divBps.toFixed(0)} bps exceeds ${c.refDivergenceHaltBps} bps`, edgeBps: 0, costBps: 0 };
    }
  }
  const expiresMs = Date.parse(c.expiresAt);
  if (!Number.isFinite(expiresMs) || nowMs + c.expirySafetyMs >= expiresMs) {
    return { take: false, reason: "halt: firm quote too close to expiry to broadcast safely", edgeBps: 0, costBps: 0 };
  }
  const edgeBps = ((c.firmRate - c.fairMid) / c.fairMid) * 1e4;
  const costBps = ((c.feeUsd + c.gasUsd + c.minEdgeUsd) / c.sizeUsdt) * 1e4;
  if (edgeBps <= costBps) {
    return {
      take: false,
      reason: `halt: firm edge ${edgeBps.toFixed(2)} bps does not beat fee + gas + min edge ${costBps.toFixed(2)} bps (fee $${c.feeUsd.toFixed(4)} + gas $${c.gasUsd.toFixed(4)} + min $${c.minEdgeUsd.toFixed(2)} on $${c.sizeUsdt})`,
      edgeBps,
      costBps,
    };
  }
  return {
    take: true,
    reason: `take: firm edge ${edgeBps.toFixed(2)} bps beats fee + gas + min edge ${costBps.toFixed(2)} bps`,
    edgeBps,
    costBps,
  };
}

/**
 * Exact-amount approval logic. Approve exactly takerPays to the reactor,
 * never unlimited. USDT-style tokens reject approve(nonzero -> nonzero),
 * so when a standing allowance is positive but short, reset it to zero
 * first. Skip the approval entirely when the allowance already covers it.
 */
export function approvalNeeded(
  allowance: bigint,
  required: bigint,
): { needed: boolean; resetFirst: boolean } {
  const needed = allowance < required;
  return { needed, resetFirst: needed && allowance > 0n };
}
