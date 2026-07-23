# MEXC Scalper Signal Scanner

A local **multi-pair scalper scanner** for MEXC. A small Node backend holds the
exchange connection, scans the **top-50 USDT pairs** on **1m and 5m** (with
**15m** as the higher-timeframe bias), runs the same setup/confluence "brain"
from the previous single-pair version, and pushes results to a dark
signal-terminal frontend over SSE. When a setup passes the strict gate it
becomes a **locked signal** (levels frozen at creation) whose outcome is tracked
live and recorded to a persistent ledger.

> **Educational tool — not financial advice.** Signals, entries and targets are
> illustrative and can be wrong. Do your own research and manage your own risk.

---

## Run it

Requires **Node.js 18+** (uses built-in `fetch` and ES modules).

```bash
npm install
node server.js
# then open http://localhost:8000
```

Offline demo (synthetic data, no network — useful to see it work without MEXC):

```bash
MOCK=1 node server.js      # or: npm run mock
```

One-click menus are also provided: **`run.bat`** (Windows) / **`./run.sh`**
(macOS/Linux).

---

## Live prices — WebSocket vs REST polling (read this)

Per the brief, the websocket format was to be **verified before building on it**.
**The build environment could not reach `api.mexc.com` or `wbs.mexc.com`** (egress
policy returns HTTP 403), so the websocket **could not be tested against the live
exchange**. Following the brief's own fallback guidance, the shipped default is:

- **`CONFIG.liveMode = "poll"`** — the server polls MEXC's all-symbol price
  endpoint (`/api/v3/ticker/price`, one request) every `timing.pricePollMs`
  (1.5s) for live price ticks, and refetches klines each scan cycle with a
  concurrency cap + politeness stagger. This path is what runs today.
