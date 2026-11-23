import type { Address, Hex } from "viem";
import { TEXTILE_V2 } from "../config.js";
import type { TakerProof } from "./proof.js";

/**
 * Textile FX RFQ v2 client (taker side). Five calls: preview is a free
 * estimate; request/cancel/submit/status work on one RFQ.
 *
 * Docs: https://fx-docs.textilecredit.com/api/v2/rfq.html
 * Auth: https://fx-docs.textilecredit.com/api/v2/authentication.html
 *
 * Keyless callers sign one EIP-712 TakerControl proof per wallet + chain
 * (see feeds/proof.ts); a verified proof covers requests for ~12 h, and a
 * 401 proof_of_control_required tells you to sign again. This client sends
 * the firm request unsigned first and signs only when asked — it never
 * tracks the grant window client-side.
 *
 * A no-quote is a 200, not an error: nobody would price the trade, which
 * is a normal outcome. Callers must handle it, not treat it as a failure.
 */

export type FetchImpl = typeof fetch;

export interface RfqAmounts {
  sellAmount: bigint; // atomic units of the sell token
  buyAmount: bigint; // atomic units of the buy token
  feeAmount: bigint; // protocol fee, atomic units of the sell token
  takerPays: bigint; // exactly what leaves the taker wallet
  rateRay: bigint; // ray (1e27)
}

export interface PreviewOk extends RfqAmounts {
  status: "preview";
  availableSellAmount?: bigint;
}

export interface NoQuote {
  status: "no_quote";
  reason: string;
  availableSellAmount?: bigint;
  reservedUntil?: string;
  retryAfterMs?: number;
}

export type PreviewResult = PreviewOk | NoQuote;

export interface FirmQuote extends RfqAmounts {
  status: "quoted";
  rfqId: string;
  claimToken: string;
  expiresAt: string; // accept cutoff (ISO)
  orderDeadline: string; // earliest signed-order deadline (ISO)
  latestOrderDeadline: string;
  reactor: Address;
  taker: Address;
  encodedOrder: Hex;
  signature: Hex;
  approval: { to: Address; data: Hex; value: bigint; chainId: number };
  swap: { to: Address; data: Hex; value: bigint; chainId: number };
  attributionSuffix?: Hex | null;
}

export type FirmResult = FirmQuote | NoQuote;

export interface RfqStatus {
  rfqId: string;
  status:
    | "soliciting"
    | "quoted"
    | "no_quote"
    | "submitted"
    | "filled"
    | "failed"
    | "expired";
  sellAmount: string;
  buyAmount: string;
  feeAmount: string;
  taker: string;
  expiresAt: string;
  txHash?: string | null;
  noQuoteReason?: string | null;
  failReason?: string | null;
}

const isDigits = (v: unknown): v is string => typeof v === "string" && /^\d+$/.test(v);

function parseAmounts(d: Record<string, unknown>, what: string): RfqAmounts {
  for (const k of ["sellAmount", "buyAmount", "feeAmount", "takerPays", "rateRay"]) {
    if (!isDigits(d[k])) throw new Error(`malformed ${what}: ${k} missing or not a uint string`);
  }
  return {
    sellAmount: BigInt(d.sellAmount as string),
    buyAmount: BigInt(d.buyAmount as string),
    feeAmount: BigInt(d.feeAmount as string),
    takerPays: BigInt(d.takerPays as string),
    rateRay: BigInt(d.rateRay as string),
  };
}

function parseNoQuote(d: Record<string, unknown>): NoQuote {
  return {
    status: "no_quote",
    reason: typeof d.reason === "string" ? d.reason : "no_valid_quote",
    availableSellAmount: isDigits(d.availableSellAmount)
      ? BigInt(d.availableSellAmount as string)
      : undefined,
    reservedUntil: typeof d.reservedUntil === "string" ? d.reservedUntil : undefined,
    retryAfterMs: typeof d.retryAfterMs === "number" ? d.retryAfterMs : undefined,
  };
}

