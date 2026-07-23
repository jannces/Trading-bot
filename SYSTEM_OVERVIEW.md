# System Overview — MEXC Scalper Signal Scanner

A technical description of the whole system, written so another engineer or AI
can suggest improvements. It reflects the actual code in this repo.

---

## 1. Purpose

A **local, single-user** web app that scans the top-50 MEXC USDT spot pairs for
short-timeframe ("scalper") trade setups, emits **locked trade signals** (frozen
entry / stop / take-profits) when a strict confluence gate passes, tracks each
signal's outcome live, and records results (with realized R / PnL) to a
persistent ledger. It is an **educational / decision-support tool**, not an
auto-trader — it never places orders.

---

## 2. High-level architecture

```
                     MEXC public REST API (api.mexc.com)
                                  ▲   (polling)
                                  │
  ┌───────────────────────────────────────────────────────────┐
  │  server.js  (Node 18+, built-in http + global fetch)       │
  │                                                            │
  │  ┌──────────────┐   ┌──────────────┐   ┌────────────────┐  │
  │  │ price loop   │   │ scan loop    │   │ top-list loop  │  │
  │  │ every 1.5s   │   │ every 15s    │   │ hourly         │  │
  │  └──────┬───────┘   └──────┬───────┘   └───────┬────────┘  │
  │         │                  │                   │           │
  │         ▼                  ▼                   ▼           │
  │  ┌─────────────────────────────────────────────────────┐  │
  │  │ Scanner (js/scanner.js): kline cache, evaluate() gate│  │
  │  │ per pair/timeframe, signal lifecycle, ledger         │  │
  │  └─────────────────────────────────────────────────────┘  │
  │         │  broadcasts scan / prices / signal / ledger      │
  │         ▼  over Server-Sent Events (SSE, /events)          │
  └─────────┼──────────────────────────────────────────────────┘
            │  (single local HTTP connection)
            ▼
   Browser frontend (index.html + js/app.js): renders scanner feed,
   detail modal (TradingView Lightweight Charts + embedded widget), ledger.
```

- **Backend** owns all data fetching and all evaluation. **No exchange calls
  happen from the browser** (avoids CORS, rate limits, and N websockets).
- **Frontend is a thin renderer**: it consumes SSE messages and draws. Its only
  outbound calls are `/api/klines` (for the detail chart) and loading the
  TradingView CDN scripts.
- **Transport** browser⇄server is **SSE** (one-way push) + a couple of GET
  endpoints. Not a websocket. Events carry **monotonic ids**; on every
  (re)connect the server sends a **full snapshot** (feed + ledger + prices +
  status) before resuming deltas, so a dropped connection resyncs cleanly
  (Last-Event-ID is read and acknowledged). `/api/klines` validates the symbol
  against the current universe and whitelists intervals (400 otherwise).

---

## 3. Data source & "real-time" characteristics

- **Exchange:** MEXC spot v3 REST (`https://api.mexc.com`), Binance-compatible
  paths, MEXC interval strings (note `1h` == `60m`).
  - `GET /api/v3/ticker/24hr` — rank pairs by 24h quote volume.
  - `GET /api/v3/klines?symbol=&interval=&limit=` — OHLCV.
  - `GET /api/v3/ticker/price` — all-symbol last prices in one call.
- **Live mode = "poll" (default).** Latencies:
  - **Prices:** every **1.5s** (`timing.pricePollMs`).
  - **Scanner re-evaluation (Phase 3): candle-close-driven.** In live mode a scan
    runs just after each 1m close + `timing.candleCloseGraceMs` (so evaluation is
    fresh, not mid-candle), with `timing.scanIntervalMs` as a slow safety
    fallback. Klines are maintained **incrementally**: after warm-up each cycle
    fetches only `timing.incrementalKlineLimit` (3) candles and merges by open
    time (full refetch only on gap/startup) — same request count, ~50× less
    payload. Concurrency cap 6, 40ms stagger, exponential backoff on 429.
    (MOCK uses a flat timer since its time is compressed.)
  - **Top-50 list:** hourly (`scanner.listRefreshMs`).
