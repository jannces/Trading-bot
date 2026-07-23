// ============================================================================
// walk.js — Pure walk-forward fold math + per-fold trade-count gating.
//
// Kept free of IO/replay so it can be unit-tested. The backtest uses these to
// build rolling folds that COVER THE FULL usable range (fold count derived from
// candles actually available, not a hardcoded number), to gate degenerate folds
// (too few train/test trades), and to warn when the window is too small for the
// observed signal frequency.
// ============================================================================

/**
 * Rolling walk-forward folds over [warmup, total). Fixed train/test window
 * sizes; the number of folds is derived from `total`. The last fold's test
 * window is stretched to `total` so the whole usable range is covered.
 * @returns { folds:[{index,trainFrom,trainTo,testFrom,testTo}], usable,
 *            coveragePct, insufficient, reason }
 */
export function computeFolds(total, warmup, trainBars, testBars) {
  const usable = Math.max(0, total - warmup);
  if (usable < trainBars + testBars) {
    return {
      folds: [], usable, coveragePct: 0, insufficient: true,
      reason: `usable ${usable} bars < train ${trainBars} + test ${testBars} (need >= ${warmup + trainBars + testBars} candles, have ${total})`,
    };
  }
  const step = testBars; // non-overlapping test windows
  const n = Math.floor((usable - trainBars - testBars) / step) + 1;
  const folds = [];
  for (let f = 0; f < n; f++) {
    const trainFrom = warmup + f * step;
    const trainTo = trainFrom + trainBars;
    const testFrom = trainTo;
    const testTo = f === n - 1 ? total : testFrom + testBars; // absorb remainder
    folds.push({ index: f, trainFrom, trainTo, testFrom, testTo });
  }
  const coveredTo = folds[folds.length - 1].testTo;
  const coveragePct = usable > 0 ? ((coveredTo - warmup) / usable) * 100 : 0;
  return { folds, usable, coveragePct, insufficient: false, reason: "" };
}

/**
 * Gate a fold by its train/test trade counts (mirrors the --compare verdict:
 * never "select" on a thin sample). `selectable` = enough train trades to pick
 * params; `includeTest` = enough OOS trades to count in the aggregate.
 */
export function foldSelectable(trainN, testN, minTrain, minTest) {
  if (trainN < minTrain) return { selectable: false, includeTest: false, reason: `insufficient train trades (${trainN} < ${minTrain}) — no selection` };
  if (testN < minTest) return { selectable: true, includeTest: false, reason: `test thin (${testN} < ${minTest}) — excluded from aggregate` };
  return { selectable: true, includeTest: true, reason: "" };
}

/**
 * Window-sizing sanity: given the observed pooled trade frequency (trades per
 * bar, already summed over all pooled pairs) and the test-window size, is the
 * expected trades-per-fold below the warning threshold? If so, suggest how much
 * more data (candles) or how many pooled pairs would be needed.
 * @returns null if fine, else { expected, neededCandles, neededPairs }
 */
export function sizingWarning(tradesPerBar, testBars, warmup, trainBars, minPerFold, pooledPairs = 1) {
  const expected = tradesPerBar * testBars;
  if (!(expected < minPerFold)) return null;
  const perBarPerPair = pooledPairs > 0 ? tradesPerBar / pooledPairs : 0;
  // Candles (single pair) to expect minPerFold in one test window:
  const neededTestBars = perBarPerPair > 0 ? Math.ceil(minPerFold / perBarPerPair) : Infinity;
  const neededCandles = Number.isFinite(neededTestBars) ? warmup + trainBars + neededTestBars : Infinity;
  // Or, keep this window and pool more pairs:
  const neededPairs = expected > 0 ? Math.ceil((minPerFold / expected) * pooledPairs) : Infinity;
  return { expected, neededCandles, neededPairs };
}
