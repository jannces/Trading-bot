// Strategy 5 — Ichimoku Cloud: price vs cloud, Tenkan/Kijun cross, cloud color.
import { ichimoku } from "../indicators.js";

export const meta = {
  key: "ichimoku",
  name: "Ichimoku Cloud",
  blurb:
    "Combines three reads: price above/below the cloud (trend), a Tenkan/Kijun cross (momentum trigger), and cloud color (Senkou A vs B) for regime bias. Agreement of all three is a strong signal.",
};

export function analyze(candles) {
  const n = candles.length;
  const { tenkan, kijun, senkouA, senkouB, displacement } = ichimoku(candles);
  const i = n - 1;

  if (tenkan[i] == null || kijun[i] == null) {
    return { signal: "NEUTRAL", strength: 0, reason: "Not enough data for Ichimoku." };
  }

  const price = candles[i].close;

  // The cloud drawn UNDER the current bar was formed `displacement` bars ago.
  const cloudIdx = i - displacement;
  let spanA = null;
  let spanB = null;
  if (cloudIdx >= 0) {
    spanA = senkouA[cloudIdx];
    spanB = senkouB[cloudIdx];
  }

  let score = 0;
  const reasons = [];

  // 1) Price vs cloud.
  if (spanA != null && spanB != null) {
    const cloudTop = Math.max(spanA, spanB);
    const cloudBottom = Math.min(spanA, spanB);
    if (price > cloudTop) {
      score += 2;
      reasons.push("price above cloud");
    } else if (price < cloudBottom) {
      score -= 2;
      reasons.push("price below cloud");
    } else {
      reasons.push("price inside cloud");
    }
    // 2) Cloud color (future regime bias).
    if (spanA > spanB) {
      score += 1;
      reasons.push("bullish cloud");
    } else if (spanA < spanB) {
      score -= 1;
      reasons.push("bearish cloud");
    }
  } else {
    reasons.push("cloud not yet formed");
  }

  // 3) Tenkan/Kijun cross or standing relationship.
  const crossUp = tenkan[i - 1] <= kijun[i - 1] && tenkan[i] > kijun[i];
  const crossDown = tenkan[i - 1] >= kijun[i - 1] && tenkan[i] < kijun[i];
  if (crossUp) {
    score += 2;
    reasons.push("Tenkan crossed above Kijun");
  } else if (crossDown) {
    score -= 2;
    reasons.push("Tenkan crossed below Kijun");
  } else if (tenkan[i] > kijun[i]) {
    score += 1;
    reasons.push("Tenkan above Kijun");
  } else if (tenkan[i] < kijun[i]) {
    score -= 1;
    reasons.push("Tenkan below Kijun");
  }

  // Map score (range roughly -5..+5) to signal + strength.
  const strength = clamp(Math.abs(score) * 18);
  const reason = capitalise(reasons.join(", ")) + ".";
  if (score >= 1) return { signal: "BUY", strength, reason };
  if (score <= -1) return { signal: "SELL", strength, reason };
  return { signal: "NEUTRAL", strength: 0, reason };
}

function capitalise(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function clamp(v) {
  return Math.max(0, Math.min(100, Math.round(v)));
}
