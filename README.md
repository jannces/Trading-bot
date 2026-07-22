# Crypto Trade-Plan Generator

A **local, static** web app (plain HTML/CSS + vanilla JS ES modules, no build
step) that turns live crypto data into **one actionable trade plan — or an
explicit NO TRADE**. It is deliberately *not* a "verdict meter": instead of
averaging indicators into a fuzzy lean, it waits for a **named setup** to trigger
on a concrete event, confirms it against 10 strategies and the higher-timeframe
bias, and only then emits an entry / stop / take-profit plan. Most of the time it
says **NO TRADE**, and that is the point.

> **Educational tool — not financial advice.** Setups, entries and targets are
> illustrative and can be wrong. Do your own research and manage your own risk.

---

## How to run

### One-click launcher
- **Windows:** double-click **`run.bat`**
- **macOS / Linux:** `chmod +x run.sh` once, then `./run.sh`

### Manual
It uses ES modules, so serve over HTTP (opening `index.html` as a `file://`
won't load modules):

```bash
python -m http.server 8000       # or: python3 -m http.server 8000 / npx serve
```

Open <http://localhost:8000>. The candlestick chart uses **TradingView
Lightweight Charts** loaded from a CDN, and a second tab embeds the full
**TradingView Advanced Chart** widget — so you'll want internet access for the
charts (signals themselves work from the fetched candle data).

### Run the tests
```bash
npm test           # runs both test files
# or individually:
node tests/indicators.test.js   # EMA/RSI/MACD/ATR/Bollinger math (22 checks)
node tests/setups.test.js       # HTF bias, resampling, setup triggers, gate, outcomes (27 checks)
```

### Backtest (prove it works)
```bash
node backtest.js BTCUSDT 5m 1000
node backtest.js BTCUSDT 15m 1000
node backtest.js --demo 1500     # offline synthetic data, no network
```
See **"Backtesting & tuning"** below for what it reports.

---

## What the app shows

1. **Hero card — the trade plan.** Either:
   - **ACTIVE SETUP** (only when the gate passes): direction (LONG/SHORT), pair,
     timeframe, **entry zone**, **stop-loss** (beyond the invalidation point with
     an ATR buffer), **TP1 (1.5R)** and **TP2 (3R)** with the R:R shown, a
     **confidence tier (A+ / A / B)**, a **checklist of exactly which confluences
     fired** in plain language, the **trigger candle timestamp**, and a live
     **outcome** (awaiting entry / running / TP1 / TP2 / stopped / **invalidated**
     if price later closes beyond the stop).
   - **NO TRADE** (the default): a clear "no high-probability setup right now"
     with *what's missing* (e.g. "Breakout & Retest LONG triggered but only
     5/10 aligned; counter to 1h trend — standing aside").
2. **Charts** (two tabs): the **Signal chart** (Lightweight Charts) with the
   plan's entry/SL/TP price lines and a marker on the trigger candle; and the
   **TradingView Advanced** widget for your own analysis. Programmatic levels
   only appear on the Signal chart — the embedded widget can't be drawn on (the
   UI says so).
3. **Confirmations** — the 10 strategies with signal / strength / reason.
4. **Plan history** (session-only) — every emitted plan with its levels, tier,
   and live outcome.
5. **Alerts** — optional browser notification + sound when a new **A / A+** plan
   appears while auto-refresh is on.

---

## The setups (the signal, not an average)

`confluence.js` is built around **named setups** (`setups.js`). Each must be
triggered by a concrete **event** and defines its **own** entry zone,
invalidation (stop) and direction from structure — the 10 strategies then act as
confirmations/vetoes, not co-equal votes.

1. **Sweep & Reverse (SMC)** — a liquidity sweep of a prior swing high/low
   followed by displacement the other way → entry at the fair-value gap / order
   block left by the displacement; stop beyond the swept wick.
2. **Divergence Reversal** — regular RSI divergence at a swing point, confirmed
   by a Stochastic/Bollinger extreme and a reaction candle → entry near the
   divergence swing; stop beyond it.
3. **Breakout & Retest** — a confirmed *close-based* S/R breakout → entry on the
   retest of the broken level; stop back beyond the level.
4. **Trend Pullback** — EMA9/21 trend intact + a pullback to EMA21/VWAP with MACD
   momentum resuming → entry in the pullback band; stop beyond the last swing.

---

## The gate (the "high quality" filter)

A plan is emitted **only when ALL** of these pass (all thresholds in
`config.js → gate`):

1. **A named setup triggered** on the active timeframe within the last
   `triggerRecencyBars` candles (an event, not a state).
2. **≥ `minAgree` (default 6) of 10 strategies** agree with the setup direction,
   **and none of the top-weighted three** (`vetoStrategies`: RSI-divergence, SMC,
   S/R) actively contradicts it.
3. **Higher-timeframe bias is not counter.** The app fetches one HTF alongside
   the active TF (`htfMap`: 5m→1h, 15m→1h, 1h→4h, 4h→1d, 1d→1w) and computes bias
   from EMA structure + last swing. Counter-HTF setups are rejected (and the
   NO-TRADE reason says so).
