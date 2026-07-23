// ============================================================================
// tests/analyzeresults.test.js — Stage 4 verdict logic (pure functions).
//   node tests/analyzeresults.test.js
// ============================================================================
import { analyze, proposedConfigDiff } from "../analyze-results.js";

let passed = 0, failed = 0;
function ok(name, cond) { if (cond) { console.log(`  ✓ ${name}`); passed++; } else { console.error(`  ✗ ${name}`); failed++; } }

const meta = { minTradesForVerdict: 50 };

console.log("analyze-results verdict logic");

// 1. Negative & sufficient -> disable; positive & sufficient -> keep;
//    below-min -> unresolved (never a recommendation).
{
  const run = { meta, matrix: { tf: "5m", bySetupTf: {
    "breakout_retest@5m": { n: 60, netAvg: -0.30, pf: 0.8, winRate: 40 },
    "trend_pullback@5m": { n: 80, netAvg: 0.40, pf: 1.5, winRate: 55 },
    "sweep_reverse@5m": { n: 10, netAvg: -0.20, pf: 0.7, winRate: 30 },
  }, overall: { n: 150, netAvg: 0.1, pf: 1.1 } }, walk: null };
  const a = analyze(run);
  ok("negative+sufficient -> disable", a.disable.length === 1 && a.disable[0].combo === "breakout_retest@5m");
  ok("positive+sufficient -> kept", a.keptPositive.length === 1 && a.keptPositive[0].combo === "trend_pullback@5m");
  ok("below-min -> unresolved", a.unresolved.length === 1 && a.unresolved[0].combo === "sweep_reverse@5m");
  ok("diff proposes disabledSetups with the negative combo", /disabledSetups: \["breakout_retest@5m"\]/.test(proposedConfigDiff(a, run)));
}

// 2. Walk OOS sound (n>=min, non-negative) -> adopt consensus params.
{
  const combo = { minAgree: 7, minRR: 1.2, capScale: 1.0, expireBars: 6, recency: 3 };
  const run = { meta, matrix: { tf: "5m", bySetupTf: {} }, walk: {
    tf: "5m", oos: { n: 60, expectancy: 0.25, pf: 1.4, netAvg: 0.25 },
    selectedParams: [combo, combo, { ...combo, minAgree: 6 }], includedFolds: 3, folds: 4,
  } };
  const a = analyze(run);
  ok("sound OOS -> adopt", a.walkVerdict.status === "adopt");
  ok("consensus picks the majority combo (minAgree 7)", a.walkVerdict.params.combo.minAgree === 7 && a.walkVerdict.params.agreeFolds === 2);
  ok("diff proposes gate.minAgree change", /minAgree: 7,/.test(proposedConfigDiff(a, run)));
}

// 3. Walk OOS present but too few trades -> keep defaults, say so.
{
  const run = { meta, matrix: { tf: "5m", bySetupTf: {} }, walk: {
    tf: "5m", oos: { n: 20, expectancy: 0.9, netAvg: 0.9 }, selectedParams: [{ minAgree: 7 }], includedFolds: 1, folds: 4,
  } };
  const a = analyze(run);
  ok("insufficient OOS -> keep-defaults", a.walkVerdict.status === "keep-defaults" && /< 50/.test(a.walkVerdict.detail));
  ok("no params proposed from thin OOS", !/minAgree/.test(proposedConfigDiff(a, run)));
}

// 4. Walk OOS sound in size but NEGATIVE expectancy -> keep defaults (not an edge).
{
  const run = { meta, matrix: { tf: "5m", bySetupTf: {} }, walk: {
    tf: "5m", oos: { n: 90, expectancy: -0.15, netAvg: -0.15 }, selectedParams: [{ minAgree: 7 }], includedFolds: 3, folds: 4,
  } };
  const a = analyze(run);
  ok("negative sound OOS -> keep-defaults", a.walkVerdict.status === "keep-defaults" && /< 0/.test(a.walkVerdict.detail));
}

// 5. All sufficient cells negative, no walk edge -> "tuning is not the fix" flag.
{
  const run = { meta, matrix: { tf: "5m", bySetupTf: {
    "breakout_retest@5m": { n: 60, netAvg: -0.30, pf: 0.8, winRate: 40 },
    "trend_pullback@5m": { n: 70, netAvg: -0.10, pf: 0.9, winRate: 45 },
  }, overall: { n: 130, netAvg: -0.2, pf: 0.85 } }, walk: { tf: "5m", oos: { n: 0 }, folds: 4, includedFolds: 0, foldRows: [] } };
  const a = analyze(run);
  ok("all-negative-given-data flagged", a.allNegativeGivenData === true && a.anyPositive === false);
  ok("both negatives proposed for disable", a.disable.length === 2);
}

// 6. Nothing reaches the minimum -> inconclusive, zero proposals.
{
  const run = { meta, matrix: { tf: "5m", bySetupTf: {
    "breakout_retest@5m": { n: 8, netAvg: -0.30, pf: 0.8, winRate: 40 },
  }, overall: { n: 8, netAvg: -0.3, pf: 0.8 } }, walk: { tf: "5m", insufficient: true, reason: "too few candles" } };
  const a = analyze(run);
  ok("nothing sufficient -> anySufficient false", a.anySufficient === false);
  ok("no disable proposals from thin data", a.disable.length === 0);
  ok("everything unresolved", a.unresolved.length === 1);
  ok("diff is empty", /no config changes proposed/.test(proposedConfigDiff(a, run)));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