- **WebSocket:** `js/mexcws.js` implements `wss://wbs.mexc.com/ws`
  (`{"method":"SUBSCRIPTION","params":["spot@public.deals.v3.api@SYM"]}`) but is
  **NOT wired into the running server** and is **unverified** (build sandbox
  couldn't reach MEXC; MEXC has partly migrated spot streams to **protobuf**).
  Enabling true streaming is an open improvement.

**Net:** near-real-time via polling. Good enough for 1m/5m scalping cadence; not
a sub-second/tick system.

---

## 4. Scanner logic (js/scanner.js)

1. **Universe:** top-50 USDT pairs by 24h quote volume, excluding leveraged
   tokens (`…3L/3S`) and stable-vs-stable pairs.
2. **Timeframes (config-driven):** `config.scanner.timeframes` (default
   **`["5m"]`** — 5m is the primary scalping TF). Add `"1m"` to re-enable 1m
   scanning; nothing 1m-specific was removed. When a TF isn't listed its klines
   are never fetched. **15m is the higher-timeframe (HTF) bias filter.** When 1m
   IS scanned, a 1m signal also requires 5m directional agreement. The
   candle-close scheduler, kline warm-up, expiry bars and stop caps all key off
   this list (the live scan aligns to the **fastest** configured TF's close).
3. Each scan cycle: for every pair × configured TF it calls the gate `evaluate()`
   with that pair's candles + the 15m candles. Results become feed items:
   - **ACTIVE** → a locked signal (see §6),
   - **FORMING** → a setup fired and nothing hard-rejects it, but it needs more
     confirmations (shows what's missing),
   - **NONE** → not shown.
4. Feed is ranked: active first, then forming, each by score.
5. **Portfolio / regime awareness (Phase 4):**
   - **BTC regime filter** — BTC bias is computed each cycle from `BTCUSDT`
     `regime.btcTimeframe` (15m) via the existing HTF logic. `regime.btcFilter`:
     `"suppress"` drops alt signals counter to BTC bias, `"downgrade"` lowers
     their tier, `"off"` disables. BTC itself is exempt; shown in the status line.
   - **Concurrent-exposure guard** — beyond `exposure.maxSameDirection` ACTIVE
     signals in one direction, new signals still lock but are flagged
     **`exposureCapped`** (an "EXP-CAP" badge in the feed and a field in the ledger).
   - Each ledger record stores the **BTC bias** and **hour-of-day (UTC)** at lock;
     the summary adds `byBtcRegime` and `byHour` breakdowns.
   - **Optional session filter (Task 5):** `config.sessionFilter` (off by
     default). When enabled, signals triggered outside `allowedUtcHours` are
     tier-downgraded and flagged `offSession` (never dropped); the ledger's
     `bySession` (in-session vs off-session) breakdown lets you measure whether
     the filter would have helped before trusting it.

---

## 5. The "brain": setups + confluence gate

### Indicators (js/indicators.js — pure functions)
EMA, SMA, RSI (Wilder), MACD, ATR, Bollinger, Stochastic, OBV, VWAP, Ichimoku,
and fractal pivot detection.

### 10 confirmation strategies (js/strategies/*)
EMA cross, RSI(+divergence), MACD, Bollinger, Ichimoku, Stochastic, VWAP,
S/R breakout, Smart-Money-Concepts (ICT), Volume/OBV. Each exports
`analyze(candles) → { signal: BUY|SELL|NEUTRAL, strength: 0-100, reason }`.
In this system they are **confirmations**, not the trigger.

### 4 named setups (js/setups.js) — the trigger (an *event*, not a state)
- **Sweep & Reverse (SMC):** liquidity sweep of a prior swing + displacement;
  entry at the resulting fair-value-gap / order block.
- **Divergence Reversal:** regular RSI divergence at a swing + oscillator
  extreme + reaction candle.
- **Breakout & Retest:** confirmed close-based S/R break; entry on the retest.
- **Trend Pullback:** EMA9/21 trend intact + pullback to EMA21/VWAP + MACD
  momentum resuming.
Each setup computes its **own** entry zone, stop (invalidation), and direction
from market structure, and a self-strength.

### The gate (js/confluence.js `evaluate()`)
A signal **LOCKS** only when ALL hold (all thresholds in `js/config.js`):
1. a setup triggered within `gate.triggerRecencyBars` (3) bars,
2. **≥ `gate.minAgree` (6) of 10** strategies agree with the setup direction,
   and none of `gate.vetoStrategies` (RSI, SMC, S/R) contradicts,
3. **HTF bias TF (`config.htf.biasTf`, 15m) is not counter** — a HARD gate
   (bias from EMA structure + swings). A second, slower **regime layer**
   (`config.htf.regimeTf`, 1h) is checked too: if its structure OPPOSES the
   signal, `config.htf.regimeMode` decides — `"downgrade"` lowers the tier one
   notch (default), `"veto"` rejects it, `"off"` ignores it. The backtest
   consumes real 1h klines the same way it does 15m (parity). The separate BTC
   market-regime filter (`config.regime`) stays on 15m, unchanged.
4. **R:R to TP1 ≥ `gate.minRR` (1.2)** with room to the nearest opposing
   structure, and
5. **scalper guardrail:** stop distance ≤ `scalper.stopCapPct[tf]`
   (0.6% on 1m, 1.2% on 5m).

Outputs per signal: **tier** (A+ ≥8 aligned & HTF strong; A ≥7; B ≥6), a
**0–100 score** (blend of setup strength, avg aligned-strategy strength, aligned
count, HTF), **named contributors** with individual scores, a plain-language
**confluence checklist**, and levels: entry zone, stop, **TP1 (1.5R)**,
**TP2 (3R)**.

---

## 6. Signal lifecycle, outcomes & ledger

- On lock, a **frozen** record is created: side and all levels never change
  afterward — only **status** advances:
  `LOCKED → RUNNING → TP1 HIT → TP2 HIT / STOPPED / EXPIRED`.
- **Outcome simulation** (`trackOutcome`, also used by the backtest): limit
  entry fills when price trades into the zone; **half off at TP1**, stop moves to
  **breakeven**, runner to **TP2**; conservative intrabar (stop/BE assumed before
  target). **Expires** if unfilled within `scalper.expireBars[tf]` (10 bars).
- **Realized R — gross and net.** Each outcome yields a **gross R** (ideal fills:
  stopped −1R, TP1→BE +0.75R, TP1+TP2 +2.25R) and a **net R** after the realistic
  cost model (`js/costs.js`, driven by `config.costs`): fees + slippage on every
  fill, entries/TPs as MAKER limit fills, stop/breakeven as TAKER market fills
  crossing the spread. `realizedR` == net. Both are stored per signal and both
  are shown; on scalps the net drag is material (often 0.2–0.4R/trade).
- **Ledger** (persisted, survives restarts): one immutable record per signal
  (`realizedR` net + `grossR`). Storage is **SQLite** (`ledger.db`) when
  `better-sqlite3` is installed, else a **JSON** file (`ledger.json`); the store
  auto-imports an existing JSON ledger into SQLite once. Export anytime with
  `npm run export-ledger` (`node server.js --export-ledger [path]`). The UI
  summary shows, overall and per setup type: signals (W/L), **win rate, avg net
  R, Net R (PnL), and gross→net**.

**Cost-model config keys (`config.costs`, fractions of price; 0.0005 = 0.05%):**

| Key | Meaning |
|---|---|
| `fees.makerPct` | per-fill fee for MAKER (limit) fills — entry + take-profits |
| `fees.takerPct` | per-fill fee for TAKER (market) fills — stop-loss + breakeven exit |
| `slippage.entryPct` | adverse slippage on the entry fill |
| `slippage.stopPct` | adverse slippage on stop / breakeven market fills |
| `slippage.entryTicks` | accepted but **not applied** (no per-symbol tick size); use the pct fields |
| `spreadPct` | half-spread crossed on taker (stop/BE) fills |

**Regime / exposure config keys (Phase 4):**

| Key | Meaning |
|---|---|
| `htf.biasTf` / `htf.regimeTf` | directional bias TF (hard gate) / slower regime TF (Task 2) |
| `htf.regimeMode` | `"downgrade"` \| `"veto"` \| `"off"` — action when the regime TF opposes a signal |
| `scanner.timeframes` | which TFs are scanned (default `["5m"]`; add `"1m"` to re-enable) (Task 1) |
| `regime.btcFilter` | `"off"` \| `"suppress"` \| `"downgrade"` — how to treat alts counter to BTC bias |
| `regime.btcSymbol` / `regime.btcTimeframe` | which symbol/timeframe defines the market regime |
| `exposure.maxSameDirection` | ACTIVE same-direction signals allowed before new ones are flagged `exposureCapped` |
| `sessionFilter.enabled` / `sessionFilter.allowedUtcHours` | when enabled, signals outside these UTC hours are downgraded + flagged `offSession` (never dropped); ledger `bySession` measures the effect (Task 5) |
| `disabledSetups` | array of setup ids / `id@tf` combos the gate skips (Phase 2) |
| `backtest.minTradesForVerdict` | min trades on a TF before `--compare` issues a keep/disable verdict (default 50) (Task 4) |
| `backtest.walk.trainBars` / `testBars` | walk-forward window sizes; fold count is derived from available candles to cover the full range |
| `backtest.walk.minTrainTrades` / `minTestTrades` | per-fold gates; below them a fold makes "no selection" / is excluded from the OOS aggregate |
| `backtest.walk.minTradesPerFoldWarn` | expected-trades/fold threshold that triggers the up-front sizing warning |
| `timing.incrementalKlineLimit` / `timing.candleCloseGraceMs` | incremental fetch size / post-close scan grace (Phase 3) |

---

## 7. Frontend (index.html, js/app.js, js/chart.js, js/tvwidget.js)

- **Scanner feed:** a card per active/forming signal — pair, TF, direction,
  0–100 score ring, entry/SL/TP1/TP2, contributor chips, age in bars, status
  badge, and a **live price tick** (updated from the 1.5s price push).
- **Detail modal:** TradingView **Lightweight Charts** of the pair/TF with the
  **frozen** entry/SL/TP price lines + trigger-candle marker, the full confluence
  checklist, and a second tab embedding the TradingView **Advanced widget**
  (`MEXC:` symbol) for manual analysis (programmatic levels only draw on the
  Lightweight chart).
- **Ledger column:** immutable records + the PnL summary header.
- **Alerts:** optional browser notification + sound on new A/A+ signals.

---

## 8. Backtest & validation tooling (backtest.js)

Replays candles **bar-by-bar through the same `evaluate()` gate** (no
look-ahead), applies the scalper guardrails, and simulates each plan with the
same half-off/BE/runner rules **and the shared cost model** (gross + net R).
**HTF bias uses REAL higher-timeframe klines sliced by time**
(`htf.htfSliceAtTime`) — identical to the live scanner, not resampled.

**Replay-perf split (`js/confluence.js`).** `evaluate()` is factored into
`evaluateRaw()` (the expensive, params-**independent** scan — strategies,
indicators, setup detection, HTF + regime bias, per-setup metrics; depends only
on candles `[0..i]`) composed with `gateDecision()` (the cheap,
params-**dependent** gate — `minAgree` / `minRR` / `stopCap`). `evaluate(c,h,m)
=== gateDecision(evaluateRaw(c,h,m), m)`, so the **live scanner path is
byte-identical**. The `--walk` grid precomputes `evaluateRaw` **once per bar per
distinct `triggerRecencyBars`** (the only detection knob it varies) and re-applies
`gateDecision` across every `minAgree`/`stopCap`/`expireBars` combo and every
fold — turning an `O(bars × combos × folds)` scan into `O(bars × recencies)`.
Measured: a 5-pair × 800-candle pooled `--walk` dropped from **~110 s to ~16 s**
(~7×), byte-for-byte identical output. No new config keys.

Guarding this: **golden regression** (`tests/golden.test.js`) diffs `--matrix`
and `--walk` on committed fixtures (`tests/golden/fixtures`) against saved
outputs generated **before** the refactor — a byte-level parity gate that fails
loudly on any behavior change. `tests/replayperf.test.js` asserts the split's
three contracts: composition (`evaluate === gateDecision∘evaluateRaw`),
params-independence of `evaluateRaw`, and empirical **no-look-ahead** (raw at bar
`i` is invariant to poisoned future candles; the precompute also asserts the
slice endpoint structurally).

Base runs: `node backtest.js SYMBOL TF CANDLES` | `--scan TF CANDLES` | `--demo`.
Reports per setup type / per tier / (per pair in `--scan`): n, win rate,
gross & net expectancy, **profit factor**, and max drawdown in R.

Validation flags:
- `--split [frac]` — in-sample vs out-of-sample split (default 0.7); prints both
  and whether edge **holds out-of-sample**.
- `--matrix` — runs all scanner timeframes and prints a **setup × timeframe ×
  tier** net-expectancy table.
- `--compare 1m 5m CANDLES` — runs the same period on both TFs and prints a
  side-by-side net-R / profit-factor / trade-count / max-DD table (overall and
  per setup), ending with a per-setup verdict ("keep both" / "keep 5m only" /
  "disable both"). A setup needs ≥ `backtest.minTradesForVerdict` (default 50)
  trades on a TF or its side is **"insufficient data"** — never a recommendation
  on a thin sample.
- `--walk` — **walk-forward**: grid-searches {`gate.minAgree`,
  `scalper.stopCapPct`, `scalper.expireBars`, `gate.triggerRecencyBars`} on
  rolling train windows, applies the winner to the next (out-of-sample) window,
  and aggregates OOS results. **Fold count/coverage are derived from the candles
  actually available** (`js/walk.js`, `backtest.walk.{trainBars,testBars}`) and
  the header prints total candles / warm-up / **coverage %** so a truncated fetch
  is visible. Folds with < `walk.minTrainTrades` train trades report
  "no selection" and are excluded; OOS with < `walk.minTestTrades` is dropped
  from the aggregate. A **sizing warning** fires up-front when expected
  trades/fold is below `walk.minTradesPerFoldWarn`, suggesting more candles or a
  pooled `--data` run. See **PARAMS.md**.
- `--walk --data <dir> TF` — **pooled multi-pair** walk-forward. Loads
  `<SYMBOL>.json` files (`{ "5m": [...], "15m": [...], "1h": [...] }`, raw MEXC
  klines or parsed candles), shares folds **by timestamp**, and pools every
  pair's trades per fold — the way to reach meaningful per-fold trade counts that
  a single 5m pair never can. The per-bar scan is cached across the grid (see
  the replay-perf split above), so a pooled `--walk` runs in minutes, not hours.

### Deep-history fetching (`fetch-data.js`)

MEXC caps a single klines request at ~500 rows. `js/mexc.js getKlinesDeep` pages
**backward via `endTime`** to assemble an arbitrary depth, stitching by open
time (`stitchDeep`), de-duplicating the seam candle, validating continuity
(records gaps), and honoring rate-limit backoff. `fetch-data.js` uses it to write
the pooled `--data` format:

```bash
node fetch-data.js --out ./klines --top 20 --limit 20000        # top-20 pairs, ~69 days of 5m
node fetch-data.js --out ./klines --pairs BTCUSDT,ETHUSDT --limit 20000
```

Each `<SYMBOL>.json` carries all needed TFs (`5m` + `15m` bias + `1h` regime, HTF
sized to the same span), BTCUSDT is always included (BTC-regime filter), and
`manifest.json` records **requested vs received** (and gap counts) per pair/TF.
The backtest's own real-provider fetches now page deep too (so `--limit` beyond
500 isn't silently truncated), and `mexc.getKlines` warns once if a single
>500-row request comes back short.

The negative-expectancy report prints a suggested **`config.disabledSetups`**
array (setup ids and `id@tf` combos with negative net expectancy).

---

## 9. Tech stack & files

- **Runtime:** Node.js 18+ (ES modules, built-in `http`, global `fetch`). No
  required runtime deps on the default path; **optional** `better-sqlite3`
  (ledger storage, JSON fallback) and `ws` (unverified websocket path).
- **Frontend:** vanilla JS ES modules, no framework/build step; TradingView
  Lightweight Charts + Advanced widget from CDN.
- **Key files:** `server.js`, `js/{config,mexc,scanner,confluence,setups,htf,
  indicators,costs,ledgerstore,app,chart,tvwidget,mexcws,mockprovider}.js`,
  `js/{walk,verdict}.js`, `js/strategies/*`, `backtest.js`, `fetch-data.js`,
  `tests/*` (indicators, setups, mexc, costs, scanner, regime, ledgerstore,
  timeframes, htflayer, verdict, session, walk, fetchdeep, replayperf, and the
  `golden` byte-parity regression with committed fixtures).
- **Config:** everything tunable is in `js/config.js`.

---

## 10. Known limitations / candidate areas to improve

Explicitly listed so a reviewer has hooks:

1. **Polling, not streaming.** Prices still poll at 1.5s (scanning is now
   candle-close-driven, Phase 3). Verifying + wiring the MEXC websocket
   (protobuf) would give true tick-level real-time.
2. **Kline refetch — now incremental (Phase 3).** After warm-up each cycle
   fetches only the last few candles and merges by open time (full refetch on
   gap/startup). Remaining win: kline **websocket** streams to drop polling
   entirely.
3. **Signal quality is unvalidated on real data.** The gate/weights/guardrails
   are heuristic; no real-money or large historical validation has been run
   (build env couldn't reach MEXC). Needs real backtests + parameter tuning, and
   ideally walk-forward / out-of-sample testing.
4. **Outcome model — costs now included (Phase 1), gaps remain.** Fees +
   slippage + spread are modeled in `js/costs.js` (`config.costs`) and reported
   as gross vs net R. Still simplified: no funding, no partial fills, a single
   fixed fill assumption, no per-symbol tick size / real spread (uses a flat
   `spreadPct` estimate), conservative intrabar ordering only.
5. **Partial portfolio awareness (Phase 4):** BTC regime filter + a
   same-direction exposure cap exist, but there is still **no position sizing**,
   no cross-pair correlation handling, and no aggregate risk budget.
6. **HTF divergence fixed (Phase 2):** the backtest now consumes real 15m klines
   sliced by time (`htf.htfSliceAtTime`), matching the live scanner. (The mock
   provider still derives its own 15m by resampling its 1m base — self-consistent.)
7. **Persistence improved (Phase 5):** SQLite (`better-sqlite3`) with a JSON
   fallback + export command. Still no auth / multi-user, and analytics are the
   session summary + the ledger table (no separate reporting UI).
8. **SSE reconnect handled (Phase 5):** monotonic ids + full snapshot on every
   (re)connect. Remaining: no delta replay buffer (snapshot supersedes), and no
   automated e2e UI tests beyond the modal + server smoke checks.
9. **Contributor direction shown (Phase 5):** each chip carries a ▲/▼ for its own
   side, so bullish-named strategies on a short read as bearish, not contradictory.
10. **Security/ops:** binds `0.0.0.0`-style local server with no rate limiting or
    input validation on `/api/klines` beyond basics; intended for localhost only.

---

## 11. What it deliberately does NOT do

No order placement / trading, no API keys, no leverage/derivatives, no
financial advice. Signals are illustrative.
