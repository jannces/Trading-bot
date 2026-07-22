// ============================================================================
// indicators.js — Pure indicator math.
//
// Every function here is a PURE function of its inputs (no DOM, no globals, no
// network) so it can be imported by both the browser app and the Node test
// script (tests/indicators.test.js), and so the formulas are easy to audit.
//
// Conventions:
//   - "values" means an array of numbers (usually closing prices).
//   - "candles" means an array of { time, open, high, low, close, volume }.
//   - Series functions return an array the SAME length as the input, with
//     `null` in the warm-up region where the indicator is not yet defined.
//     This keeps every series index-aligned with the candle array.
// ============================================================================

/**
 * Simple Moving Average.
 * @returns number[] aligned with input; null until `period` samples exist.
 */
export function sma(values, period) {
  const out = new Array(values.length).fill(null);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

/**
 * Exponential Moving Average.
 * Seeded with the SMA of the first `period` values (standard convention),
 * then EMA_i = (value_i - EMA_{i-1}) * k + EMA_{i-1}, with k = 2/(period+1).
 */
export function ema(values, period) {
  const out = new Array(values.length).fill(null);
  if (values.length < period) return out;
  const k = 2 / (period + 1);
  // Seed with SMA of the first `period` values.
  let seed = 0;
  for (let i = 0; i < period; i++) seed += values[i];
  let prev = seed / period;
  out[period - 1] = prev;
  for (let i = period; i < values.length; i++) {
    prev = (values[i] - prev) * k + prev;
    out[i] = prev;
  }
  return out;
}

/**
 * Wilder's Relative Strength Index.
 * The first average gain/loss is a simple mean of the first `period` changes;
 * subsequent averages use Wilder smoothing: avg = (avg*(p-1) + current)/p.
 * @returns number[] aligned with input; first value at index `period`.
 */
export function rsi(values, period = 14) {
  const out = new Array(values.length).fill(null);
  if (values.length <= period) return out;

  let gainSum = 0;
  let lossSum = 0;
  // Seed period: changes for closes[1..period].
  for (let i = 1; i <= period; i++) {
    const change = values[i] - values[i - 1];
    if (change >= 0) gainSum += change;
    else lossSum -= change; // subtract negative -> positive loss
  }
  let avgGain = gainSum / period;
  let avgLoss = lossSum / period;
  out[period] = rsiFromAvg(avgGain, avgLoss);

  for (let i = period + 1; i < values.length; i++) {
    const change = values[i] - values[i - 1];
    const gain = change > 0 ? change : 0;
    const loss = change < 0 ? -change : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    out[i] = rsiFromAvg(avgGain, avgLoss);
  }
  return out;
}

function rsiFromAvg(avgGain, avgLoss) {
  if (avgLoss === 0) return 100;
  if (avgGain === 0) return 0;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

/**
 * MACD (Moving Average Convergence Divergence).
 * @returns { macd: number[], signal: number[], hist: number[] } all aligned.
 */
export function macd(values, fast = 12, slow = 26, signalPeriod = 9) {
  const emaFast = ema(values, fast);
  const emaSlow = ema(values, slow);
  const macdLine = values.map((_, i) =>
    emaFast[i] != null && emaSlow[i] != null ? emaFast[i] - emaSlow[i] : null
  );

  // Signal line = EMA of the (defined portion of the) MACD line.
  const firstIdx = macdLine.findIndex((v) => v != null);
  const signal = new Array(values.length).fill(null);
  const hist = new Array(values.length).fill(null);
  if (firstIdx !== -1) {
    const defined = macdLine.slice(firstIdx).filter((v) => v != null);
    const sig = ema(defined, signalPeriod);
    for (let j = 0; j < sig.length; j++) {
      const idx = firstIdx + j;
      signal[idx] = sig[j];
      if (sig[j] != null && macdLine[idx] != null) hist[idx] = macdLine[idx] - sig[j];
    }
  }
  return { macd: macdLine, signal, hist };
}

/** True Range series. TR[0] is null (no previous close). */
export function trueRange(candles) {
  const out = new Array(candles.length).fill(null);
  for (let i = 1; i < candles.length; i++) {
    const h = candles[i].high;
    const l = candles[i].low;
    const pc = candles[i - 1].close;
    out[i] = Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc));
  }
  return out;
}

