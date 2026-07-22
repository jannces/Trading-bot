// Strategy 2 — RSI(14) + regular RSI divergence.
//
// Two signal sources, combined:
//   (a) Overbought / oversold levels (70 / 30) with a reversal bias.
//   (b) REGULAR bullish/bearish divergence, detected properly via PIVOTS:
//         - Bullish divergence:  price makes a LOWER low  while RSI makes a
//           HIGHER low  -> waning downside momentum -> BUY.
//         - Bearish divergence:  price makes a HIGHER high while RSI makes a
//           LOWER  high -> waning upside momentum   -> SELL.
//       Divergence, when present and recent, dominates the level reading.
import { rsi, pivotLows, pivotHighs, pivotsOnSeries, last } from "../indicators.js";
import { CONFIG } from "../config.js";

export const meta = {
  key: "rsi",
  name: "RSI(14) + Divergence",
  blurb:
    "RSI overbought/oversold plus proper regular divergence: it pairs recent price swing highs/lows with RSI swing highs/lows (pivot detection) and flags when they disagree, which often precedes a reversal.",
};

export function analyze(candles) {
  const period = CONFIG.indicators.rsiPeriod;
  const { pivotLeft, pivotRight } = CONFIG.indicators;
  const closes = candles.map((c) => c.close);
  const rsiSeries = rsi(closes, period);
  const rsiNow = last(rsiSeries);

  if (rsiNow == null) {
    return { signal: "NEUTRAL", strength: 0, reason: "Not enough data for RSI." };
  }

  // --- (b) Divergence detection ------------------------------------------
  const div = detectDivergence(candles, rsiSeries, pivotLeft, pivotRight);
  if (div) {
    return div; // divergence takes precedence when found and recent
  }

  // --- (a) Level-based reading -------------------------------------------
  if (rsiNow >= 70) {
    const strength = clamp(50 + (rsiNow - 70) * 3); // deeper into OB = stronger
    return { signal: "SELL", strength, reason: `RSI overbought at ${rsiNow.toFixed(1)}.` };
  }
  if (rsiNow <= 30) {
    const strength = clamp(50 + (30 - rsiNow) * 3);
    return { signal: "BUY", strength, reason: `RSI oversold at ${rsiNow.toFixed(1)}.` };
  }
  // Mid-range: mild bias from which side of 50 we are on.
  if (rsiNow > 55) {
    return { signal: "BUY", strength: clamp((rsiNow - 50) * 2), reason: `RSI bullish (${rsiNow.toFixed(1)}).` };
  }
  if (rsiNow < 45) {
    return { signal: "SELL", strength: clamp((50 - rsiNow) * 2), reason: `RSI bearish (${rsiNow.toFixed(1)}).` };
  }
  return { signal: "NEUTRAL", strength: clamp(Math.abs(rsiNow - 50) * 2), reason: `RSI neutral (${rsiNow.toFixed(1)}).` };
}

/**
 * Compare the two most recent price pivots against the RSI pivots that sit at
 * (or near) the same bars. Only fires when the divergence is recent (last
 * pivot within ~1.5 pivot windows of the final bar).
 */
function detectDivergence(candles, rsiSeries, left, right) {
  const priceLows = pivotLows(candles, left, right);
  const priceHighs = pivotHighs(candles, left, right);
  const rsiPivots = pivotsOnSeries(rsiSeries, left, right);
  const lastIdx = candles.length - 1;
  const recencyWindow = (left + right) * 3;

  // Bullish: price lower low, RSI higher low.
  if (priceLows.length >= 2 && rsiPivots.lows.length >= 2) {
    const p2 = priceLows[priceLows.length - 1];
    const p1 = priceLows[priceLows.length - 2];
    const r2 = nearestPivot(rsiPivots.lows, p2.index);
    const r1 = nearestPivot(rsiPivots.lows, p1.index);
    if (r1 && r2 && lastIdx - p2.index <= recencyWindow) {
      if (p2.price < p1.price && r2.value > r1.value) {
        const strength = clamp(65 + (r2.value - r1.value) * 2);
        return { signal: "BUY", strength, reason: "Regular bullish RSI divergence (price LL, RSI HL)." };
      }
    }
  }

  // Bearish: price higher high, RSI lower high.
  if (priceHighs.length >= 2 && rsiPivots.highs.length >= 2) {
    const p2 = priceHighs[priceHighs.length - 1];
    const p1 = priceHighs[priceHighs.length - 2];
    const r2 = nearestPivot(rsiPivots.highs, p2.index);
    const r1 = nearestPivot(rsiPivots.highs, p1.index);
    if (r1 && r2 && lastIdx - p2.index <= recencyWindow) {
      if (p2.price > p1.price && r2.value < r1.value) {
        const strength = clamp(65 + (r1.value - r2.value) * 2);
        return { signal: "SELL", strength, reason: "Regular bearish RSI divergence (price HH, RSI LH)." };
      }
    }
  }
  return null;
}

/** Find the RSI pivot whose index is closest to a given price-pivot index. */
function nearestPivot(pivots, index, maxDist = 3) {
  let best = null;
  let bestDist = Infinity;
  for (const p of pivots) {
    const d = Math.abs(p.index - index);
    if (d < bestDist) {
      bestDist = d;
      best = p;
    }
  }
  return bestDist <= maxDist ? best : null;
}

function clamp(v) {
  return Math.max(0, Math.min(100, Math.round(v)));
}