4. **≥ `minRR` (default 1.2) room to TP1** before the nearest opposing structure;
   otherwise rejected.

**Tier:** A+ = `tiers.aPlusAgree` (8) aligned **and** HTF strongly agrees;
A = `tiers.aAgree` (7); B = `tiers.bAgree` (6).

---

## How to change weights / thresholds

Everything tunable lives in **`js/config.js`** (plain data):

| Setting | Where | What it does |
|---|---|---|
| Gate | `CONFIG.gate` | `minAgree`, `vetoStrategies`, `triggerRecencyBars`, `minRR`, `tp1R`/`tp2R`, tier thresholds, `requireHtfAlignment`. |
| Setups on/off | `CONFIG.setups` | Enable/disable each setup and tweak its ATR buffers. Set `enabled:false` to switch one off. |
| HTF mapping | `CONFIG.htfMap` | Which higher timeframe backs each active timeframe. |
| Strategy weights | `CONFIG.weights` | Relative weighting; the three biggest are the veto set. |
| Indicator periods | `CONFIG.indicators` | EMA/RSI/MACD/BB/Stochastic periods, pivot sensitivity. |
| Risk / backtest | `CONFIG.risk`, `CONFIG.backtest` | ATR period, fill window, warm-up. |
| Alerts | `CONFIG.notifications` | Default on/off and `minTierForAlert`. |

All indicator math is in **`js/indicators.js`** as auditable pure functions.

---

## Backtesting & tuning

```bash
node backtest.js SYMBOL TF CANDLES
```

Replays candles **bar-by-bar through the exact same `evaluate()` gate** the
dashboard uses, with **no look-ahead** (only `candles[0..i]` are visible at bar
`i`). The higher-timeframe bias is derived by **resampling those same candles**,
so live and backtest share one code path. Each emitted plan is simulated:

- limit **entry fills** when price trades into the zone (else it expires),
- **half off at TP1**, stop moved to **breakeven**, runner to **TP2**,
- **conservative intrabar order** (stop/breakeven assumed to fill before a
  target), so results are a floor, not an optimistic ceiling.

It reports, **per setup type and per tier**: number of signals, win rate,
average R, expectancy (R/trade), and max drawdown in R (equity curve). If any
setup shows **negative expectancy** on your sample, it tells you to set
`CONFIG.setups.<id>.enabled = false`.

**On real data:** run it on `BTCUSDT 5m` and `15m` (and your own pairs) before
trusting anything, and disable any setup that prints negative expectancy over a
reasonable sample.

> **Note on this build's own verification:** the sandbox used to build this
> could not reach Binance/CoinGecko (egress policy returns HTTP 403), so the
> real-data backtests must be run on your machine. The engine, gate,
> simulation and report were validated end-to-end on synthetic data
> (`node backtest.js --demo`) and by the test suite; the parser targets
> Binance's documented kline layout and runs from your browser/Node where the
> endpoint is reachable, with automatic fallback to Binance.US then CoinGecko.

---

## Project structure

```
index.html
css/style.css
js/main.js            App state, fetch loop (active TF + HTF), rendering, alerts
js/api.js             Binance/CoinGecko fetching + fallback + error handling
js/chart.js           TradingView Lightweight Charts wrapper (candles/volume/levels)
js/tvwidget.js        TradingView Advanced Chart embed (second tab)
js/confluence.js      The gate: setup + strategies + HTF -> plan | NO TRADE; outcomes
js/setups.js          Named event-triggered setups (entry/stop/direction from structure)
js/htf.js             Higher-timeframe bias + resampling
js/config.js          All gate thresholds, setup switches, weights, periods (edit here)
js/indicators.js      Pure indicator math (audit/tweak here)
js/strategies/        The 10 confirmation strategies + index.js registry
backtest.js           Bar-by-bar replay of the gate + trade simulation + stats
run.bat / run.sh      One-click launcher menus
tests/indicators.test.js   Indicator math tests
tests/setups.test.js       HTF bias, resampling, setup-trigger, gate, outcome tests
README.md
```

---

## The 10 confirmation strategies

Each exports `analyze(candles) → { signal, strength, reason }`:
EMA Crossover (9/21), RSI(14)+divergence, MACD (12/26/9), Bollinger (20,2),
Ichimoku Cloud, Stochastic (14,3,3), VWAP (session), S/R Breakout, Smart Money
Concepts (ICT), Volume (OBV + spikes). In this build they are **confirmations**
for the gate, not the signal themselves.

---

## Known limitations

- **Not financial advice.** Mechanical setups on lagging data; a study aid.
- **Charts need a CDN** (TradingView Lightweight Charts + the Advanced widget). If
  offline, signals still compute but the chart shows a fallback message.
- **CoinGecko fallback has no volume**, so OBV/volume confirmations degrade there
  (the status bar tells you when this feed is active).
- **Backtest HTF is resampled** from the base candles (not a separate fetch) to
  stay look-ahead-free; live uses a real HTF fetch — a small, deliberate
  difference.
- **Session-only history** — clears on reload. Alerts require granting the
  browser notification permission.
- **Thresholds are heuristic** — tune them in `config.js` using the backtest,
  and disable any setup with negative expectancy on your market/timeframe.
