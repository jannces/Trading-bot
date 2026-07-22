// ============================================================================
// htf.js — Higher-timeframe bias.
//
// Two pure helpers:
//   intervalMinutes(iv)      -> minutes per candle for a Binance interval
//   resampleToHTF(c, factor) -> aggregate N base candles into HTF candles
//   htfBias(htfCandles)      -> { bias: "BULL"|"BEAR"|"NEUTRAL", strong, reason }
//
// The live app fetches real HTF klines; the backtest derives HTF by resampling
// the base candles it already has (so there's no look-ahead and no second
// time-aligned fetch). Both feed the SAME htfBias() function, so the gate logic
// is identical in both paths.
// ============================================================================
import { ema, pivotHighs, pivotLows, last } from "./indicators.js";
import { CONFIG } from "./config.js";

const MINUTES = { "1m": 1, "3m": 3, "5m": 5, "15m": 15, "30m": 30, "1h": 60, "2h": 120, "4h": 240, "6h": 360, "12h": 720, "1d": 1440, "3d": 4320, "1w": 10080 };

export function intervalMinutes(iv) {
  return MINUTES[iv] || 15;
}

/** Integer factor between two intervals (htf / base), or 1 if not clean. */
export function htfFactor(baseIv, htfIv) {
  const f = intervalMinutes(htfIv) / intervalMinutes(baseIv);
  return f >= 1 ? Math.round(f) : 1;
}

/**
 * Aggregate `factor` consecutive base candles into one HTF candle. The final
 * bucket may be partial (represents the currently-forming HTF candle) — that is
 * correct and introduces no look-ahead.
 */
export function resampleToHTF(candles, factor) {
  if (factor <= 1) return candles.slice();
  const out = [];
  for (let i = 0; i < candles.length; i += factor) {
    const chunk = candles.slice(i, i + factor);
    if (chunk.length === 0) break;
    let high = -Infinity;
    let low = Infinity;
    let vol = 0;
    for (const c of chunk) {
      if (c.high > high) high = c.high;
      if (c.low < low) low = c.low;
      vol += c.volume;
    }
    out.push({
      time: chunk[0].time,
      open: chunk[0].open,
      high,
      low,
      close: chunk[chunk.length - 1].close,
      volume: vol,
    });
  }
  return out;
}

/**
 * Trend bias from EMA structure + last swing.
 *   BULL  if EMA9 > EMA21 and price > EMA21 (and swing not making lower lows)
 *   BEAR  if EMA9 < EMA21 and price < EMA21 (and swing not making higher highs)
 * `strong` is true when EMA structure AND the swing structure agree.
 */
export function htfBias(htfCandles) {
  const { emaFast, emaSlow, pivotLeft, pivotRight } = CONFIG.indicators;
  if (!htfCandles || htfCandles.length < emaSlow + 5) {
    return { bias: "NEUTRAL", strong: false, reason: "insufficient HTF data" };
  }
  const closes = htfCandles.map((c) => c.close);
  const f = last(ema(closes, emaFast));
  const s = last(ema(closes, emaSlow));
  const price = closes[closes.length - 1];

  let emaBias = "NEUTRAL";
  if (f > s && price > s) emaBias = "BULL";
  else if (f < s && price < s) emaBias = "BEAR";

  // Swing structure: compare the last two pivot highs and lows.
  const highs = pivotHighs(htfCandles, pivotLeft, pivotRight);
  const lows = pivotLows(htfCandles, pivotLeft, pivotRight);
  let swingBias = "NEUTRAL";
  if (highs.length >= 2 && lows.length >= 2) {
    const hh = highs[highs.length - 1].price > highs[highs.length - 2].price;
    const hl = lows[lows.length - 1].price > lows[lows.length - 2].price;
    const lh = highs[highs.length - 1].price < highs[highs.length - 2].price;
    const ll = lows[lows.length - 1].price < lows[lows.length - 2].price;
    if (hh && hl) swingBias = "BULL";
    else if (lh && ll) swingBias = "BEAR";
  }

  let bias = emaBias;
  if (emaBias === "NEUTRAL") bias = swingBias;
  const strong = emaBias !== "NEUTRAL" && emaBias === swingBias;

  const tfLabel = "HTF";
  const reason =
    bias === "NEUTRAL"
      ? `${tfLabel} trend flat/mixed`
      : `${tfLabel} trend ${bias === "BULL" ? "bullish" : "bearish"}${strong ? " (EMA + structure)" : ""}`;
  return { bias, strong, reason };
}

/** Map a setup direction to the bias it needs. */
export function biasForDirection(dir) {
  return dir === "LONG" ? "BULL" : "BEAR";
}