function parseHex(v: unknown, what: string): Hex {
  if (typeof v !== "string" || !/^0x[0-9a-fA-F]*$/.test(v)) {
    throw new Error(`malformed firm quote: ${what} is not hex`);
  }
  return v as Hex;
}

function parseAddress(v: unknown, what: string): Address {
  if (typeof v !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(v)) {
    throw new Error(`malformed firm quote: ${what} is not an address`);
  }
  return v as Address;
}

function parseTx(d: unknown, what: string): FirmQuote["swap"] {
  const t = d as Record<string, unknown>;
  if (!t || typeof t !== "object") throw new Error(`malformed firm quote: ${what} missing`);
  return {
    to: parseAddress(t.to, `${what}.to`),
    data: parseHex(t.data, `${what}.data`),
    value: isDigits(t.value) ? BigInt(t.value as string) : 0n,
    chainId: typeof t.chainId === "number" ? t.chainId : 0,
  };
}

export class RfqClient {
  private readonly base: string;
  private readonly doFetch: FetchImpl;

  constructor(opts: { baseUrl?: string; fetchImpl?: FetchImpl } = {}) {
    this.base = opts.baseUrl ?? TEXTILE_V2;
    this.doFetch = opts.fetchImpl ?? fetch;
  }

  /** Indicative price off the makers' latest levels. Free, no taker, no signing. */
  async preview(args: {
    chainId: number;
    sellToken: Address;
    buyToken: Address;
    sellAmount: bigint;
  }): Promise<PreviewResult> {
    const r = await this.doFetch(`${this.base}/rfq/preview`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chainId: args.chainId,
        sellToken: args.sellToken,
        buyToken: args.buyToken,
        sellAmount: args.sellAmount.toString(),
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!r.ok) throw new Error(`rfq preview ${r.status}`);
    const body = (await r.json()) as { data?: Record<string, unknown> };
    const d = body.data;
    if (!d || typeof d !== "object") throw new Error("malformed preview: no data");
    if (d.status === "no_quote") return parseNoQuote(d);
    if (d.status !== "preview") throw new Error(`malformed preview: status ${String(d.status)}`);
    return {
      status: "preview",
      ...parseAmounts(d, "preview"),
      availableSellAmount: isDigits(d.availableSellAmount)
        ? BigInt(d.availableSellAmount as string)
        : undefined,
    };
  }

