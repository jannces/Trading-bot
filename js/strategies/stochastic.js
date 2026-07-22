// Strategy 6 — Stochastic (14,3,3): %K/%D crosses inside OB/OS zones.
import { stochastic, last } from "../indicators.js";
import { CONFIG } from "../config.js";

export const meta = {
  key: "stochastic",
  name: "Stochastic (14,3,3)",
  blurb:
    "Smoothed %K and %D oscillators. The highest-conviction signals are %K crossing above %D while oversold (<20) for buys, or %K crossing below %D while overbought (>80) for sells.",
};

export function analyze(candles) {
  const { stochK, stochSmooth, stochD } = CONFIG.indicators;
  const { k, d } = stochastic(candles, stochK, stochSmooth, stochD);
  const i = candles.length - 1;

  if (k[i] == null || d[i] == null || k[i - 1] == null || d[i - 1] == null) {
    return { signal: "NEUTRAL", strength: 0, reason: "Not enough data for Stochastic." };
  }

  const crossUp = k[i - 1] <= d[i - 1] && k[i] > d[i];
  const crossDown = k[i - 1] >= d[i - 1] && k[i] < d[i];
  const oversold = k[i] < 20;
  const overbought = k[i] > 80;

  if (crossUp && oversold) {
    return { signal: "BUY", strength: clamp(75 + (20 - k[i])), reason: `Bullish %K/%D cross in oversold zone (${k[i].toFixed(0)}).` };
  }
  if (crossDown && overbought) {
    return { signal: "SELL", strength: clamp(75 + (k[i] - 80)), reason: `Bearish %K/%D cross in overbought zone (${k[i].toFixed(0)}).` };
  }
  if (crossUp) {
    return { signal: "BUY", strength: clamp(45), reason: `Bullish %K/%D cross (%K ${k[i].toFixed(0)}).` };
  }
  if (crossDown) {
    return { signal: "SELL", strength: clamp(45), reason: `Bearish %K/%D cross (%K ${k[i].toFixed(0)}).` };
  }
  // No cross: bias from zone only.
  if (oversold) return { signal: "BUY", strength: clamp(30), reason: `Stochastic oversold (${k[i].toFixed(0)}), awaiting cross.` };
  if (overbought) return { signal: "SELL", strength: clamp(30), reason: `Stochastic overbought (${k[i].toFixed(0)}), awaiting cross.` };
  return { signal: "NEUTRAL", strength: 0, reason: `Stochastic mid-range (%K ${k[i].toFixed(0)}).` };
}

function clamp(v) {
  return Math.max(0, Math.min(100, Math.round(v)));
}
