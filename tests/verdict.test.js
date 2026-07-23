// ============================================================================
// tests/verdict.test.js — --compare keep/disable verdict logic (Task 4).
//   node tests/verdict.test.js
// ============================================================================
import { compareVerdict } from "../js/verdict.js";

let passed = 0, failed = 0;
const eq = (a, b, l) => (a === b ? (console.log(`  ✓ ${l}`), passed++) : (console.error(`  ✗ ${l}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`), failed++));

const MIN = 50;
const S = (n, netAvg) => ({ n, netAvg });

console.log("verdicts with min-trade threshold = 50");
// Both thin -> never a recommendation.
eq(compareVerdict(S(10, 1), S(20, 1), "1m", "5m", MIN), "insufficient data (n=10/20)", "both thin -> insufficient");
// Both have enough + positive -> keep both.
eq(compareVerdict(S(60, 0.2), S(80, 0.3), "1m", "5m", MIN), "keep both", "both positive -> keep both");
// 5m positive, 1m negative (both enough) -> keep 5m only.
eq(compareVerdict(S(60, -0.1), S(80, 0.2), "1m", "5m", MIN), "keep 5m only", "5m good, 1m bad -> keep 5m only");
// 1m positive, 5m negative -> keep 1m only.
eq(compareVerdict(S(70, 0.15), S(90, -0.2), "1m", "5m", MIN), "keep 1m only", "1m good, 5m bad -> keep 1m only");
// Both enough + negative -> disable both.
eq(compareVerdict(S(60, -0.3), S(80, -0.1), "1m", "5m", MIN), "disable both", "both negative -> disable both");
// 5m positive + enough, 1m thin -> keep 5m only (1m thin).
eq(compareVerdict(S(10, 0.5), S(80, 0.2), "1m", "5m", MIN), "keep 5m only (1m thin)", "5m good, 1m thin");
// 5m negative + enough, 1m thin -> can't recommend -> insufficient.
eq(compareVerdict(S(10, 0.5), S(80, -0.2), "1m", "5m", MIN), "insufficient data (n=10/80)", "5m bad, 1m thin -> insufficient");
// Exactly at threshold counts as enough.
eq(compareVerdict(S(50, 0.1), S(50, 0.1), "1m", "5m", MIN), "keep both", "n == min is enough");
// Zero net counts as non-positive (<= 0).
eq(compareVerdict(S(60, 0), S(60, 0), "1m", "5m", MIN), "disable both", "zero net is non-positive");

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