/**
 * Average True Range (Wilder). First ATR at index `period` is the simple mean
 * of TR[1..period]; thereafter Wilder-smoothed.
 */
export function atr(candles, period = 14) {
  const tr = trueRange(candles);
  const out = new Array(candles.length).fill(null);
  if (candles.length <= period) return out;
  let sum = 0;
  for (let i = 1; i <= period; i++) sum += tr[i];
  let prev = sum / period;
  out[period] = prev;
  for (let i = period + 1; i < candles.length; i++) {
    prev = (prev * (period - 1) + tr[i]) / period;
    out[i] = prev;
  }
  return out;
}

/** Population standard deviation of a window (used by Bollinger Bands). */
function stdDev(window, mean) {
  let acc = 0;
  for (const v of window) acc += (v - mean) * (v - mean);
  return Math.sqrt(acc / window.length);
}

/**
 * Bollinger Bands. Uses population standard deviation (÷N).
 * @returns { middle, upper, lower, bandwidth } — all number[] aligned.
 * bandwidth = (upper - lower) / middle  (relative band width; squeeze metric).
 */
export function bollinger(values, period = 20, mult = 2) {
  const middle = sma(values, period);
  const upper = new Array(values.length).fill(null);
  const lower = new Array(values.length).fill(null);
  const bandwidth = new Array(values.length).fill(null);
  for (let i = period - 1; i < values.length; i++) {
    const window = values.slice(i - period + 1, i + 1);
    const sd = stdDev(window, middle[i]);
    upper[i] = middle[i] + mult * sd;
    lower[i] = middle[i] - mult * sd;
    bandwidth[i] = middle[i] !== 0 ? (upper[i] - lower[i]) / middle[i] : null;
  }
  return { middle, upper, lower, bandwidth };
}

/**
 * Stochastic Oscillator.
 * %K raw = 100 * (close - lowestLow) / (highestHigh - lowestLow) over kPeriod,
 * then smoothed by kSmooth (this smoothed %K is the reported %K), and %D is the
 * SMA of %K over dPeriod.
 * @returns { k: number[], d: number[] }
 */
export function stochastic(candles, kPeriod = 14, kSmooth = 3, dPeriod = 3) {
  const rawK = new Array(candles.length).fill(null);
  for (let i = kPeriod - 1; i < candles.length; i++) {
    let hh = -Infinity;
    let ll = Infinity;
    for (let j = i - kPeriod + 1; j <= i; j++) {
      if (candles[j].high > hh) hh = candles[j].high;
      if (candles[j].low < ll) ll = candles[j].low;
    }
    const denom = hh - ll;
    rawK[i] = denom === 0 ? 50 : (100 * (candles[i].close - ll)) / denom;
  }
  const k = smoothNullable(rawK, kSmooth);
  const d = smoothNullable(k, dPeriod);
  return { k, d };
}

/** SMA over an array that may contain leading nulls (used for stochastic). */
function smoothNullable(arr, period) {
  const out = new Array(arr.length).fill(null);
  const buf = [];
  for (let i = 0; i < arr.length; i++) {
    if (arr[i] == null) {
      buf.length = 0;
      continue;
    }
    buf.push(arr[i]);
    if (buf.length > period) buf.shift();
    if (buf.length === period) out[i] = buf.reduce((a, b) => a + b, 0) / period;
  }
  return out;
}

/** On-Balance Volume. */
export function obv(candles) {
  const out = new Array(candles.length).fill(0);
  for (let i = 1; i < candles.length; i++) {
    if (candles[i].close > candles[i - 1].close) out[i] = out[i - 1] + candles[i].volume;
    else if (candles[i].close < candles[i - 1].close) out[i] = out[i - 1] - candles[i].volume;
    else out[i] = out[i - 1];
  }
  return out;
}

/**
 * Session VWAP (cumulative over the whole fetched window).
 * VWAP_i = Σ(typicalPrice * volume) / Σ(volume), typical = (h+l+c)/3.
 */
export function vwap(candles) {
  const out = new Array(candles.length).fill(null);
  let cumPV = 0;
  let cumV = 0;
  for (let i = 0; i < candles.length; i++) {
    const typical = (candles[i].high + candles[i].low + candles[i].close) / 3;
    cumPV += typical * candles[i].volume;
    cumV += candles[i].volume;
    out[i] = cumV > 0 ? cumPV / cumV : typical;
  }
  return out;
}

