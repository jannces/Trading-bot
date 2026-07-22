// Strategy 7 — VWAP (session): position vs VWAP + reclaim / rejection behaviour.
import { vwap } from "../indicators.js";

export const meta = {
  key: "vwap",
  name: "VWAP (session)",
  blurb:
    "Volume-weighted average price over the fetched window. Price above VWAP is bullish control, below is bearish. A reclaim (crossing back above) or rejection (crossing back below) in the last bars is treated as an actionable trigger.",
};

export function analyze(candles) {
  const vw = vwap(candles);
  const i = candles.length - 1;
  if (vw[i] == null) {
    return { signal: "NEUTRAL", strength: 0, reason: "Not enough data for VWAP." };
  }

  const price = candles[i].close;
  const distPct = (price - vw[i]) / vw[i];

  // Look for a recent reclaim/rejection across VWAP within the last ~3 bars.
  let reclaim = false;
  let rejection = false;
  for (let j = Math.max(1, i - 2); j <= i; j++) {
    if (vw[j - 1] == null) continue;
    const prevAbove = candles[j - 1].close > vw[j - 1];
    const nowAbove = candles[j].close > vw[j];
    if (!prevAbove && nowAbove) reclaim = true;
    if (prevAbove && !nowAbove) rejection = true;
  }

  if (reclaim && price > vw[i]) {
    return { signal: "BUY", strength: clamp(65 + Math.abs(distPct) * 2000), reason: "Price reclaimed VWAP from below." };
  }
  if (rejection && price < vw[i]) {
    return { signal: "SELL", strength: clamp(65 + Math.abs(distPct) * 2000), reason: "Price rejected at VWAP from above." };
  }

  if (distPct > 0.0005) {
    return { signal: "BUY", strength: clamp(30 + distPct * 2500), reason: `Price ${(distPct * 100).toFixed(2)}% above VWAP.` };
  }
  if (distPct < -0.0005) {
    return { signal: "SELL", strength: clamp(30 + Math.abs(distPct) * 2500), reason: `Price ${(Math.abs(distPct) * 100).toFixed(2)}% below VWAP.` };
  }
  return { signal: "NEUTRAL", strength: 0, reason: "Price sitting on VWAP." };
}

function clamp(v) {
  return Math.max(0, Math.min(100, Math.round(v)));
}