- **`js/mexcws.js`** — a MEXC websocket client (`wss://wbs.mexc.com/ws`,
  `{"method":"SUBSCRIPTION","params":["spot@public.deals.v3.api@BTCUSDT"]}`) is
  included **but is NOT wired into the running server**, because it is unverified
  and MEXC has migrated some spot streams to **protobuf**. Before enabling it,
  test locally: if you receive binary frames, decode them with MEXC's protobuf
  schema (<https://github.com/mexcdevelop/websocket-proto>) or keep REST polling.
  The module documents exactly what to check.

So: **prices are live via fast REST polling by default; the websocket is
opt-in and must be verified first.**

---

## How it works

### Backend (`server.js`)
- Ranks the top-50 USDT pairs by 24h quote volume on startup (refreshes hourly),
  excluding leveraged tokens (`…3L/3S`) and stablecoin-vs-stablecoin pairs.
- Fetches 1m / 5m / 15m klines per pair (concurrency-capped, backoff-aware).
- Runs the scanner loop server-side and serves the static frontend.
- Pushes `scan` / `prices` / `signal` / `ledger` events to the browser over
  **SSE** (`/events`). REST helpers: `/api/klines`, `/api/snapshot`,
  `/api/ledger`, `/api/status`.
- Persists the signal ledger so history survives restarts — **SQLite**
  (`ledger.db`, if `better-sqlite3` is installed) or a **JSON** file
  (`ledger.json`) otherwise. Export anytime: `npm run export-ledger`.

### Scanner (`js/scanner.js`)
- Re-evaluates each pair on 1m and 5m every cycle. **Pairs with no setup are not
  shown.** The feed contains only:
  - **active locked signals**, and
  - **forming setups** (event detected, waiting on confirmations — shows what's
    missing), ranked by score.
- **1m signals also require 5m directional agreement.**
- A compact status line shows pairs scanned, scan cycle time, feed source, and
  last update.

### The setups + gate (the "brain", unchanged)
Named, event-triggered setups (`js/setups.js`) — **Sweep & Reverse**,
**Divergence Reversal**, **Breakout & Retest**, **Trend Pullback** — each define
their own entry/stop/direction from structure. A signal **locks** only when
(`js/confluence.js`, all thresholds in `config.js`):

1. a setup triggered on the timeframe (an event, within `triggerRecencyBars`),
2. **≥ `gate.minAgree` (6) of 10** strategies agree, and none of
   `gate.vetoStrategies` (RSI-divergence, SMC, S/R) contradicts,
3. **HTF (15m) bias is not counter**,
4. **R:R to TP1 ≥ `gate.minRR` (1.2)** with room to structure, and
5. **scalper guardrail:** stop distance ≤ `scalper.stopCapPct[tf]`
   (default **0.6% on 1m, 1.2% on 5m**).

**Tier:** A+ (≥8 aligned & HTF strong-aligned), A (≥7), B (≥6). Each signal also
gets a **0–100 score** and named **contributors** (e.g. "Liquidity Sweep · 77",
"RSI Divergence · 81").

### Locked signals (frozen at creation)
When the gate passes, a signal record is frozen: direction, pair, TF, score,
entry zone, SL, TP1/TP2, tier, contributors. **Levels and side never change
after creation** — only the status advances:
`LOCKED → RUNNING → TP1 HIT → TP2 HIT / STOPPED / EXPIRED`. If price runs away
without filling the entry within `scalper.expireBars[tf]` (default 10 on 1m),
it's marked **EXPIRED**. Outcome simulation: half off at TP1, stop to breakeven,
runner to TP2 (conservative intrabar).

### UI (`index.html`, `js/app.js`)
- **Scanner feed** — a card per active/forming signal: pair, TF, direction,
  score ring, entry zone, SL, TP1/TP2, contributor chips, age in bars, status
  badge, and a **live price tick**.
- **Detail view** (click a card) — TradingView **Lightweight Charts** of that
  pair/TF with the **frozen** entry/SL/TP lines and a trigger-candle marker, plus
  the full confluence checklist; a second tab embeds the TradingView **Advanced
  widget** (`MEXC:` symbol) for manual analysis (programmatic levels only appear
  on the Lightweight chart).
- **Signal ledger** — every accepted signal as one immutable record with its
  final outcome and realized R; a summary header shows total / win rate / avg R /
  expectancy, overall and per setup type.
- **Browser notification + sound** on new A/A+ signals (toggle in the top bar).

---

## Backtesting & tuning

```bash
node backtest.js SYMBOL TF CANDLES     # e.g. node backtest.js BTCUSDT 5m 1000
node backtest.js --scan TF CANDLES     # across the current top-50 list
node backtest.js --demo 5m 1000        # offline synthetic data
node backtest.js --demo --scan 5m 1000 # offline scan across mock symbols
```

Replays candles **bar-by-bar through the same `evaluate()` gate** the scanner
uses (no look-ahead; HTF via resampling) with the **scalper guardrails applied**,
simulates each plan (half off at TP1 → breakeven → runner to TP2, conservative
intrabar), and reports **per setup type, per tier (and per pair in `--scan`)**:
signals, win rate, avg R, expectancy, and max drawdown in R. It flags any setup
type with **negative expectancy** so you can disable it via
`CONFIG.setups.<id>.enabled = false`.

### On real data — please run this yourself
The build sandbox can't reach MEXC, so I could **not** run the backtest on live
BTCUSDT 1m/5m. It was validated end-to-end on **synthetic** data instead
(`--demo` / `--demo --scan`), which proves the machinery but is **not** a basis
for enabling/disabling setups — random synthetic candles have no edge, so every
setup nets slightly negative there (that's expected, not evidence). **All four
setups therefore ship enabled.** Run these on your machine and act on the output:

```bash
node backtest.js BTCUSDT 1m 1000
node backtest.js BTCUSDT 5m 1000
node backtest.js --scan 1m 1000
node backtest.js --scan 5m 1000
```

If a setup shows negative expectancy over a reasonable real sample, set
`CONFIG.setups.<id>.enabled = false`.

---

## Configuration (`js/config.js`)

| Area | Key | What |
|---|---|---|
| Exchange | `exchange` | MEXC REST/WS base + interval map (`1h`→`60m`). |
| Scanner | `scanner` | top-N, refresh, scan timeframes, HTF, exclusions. |
| Timing | `timing` | price poll, scan interval, concurrency, backoff. |
| Live mode | `liveMode` | `"poll"` (default) or `"ws"` (unverified). |
| Gate | `gate` | minAgree, veto set, recency, minRR, tiers, forming slack. |
| Scalper | `scalper` | `stopCapPct` and `expireBars` per timeframe. |
| Setups | `setups` | enable/disable each setup + ATR buffers. |
| Server | `server` | port, ledger path. |

Indicator math lives in `js/indicators.js` as auditable pure functions.

---

## Tests

```bash
npm test        # runs all suites (indicators, setups, mexc, costs, scanner, regime, ledgerstore)
```

- `tests/indicators.test.js` — EMA/RSI/MACD/ATR/Bollinger math (hand-computed).
- `tests/setups.test.js` — HTF bias + resampling, setup triggering, the gate
  states, and outcome tracking (waiting/running/tp1/tp2/stopped/expired).
- `tests/mexc.test.js` — MEXC kline / 24hr-ticker parsing and top-pair ranking
  against a fixture in `tests/fixtures/` (constructed from MEXC's documented
  shapes, since the build env couldn't capture a live response).

**Verification done for this build:** all tests pass; the backend was driven
end-to-end on mock data (top-list ranking → scan → gate → locked signals →
outcome tracking → ledger + summary), and the HTTP layer was smoke-tested
(static files, `/api/snapshot`, `/api/klines`, SSE). Live MEXC + the real-data
backtests must be run on your machine.

---

## Project structure

```
server.js               Node backend: MEXC data + scanner loop + static + SSE + ledger
js/config.js            All thresholds, scanner list, scalper guardrails (edit here)
js/mexc.js              MEXC REST client + pure parsers/ranking (fixture-tested)
js/mexcws.js            Optional MEXC websocket client (UNVERIFIED — opt-in)
js/mockprovider.js      Synthetic data provider for MOCK/offline mode
js/scanner.js           Multi-pair scan loop, signal lifecycle, ledger
js/confluence.js        The gate: setup + strategies + HTF -> locked signal; outcomes
js/setups.js            Named event-triggered setups
js/htf.js               Higher-timeframe bias + resampling
js/indicators.js        Pure indicator math
js/strategies/          The 10 confirmation strategies
js/app.js               Browser client (SSE consumer, cards, detail view, alerts)
js/chart.js             TradingView Lightweight Charts wrapper
js/tvwidget.js          TradingView Advanced widget (MEXC: symbol)
index.html, css/        Frontend
backtest.js             Bar-by-bar replay + scalper sim + --scan
tests/                  indicators / setups / mexc + fixtures
run.bat / run.sh        Launcher menus
```

---

## Known limitations

- **Not financial advice.** Mechanical setups on lagging data.
- **WebSocket is unverified** from the build env; REST polling is the default
  live path. Verify `js/mexcws.js` before switching `liveMode` to `"ws"`.
- **Charts need a CDN** (TradingView Lightweight Charts + the Advanced widget).
- **Backtest HTF is resampled** from base candles (no look-ahead); the live
  scanner uses real 15m klines — a small, deliberate difference.
- **Ledger** is local (`ledger.db` SQLite or `ledger.json`); deleting it resets
  history. `npm run export-ledger` writes a portable JSON copy.
- **Thresholds are heuristic** — tune them in `config.js` using the backtest on
  real MEXC data, and disable any setup with negative expectancy.
