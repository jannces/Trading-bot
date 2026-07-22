// Strategy 1 — EMA Crossover (9/21) with trend-slope confirmation.
import { ema, last } from "../indicators.js";
import { CONFIG } from "../config.js";

export const meta = {
  key: "ema",
  name: "EMA Crossover (9/21)",
  blurb:
    "Fast 9-EMA vs slow 21-EMA. A fresh bullish/bearish cross is the primary trigger; the slope of the slow EMA scales conviction so signals with the trend score higher.",
};

export function analyze(candles) {
  const { emaFast: fastP, emaSlow: slowP } = CONFIG.indicators;
  const closes = candles.map((c) => c.close);
  const fast = ema(closes, fastP);
  const slow = ema(closes, slowP);

  const i = candles.length - 1;
  if (fast[i] == null || slow[i] == null || fast[i - 1] == null || slow[i - 1] == null) {
    return { signal: "NEUTRAL", strength: 0, reason: "Not enough data for EMA cross." };
  }

  const diffNow = fast[i] - slow[i];
  const diffPrev = fast[i - 1] - slow[i - 1];
  const crossedUp = diffPrev <= 0 && diffNow > 0;
  const crossedDown = diffPrev >= 0 && diffNow < 0;

  // Slope of the slow EMA over the last few bars, normalised to price.
  const lookback = Math.min(5, i);
  const slope = (slow[i] - slow[i - lookback]) / (slow[i - lookback] || 1);
  const price = last(closes);
  const spreadPct = Math.abs(diffNow) / price; // separation of the two EMAs

  if (crossedUp) {
    const strength = clamp(60 + slope * 4000 + spreadPct * 2000);
    return { signal: "BUY", strength, reason: "Bullish 9/21 EMA cross just formed." };
  }
  if (crossedDown) {
    const strength = clamp(60 - slope * 4000 + spreadPct * 2000);
    return { signal: "SELL", strength, reason: "Bearish 9/21 EMA cross just formed." };
  }

  // No fresh cross: report the standing trend, strength from separation+slope.
  if (diffNow > 0) {
    const strength = clamp(30 + spreadPct * 3000 + slope * 3000);
    return {
      signal: "BUY",
      strength,
      reason: `Fast EMA above slow EMA (uptrend, slope ${(slope * 100).toFixed(2)}%).`,
    };
  }
  const strength = clamp(30 + spreadPct * 3000 - slope * 3000);
  return {
    signal: "SELL",
    strength,
    reason: `Fast EMA below slow EMA (downtrend, slope ${(slope * 100).toFixed(2)}%).`,
  };
}

function clamp(v) {
  return Math.max(0, Math.min(100, Math.round(v)));
}