  /**
   * Firm quote: signed maker orders + ready calldata, 60 s TTL,
   * whole-or-nothing. Blocks while makers answer (reply budget up to 10 s,
   * plus up to 60 s on-chain preflight on a cold corridor) — client timeout
   * is 75 s, per the docs. Sends unsigned first; signs TakerControl only
   * when the server answers 401 proof_of_control_required.
   */
  async requestFirm(args: {
    chainId: number;
    sellToken: Address;
    buyToken: Address;
    sellAmount: bigint;
    taker: Address;
    timeoutMs?: number;
    signProof?: () => Promise<TakerProof>;
  }): Promise<FirmResult> {
    const timeout = args.timeoutMs ?? 75_000;
    const send = async (proof?: TakerProof) => {
      const res = await this.doFetch(`${this.base}/rfq/request`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chainId: args.chainId,
          sellToken: args.sellToken,
          buyToken: args.buyToken,
          sellAmount: args.sellAmount.toString(),
          taker: args.taker,
          ...(proof ? { takerProof: proof } : {}),
        }),
        signal: AbortSignal.timeout(timeout),
      });
      return res;
    };

    let res = await send();
    if (res.status === 401) {
      const err = (await res.clone().json().catch(() => ({}))) as {
        error?: { details?: { reason?: string } };
      };
      if (err.error?.details?.reason === "proof_of_control_required") {
        if (!args.signProof) {
          throw new Error("firm request needs TakerControl proof but no signer was provided");
        }
        res = await send(await args.signProof());
      }
    }
    if (!res.ok) throw new Error(`rfq request ${res.status}`);
    const body = (await res.json()) as { data?: Record<string, unknown> };
    const d = body.data;
    if (!d || typeof d !== "object") throw new Error("malformed firm quote: no data");
    if (d.status === "no_quote") return parseNoQuote(d);
    if (d.status !== "quoted") throw new Error(`malformed firm quote: status ${String(d.status)}`);

    const q = d.quote as Record<string, unknown> | undefined;
    const txs = d.transactions as Record<string, unknown> | undefined;
    if (!q || typeof q !== "object") throw new Error("malformed firm quote: no quote");
    if (!txs || typeof txs !== "object") throw new Error("malformed firm quote: no transactions");
    for (const k of ["expiresAt", "orderDeadline", "latestOrderDeadline"]) {
      if (typeof q[k] !== "string") throw new Error(`malformed firm quote: ${k} missing`);
    }
    if (typeof d.rfqId !== "string" || typeof d.claimToken !== "string") {
      throw new Error("malformed firm quote: rfqId/claimToken missing");
    }
    return {
      status: "quoted",
      ...parseAmounts(q, "firm quote"),
      rfqId: d.rfqId,
      claimToken: d.claimToken,
      expiresAt: q.expiresAt as string,
      orderDeadline: q.orderDeadline as string,
      latestOrderDeadline: q.latestOrderDeadline as string,
      reactor: parseAddress(q.reactor, "quote.reactor"),
      taker: parseAddress(q.taker, "quote.taker"),
      encodedOrder: parseHex(q.encodedOrder, "quote.encodedOrder"),
      signature: parseHex(q.signature, "quote.signature"),
      approval: parseTx(txs.approval, "transactions.approval"),
      swap: parseTx(txs.swap, "transactions.swap"),
      attributionSuffix:
        typeof d.attributionSuffix === "string"
          ? (d.attributionSuffix as Hex)
          : null,
    };
  }

  /** Report the broadcast swap hash so Textile can reconcile the fill. Idempotent on the same hash. */
  async submit(rfqId: string, claimToken: string, txHash: Hex): Promise<RfqStatus> {
    const r = await this.doFetch(`${this.base}/rfq/${rfqId}/submit`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Rfq-Claim": claimToken },
      body: JSON.stringify({ txHash }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!r.ok) throw new Error(`rfq submit ${r.status}`);
    const body = (await r.json()) as { data?: RfqStatus };
    if (!body.data) throw new Error("malformed submit response: no data");
    return body.data;
  }

  /** Release a quoted RFQ's claim on maker inventory. Only works while still quoted. */
  async cancel(rfqId: string, claimToken: string): Promise<{ rfqId: string; status: string }> {
    const r = await this.doFetch(`${this.base}/rfq/${rfqId}/cancel`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Rfq-Claim": claimToken },
      body: JSON.stringify({}),
      signal: AbortSignal.timeout(10_000),
    });
    if (!r.ok) throw new Error(`rfq cancel ${r.status}`);
    const body = (await r.json()) as { data?: { rfqId: string; status: string } };
    if (!body.data) throw new Error("malformed cancel response: no data");
    return body.data;
  }

  /** Read an RFQ's status. The signed order is never replayed here. */
  async status(rfqId: string, claimToken: string): Promise<RfqStatus> {
    const r = await this.doFetch(`${this.base}/rfq/${rfqId}`, {
      headers: { "X-Rfq-Claim": claimToken },
      signal: AbortSignal.timeout(10_000),
    });
    if (!r.ok) throw new Error(`rfq status ${r.status}`);
    const body = (await r.json()) as { data?: RfqStatus };
    if (!body.data) throw new Error("malformed status response: no data");
    return body.data;
  }
}

/** Effective fill rate of a quote, in buy-token units per sell-token unit, at the given decimals. */
export function effectiveRate(
  q: RfqAmounts,
  sellDecimals: number,
  buyDecimals: number,
): number {
  const sell = Number(q.sellAmount) / 10 ** sellDecimals;
  const buy = Number(q.buyAmount) / 10 ** buyDecimals;
  if (!(sell > 0) || !(buy > 0)) return Number.NaN;
  return buy / sell;
}
