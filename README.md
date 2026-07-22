# Crypto Confluence Signal Dashboard

A **local, static** crypto buy/sell signal dashboard. No frameworks, no build
step — plain HTML/CSS and vanilla JavaScript ES modules. It pulls public candle
data, runs **10 independent technical strategies**, and combines them into a
single weighted **confluence score** (−100 … +100) with a color-coded verdict,
a canvas candlestick chart, and an illustrative trade plan for high-quality
setups.

> **Educational tool — not financial advice.** Signals are illustrative and can
> be wrong. Do your own research.

---

## How to run

Because it uses ES modules, you must serve it over HTTP (opening `index.html`
directly with `file://` will not load the modules). From this folder:

```bash
python -m http.server 8000
# or:  python3 -m http.server 8000
# or:  npx serve
```

Then open <http://localhost:8000> in your browser.

### Run the indicator tests

```bash
node tests/indicators.test.js
```

This checks EMA, RSI, MACD, ATR, Bollinger (and SMA/OBV) math against
hand-computed known values from fixed candle arrays. No test framework needed.

### Backtest the confluence engine

Turn weight/threshold tuning from guesswork into something measurable. This
replays recent candles through the **exact same** strategies + confluence code
the dashboard uses, and reports how the **High-Quality** signals would have
performed at **1.5R / 3R**:

```bash
node backtest.js                    # BTCUSDT 15m, 500 candles (defaults)
node backtest.js ETHUSDT 5m 1000    # any pair / timeframe / 300–1000 candles
node backtest.js --demo             # offline: synthetic candles, no network
```

