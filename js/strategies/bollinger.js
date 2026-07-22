// Strategy 4 — Bollinger Bands (20, 2): squeeze, mean-reversion vs breakout.
import { bollinger, last } from "../indicators.js";
import { CONFIG } from "../config.js";

export const meta = {
  key: "bollinger",
  name: "Bollinger Bands (20,2)",
  blurb:
    "Bands around a 20-SMA at ±2σ. Inside a normal range, tags of the lower/upper band are treated as mean-reversion (buy low / sell high); when a squeeze (unusually narrow bands) resolves with a close outside a band, it is read as a breakout instead.",
};

export function analyze(candles) {
  const { bbPeriod, bbMult } = CONFIG.indicators;
  const closes = candles.map((c) => c.close);
  const { middle, upper, lower, bandwidth } = bollinger(closes, bbPeriod, bbMult);
  const i = candles.length - 1;

  if (upper[i] == null || bandwidth[i] == null) {
    return { signal: "NEUTRAL", strength: 0, reason: "Not enough data for Bollinger Bands." };
  }

  const price = closes[i];
  const bw = bandwidth[i];

  // Is this a squeeze? Compare current bandwidth to the recent median.
  const recentBw = bandwidth.slice(Math.max(0, i - bbPeriod * 2), i + 1).filter((v) => v != null);
  const medianBw = median(recentBw);
  const squeeze = bw < medianBw * 0.7;

  const closedAbove = price > upper[i];
  const closedBelow = price < lower[i];
  const pctFromMid = (price - middle[i]) / middle[i];

  // Breakout logic: a squeeze resolving outside the band.
  if (squeeze && closedAbove) {
    return { signal: "BUY", strength: clamp(70), reason: "Bollinger squeeze breakout above upper band." };
  }
  if (squeeze && closedBelow) {
    return { signal: "SELL", strength: clamp(70), reason: "Bollinger squeeze breakdown below lower band." };
  }

  // Mean-reversion logic in a normal (non-squeeze) regime.
  if (closedBelow) {
    return { signal: "BUY", strength: clamp(55 + Math.abs(pctFromMid) * 1500), reason: "Price below lower band — mean-reversion buy." };
  }
  if (closedAbove) {
    return { signal: "SELL", strength: clamp(55 + Math.abs(pctFromMid) * 1500), reason: "Price above upper band — mean-reversion sell." };
  }

  // Inside the bands: mild bias by position relative to the mid-line.
  if (pctFromMid > 0.002) {
    return { signal: "BUY", strength: clamp(20 + pctFromMid * 1500), reason: "Price in upper half of the bands." };
  }
  if (pctFromMid < -0.002) {
    return { signal: "SELL", strength: clamp(20 + Math.abs(pctFromMid) * 1500), reason: "Price in lower half of the bands." };
  }
  return { signal: "NEUTRAL", strength: 0, reason: `Price at Bollinger mid-line${squeeze ? " (squeeze building)" : ""}.` };
}

function median(arr) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function clamp(v) {
  return Math.max(0, Math.min(100, Math.round(v)));
}