/**
 * Ichimoku components.
 * Tenkan = (max high + min low)/2 over `conversion` (9).
 * Kijun  = same over `base` (26).
 * Senkou A = (Tenkan + Kijun)/2, plotted `displacement` ahead.
 * Senkou B = (max high + min low)/2 over `spanB` (52), plotted ahead.
 * We return spans index-aligned to the candle that FORMS them (not shifted
 * forward), plus a `cloudAt(i)` helper that reads the cloud drawn under bar i.
 */
export function ichimoku(candles, conversion = 9, base = 26, spanB = 52, displacement = 26) {
  const n = candles.length;
  const midpoint = (start, end) => {
    let hh = -Infinity;
    let ll = Infinity;
    for (let j = start; j <= end; j++) {
      if (candles[j].high > hh) hh = candles[j].high;
      if (candles[j].low < ll) ll = candles[j].low;
    }
    return (hh + ll) / 2;
  };
  const tenkan = new Array(n).fill(null);
  const kijun = new Array(n).fill(null);
  const senkouA = new Array(n).fill(null); // value formed at i (unshifted)
  const senkouB = new Array(n).fill(null);
  for (let i = 0; i < n; i++) {
    if (i >= conversion - 1) tenkan[i] = midpoint(i - conversion + 1, i);
    if (i >= base - 1) kijun[i] = midpoint(i - base + 1, i);
    if (tenkan[i] != null && kijun[i] != null) senkouA[i] = (tenkan[i] + kijun[i]) / 2;
    if (i >= spanB - 1) senkouB[i] = midpoint(i - spanB + 1, i);
  }
  return { tenkan, kijun, senkouA, senkouB, displacement };
}

// ---------------------------------------------------------------------------
// Pivot / swing detection — shared by RSI divergence, S/R breakout and SMC.
// ---------------------------------------------------------------------------

/**
 * Fractal pivot highs. A bar i is a pivot high if its high is strictly greater
 * than the `left` bars before and `right` bars after it.
 * @returns array of { index, price }.
 */
export function pivotHighs(candles, left = 2, right = 2) {
  const piv = [];
  for (let i = left; i < candles.length - right; i++) {
    const h = candles[i].high;
    let isPivot = true;
    for (let j = i - left; j <= i + right; j++) {
      if (j === i) continue;
      if (candles[j].high >= h) {
        isPivot = false;
        break;
      }
    }
    if (isPivot) piv.push({ index: i, price: h });
  }
  return piv;
}

/** Fractal pivot lows (mirror of pivotHighs). */
export function pivotLows(candles, left = 2, right = 2) {
  const piv = [];
  for (let i = left; i < candles.length - right; i++) {
    const l = candles[i].low;
    let isPivot = true;
    for (let j = i - left; j <= i + right; j++) {
      if (j === i) continue;
      if (candles[j].low <= l) {
        isPivot = false;
        break;
      }
    }
    if (isPivot) piv.push({ index: i, price: l });
  }
  return piv;
}

/** Generic pivots on a numeric series (used for RSI swing points). */
export function pivotsOnSeries(series, left = 2, right = 2) {
  const highs = [];
  const lows = [];
  for (let i = left; i < series.length - right; i++) {
    if (series[i] == null) continue;
    let isHigh = true;
    let isLow = true;
    for (let j = i - left; j <= i + right; j++) {
      if (j === i || series[j] == null) continue;
      if (series[j] >= series[i]) isHigh = false;
      if (series[j] <= series[i]) isLow = false;
    }
    if (isHigh) highs.push({ index: i, value: series[i] });
    if (isLow) lows.push({ index: i, value: series[i] });
  }
  return { highs, lows };
}

/** Convenience: last non-null value of a series. */
export function last(series) {
  for (let i = series.length - 1; i >= 0; i--) {
    if (series[i] != null) return series[i];
  }
  return null;
}

/** Convenience: value + index of the last non-null entry. */
export function lastWithIndex(series) {
  for (let i = series.length - 1; i >= 0; i--) {
    if (series[i] != null) return { value: series[i], index: i };
  }
  return { value: null, index: -1 };
}
