// ============================================================================
// tests/indicators.test.js — Zero-dependency sanity tests for the indicator
// math. Run with:  node tests/indicators.test.js
//
// Each expected value below was computed by hand from the fixed inputs so the
// formulas can be audited independently of this code.
// ============================================================================
import { ema, rsi, macd, atr, bollinger, sma, obv } from "../js/indicators.js";

let passed = 0;
let failed = 0;

function approx(actual, expected, tol, label) {
  if (actual == null || !isFinite(actual) || Math.abs(actual - expected) > tol) {
    console.error(`  ✗ ${label}: expected ≈ ${expected}, got ${actual}`);
    failed++;
  } else {
    console.log(`  ✓ ${label}: ${actual}`);
    passed++;
  }
}

function eq(actual, expected, label) {
  if (actual === expected) {
    console.log(`  ✓ ${label}: ${actual}`);
    passed++;
  } else {
    console.error(`  ✗ ${label}: expected ${expected}, got ${actual}`);
    failed++;
  }
}

// Helper: build candles from close prices (h/l offset for TR/ATR-independent tests).
function candlesFrom(hlc) {
  return hlc.map(([h, l, c], i) => ({ time: i, open: c, high: h, low: l, close: c, volume: 100 }));
}

// --- SMA -------------------------------------------------------------------
console.log("SMA(3) on [1,2,3,4,5]");
{
  const s = sma([1, 2, 3, 4, 5], 3);
  eq(s[0], null, "sma[0] warmup null");
  eq(s[2], 2, "sma[2] = (1+2+3)/3");
  eq(s[4], 4, "sma[4] = (3+4+5)/3");
}

// --- EMA -------------------------------------------------------------------
// EMA(3) on [1,2,3,4,5]: seed SMA(1,2,3)=2 at idx2; k=0.5;
//   idx3 = (4-2)*.5+2 = 3;  idx4 = (5-3)*.5+3 = 4.
console.log("EMA(3) on [1,2,3,4,5]");
{
  const e = ema([1, 2, 3, 4, 5], 3);
  eq(e[1], null, "ema warmup null");
  approx(e[2], 2, 1e-9, "ema[2] seed = SMA");
  approx(e[3], 3, 1e-9, "ema[3]");
  approx(e[4], 4, 1e-9, "ema[4]");
}

// --- RSI -------------------------------------------------------------------
// All-gains series -> RSI = 100; all-losses -> RSI = 0.
console.log("RSI edge cases");
{
  const up = rsi([1, 2, 3, 4, 5, 6, 7, 8], 3);
  approx(up[up.length - 1], 100, 1e-9, "RSI all gains = 100");
  const down = rsi([8, 7, 6, 5, 4, 3, 2, 1], 3);
  approx(down[down.length - 1], 0, 1e-9, "RSI all losses = 0");
}
// Hand-computed RSI(3) on [10,11,10,12,13,12,14]:
//   idx3 = 75.000 ; last idx = 77.586 (see README derivation).
console.log("RSI(3) on [10,11,10,12,13,12,14]");
{
  const r = rsi([10, 11, 10, 12, 13, 12, 14], 3);
  approx(r[3], 75, 0.01, "rsi[3]");
  approx(r[6], 77.586, 0.02, "rsi[6]");
}

// --- MACD ------------------------------------------------------------------
// On [1..8] with (2,3,2): EMA2-EMA3 is a constant 0.5 from idx2 on, so the
// MACD line = 0.5, signal (EMA2 of 0.5s) = 0.5, histogram = 0.
console.log("MACD(2,3,2) on [1..8]");
{
  const m = macd([1, 2, 3, 4, 5, 6, 7, 8], 2, 3, 2);
  const i = 7;
  approx(m.macd[i], 0.5, 1e-9, "macd line = 0.5");
  approx(m.signal[i], 0.5, 1e-9, "signal = 0.5");
  approx(m.hist[i], 0, 1e-9, "hist = 0");
}

// --- ATR -------------------------------------------------------------------
// Candles (high,low,close):
//   (10,8,9)(11,9,10)(12,10,11)(13,11,12)(11,9,10)
// TR: idx1=2, idx2=2, idx3=2, idx4=3.  ATR(3): idx3 = 2 ; idx4 = (2*2+3)/3 = 2.3333.
console.log("ATR(3)");
{
  const c = candlesFrom([
    [10, 8, 9],
    [11, 9, 10],
    [12, 10, 11],
    [13, 11, 12],
    [11, 9, 10],
  ]);
  const a = atr(c, 3);
  approx(a[3], 2, 1e-9, "atr[3] seed");
  approx(a[4], 2.33333, 1e-4, "atr[4] Wilder");
}

// --- Bollinger -------------------------------------------------------------
// BB(3,2) on [2,4,6,8,10]: idx2 window [2,4,6] mean 4, popStd = sqrt(8/3)=1.63299;
//   upper = 4 + 2*1.63299 = 7.26599 ; lower = 0.73401.
console.log("Bollinger(3,2) on [2,4,6,8,10]");
{
  const b = bollinger([2, 4, 6, 8, 10], 3, 2);
  approx(b.middle[2], 4, 1e-9, "bb middle");
  approx(b.upper[2], 7.26599, 1e-4, "bb upper");
  approx(b.lower[2], 0.73401, 1e-4, "bb lower");
}

// --- OBV -------------------------------------------------------------------
// closes up,up,down => +vol,+vol,-vol.
console.log("OBV direction");
{
  const c = [
    { close: 10, volume: 5 },
    { close: 11, volume: 5 },
    { close: 12, volume: 5 },
    { close: 11, volume: 5 },
  ];
  const o = obv(c);
  eq(o[1], 5, "obv up");
  eq(o[2], 10, "obv up again");
  eq(o[3], 5, "obv down");
}

// --- Summary ---------------------------------------------------------------
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
