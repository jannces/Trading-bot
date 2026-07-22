// Strategy 10 — Volume: OBV trend confirmation + unusual volume spikes.
import { obv, sma, last } from "../indicators.js";

export const meta = {
  key: "volume",
  name: "Volume (OBV + spikes)",
  blurb:
    "On-Balance Volume confirms whether volume is flowing with price (rising OBV = accumulation). A volume spike well above its average adds conviction in the direction of the spiking candle.",
};

export function analyze(candles) {
  const n = candles.length;
  const i = n - 1;
  if (n < 25) return { signal: "NEUTRAL", strength: 0, reason: "Not enough data for volume analysis." };

  const obvSeries = obv(candles);
  const obvSma = sma(obvSeries, 20);
  const obvNow = obvSeries[i];
  const obvRef = obvSma[i];

  // OBV trend: slope over the last 10 bars, and position vs its own SMA.
  const obvSlope = obvSeries[i] - obvSeries[i - 10];
  const obvAboveAvg = obvRef != null && obvNow > obvRef;

  // Volume spike: current volume vs average of the prior 20.
  const vols = candles.map((c) => c.volume);
  const avgVol = sma(vols, 20)[i] || last(sma(vols, 20));
  const spikeRatio = avgVol ? candles[i].volume / avgVol : 1;
  const candleUp = candles[i].close >= candles[i].open;

  let score = 0;
  const reasons = [];

  if (obvSlope > 0 && obvAboveAvg) {
    score += 1;
    reasons.push("OBV rising (accumulation)");
  } else if (obvSlope < 0 && !obvAboveAvg) {
    score -= 1;
    reasons.push("OBV falling (distribution)");
  } else {
    reasons.push("OBV flat / mixed");
  }

  if (spikeRatio >= 1.8) {
    if (candleUp) {
      score += 2;
      reasons.push(`bullish volume spike ${spikeRatio.toFixed(1)}×`);
    } else {
      score -= 2;
      reasons.push(`bearish volume spike ${spikeRatio.toFixed(1)}×`);
    }
  }

  const strength = clamp(Math.abs(score) * 22 + (spikeRatio >= 1.8 ? 10 : 0));
  const reason = capitalise(reasons.join(", ")) + ".";
  if (score > 0) return { signal: "BUY", strength, reason };
  if (score < 0) return { signal: "SELL", strength, reason };
  return { signal: "NEUTRAL", strength: 0, reason };
}

function capitalise(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function clamp(v) {
  return Math.max(0, Math.min(100, Math.round(v)));
}
