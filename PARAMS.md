# 5m parameter sanity pass (Task 3)

With **5m** now the primary scalping timeframe (`config.scanner.timeframes:
["5m"]`), this note reviews the timing/risk defaults that most affect 5m
behavior. **No defaults were changed in code** — changing behavior silently would
be wrong. Everything below is a *proposal* plus the reasoning; every parameter is
already a `config.js` value, and `node backtest.js --walk 5m <candles>` now
grid-searches over them so you can decide from data (on real MEXC klines, not the
synthetic sample the build environment is limited to).

## Parameters reviewed

| Param (config path) | Current default | On 5m that means | Assessment | Proposed to test |
|---|---|---|---|---|
| `scalper.expireBars["5m"]` | `10` | a limit entry is abandoned after **50 min** if unfilled | Likely **too long**. These are retest/pullback/sweep-reversal entries; if price hasn't returned to the zone within ~30 min it has usually left without you, and a fill 45 min later is a *different* trade in a *different* context than the one the setup described. | **6** (30 min). Grid: `{10, 6}`. |
| `gate.triggerRecencyBars` | `3` | the setup event must be within the last **15 min** | **Reasonable.** A sweep/breakout/divergence acted on within 15 min is still fresh on 5m. Tighter (2 = 10 min) reduces stale entries but also cuts signal count. | Keep **3**; test **2**. Grid: `{3, 2}`. |
| `scalper.stopCapPct["5m"]` | `1.2%` | setups with a stop wider than 1.2% of entry are rejected | On the **generous** side for scalping alts. A 1.2% stop implies a 1.8% TP1 (1.5R) and 3.6% TP2 (3R) — achievable, but tighter structure keeps R small and win-rate friendlier to fees. Too tight, though, and you reject most setups. | Test **tighter** (~0.9%) and looser. Grid scales the cap by `{0.75, 1.0, 1.5}` → `{0.9%, 1.2%, 1.8%}`. |

Related (not re-tuned here, but worth noting on 5m):
- `gate.tp1R` / `gate.tp2R` (1.5 / 3.0) — unchanged; the half-off-at-TP1 →
  breakeven → runner model is TF-agnostic.
- `backtest.maxBarsToFill` (10) — the backtest's own fill window; keep it ≥ the
  `expireBars` you settle on so live and backtest agree on "did it fill".

## How to decide (don't trust the synthetic numbers)

```bash
# Walk-forward now grids minAgree × stopCap × expireBars × triggerRecencyBars
node backtest.js --walk 5m 1500
# And compare in/out-of-sample stability for a fixed config:
node backtest.js BTCUSDT 5m 1500 --split
```

The walk-forward's per-fold "chosen(...)" column shows which
`(minAgree, capScale, expire, recency)` won each training window and how it did
out-of-sample. If a tighter `expireBars`/`stopCapPct` consistently wins OOS
across folds **and** pairs, promote it to the default in `config.js`. If results
are noisy or the OOS trade count is thin, **leave the defaults alone** — a small
sample is not evidence.

## Applying a change

Because these are plain config values, promoting a proposal is a one-line edit,
e.g.:

```js
// js/config.js
scalper: {
  stopCapPct: { "1m": 0.6, "5m": 0.9, "15m": 2.0 },  // was 1.2 on 5m
  expireBars: { "1m": 10, "5m": 6,  "15m": 12 },      // was 10 on 5m
},
gate: { /* ... */ triggerRecencyBars: 3 /* or 2 */ },
```
