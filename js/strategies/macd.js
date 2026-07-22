// Strategy 3 — MACD (12/26/9): signal-line crosses + histogram momentum.
import { macd, last } from "../indicators.js";
import { CONFIG } from "../config.js";

export const meta = {
  key: "macd",
  name: "MACD (12/26/9)",
  blurb:
    "MACD line vs signal line. A fresh cross is the trigger; the histogram (MACD − signal) adds momentum context — a rising histogram above zero is strong bullish, a falling one below zero strong bearish.",
};

export function analyze(candles) {
  const { macdFast, macdSlow, macdSignal } = CONFIG.indicators;
  const closes = candles.map((c) => c.close);
  const { macd: line, signal, hist } = macd(closes, macdFast, macdSlow, macdSignal);
  const i = candles.length - 1;

  if (line[i] == null || signal[i] == null || hist[i] == null || hist[i - 1] == null) {
    return { signal: "NEUTRAL", strength: 0, reason: "Not enough data for MACD." };
  }

  const price = last(closes);
  const crossedUp = line[i - 1] <= signal[i - 1] && line[i] > signal[i];
  const crossedDown = line[i - 1] >= signal[i - 1] && line[i] < signal[i];
  const histRising = hist[i] > hist[i - 1];
  const histMagPct = Math.abs(hist[i]) / price;

  if (crossedUp) {
    return { signal: "BUY", strength: clamp(65 + histMagPct * 5000), reason: "Bullish MACD signal-line cross." };
  }
  if (crossedDown) {
    return { signal: "SELL", strength: clamp(65 + histMagPct * 5000), reason: "Bearish MACD signal-line cross." };
  }

  // No cross: use histogram sign + slope for a momentum read.
  if (hist[i] > 0) {
    const strength = clamp(30 + histMagPct * 5000 + (histRising ? 15 : 0));
    return {
      signal: "BUY",
      strength,
      reason: `MACD above signal, histogram ${histRising ? "expanding" : "fading"}.`,
    };
  }
  if (hist[i] < 0) {
    const strength = clamp(30 + histMagPct * 5000 + (!histRising ? 15 : 0));
    return {
      signal: "SELL",
      strength,
      reason: `MACD below signal, histogram ${!histRising ? "expanding" : "fading"}.`,
    };
  }
  return { signal: "NEUTRAL", strength: 0, reason: "MACD flat at signal line." };
}

function clamp(v) {
  return Math.max(0, Math.min(100, Math.round(v)));
}
