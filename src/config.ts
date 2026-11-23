import type { Address } from "viem";

// Load a local .env if present (Node built-in; no dependency). Shell-exported
// variables take precedence — loadEnvFile never overrides ones already set.
// Without this, nothing in the repo reads .env at all and every value in
// .env.example would be silently ignored.
try {
  process.loadEnvFile();
} catch {
  // No .env file — fine, defaults and shell env still apply.
}

/**
 * ERC-8021 attribution code assigned by Loops for the Agents Open for Business
 * entry. Issued at enrollment, verified in the Loops playground after the
 * agent wallet was saved. Every transaction from the agent wallet MUST carry
 * it. Do not derive it from the repo, and do NOT reuse the old programme tag
 * celo_1491b3c3f297.
 */
export const ATTRIBUTION_TAG = "celo_f92cf52450d6" as const;

export const CHAIN_ID = 42220; // Celo mainnet
export const AGENT_ADDRESS: Address = "0x77fBd73F31ab04334e7BF7a9027e08fc81686cE2";

/** Verify against docs.textilecredit.com/protocol/address-book.html before use. */
export const ADDR = {
  textileReactor: "0xa9AA0a64769cBed4d3B1Ceb4Df01CdE915C235b3",
  feeController: "0x7b005466F905DD882A959888154587fA76cd3Ea7",
  permit2: "0x000000000022D473030F116dDEE9F6B43aC78BA3",
  erc8004Registry: "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432",
  cNGN: "0xF6829D7393dAe24509eb1E52eE8e572e2E271a4f",
  USDT: "0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e",
} as const satisfies Record<string, Address>;

export const DECIMALS = { cNGN: 6, USDT: 6 } as const;

export const TEXTILE_API = "https://api.textilecredit.com";
export const TEXTILE_V2 = `${TEXTILE_API}/v2`;
export const TEXTILE_FEE_BPS = 1;

/**
 * The payee: a real person George actually pays, with a Celo or MiniPay
 * wallet. Set via PAYEE_ADDRESS. Empty by default on purpose: the payout
 * step refuses to run without it, and this repo must never invent one.
 * A payee address that is not a valid address fails loud at import.
 */
const payeeRaw = (process.env.PAYEE_ADDRESS ?? "").trim();
export const PAYEE_ADDRESS: Address | "" =
  payeeRaw === ""
    ? ""
    : /^0x[0-9a-fA-F]{40}$/.test(payeeRaw)
      ? (payeeRaw as Address)
      : (() => {
          throw new Error(`Invalid PAYEE_ADDRESS="${payeeRaw}" — expected a 0x address or empty`);
        })();

const num = (k: string, d: number) => {
  const raw = process.env[k];
  if (raw === undefined) return d;
  const v = Number(raw);
  // A typo'd value must fail loud here. Letting NaN through would silently
  // disable the caps below (every NaN comparison is false), and a negative
  // spread/skew would quote through the mid.
  if (!Number.isFinite(v) || v < 0) {
    throw new Error(`Invalid ${k}="${raw}" — expected a finite number >= 0`);
  }
  return v;
};

export const PARAMS = {
  baseSpreadBps: num("BASE_SPREAD_BPS", 3), // floor half-spread each side
  volMultiplier: num("VOL_MULTIPLIER", 1.5), // half-spread += k * sigma(bps)
  maxSkewBps: num("MAX_SKEW_BPS", 25), // max price shift from inventory imbalance
  targetUsdtShare: num("TARGET_USDT_SHARE", 0.5), // desired USDT share of inventory value
  bandWidth: num("BAND_WIDTH", 0.2), // +/- band around target before rebalance flag
  maxQuoteUsdt: num("MAX_QUOTE_USDT", 500), // hard size cap per quote
  maxInventoryShareUsedPerQuote: num("MAX_SHARE_PER_QUOTE", 0.25),
  maxSpreadBps: num("MAX_SPREAD_BPS", 150), // refuse to quote wider than this
  refDivergenceHaltBps: num("REF_DIVERGENCE_HALT_BPS", 1000),
  // Payout-specific.
  payoutSizeUsdt: num("PAYOUT_SIZE_USDT", 10), // demo payout size, USDT
  minEdgeUsd: num("MIN_EDGE_USD", 0.05), // firm price must beat fair value by more than fee + gas + this
  maxTradeUsd: num("MAX_TRADE_USD", 500), // hard cap per payout conversion
  rfqTimeoutMs: num("RFQ_TIMEOUT_MS", 75_000), // Textile docs: 75s, not less
  maxOutstandingRfqs: num("MAX_OUTSTANDING_RFQS", 4),
  expirySafetyMs: num("EXPIRY_SAFETY_MS", 5_000), // refuse to broadcast inside this window of expiresAt
};

/** LIVE=1 executes on mainnet. Anything else (including unset) is dry-run: scan and log, send nothing. */
export const LIVE = process.env.LIVE === "1";
