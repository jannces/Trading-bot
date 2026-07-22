// ============================================================================
// setups.js — Named, event-triggered trade setups.
//
// A setup only EXISTS when a concrete event has just happened (a sweep, a
// divergence, a breakout, a pullback-with-momentum), not merely when an
// indicator is in some state. Each detector returns null OR a setup object that
// carries its OWN entry zone, invalidation (stop) and direction, derived from
// market structure — the 10 strategies then act as confirmations/vetoes in the
// gate (confluence.js), they do not vote the setup into existence.
//
// Setup shape:
//   { id, name, direction: "LONG"|"SHORT", triggerIndex, triggerTime,
//     entryLow, entryHigh, entryPrice, stop, rationale, hints:[...] }
//   entryPrice = the reference fill used for R math (top of a long zone / bottom
//   of a short zone — the price a retrace-limit realistically fills at).
// ============================================================================
import {
  ema, rsi, macd, bollinger, stochastic, vwap, atr,
  pivotHighs, pivotLows, pivotsOnSeries, last,
} from "./indicators.js";
import { CONFIG } from "./config.js";

/** Precompute every indicator once so detectors stay cheap and consistent. */
export function buildContext(candles) {
  const I = CONFIG.indicators;
  const closes = candles.map((c) => c.close);
  return {
    closes,
    ema9: ema(closes, I.emaFast),
    ema21: ema(closes, I.emaSlow),
    rsiSeries: rsi(closes, I.rsiPeriod),
    macd: macd(closes, I.macdFast, I.macdSlow, I.macdSignal),
    bb: bollinger(closes, I.bbPeriod, I.bbMult),
    stoch: stochastic(candles, I.stochK, I.stochSmooth, I.stochD),
    vwapSeries: vwap(candles),
    atrSeries: atr(candles, CONFIG.risk.atrPeriod),
    pivH: pivotHighs(candles, I.pivotLeft, I.pivotRight),
    pivL: pivotLows(candles, I.pivotLeft, I.pivotRight),
  };
}

/** Run all enabled detectors; return every setup that triggered (0..n). */
export function detectSetups(candles, ctx = buildContext(candles)) {
  const found = [];
  const S = CONFIG.setups;
  if (S.sweep_reverse.enabled) found.push(detectSweepReverse(candles, ctx));
  if (S.divergence_reversal.enabled) found.push(detectDivergenceReversal(candles, ctx));
  if (S.breakout_retest.enabled) found.push(detectBreakoutRetest(candles, ctx));
  if (S.trend_pullback.enabled) found.push(detectTrendPullback(candles, ctx));
  return found.filter(Boolean);
}

const recencyStart = (n) => n - 1 - CONFIG.gate.triggerRecencyBars;

