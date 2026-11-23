# NairaQuote Pay

NairaQuote Pay turns a USDT invoice into naira in a freelancer wallet, in one tagged onchain flow. Not a quote. A payday.

A client pays USDT. The agent takes a firm [Textile FX](https://app.textilecredit.com/) RFQ v2 quote as a taker, converts to cNGN, and pays a named freelancer in cNGN — every transaction carrying the Loops attribution tag, on **Celo mainnet** (chain 42220). Built for the Celo Agents Open for Business hackathon, **Track 1, Stablecoin Corridors**.

Current state, honestly: the code is built and the dry-run path is tested against the live Textile RFQ preview, but **no live payout has happened yet**. The payee (George's brother) is named but his wallet is not confirmed yet, and the agent wallet is not funded yet. The dashboard says "no payouts yet" until the agent actually pays someone. No numbers here are mocked.

## Why
Most Textile fillers quote price ± fixed bips. NairaQuote Pay converts once, in the direction the job needs:
- **Live mid** from the Textile USDT_NGN book, sanity-checked against an independent NGN/USD reference.
- **Volatility**: EWMA of log returns widens the half-spread when the naira moves fast.
- **Inventory skew**: when the agent is long USDT it shades both prices down (and vice versa) to pull inventory back to target.
- **Firm-price guard**: the agent takes a firm quote only if it beats the engine fair value by more than fee + gas + a minimum edge, with a 1,000 bps divergence halt and hard size caps. A bad price halts the run and logs why. It never takes a bad price to force a demo.
- **Exact approvals**: the agent approves exactly `takerPays` to the Textile LimitOrderReactor, never unlimited, resetting to zero first for USDT-style tokens when a standing allowance is positive but short.
- **Tagged everything**: every transaction from the agent wallet carries the ERC-8021 attribution tag `celo_f92cf52450d6` via `withAttribution` where the wallet client is built (`src/wallet.ts`). Verify the suffix any time with `npm run check:tag`.
- **Ledger first**: every conversion fill and every payout is recorded to a JSONL ledger (`src/engine/ledger.ts`). The dashboard (`npm run dashboard`) shows payouts, cNGN delivered, and both tx hashes per payout. No payout, no numbers.
- **Safe by default**: `LIVE=0` is dry-run — scan, preview, log, send nothing. Execution happens only in `--once` mode with `LIVE=1`, and the planning loop never executes, so a runaway loop can never double-pay.

The engine (`src/engine/quote.ts`, `src/engine/taker.ts`) is pure functions, so it is unit-tested and can be replayed against history.

## Onchain
- Agent wallet: `0x77fBd73F31ab04334e7BF7a9027e08fc81686cE2` — [view on Celoscan](https://celoscan.io/address/0x77fBd73F31ab04334e7BF7a9027e08fc81686cE2)
- ERC-8021 attribution: every transaction is tagged `celo_f92cf52450d6` via `withAttribution` where the wallet client is built (`src/wallet.ts`). Verify the suffix any time with `npm run check:tag`.
- ERC-8004 identity: **not registered yet**. The registration file is `agent.json` in this repo; registration (`npm run register:agent`) runs once the agent wallet is funded. Registry `0x8004A169FB4a3325136EB29fA0ceB6D2e539a432`.
- Textile LimitOrderReactor: `0xa9AA0a64769cBed4d3B1Ceb4Df01CdE915C235b3`; USDT `0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e`; cNGN `0xF6829D7393dAe24509eb1E52eE8e572e2E271a4f`.
- Payee: George's brother — wallet pending confirmation. The payout step refuses to run until `PAYEE_ADDRESS` is set, and this repo never invents one.

## Run
```sh
npm install
npm test            # engine + RFQ + taker + payout tests
npm run typecheck   # tsc --noEmit
npm run check:tag   # prints the ERC-8021 attribution tag and its data suffix
npm run pay:once    # one payout cycle: live preview + plan (LIVE=0: nothing signed or sent)
npm run dev         # planning loop every 60s (planning only, never executes)
NQ_TICK_LOG=data/payouts.jsonl npm run pay:once  # also persist the run to the ledger
npm run dashboard   # read-only dashboard over the ledger (PORT, default 8787)
```

No `.env` or key is needed for the dry-run commands. For anything wallet-related, copy `.env.example` to `.env` (loaded automatically; shell-exported variables take precedence) and set `AGENT_PRIVATE_KEY` — it must belong to the agent wallet above; `src/wallet.ts` refuses any other key. Set `PAYEE_ADDRESS` to the payee's Celo / MiniPay wallet before any live run.

Live run (only when the payee is set and the wallet holds the $10 USDT plus a little CELO for gas):
```sh
LIVE=1 npm run pay:once
```

## How a payout works
1. The agent reads the live Textile book and the independent NGN/USD reference. Both feeds must be healthy or the run halts.
2. It previews the $10 USDT → cNGN conversion on Textile RFQ v2 (free, no signing).
3. In live mode it requests a firm quote, signing the EIP-712 `TakerControl` proof only if Textile answers 401, then checks the firm price against fair value.
4. It approves exactly `takerPays` to the reactor, waits for the receipt, re-checks the quote expiry, and broadcasts the swap with the tag appended.
5. It sends the cNGN received to the payee, tagged, in the same run, verifies the tag on both transactions, and writes the fill + payout to the ledger with both tx hashes.

## Receipts
- Dry-run proof (live Textile preview, 2026-11-23): see `docs/dry-run-2026-11-23.md`. Real preview numbers, no signing, no spending.
- Live payouts: none yet. The first one lands here with its tx hashes when the payee and funding clear.

## Status
- [x] Tagged wallet client, live Textile + reference feeds, quoting engine with tests (dry-run); reference-outage halt, per-decision reasons, dynamic size ladder, real balance readout with labelled paper fallback
- [x] Textile RFQ v2 client (preview, firm request, submit, status, cancel) + EIP-712 TakerControl proof, with tests
- [x] Taker decision rule (edge vs fee + gas + min edge, divergence halt, expiry guard) + exact-allowance logic, with tests
- [x] Payout orchestration (firm quote → exact approve → tagged swap → tagged cNGN payout → ledger), dry-run verified against live preview
- [x] ERC-8004 registration file (`agent.json`); on-chain registration pending funding
- [ ] Payee wallet confirmed (George's brother)
- [ ] Agent wallet funded ($10 USDT + a little CELO for gas)
- [ ] First live payout, tag verified on both transactions
- [ ] Altana Track 4 session-key leg (only after the Track 1 core pays out)

All code in this repository was written during the hackathon. The pricing engine, feeds, and risk checks are ported from NairaQuote (the previous programme's entry) as reference, rewritten for the payout agent; the payout orchestration, RFQ client, and taker rule are new. MIT licensed.
