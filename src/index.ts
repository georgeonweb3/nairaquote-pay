import { LIVE, PARAMS, PAYEE_ADDRESS } from "./config.js";
import { planPayout, runPayout } from "./engine/payout.js";

/**
 * NairaQuote Pay — one payout per invocation.
 *
 *   npm run pay:once   one payout cycle (preview + plan; executes only with LIVE=1)
 *   npm run dev        planning loop every 60 s (LIVE=0 planning only, by design)
 *
 * Safety: execution happens ONLY in --once mode with LIVE=1. The loop never
 * executes, so a runaway loop can never double-pay. A tick plans only when
 * BOTH feeds are healthy; a reference outage halts the tick instead of
 * planning without the divergence guard.
 */
const once = process.argv.includes("--once");

async function tick() {
  const plan = await planPayout();
  const result = await runPayout(plan);
  console.log(
    JSON.stringify({
      at: new Date().toISOString(),
      mode: plan.mode,
      live: LIVE,
      payee: PAYEE_ADDRESS || "(not configured)",
      sizeUsdt: plan.sizeUsdt,
      fairMid: Number.isFinite(plan.fairMid) ? +plan.fairMid.toFixed(2) : null,
      refRate: Number.isFinite(plan.refRate) ? +plan.refRate.toFixed(2) : null,
      previewRate: plan.previewRate !== null ? +plan.previewRate.toFixed(2) : null,
      previewBuyCngn:
        plan.preview !== null ? Number((plan.preview.buyAmount / 1_000_000n).toString()) : null,
      previewFeeUsdt:
        plan.preview !== null ? Number((plan.preview.feeAmount / 1_000_000n).toString()) : null,
      wallet: { usdt: plan.walletUsdt, celo: +plan.walletCelo.toFixed(4) },
      inventorySource: plan.inventorySource,
      outcome: result.outcome,
      reason: result.reason,
      ...(result.swapTxHash ? { swapTxHash: result.swapTxHash } : {}),
      ...(result.payoutTxHash ? { payoutTxHash: result.payoutTxHash } : {}),
      ...(result.rfqId ? { rfqId: result.rfqId } : {}),
    }),
  );
  return result;
}

if (once) {
  // One-shot mode: a failed tick fails the command (non-zero exit).
  await tick();
} else {
  // Loop mode: planning only — runPayout never executes outside --once.
  // A transient feed failure must not kill the process, and a slow tick
  // must never overlap the next one.
  let running = false;
  const guarded = async () => {
    if (running) return;
    running = true;
    try {
      await tick();
    } catch (e) {
      console.error(e);
    } finally {
      running = false;
    }
  };
  await guarded();
  setInterval(guarded, 60_000);
  console.log(`NairaQuote Pay planning loop every ${PARAMS.payoutSizeUsdt} USDT (LIVE=${LIVE ? 1 : 0}, loop never executes)`);
}