// ---------------------------------------------------------------------------
// 1) Sweep & Reverse (SMC): liquidity sweep of a prior swing + displacement.
// ---------------------------------------------------------------------------
function detectSweepReverse(candles, ctx) {
  const n = candles.length;
  const a = last(ctx.atrSeries) || candles[n - 1].close * 0.005;
  const buf = CONFIG.setups.sweep_reverse.atrBuffer;
  const start = Math.max(3, recencyStart(n));

  for (let i = n - 1; i >= start; i--) {
    const cur = candles[i];
    const body = Math.abs(cur.close - cur.open);
    const displaced = body > a * 0.5;
    if (!displaced) continue;

    // LONG: swept a prior low then closed back above with a bullish body.
    if (cur.close > cur.open) {
      const priorLows = ctx.pivL.filter((p) => p.index <= i - 1).slice(-4);
      for (const l of priorLows) {
        if (cur.low < l.price && cur.close > l.price) {
          const fvg = bullishFVG(candles, i);
          const zone = fvg || { low: Math.min(cur.open, l.price), high: cur.close };
          const stop = cur.low - a * buf;
          if (zone.high <= stop) continue;
          return mkSetup("sweep_reverse", "Sweep & Reverse", "LONG", i, candles[i].time, zone.low, zone.high, stop, [
            `liquidity sweep of prior low ${fmt(l.price)} + bullish displacement`,
            fvg ? "entry at displacement fair-value gap" : "entry at reversal candle body",
          ]);
        }
      }
    }
    // SHORT: swept a prior high then closed back below with a bearish body.
    if (cur.close < cur.open) {
      const priorHighs = ctx.pivH.filter((p) => p.index <= i - 1).slice(-4);
      for (const h of priorHighs) {
        if (cur.high > h.price && cur.close < h.price) {
          const fvg = bearishFVG(candles, i);
          const zone = fvg || { low: cur.close, high: Math.max(cur.open, h.price) };
          const stop = cur.high + a * buf;
          if (zone.low >= stop) continue;
          return mkSetup("sweep_reverse", "Sweep & Reverse", "SHORT", i, candles[i].time, zone.low, zone.high, stop, [
            `liquidity sweep of prior high ${fmt(h.price)} + bearish displacement`,
            fvg ? "entry at displacement fair-value gap" : "entry at reversal candle body",
          ]);
        }
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// 2) Divergence Reversal: regular RSI divergence at a swing + extreme + reaction.
// ---------------------------------------------------------------------------
function detectDivergenceReversal(candles, ctx) {
  const n = candles.length;
  const a = last(ctx.atrSeries) || candles[n - 1].close * 0.005;
  const buf = CONFIG.setups.divergence_reversal.atrBuffer;
  const { pivotLeft, pivotRight } = CONFIG.indicators;
  const rsiPiv = pivotsOnSeries(ctx.rsiSeries, pivotLeft, pivotRight);
  const kNow = last(ctx.stoch.k);
  const price = candles[n - 1].close;
  const reactionUp = candles[n - 1].close > candles[n - 1].open;
  const reactionDn = candles[n - 1].close < candles[n - 1].open;
  const maxAge = CONFIG.gate.triggerRecencyBars + pivotRight + 2;

  // Bullish divergence: price lower low, RSI higher low.
  if (ctx.pivL.length >= 2 && rsiPiv.lows.length >= 2) {
    const p2 = ctx.pivL[ctx.pivL.length - 1];
    const p1 = ctx.pivL[ctx.pivL.length - 2];
    const r2 = nearestPiv(rsiPiv.lows, p2.index);
    const r1 = nearestPiv(rsiPiv.lows, p1.index);
    if (r1 && r2 && p2.price < p1.price && r2.value > r1.value && n - 1 - p2.index <= maxAge) {
      const oversold = (kNow != null && kNow < 25) || price <= (ctx.bb.lower[n - 1] ?? -Infinity);
      if (oversold && reactionUp) {
        const entryLow = p2.price;
        const entryHigh = p2.price + a * 0.5;
        const stop = p2.price - a * buf;
        return mkSetup("divergence_reversal", "Divergence Reversal", "LONG", n - 1, candles[n - 1].time, entryLow, entryHigh, stop, [
          "regular bullish RSI divergence at swing low",
          oversold ? "oscillator oversold / lower-band tag" : "",
          "bullish reaction candle",
        ]);
      }
    }
  }
  // Bearish divergence: price higher high, RSI lower high.
  if (ctx.pivH.length >= 2 && rsiPiv.highs.length >= 2) {
    const p2 = ctx.pivH[ctx.pivH.length - 1];
    const p1 = ctx.pivH[ctx.pivH.length - 2];
    const r2 = nearestPiv(rsiPiv.highs, p2.index);
    const r1 = nearestPiv(rsiPiv.highs, p1.index);
    if (r1 && r2 && p2.price > p1.price && r2.value < r1.value && n - 1 - p2.index <= maxAge) {
      const overbought = (kNow != null && kNow > 75) || price >= (ctx.bb.upper[n - 1] ?? Infinity);
      if (overbought && reactionDn) {
        const entryHigh = p2.price;
        const entryLow = p2.price - a * 0.5;
        const stop = p2.price + a * buf;
        return mkSetup("divergence_reversal", "Divergence Reversal", "SHORT", n - 1, candles[n - 1].time, entryLow, entryHigh, stop, [
          "regular bearish RSI divergence at swing high",
          overbought ? "oscillator overbought / upper-band tag" : "",
          "bearish reaction candle",
        ]);
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// 3) Breakout & Retest: confirmed close-based S/R break; entry on the retest.
// ---------------------------------------------------------------------------
function detectBreakoutRetest(candles, ctx) {
  const n = candles.length;
  const a = last(ctx.atrSeries) || candles[n - 1].close * 0.005;
  const cfg = CONFIG.setups.breakout_retest;
  const start = Math.max(1, recencyStart(n));

  for (let i = n - 1; i >= start; i--) {
    const cur = candles[i];
    const prev = candles[i - 1];
    // Breakout up: prior bar at/under a resistance, this bar closes clearly above.
    const res = ctx.pivH.filter((p) => p.index <= i - 1).map((p) => p.price);
    for (const level of res.sort((x, y) => x - y)) {
      if (prev.close <= level + a * 0.1 && cur.close > level + a * cfg.atrBuffer) {
        const pad = a * cfg.retestPad;
        const stop = level - a * cfg.atrBuffer;
        return mkSetup("breakout_retest", "Breakout & Retest", "LONG", i, candles[i].time, level - pad, level + pad, stop, [
          `confirmed close above resistance ${fmt(level)}`,
          "long the retest of the broken level",
        ]);
      }
    }
    // Breakdown: prior bar at/over a support, this bar closes clearly below.
    const sup = ctx.pivL.filter((p) => p.index <= i - 1).map((p) => p.price);
    for (const level of sup.sort((x, y) => y - x)) {
      if (prev.close >= level - a * 0.1 && cur.close < level - a * cfg.atrBuffer) {
        const pad = a * cfg.retestPad;
        const stop = level + a * cfg.atrBuffer;
        return mkSetup("breakout_retest", "Breakout & Retest", "SHORT", i, candles[i].time, level - pad, level + pad, stop, [
          `confirmed close below support ${fmt(level)}`,
          "short the retest of the broken level",
        ]);
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// 4) Trend Pullback: EMA trend intact + pullback to EMA21/VWAP + MACD resuming.
// ---------------------------------------------------------------------------
function detectTrendPullback(candles, ctx) {
  const n = candles.length;
  const i = n - 1;
  const a = last(ctx.atrSeries) || candles[i].close * 0.005;
  const cfg = CONFIG.setups.trend_pullback;
  const e9 = ctx.ema9[i];
  const e21 = ctx.ema21[i];
  const vw = ctx.vwapSeries[i];
  const hist = ctx.macd.hist;
  if (e9 == null || e21 == null || hist[i] == null || hist[i - 1] == null || hist[i - 2] == null) return null;

  const price = candles[i].close;
  const nearEma = Math.abs(price - e21) < a * cfg.nearBand;
  const nearVwap = vw != null && Math.abs(price - vw) < a * cfg.nearBand;
  const histTurnedUp = hist[i] > hist[i - 1] && hist[i - 1] <= hist[i - 2];
  const histTurnedDn = hist[i] < hist[i - 1] && hist[i - 1] >= hist[i - 2];

  // Uptrend pullback.
  if (e9 > e21 && (nearEma || nearVwap) && histTurnedUp) {
    const bandLo = Math.min(e21, vw ?? e21);
    const bandHi = Math.max(e21, vw ?? e21);
    const lastLow = ctx.pivL.length ? ctx.pivL[ctx.pivL.length - 1].price : bandLo;
    const stop = Math.min(lastLow, bandLo) - a * cfg.atrBuffer;
    const entryLow = bandLo - a * 0.15;
    const entryHigh = bandHi + a * 0.15;
    if (entryHigh > stop) {
      return mkSetup("trend_pullback", "Trend Pullback", "LONG", i, candles[i].time, entryLow, entryHigh, stop, [
        "EMA9>EMA21 uptrend intact",
        nearVwap ? "pullback to VWAP/EMA21" : "pullback to EMA21",
        "MACD histogram turning up",
      ]);
    }
  }
  // Downtrend pullback.
  if (e9 < e21 && (nearEma || nearVwap) && histTurnedDn) {
    const bandLo = Math.min(e21, vw ?? e21);
    const bandHi = Math.max(e21, vw ?? e21);
    const lastHigh = ctx.pivH.length ? ctx.pivH[ctx.pivH.length - 1].price : bandHi;
    const stop = Math.max(lastHigh, bandHi) + a * cfg.atrBuffer;
    const entryLow = bandLo - a * 0.15;
    const entryHigh = bandHi + a * 0.15;
    if (entryLow < stop) {
      return mkSetup("trend_pullback", "Trend Pullback", "SHORT", i, candles[i].time, entryLow, entryHigh, stop, [
        "EMA9<EMA21 downtrend intact",
        nearVwap ? "pullback to VWAP/EMA21" : "pullback to EMA21",
        "MACD histogram turning down",
      ]);
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function mkSetup(id, name, direction, triggerIndex, triggerTime, entryLow, entryHigh, stop, hints) {
  const entryPrice = direction === "LONG" ? entryHigh : entryLow;
  return {
    id, name, direction, triggerIndex, triggerTime,
    entryLow, entryHigh, entryPrice, stop,
    rationale: hints.filter(Boolean)[0] || name,
    hints: hints.filter(Boolean),
  };
}

/** Bullish 3-candle fair-value gap ending at/near index k: low[k] > high[k-2]. */
function bullishFVG(candles, k) {
  for (const kk of [k, k + 1]) {
    if (kk - 2 < 0 || kk >= candles.length) continue;
    const lo = candles[kk].low;
    const hi = candles[kk - 2].high;
    if (lo > hi) return { low: hi, high: lo };
  }
  return null;
}

/** Bearish 3-candle fair-value gap: high[k] < low[k-2]. */
function bearishFVG(candles, k) {
  for (const kk of [k, k + 1]) {
    if (kk - 2 < 0 || kk >= candles.length) continue;
    const hi = candles[kk].high;
    const lo = candles[kk - 2].low;
    if (hi < lo) return { low: hi, high: lo };
  }
  return null;
}

function nearestPiv(pivots, index, maxDist = 3) {
  let best = null;
  let bestDist = Infinity;
  for (const p of pivots) {
    const d = Math.abs(p.index - index);
    if (d < bestDist) { bestDist = d; best = p; }
  }
  return bestDist <= maxDist ? best : null;
}

function fmt(v) {
  return v >= 100 ? v.toFixed(2) : v.toPrecision(5);
}
