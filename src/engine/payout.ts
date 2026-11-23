import { encodeFunctionData, erc20Abi, formatUnits, parseUnits, type Address, type Hash } from "viem";
import {
  ADDR,
  CHAIN_ID,
  DECIMALS,
  LIVE,
  PARAMS,
  PAYEE_ADDRESS,
} from "../config.js";
import { agentBalances } from "../feeds/balances.js";
import { referenceNgnPerUsd } from "../feeds/reference.js";
import { textileTicker } from "../feeds/textile.js";
import { effectiveRate, RfqClient, type FirmQuote, type PreviewOk } from "../feeds/rfq.js";
import { signTakerControl } from "../feeds/proof.js";
import { approvalNeeded, takeDecision } from "./taker.js";
import { appendRecord, type FillRecord, type PayoutRecord } from "./ledger.js";
import { assertTagged, agentWallet, publicClient } from "../wallet.js";
import type { Account } from "viem/accounts";

/**
 * Payout orchestration: one client USDT invoice in, one cNGN payout out.
 *
 * Flow (live):
 *   1. Fetch a Textile RFQ v2 firm quote for USDT -> cNGN at the payout size.
 *   2. Check the firm price against the engine fair value (1,000 bps
 *      divergence halt, fee + gas edge check). Halt and log if it fails.
 *      The agent never takes a bad price to force a demo.
 *   3. Approve the EXACT takerPays amount to the LimitOrderReactor
 *      (never unlimited; reset to zero first for USDT-style tokens when a
 *      standing allowance is positive but short).
 *   4. Broadcast transactions.swap from the agent wallet. The wallet client
 *      appends the ERC-8021 attribution tag to every transaction.
 *   5. Send the received cNGN to PAYEE_ADDRESS, tagged, in the same run.
 *   6. Write the ledger entries (conversion fill + payout) with both tx hashes.
 *
 * LIVE=0 (default) is dry-run: steps 1-2 run against the live preview only,
 * the plan is logged, and nothing is signed or sent. Execution happens only
 * in --once mode with LIVE=1; the loop mode is planning-only by design, so
 * a runaway loop can never double-pay.
 */

export interface PayoutPlan {
  mode: "dry" | "live";
  sizeUsdt: number;
  sellAmount: bigint;
  payee: Address | "";
  fairMid: number;
  refRate: number;
  preview: PreviewOk | null;
  previewRate: number | null;
  blockedReason: string | null;
  inventorySource: string;
  walletUsdt: number;
  walletCelo: number;
}

export interface PayoutResult {
  outcome: "dry" | "paid" | "blocked";
  reason: string;
  plan: PayoutPlan;
  swapTxHash?: Hash;
  payoutTxHash?: Hash;
  rfqId?: string;
  amountCngn?: number;
  rate?: number;
}

export interface PayoutDeps {
  rfq?: RfqClient;
  ledgerPath?: string;
  /** Conservative USD estimate for the two on-chain txs (swap + payout). Celo gas is pennies; $0.05 is a 10x+ cushion and is logged as an assumption. */
  gasUsdEstimate?: number;
}

const sellAmountFor = (sizeUsdt: number) =>
  parseUnits(sizeUsdt.toFixed(DECIMALS.USDT), DECIMALS.USDT);

/** Build the plan: feeds + preview + validation. Signs nothing, sends nothing. */
export async function planPayout(deps: PayoutDeps = {}): Promise<PayoutPlan> {
  const rfq = deps.rfq ?? new RfqClient();
  const sizeUsdt = PARAMS.payoutSizeUsdt;
  const plan: PayoutPlan = {
    mode: LIVE ? "live" : "dry",
    sizeUsdt,
    sellAmount: sellAmountFor(sizeUsdt),
    payee: PAYEE_ADDRESS,
    fairMid: Number.NaN,
    refRate: Number.NaN,
    preview: null,
    previewRate: null,
    blockedReason: null,
    inventorySource: "unknown",
    walletUsdt: 0,
    walletCelo: 0,
  };

  if (!PAYEE_ADDRESS) {
    plan.blockedReason = "blocked: PAYEE_ADDRESS not configured — the payee is not known yet, and this repo must never invent one";
    return plan;
  }
  if (!(sizeUsdt >= 1)) {
    plan.blockedReason = `blocked: payout size ${sizeUsdt} USDT below the $1 RFQ floor`;
    return plan;
  }
  if (sizeUsdt > PARAMS.maxTradeUsd) {
    plan.blockedReason = `blocked: payout size ${sizeUsdt} USDT exceeds max trade ${PARAMS.maxTradeUsd} USDT`;
    return plan;
  }

  // Both feeds must be healthy: a tick without the reference guard is a halt, by design.
  const [t, ref, bal] = await Promise.all([
    textileTicker(),
    referenceNgnPerUsd(),
    agentBalances().catch(() => undefined),
  ]);
  plan.fairMid = (t.bid + t.ask) / 2;
  plan.refRate = ref.rate;
  if (bal) {
    plan.walletUsdt = bal.usdt;
    plan.walletCelo = bal.celo;
    plan.inventorySource = bal.usdt > 0 || bal.cngn > 0 ? "onchain" : "paper — agent wallet holds no cNGN/USDT yet";
  }

  const preview = await rfq.preview({
    chainId: CHAIN_ID,
    sellToken: ADDR.USDT,
    buyToken: ADDR.cNGN,
    sellAmount: plan.sellAmount,
  });
  if (preview.status === "no_quote") {
    plan.blockedReason =
      `blocked: Textile returned no_quote (${preview.reason})` +
      (preview.retryAfterMs ? ` — retry after ${preview.retryAfterMs} ms` : "");
    return plan;
  }
  plan.preview = preview;
  plan.previewRate = effectiveRate(preview, DECIMALS.USDT, DECIMALS.cNGN);
  return plan;
}

