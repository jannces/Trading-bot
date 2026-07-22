// Strategy 8 — Support/Resistance Breakout.
//
// Auto-detects swing highs (resistance) and swing lows (support) via fractal
// pivots, clusters nearby levels, then flags:
//   - Confirmed breakout: a candle CLOSES above a resistance level it was under.
//   - Confirmed breakdown: a candle CLOSES below a support level it was above.
//   - Rejection: price wicked through a level but closed back on the prior side.
import { pivotHighs, pivotLows, atr, last } from "../indicators.js";
import { CONFIG } from "../config.js";

export const meta = {
  key: "sr",
  name: "S/R Breakout",
  blurb:
    "Finds recent swing highs and lows as horizontal support/resistance. A close beyond a level is a confirmed breakout/breakdown; a wick through that closes back inside is a rejection (fade the level).",
};

export function analyze(candles) {
  const { pivotLeft, pivotRight } = CONFIG.indicators;
  const i = candles.length - 1;
  const atrSeries = atr(candles, CONFIG.risk.atrPeriod);
  const a = last(atrSeries) || candles[i].close * 0.005;

  const highs = pivotHighs(candles, pivotLeft, pivotRight).map((p) => p.price);
  const lows = pivotLows(candles, pivotLeft, pivotRight).map((p) => p.price);
  if (!highs.length && !lows.length) {
    return { signal: "NEUTRAL", strength: 0, reason: "No swing levels detected yet." };
  }

  const close = candles[i].close;
  const prevClose = candles[i - 1] ? candles[i - 1].close : close;
  const high = candles[i].high;
  const low = candles[i].low;
  const tol = a * 0.25; // proximity tolerance for "at" a level

  // Nearest resistance we were below last bar, and nearest support we were above.
  const resistances = highs.filter((h) => prevClose <= h + tol).sort((x, y) => x - y);
  const supports = lows.filter((l) => prevClose >= l - tol).sort((x, y) => y - x);
  const nearestRes = resistances[0];
  const nearestSup = supports[0];

  // Breakout: close above a resistance the prior bar was below.
  if (nearestRes != null && prevClose <= nearestRes && close > nearestRes + tol) {
    return { signal: "BUY", strength: clamp(70 + ((close - nearestRes) / a) * 20), reason: `Breakout: closed above resistance ${fmt(nearestRes)}.` };
  }
  // Breakdown: close below a support the prior bar was above.
  if (nearestSup != null && prevClose >= nearestSup && close < nearestSup - tol) {
    return { signal: "SELL", strength: clamp(70 + ((nearestSup - close) / a) * 20), reason: `Breakdown: closed below support ${fmt(nearestSup)}.` };
  }
  // Rejection at resistance: wicked above but closed back below.
  if (nearestRes != null && high > nearestRes + tol && close < nearestRes) {
    return { signal: "SELL", strength: clamp(55), reason: `Rejected at resistance ${fmt(nearestRes)} (wick + close back below).` };
  }
  // Rejection at support: wicked below but closed back above.
  if (nearestSup != null && low < nearestSup - tol && close > nearestSup) {
    return { signal: "BUY", strength: clamp(55), reason: `Held support ${fmt(nearestSup)} (wick + close back above).` };
  }

  // Otherwise, bias by which level is closer (approaching support = mild buy).
  if (nearestSup != null && nearestRes != null) {
    const dRes = Math.abs(nearestRes - close);
    const dSup = Math.abs(close - nearestSup);
    if (dSup < dRes && dSup < a) return { signal: "BUY", strength: clamp(25), reason: `Approaching support ${fmt(nearestSup)}.` };
    if (dRes < dSup && dRes < a) return { signal: "SELL", strength: clamp(25), reason: `Approaching resistance ${fmt(nearestRes)}.` };
  }
  return { signal: "NEUTRAL", strength: 0, reason: "Mid-range between S/R levels." };
}

function fmt(v) {
  return v >= 100 ? v.toFixed(2) : v.toPrecision(5);
}

function clamp(v) {
  return Math.max(0, Math.min(100, Math.round(v)));
}