What it does (with **no look-ahead**): for every bar it scores the confluence
on candles up to that bar only, builds the same illustrative plan the UI shows
(entry = that bar's close, ATR/swing stop, TP1 = 1.5R, TP2 = 3R), then walks
forward to see what got hit. Intrabar ties are resolved **conservatively** (if a
candle spans both stop and target, the stop is assumed first), so the win-rates
are a floor, not an optimistic ceiling.

Crucially it **sweeps the High-Quality gate** across several
`minAgreeing × minComposite` settings and prints a table of signal count,
frequency, TP1%/TP2% win-rate, and expectancy (R/trade) for each — so you can
see directly whether **7-of-10 agreement** is too strict (few signals) or too
loose (poor win-rate) *before* changing `js/config.js`. The row matching your
live config is marked, with a detailed breakdown underneath.

> It's a measurement tool on a small, recent, single-sample dataset — not a
> promise of future results, and still not financial advice.

---

## Data sources & fallback

Data is fetched **client-side, from your browser**, trying these in order and
telling you which feed is live (see the "Source:" tag):

1. **Binance.com** — `api.binance.com/api/v3/klines` (full OHLC **+ volume**).
2. **Binance.US** — `api.binance.us` (same shape; used if `.com` is geo-blocked).
3. **CoinGecko OHLC** — mapped from a symbol whitelist. **No volume** on this
   feed, so the Volume/OBV strategy degrades to neutral and the tag says so.

- **Pairs:** dropdown (BTCUSDT, ETHUSDT, SOLUSDT, BNBUSDT, XRPUSDT, DOGEUSDT)
  plus a free-text box for **any** Binance pair.
- **Timeframes:** 5m, 15m, 1h, 4h, 1d (default 15m; 5m is fully supported for
  scalping lower timeframes).
- **Refresh:** manual button + a 60s auto-refresh toggle.

---

## How to change weights / thresholds

Everything tunable lives in **`js/config.js`** — plain data, no logic:

| Setting | Where | What it does |
|---|---|---|
| Strategy weights | `CONFIG.weights` | Relative influence of each strategy on the composite (RSI-divergence, SMC and S/R are weighted slightly higher by default). They don't need to sum to anything. |
| Verdict bands | `CONFIG.thresholds` | Composite cutoffs for STRONG BUY / BUY / NEUTRAL / SELL / STRONG SELL. |
| High-Quality gate | `CONFIG.highQuality` | `minAgreeing` (default 7 of 10) and `minComposite` (default 60). |
| Risk plan | `CONFIG.risk` | ATR period, stop multiplier, TP1/TP2 in R, entry-zone width. |
| Indicator periods | `CONFIG.indicators` | EMA/RSI/MACD/BB/Stochastic periods and pivot sensitivity. |
| Defaults | top of `CONFIG` | Default pair, interval, candle count, auto-refresh seconds. |

The composite is a **weighted average of each strategy's signed strength**
(`+strength` for BUY, `−strength` for SELL, `0` for NEUTRAL), scaled to
−100 … +100. A **High Quality Signal** badge appears only when **≥ 7 of 10**
strategies agree on direction **and** `|composite| ≥ 60`.

All indicator math is in **`js/indicators.js`** as clearly named **pure
functions** (`ema`, `rsi`, `macd`, `atr`, `bollinger`, `stochastic`, `obv`,
`vwap`, `ichimoku`, pivot detection), so you can audit and tweak the formulas.

---

## The 10 strategies

Each file in `js/strategies/` exports the same interface:
`analyze(candles) -> { signal: "BUY"|"SELL"|"NEUTRAL", strength: 0-100, reason }`.

1. **EMA Crossover (9/21)** — fast/slow EMA cross as the trigger; the slow-EMA
   slope scales conviction so with-trend signals score higher.
2. **RSI(14) + Divergence** — overbought/oversold levels **plus proper regular
   divergence** detected via pivots: price makes a lower low while RSI makes a
   higher low (bullish), or price higher high while RSI lower high (bearish).
   Divergence, when recent, overrides the level read.
3. **MACD (12/26/9)** — signal-line crosses as triggers; histogram sign and
   slope add momentum context.
4. **Bollinger Bands (20, 2)** — mean-reversion on band tags in a normal range;
   when a **squeeze** (narrow bands) resolves with a close outside a band, it's
   read as a breakout instead.
5. **Ichimoku Cloud** — combines price vs cloud, Tenkan/Kijun cross, and cloud
   color (Senkou A vs B); agreement of all three is a strong signal.
6. **Stochastic (14, 3, 3)** — %K/%D crosses, strongest when they occur inside
   the oversold (<20) or overbought (>80) zones.
7. **VWAP (session)** — position relative to session VWAP, with reclaim (cross
   back above) and rejection (cross back below) treated as triggers.
8. **Support/Resistance Breakout** — auto-detects swing highs/lows as levels;
   flags confirmed breakouts/breakdowns (a *close* beyond a level) and
   rejections (wick through, close back inside).
9. **Smart Money Concepts (ICT)** — detects Fair Value Gaps, order blocks, and
   **liquidity sweeps**; the premium signal is a sweep of a prior high/low
   followed by a displacement candle the opposite way (stops taken → reversal).
10. **Volume (OBV + spikes)** — OBV trend confirms accumulation/distribution;
    an unusual volume spike adds conviction in the spiking candle's direction.

For **high-quality signals** the dashboard also shows an illustrative **entry
zone**, an **ATR(14)- or swing-based stop**, and take-profits at **1.5R and
3R** — clearly labeled as illustrative, not financial advice.

---

## Project structure

```
index.html
css/style.css
js/main.js            App state, fetch loop, rendering orchestration
js/api.js             Binance/CoinGecko fetching + fallback + error handling
js/chart.js           Canvas candlestick + volume chart (no chart libs)
js/confluence.js      Weighted composite scoring + trade-plan builder
js/config.js          All weights, thresholds, periods, defaults (edit here)
js/indicators.js      Pure indicator math (audit/tweak here)
js/strategies/        One file per strategy + index.js registry
backtest.js           Replay candles through the engine; measure 1.5R/3R + sweep thresholds
tests/indicators.test.js   Node test of the indicator math
README.md
```

---

## Verification performed

- **Indicator tests:** `node tests/indicators.test.js` → 22/22 pass against
  hand-computed values.
- **Pipeline smoke test:** all 10 strategies + the confluence engine run on
  synthetic candles with no errors and in-range outputs.
- **Module paths:** served via `python -m http.server`; every module returns
  `200` with `Content-Type: text/javascript`, and every relative import
  resolves to a real file (no module-path errors).

> Note: the Binance klines endpoint could not be `curl`ed from the sandboxed
> build environment (outbound egress policy returns HTTP 403 for
> `api.binance.com`). The parser is written to Binance's **documented, stable**
> kline row layout — `[openTime, open, high, low, close, volume, closeTime, …]`
> — and the fetch runs from **your** browser, where the endpoint is reachable
> (or it falls back automatically). If you're behind a geo-block, the app will
> transparently switch to Binance.US or CoinGecko.

---

## Known limitations

- **Not financial advice.** Signals are mechanical and lagging; treat them as a
  study aid, not a trading system.
- **CoinGecko fallback has no volume** — OBV/volume-spike signals go neutral on
  that feed (the status bar tells you when this happens).
- **Session VWAP** is computed over the fetched candle window, not a true
  exchange trading session, so it drifts from a broker's session VWAP.
- **Ichimoku** displaces the cloud back onto formed bars for the price-vs-cloud
  read rather than projecting it forward; the leading span visualization is
  simplified.
- **Signal history is session-only** — it clears on page reload (no storage).
- Strengths/weights are **heuristic**, chosen for balance, not fitted to any
  market. Tune them in `js/config.js`.
- **Rate limits:** public endpoints are unauthenticated; very frequent
  refreshing can get you temporarily throttled.
