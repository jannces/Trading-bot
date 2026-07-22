// ============================================================================
// confluence.js — Composite scoring engine.
//
// Turns the 10 individual strategy results into ONE weighted score in
// [-100, +100], classifies it, decides whether it qualifies as a
// "High Quality Signal", and (for HQ signals) builds an illustrative
// entry / stop / take-profit plan.
// ============================================================================
import { CONFIG } from "./config.js";
import { atr, pivotLows, pivotHighs, last } from "./indicators.js";

/** Map a strategy signal string to a direction sign. */
function dir(signal) {
  if (signal === "BUY") return 1;
  if (signal === "SELL") return -1;
  return 0;
}

/**
 * @param results array from strategies/runAll
 * @param candles the candle set (for ATR / swing-based risk levels)
 * @returns full confluence object consumed by the UI.
 */
export function computeConfluence(results, candles) {
  const weights = CONFIG.weights;

  // Weighted average of signed strengths -> composite in [-100, 100].
  let weightedSum = 0;
  let weightTotal = 0;
  let buys = 0;
  let sells = 0;
  let neutrals = 0;

  for (const r of results) {
    const w = weights[r.key] ?? 1;
    const signed = dir(r.signal) * r.strength; // -100..100 per strategy
    weightedSum += w * signed;
    weightTotal += w;
    if (r.signal === "BUY") buys++;
    else if (r.signal === "SELL") sells++;
    else neutrals++;
  }

  const composite = weightTotal ? clampScore(weightedSum / weightTotal) : 0;
  const verdict = classify(composite);

  // Directional agreement for the High-Quality gate.
  const agreeing = composite >= 0 ? buys : sells;
  const dominantDir = composite >= 0 ? "BUY" : "SELL";
  const highQuality =
    agreeing >= CONFIG.highQuality.minAgreeing &&
    Math.abs(composite) >= CONFIG.highQuality.minComposite;

  const plan = highQuality ? buildTradePlan(dominantDir, candles) : null;

  return {
    composite: Math.round(composite),
    verdict,
    buys,
    sells,
    neutrals,
    agreeing,
    dominantDir,
    highQuality,
    plan,
  };
}

/** Classify composite score into the 5 verdict buckets. */
export function classify(score) {
  const t = CONFIG.thresholds;
  if (score >= t.strongBuy) return "STRONG BUY";
  if (score >= t.buy) return "BUY";
  if (score <= t.strongSell) return "STRONG SELL";
  if (score <= t.sell) return "SELL";
  return "NEUTRAL";
}

/**
 * Build an ILLUSTRATIVE trade plan (not financial advice):
 *   - Entry zone: a small band around the current price.
 *   - Stop: nearest opposing swing (support for longs / resistance for shorts),
 *     but never wider than ATR * atrStopMultiplier; ATR is the fallback.
 *   - Targets: 1.5R and 3R measured from entry to stop.
 */
export function buildTradePlan(direction, candles) {
  const price = candles[candles.length - 1].close;
  const a = last(atr(candles, CONFIG.risk.atrPeriod)) || price * 0.005;
  const { atrStopMultiplier, tp1R, tp2R, entryZonePct } = CONFIG.risk;
  const { pivotLeft, pivotRight } = CONFIG.indicators;

  const entryLow = price * (1 - entryZonePct);
  const entryHigh = price * (1 + entryZonePct);
  const atrStopDist = a * atrStopMultiplier;

  let stop;
  if (direction === "BUY") {
    // Prefer the most recent swing low just under price, capped by ATR distance.
    const lows = pivotLows(candles, pivotLeft, pivotRight)
      .map((p) => p.price)
      .filter((p) => p < price);
    const swing = lows.length ? Math.max(...lows) : null;
    const swingStop = swing != null ? swing - a * 0.1 : null;
    stop = swingStop != null && price - swingStop <= atrStopDist * 1.5 ? swingStop : price - atrStopDist;
  } else {
    const highs = pivotHighs(candles, pivotLeft, pivotRight)
      .map((p) => p.price)
      .filter((p) => p > price);
    const swing = highs.length ? Math.min(...highs) : null;
    const swingStop = swing != null ? swing + a * 0.1 : null;
    stop = swingStop != null && swingStop - price <= atrStopDist * 1.5 ? swingStop : price + atrStopDist;
  }

  const risk = Math.abs(price - stop);
  const tp1 = direction === "BUY" ? price + risk * tp1R : price - risk * tp1R;
  const tp2 = direction === "BUY" ? price + risk * tp2R : price - risk * tp2R;

  return {
    direction,
    entryLow,
    entryHigh,
    stop,
    tp1,
    tp2,
    riskPerUnit: risk,
    rr1: tp1R,
    rr2: tp2R,
  };
}

function clampScore(v) {
  return Math.max(-100, Math.min(100, v));
}
