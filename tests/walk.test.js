// ============================================================================
// tests/walk.test.js — walk-forward fold math + per-fold gating (pure).
//   node tests/walk.test.js
// ============================================================================
import { computeFolds, foldSelectable, sizingWarning } from "../js/walk.js";

let passed = 0, failed = 0;
const ok = (c, l) => (c ? (console.log(`  ✓ ${l}`), passed++) : (console.error(`  ✗ ${l}`), failed++));
const eq = (a, b, l) => ok(a === b, `${l} (got ${JSON.stringify(a)})`);

// --- Fold coverage: full range, derived fold count -------------------------
console.log("computeFolds coverage");
{
  const r = computeFolds(1500, 120, 200, 100); // usable 1380
  ok(!r.insufficient, "1500 candles -> sufficient");
  eq(r.usable, 1380, "usable = total - warmup");
  // n = floor((1380-200-100)/100)+1 = 11
  eq(r.folds.length, 11, "fold count derived from usable (not hardcoded 3)");
  eq(r.folds[0].trainFrom, 120, "first train starts at warmup");
  eq(r.folds[0].trainTo, 320, "train window = trainBars");
  eq(r.folds[0].testFrom, 320, "test starts where train ends");
  eq(r.folds[r.folds.length - 1].testTo, 1500, "last test window stretches to total");
  ok(Math.round(r.coveragePct) === 100, `coverage 100% (got ${r.coveragePct.toFixed(1)})`);
  // Monotonic, non-overlapping test windows (step = testBars).
  for (let i = 1; i < r.folds.length; i++) ok(r.folds[i].testFrom === r.folds[i - 1].testFrom + 100, `fold ${i} steps by testBars`);
}

// The bug case: a truncated fetch (~500 candles) is surfaced, not silently used.
console.log("computeFolds on a truncated fetch");
{
  const r = computeFolds(500, 120, 200, 100); // usable 380
  ok(!r.insufficient, "500 candles still runs");
  eq(r.folds.length, 1, "500 candles -> only 1 fold (was silently 3 before)");
  eq(r.folds[0].testTo, 500, "covers to the real end");
  ok(Math.round(r.coveragePct) === 100, "coverage still 100% of the (small) usable range");
}

// --- Insufficient data -----------------------------------------------------
console.log("computeFolds insufficient");
{
  const r = computeFolds(300, 120, 200, 100); // usable 180 < 300
  ok(r.insufficient, "usable < train+test -> insufficient");
  eq(r.folds.length, 0, "no folds emitted");
  ok(/need >= 420 candles/.test(r.reason), "reason states the candle requirement");
}
console.log("computeFolds exact boundary");
{
  const r = computeFolds(420, 120, 200, 100); // usable 300 == train+test
  ok(!r.insufficient, "exactly train+test -> one fold");
  eq(r.folds.length, 1, "one fold at the boundary");
}

// --- Per-fold gating (insufficient-trades path) ----------------------------
console.log("foldSelectable");
eq(foldSelectable(3, 50, 10, 10).selectable, false, "train < min -> not selectable");
ok(/insufficient train trades \(3 < 10\)/.test(foldSelectable(3, 50, 10, 10).reason), "reason names the counts");
eq(foldSelectable(20, 4, 10, 10).selectable, true, "enough train -> selectable");
eq(foldSelectable(20, 4, 10, 10).includeTest, false, "thin test -> excluded from aggregate");
ok(/test thin \(4 < 10\)/.test(foldSelectable(20, 4, 10, 10).reason), "thin-test reason");
eq(foldSelectable(20, 30, 10, 10).includeTest, true, "enough train + test -> included");

// --- Sizing warning --------------------------------------------------------
console.log("sizingWarning");
ok(sizingWarning(1.0, 100, 120, 200, 20, 1) === null, "plenty of trades -> no warning");
{
  const w = sizingWarning(0.05, 100, 120, 200, 20, 1); // 5 expected < 20
  ok(w !== null, "too few trades -> warning");
  eq(Math.round(w.expected), 5, "expected trades per window");
  ok(w.neededCandles > 120 + 200, "suggests more candles than warmup+train");
  ok(w.neededPairs >= 4, "suggests pooling more pairs");
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
