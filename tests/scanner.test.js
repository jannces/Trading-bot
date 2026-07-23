// ============================================================================
// tests/scanner.test.js — incremental kline cache merge (Phase 3).
//   node tests/scanner.test.js
// ============================================================================
import { mergeIncremental } from "../js/scanner.js";

let passed = 0, failed = 0;
const eq = (a, b, l) => (a === b ? (console.log(`  ✓ ${l}: ${a}`), passed++) : (console.error(`  ✗ ${l}: expected ${b}, got ${a}`), failed++));
const ok = (c, l) => (c ? (console.log(`  ✓ ${l}`), passed++) : (console.error(`  ✗ ${l}`), failed++));

const INT = 60000;
const bar = (t, c) => ({ time: t, open: c, high: c, low: c, close: c, volume: 1 });
const cache = [bar(0, 10), bar(INT, 11), bar(2 * INT, 12)]; // last openTime = 2*INT

console.log("mergeIncremental");
// 1) In-progress update: same last open time replaces the last candle.
{
  const r = mergeIncremental(cache, [bar(2 * INT, 12.5)], INT, 100);
  eq(r.candles.length, 3, "same length (updated in place)");
  eq(r.candles[2].close, 12.5, "last candle updated to fresh value");
}
// 2) Next candle appends.
{
  const r = mergeIncremental(cache, [bar(2 * INT, 12), bar(3 * INT, 13)], INT, 100);
  eq(r.candles.length, 4, "appended the next candle");
  eq(r.candles[3].close, 13, "appended value correct");
}
// 3) Catch up one missed candle then continue.
{
  const short = [bar(0, 10), bar(INT, 11)]; // last = INT
  const r = mergeIncremental(short, [bar(2 * INT, 12), bar(3 * INT, 13)], INT, 100);
  eq(r.candles.length, 4, "catches up 1-behind cache");
}
// 4) Gap detection: jump >1 interval -> gap.
{
  const r = mergeIncremental(cache, [bar(5 * INT, 15)], INT, 100);
  ok(r.gap === true, "missed candles -> { gap: true }");
}
// 5) Older candles ignored.
{
  const r = mergeIncremental(cache, [bar(INT, 99)], INT, 100);
  eq(r.candles.length, 3, "older fresh candle ignored");
  eq(r.candles[1].close, 11, "existing candle unchanged");
}
// 6) Window cap.
{
  const big = Array.from({ length: 100 }, (_, i) => bar(i * INT, i));
  const r = mergeIncremental(big, [bar(100 * INT, 100)], INT, 100);
  eq(r.candles.length, 100, "capped at 100");
  eq(r.candles[99].close, 100, "newest kept");
  eq(r.candles[0].close, 1, "oldest dropped");
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
