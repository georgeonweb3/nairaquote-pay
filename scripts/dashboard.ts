import { createServer } from "node:http";
import { payoutSummary, readRecords, summarize } from "../src/engine/ledger.js";

/**
 * Minimal read-only dashboard over the payout ledger (NQ_TICK_LOG,
 * default data/payouts.jsonl). Shows payouts paid, cNGN delivered, the
 * conversion ledger, and the latest payouts with both tx hashes.
 * Until a payout lands the page says "no payouts yet" — it never invents
 * trading numbers. Run: npm run dashboard (PORT env, default 8787).
 */
const path = process.env.NQ_TICK_LOG ?? "data/payouts.jsonl";
const port = Number(process.env.PORT ?? 8787);

const esc = (s: unknown) =>
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const n = (x: number, d = 2) => x.toLocaleString("en-US", { maximumFractionDigits: d });

createServer((_req, res) => {
  const records = readRecords(path);
  const s = summarize(records);
  const p = payoutSummary(records);
  const payouts = records.filter((r) => r.type === "payout").slice(-10).reverse();
  const rows = payouts
    .map(
      (r) =>
        `<tr><td>${esc(r.at)}</td><td>${esc(r.payee)}</td><td>${n(r.sizeUsdt, 0)}</td>` +
        `<td>${n(r.amountCngn)}</td><td>${n(r.rate)}</td>` +
        `<td><a href="https://celoscan.io/tx/${esc(r.swapTxHash)}">${esc(r.swapTxHash.slice(0, 12))}…</a></td>` +
        `<td><a href="https://celoscan.io/tx/${esc(r.payoutTxHash)}">${esc(r.payoutTxHash.slice(0, 12))}…</a></td></tr>`,
    )
    .join("");
  res.writeHead(200, { "content-type": "text/html" });
  res.end(`<!doctype html><meta charset="utf-8"><title>NairaQuote Pay dashboard</title>
<style>body{font-family:system-ui;background:#0b0f14;color:#e6edf3;margin:2rem}
.card{display:inline-block;background:#151b24;border:1px solid #26303d;border-radius:10px;padding:1rem 1.25rem;margin:.35rem}
.card b{font-size:1.5rem;display:block}table{border-collapse:collapse;margin-top:1rem}
td,th{border:1px solid #26303d;padding:.35rem .6rem;font-size:.85rem;text-align:left}a{color:#7dd3fc}</style>
<h1>NairaQuote Pay — USDT invoice in, cNGN payout out</h1>
<p>Ledger: ${esc(path)} · Updated ${new Date().toISOString()}</p>
<div>
<span class="card">Payouts paid<b>${p.payoutsPaid ? p.payoutsPaid : "none yet"}</b></span>
<span class="card">USDT converted<b>${p.payoutsPaid ? n(p.volumeConvertedUsdt, 0) : "—"}</b></span>
<span class="card">cNGN delivered<b>${p.payoutsPaid ? n(p.volumePaidCngn) : "—"}</b></span>
<span class="card">Quotes answered<b>${s.quotesAnswered}</b></span>
<span class="card">Conversions filled<b>${s.quotesFilled}</b></span>
</div>
<h2>Latest payouts</h2>
${payouts.length ? `<table><tr><th>Time</th><th>Payee</th><th>USDT</th><th>cNGN</th><th>Rate</th><th>Swap tx</th><th>Payout tx</th></tr>${rows}</table>` : "<p>No payouts yet. The ledger records a payout only when the agent actually pays someone.</p>"}`);
}).listen(port, () => console.log(`NairaQuote Pay dashboard on http://localhost:${port} (ledger: ${path})`));
