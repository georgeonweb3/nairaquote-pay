import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Side } from "./quote.js";

/**
 * Payout ledger. Every answered quote, every conversion fill, and every
 * cNGN payout to the payee is recorded here (JSONL on disk), so volume and
 * receipts are computed from records, never estimated after the fact.
 * In dry-run the tick can record its indicative quotes with NQ_TICK_LOG set;
 * fills and payouts only ever come from real executions, so the dashboard
 * says "no payouts yet" until the agent actually pays someone.
 */
export interface QuoteRecord {
  type: "quote";
  at: string;
  side: Side;
  sizeUsdt: number;
  price: number; // NGN per USDT quoted
  mid: number; // NGN per USDT at quote time
  reason?: string;
  inventorySource?: string;
}

export interface FillRecord {
  type: "fill";
  at: string;
  side: Side;
  sizeUsdt: number;
  price: number; // NGN per USDT actually filled
  midAtFill: number; // NGN per USDT reference mid at fill time
  rfqId?: string;
  txHash?: string;
  feeAmount?: string; // protocol fee, atomic units of the sell token
}

export interface PayoutRecord {
  type: "payout";
  at: string;
  payee: string; // Celo / MiniPay wallet that received the cNGN
  amountCngn: number; // cNGN units paid out
  rate: number; // NGN per USDT filled on the conversion leg
  sizeUsdt: number; // USDT converted for this payout
  swapTxHash: string; // Textile swap (USDT -> cNGN)
  payoutTxHash: string; // cNGN transfer to the payee
  rfqId: string;
}

export type LedgerRecord = QuoteRecord | FillRecord | PayoutRecord;

/** P&L of one fill in NGN, marked against the mid at fill time. */
export function fillPnlNgn(f: FillRecord): number {
  // Taker buys USDT -> we sold at our ask (earn price - mid).
  // Taker sells USDT -> we bought at our bid (earn mid - price).
  const perUsdt = f.side === "taker_buys_usdt" ? f.price - f.midAtFill : f.midAtFill - f.price;
  return perUsdt * f.sizeUsdt;
}

export interface LedgerSummary {
  quotesAnswered: number;
  quotesFilled: number;
  volumeQuotedUsdt: number;
  volumeFilledUsdt: number;
  pnlNgn: number;
  /** What a fixed-spread filler would have earned on the same fills. */
  baselineNgn: number;
  pnlVsBaselineNgn: number;
  payoutsPaid: number;
  volumePaidCngn: number;
}

export function summarize(
  records: LedgerRecord[],
  baselineHalfSpreadBps = 5,
): LedgerSummary {
  const quotes = records.filter((r): r is QuoteRecord => r.type === "quote");
  const fills = records.filter((r): r is FillRecord => r.type === "fill");
  const payouts = records.filter((r): r is PayoutRecord => r.type === "payout");
  const pnlNgn = fills.reduce((s, f) => s + fillPnlNgn(f), 0);
  const baselineNgn = fills.reduce(
    (s, f) => s + ((f.midAtFill * baselineHalfSpreadBps) / 1e4) * f.sizeUsdt,
    0,
  );
  return {
    quotesAnswered: quotes.length,
    quotesFilled: fills.length,
    volumeQuotedUsdt: quotes.reduce((s, q) => s + q.sizeUsdt, 0),
    volumeFilledUsdt: fills.reduce((s, f) => s + f.sizeUsdt, 0),
    pnlNgn,
    baselineNgn,
    pnlVsBaselineNgn: pnlNgn - baselineNgn,
    payoutsPaid: payouts.length,
    volumePaidCngn: payouts.reduce((s, p) => s + p.amountCngn, 0),
  };
}

export interface PayoutSummary {
  payoutsPaid: number;
  volumeConvertedUsdt: number;
  volumePaidCngn: number;
  swapTxHashes: string[];
  payoutTxHashes: string[];
}

export function payoutSummary(records: LedgerRecord[]): PayoutSummary {
  const payouts = records.filter((r): r is PayoutRecord => r.type === "payout");
  return {
    payoutsPaid: payouts.length,
    volumeConvertedUsdt: payouts.reduce((s, p) => s + p.sizeUsdt, 0),
    volumePaidCngn: payouts.reduce((s, p) => s + p.amountCngn, 0),
    swapTxHashes: payouts.map((p) => p.swapTxHash),
    payoutTxHashes: payouts.map((p) => p.payoutTxHash),
  };
}

export function appendRecord(path: string, rec: LedgerRecord): void {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, JSON.stringify(rec) + "\n");
}

export function readRecords(path: string): LedgerRecord[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as LedgerRecord);
}
