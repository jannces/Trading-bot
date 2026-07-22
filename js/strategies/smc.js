// Strategy 9 — Smart Money Concepts (ICT-style).
//
// Detects three structures over the recent window and combines them:
//   1. Fair Value Gaps (FVG): a 3-candle imbalance where candle i-2 and candle i
//      do not overlap (bullish gap: low[i] > high[i-2]; bearish: high[i] < low[i-2]).
//   2. Order Blocks (OB): the last down-candle before a strong up-move (bullish OB)
//      or last up-candle before a strong down-move (bearish OB) — a supply/demand
//      origin price to watch.
//   3. Liquidity sweeps: price runs a prior swing high/low (takes the liquidity
//      resting there) and then DISPLACES back the other way. This sweep-then-
//      displace is the core ICT reversal trigger and is weighted highest here.
import { pivotHighs, pivotLows, atr, last } from "../indicators.js";
import { CONFIG } from "../config.js";

export const meta = {
  key: "smc",
  name: "Smart Money Concepts",
  blurb:
    "ICT-style read of Fair Value Gaps, order blocks and liquidity sweeps. The premium signal is a liquidity sweep of a prior high/low followed by a displacement candle the opposite way — i.e. stops taken, then reversal.",
};

export function analyze(candles) {
  const { pivotLeft, pivotRight } = CONFIG.indicators;
  const n = candles.length;
  const i = n - 1;
  if (n < 10) return { signal: "NEUTRAL", strength: 0, reason: "Not enough data for SMC." };

  const a = last(atr(candles, CONFIG.risk.atrPeriod)) || candles[i].close * 0.005;
  const lookback = Math.min(30, n - 1); // recent structure window
  const start = n - lookback;

  const highs = pivotHighs(candles, pivotLeft, pivotRight);
  const lows = pivotLows(candles, pivotLeft, pivotRight);

  // --- 1) Liquidity sweep + displacement (highest priority) --------------
  const sweep = detectSweep(candles, highs, lows, a);
  if (sweep) return sweep;

  // --- 2) Fair Value Gap in the recent window ----------------------------
  const fvg = detectFVG(candles, start, a);

  // --- 3) Order block bias -----------------------------------------------
  const ob = detectOrderBlock(candles, start, a);

  // Combine FVG + OB into a lower-priority bias.
  let score = 0;
  const reasons = [];
  if (fvg) {
    score += fvg.dir * 2;
    reasons.push(fvg.reason);
  }
  if (ob) {
    score += ob.dir * 1;
    reasons.push(ob.reason);
  }
  if (score > 0) return { signal: "BUY", strength: clamp(35 + score * 8), reason: reasons.join("; ") + "." };
  if (score < 0) return { signal: "SELL", strength: clamp(35 - score * 8), reason: reasons.join("; ") + "." };
  return { signal: "NEUTRAL", strength: 0, reason: "No recent FVG / order block / sweep." };
}

/**
 * Sweep: the current (or immediately prior) bar wicks beyond a recent pivot
 * high/low but closes back inside, AND the close shows displacement (a decent
 * body) in the reversal direction.
 */
function detectSweep(candles, highs, lows, a) {
  const i = candles.length - 1;
  const cur = candles[i];
  const body = Math.abs(cur.close - cur.open);
  const displaced = body > a * 0.5; // meaningful displacement candle

  // Sweep of a prior HIGH (took buy-side liquidity) -> expect SELL.
  const recentHighs = highs.filter((p) => p.index <= i - 1).slice(-3);
  for (const h of recentHighs) {
    if (cur.high > h.price && cur.close < h.price) {
      const strength = clamp(70 + (displaced ? 15 : 0) + ((cur.high - h.price) / a) * 15);
      return { signal: "SELL", strength, reason: `Liquidity sweep of prior high ${fmt(h.price)} then rejection${displaced ? " + displacement" : ""}.` };
    }
  }
  // Sweep of a prior LOW (took sell-side liquidity) -> expect BUY.
  const recentLows = lows.filter((p) => p.index <= i - 1).slice(-3);
  for (const l of recentLows) {
    if (cur.low < l.price && cur.close > l.price) {
      const strength = clamp(70 + (displaced ? 15 : 0) + ((l.price - cur.low) / a) * 15);
      return { signal: "BUY", strength, reason: `Liquidity sweep of prior low ${fmt(l.price)} then reclaim${displaced ? " + displacement" : ""}.` };
    }
  }
  return null;
}

/** Most recent unfilled Fair Value Gap within the window. dir: +1 bull, -1 bear. */
function detectFVG(candles, start, a) {
  for (let k = candles.length - 1; k >= start + 2; k--) {
    const c0 = candles[k - 2];
    const c2 = candles[k];
    // Bullish FVG: gap between high[k-2] and low[k].
    if (c2.low > c0.high && c2.low - c0.high > a * 0.15) {
      const filled = candles[candles.length - 1].close < c0.high; // price traded back through
      if (!filled) return { dir: +1, reason: `Unfilled bullish FVG ${fmt(c0.high)}–${fmt(c2.low)}` };
    }
    // Bearish FVG: gap between low[k-2] and high[k].
    if (c2.high < c0.low && c0.low - c2.high > a * 0.15) {
      const filled = candles[candles.length - 1].close > c0.low;
      if (!filled) return { dir: -1, reason: `Unfilled bearish FVG ${fmt(c2.high)}–${fmt(c0.low)}` };
    }
  }
  return null;
}

/** Last order block: down-candle before an up-impulse (bull) or vice-versa. */
function detectOrderBlock(candles, start, a) {
  for (let k = candles.length - 2; k >= start + 1; k--) {
    const impulse = candles[k].close - candles[k].open;
    // Bullish OB: strong up-candle whose prior candle was down.
    if (impulse > a * 0.6 && candles[k - 1].close < candles[k - 1].open) {
      const obLow = candles[k - 1].low;
      const price = candles[candles.length - 1].close;
      if (price > obLow) return { dir: +1, reason: `Bullish order block near ${fmt(obLow)}` };
    }
    // Bearish OB: strong down-candle whose prior candle was up.
    if (-impulse > a * 0.6 && candles[k - 1].close > candles[k - 1].open) {
      const obHigh = candles[k - 1].high;
      const price = candles[candles.length - 1].close;
      if (price < obHigh) return { dir: -1, reason: `Bearish order block near ${fmt(obHigh)}` };
    }
  }
  return null;
}

function fmt(v) {
  return v >= 100 ? v.toFixed(2) : v.toPrecision(5);
}

function clamp(v) {
  return Math.max(0, Math.min(100, Math.round(v)));
}