/** Execute one payout run from a plan. In dry mode this only logs the plan. */
export async function runPayout(
  plan: PayoutPlan,
  deps: PayoutDeps = {},
): Promise<PayoutResult> {
  const rfq = deps.rfq ?? new RfqClient();
  const gasUsd = deps.gasUsdEstimate ?? 0.05;

  if (plan.blockedReason) {
    return { outcome: "blocked", reason: plan.blockedReason, plan };
  }
  if (plan.mode === "dry") {
    const preview = plan.preview!;
    const feeUsd = Number(preview.feeAmount) / 10 ** DECIMALS.USDT; // fee is in sell-token (USDT) units, USDT ≈ $1
    const decision = takeDecision({
      firmRate: plan.previewRate!,
      fairMid: plan.fairMid,
      refRate: plan.refRate,
      feeUsd,
      gasUsd,
      sizeUsdt: plan.sizeUsdt,
      minEdgeUsd: PARAMS.minEdgeUsd,
      refDivergenceHaltBps: PARAMS.refDivergenceHaltBps,
      maxTradeUsd: PARAMS.maxTradeUsd,
      // Dry-run has no firm quote yet, so the expiry check is skipped here
      // by passing a far-future cutoff; the live path checks the real one.
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      expirySafetyMs: PARAMS.expirySafetyMs,
    });
    const reason =
      `dry-run: preview ${plan.sizeUsdt} USDT -> ${formatUnits(preview.buyAmount, DECIMALS.cNGN)} cNGN ` +
      `@ ${plan.previewRate!.toFixed(2)} NGN/USDT (fair mid ${plan.fairMid.toFixed(2)}, ref ${plan.refRate.toFixed(2)}), ` +
      `fee ${formatUnits(preview.feeAmount, DECIMALS.USDT)} USDT, takerPays ${formatUnits(preview.takerPays, DECIMALS.USDT)} USDT. ` +
      `Decision: ${decision.reason}. Nothing signed, nothing sent (LIVE=0).`;
    return { outcome: "dry", reason, plan };
  }

  // ---- LIVE path: executes on mainnet. Only reachable with LIVE=1. ----
  const account = agentWallet().account as Account;
  const wallet = agentWallet();
  const payee = plan.payee as Address;

  if (plan.walletUsdt < plan.sizeUsdt) {
    return { outcome: "blocked", reason: `blocked: agent wallet holds ${plan.walletUsdt} USDT, needs ${plan.sizeUsdt} USDT for the payout`, plan };
  }
  if (!(plan.walletCelo > 0)) {
    return { outcome: "blocked", reason: "blocked: agent wallet holds no CELO for gas", plan };
  }

  const firm = await rfq.requestFirm({
    chainId: CHAIN_ID,
    sellToken: ADDR.USDT,
    buyToken: ADDR.cNGN,
    sellAmount: plan.sellAmount,
    taker: account.address,
    timeoutMs: PARAMS.rfqTimeoutMs,
    signProof: () => signTakerControl(account, CHAIN_ID),
  });
  if (firm.status === "no_quote") {
    return { outcome: "blocked", reason: `blocked: firm request returned no_quote (${firm.reason})`, plan };
  }
  const quote: FirmQuote = firm;
  const firmRate = effectiveRate(quote, DECIMALS.USDT, DECIMALS.cNGN);
  const feeUsd = Number(formatUnits(quote.feeAmount, DECIMALS.USDT));
  const decision = takeDecision({
    firmRate,
    fairMid: plan.fairMid,
    refRate: plan.refRate,
    feeUsd,
    gasUsd,
    sizeUsdt: plan.sizeUsdt,
    minEdgeUsd: PARAMS.minEdgeUsd,
    refDivergenceHaltBps: PARAMS.refDivergenceHaltBps,
    maxTradeUsd: PARAMS.maxTradeUsd,
    expiresAt: quote.expiresAt,
    expirySafetyMs: PARAMS.expirySafetyMs,
  });
  if (!decision.take) {
    await rfq.cancel(quote.rfqId, quote.claimToken).catch(() => undefined);
    return { outcome: "blocked", reason: `blocked: firm quote rejected — ${decision.reason}`, plan };
  }

  // Approve exactly takerPays to the reactor (never unlimited).
  const erc20 = erc20Abi;
  const allowance = await publicClient.readContract({
    address: ADDR.USDT,
    abi: erc20,
    functionName: "allowance",
    args: [account.address, quote.reactor],
  });
  const { needed, resetFirst } = approvalNeeded(allowance, quote.takerPays);
  if (needed) {
    if (resetFirst) {
      const resetHash = await wallet.sendTransaction({
        to: ADDR.USDT,
        data: encodeFunctionData({
          abi: erc20,
          functionName: "approve",
          args: [quote.reactor, 0n],
        }),
        value: 0n,
      });
      await publicClient.waitForTransactionReceipt({ hash: resetHash });
    }
    const approvalHash = await wallet.sendTransaction({
      to: quote.approval.to,
      data: quote.approval.data,
      value: BigInt(quote.approval.value),
    });
    await publicClient.waitForTransactionReceipt({ hash: approvalHash });
  }

  // Re-check the accept cutoff before broadcasting: after expiresAt the
  // venue rejects /submit and the signed order can no longer settle in full.
  if (Date.now() + PARAMS.expirySafetyMs >= Date.parse(quote.expiresAt)) {
    await rfq.cancel(quote.rfqId, quote.claimToken).catch(() => undefined);
    return { outcome: "blocked", reason: "blocked: quote expired during approval — request a new one", plan };
  }

  const cngnBefore = await publicClient.readContract({
    address: ADDR.cNGN,
    abi: erc20,
    functionName: "balanceOf",
    args: [account.address],
  });

  // The wallet client appends the ERC-8021 attribution tag to the swap data.
  const swapHash = await wallet.sendTransaction({
    to: quote.swap.to,
    data: quote.swap.data,
    value: BigInt(quote.swap.value),
  });
  const swapReceipt = await publicClient.waitForTransactionReceipt({ hash: swapHash });
  if (swapReceipt.status !== "success") {
    throw new Error(`swap tx ${swapHash} did not succeed (status ${swapReceipt.status})`);
  }
  await assertTagged(swapHash);
  await rfq.submit(quote.rfqId, quote.claimToken, swapHash).catch(() => undefined);

  const cngnAfter = await publicClient.readContract({
    address: ADDR.cNGN,
    abi: erc20,
    functionName: "balanceOf",
    args: [account.address],
  });
  const receivedCngn = cngnAfter - cngnBefore;
  if (receivedCngn <= 0n) {
    throw new Error(`swap ${swapHash} settled but no cNGN arrived — inspect before paying anyone`);
  }

  // Pay the freelancer the cNGN received, tagged, in the same run.
  const payoutHash = await wallet.sendTransaction({
    to: ADDR.cNGN,
    data: encodeFunctionData({
      abi: erc20,
      functionName: "transfer",
      args: [payee, receivedCngn],
    }),
    value: 0n,
  });
  const payoutReceipt = await publicClient.waitForTransactionReceipt({ hash: payoutHash });
  if (payoutReceipt.status !== "success") {
    throw new Error(`payout tx ${payoutHash} did not succeed (status ${payoutReceipt.status}) — the cNGN is still in the agent wallet`);
  }
  await assertTagged(payoutHash);

  const at = new Date().toISOString();
  const amountCngn = Number(formatUnits(receivedCngn, DECIMALS.cNGN));
  const fill: FillRecord = {
    type: "fill",
    at,
    side: "taker_sells_usdt",
    sizeUsdt: plan.sizeUsdt,
    price: firmRate,
    midAtFill: plan.fairMid,
    rfqId: quote.rfqId,
    txHash: swapHash,
    feeAmount: quote.feeAmount.toString(),
  };
  const payout: PayoutRecord = {
    type: "payout",
    at,
    payee,
    amountCngn,
    rate: firmRate,
    sizeUsdt: plan.sizeUsdt,
    swapTxHash: swapHash,
    payoutTxHash: payoutHash,
    rfqId: quote.rfqId,
  };
  const ledgerPath = deps.ledgerPath ?? process.env.NQ_TICK_LOG ?? "data/payouts.jsonl";
  appendRecord(ledgerPath, fill);
  appendRecord(ledgerPath, payout);

  return {
    outcome: "paid",
    reason:
      `paid: ${plan.sizeUsdt} USDT -> ${amountCngn.toFixed(2)} cNGN @ ${firmRate.toFixed(2)} NGN/USDT ` +
      `to ${payee}. Swap ${swapHash}, payout ${payoutHash}.`,
    plan,
    swapTxHash: swapHash,
    payoutTxHash: payoutHash,
    rfqId: quote.rfqId,
    amountCngn,
    rate: firmRate,
  };
}
