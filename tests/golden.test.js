// ============================================================================
// tests/golden.test.js — bit-for-bit regression guard for the backtest replay.
//
// Runs `backtest.js --matrix` and `--walk` on the committed fixtures
// (tests/golden/fixtures — 5 pairs) and asserts the output EXACTLY matches the
// committed golden files (tests/golden/{matrix,walk}.out), path-normalized.
//
// These goldens were generated from the PRE-refactor code; the replay-perf
// refactor must reproduce them exactly. If they diverge, that is a real
// behavior change — investigate, do NOT blindly regenerate.
//   node tests/golden.test.js
// ============================================================================
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FIX = "tests/golden/fixtures";

let passed = 0, failed = 0;

function run(argStr) {
  const out = execSync(`node backtest.js ${argStr}`, { cwd: root, encoding: "utf8", maxBuffer: 1e8 });
  return out.split(FIX).join("<FIXTURES>");
}
function firstDiff(a, b) {
  const A = a.split("\n"), B = b.split("\n");
  for (let i = 0; i < Math.max(A.length, B.length); i++) {
    if (A[i] !== B[i]) return `line ${i + 1}:\n   golden: ${JSON.stringify(B[i])}\n   actual: ${JSON.stringify(A[i])}`;
  }
  return "(only trailing whitespace/length differs)";
}
function check(name, argStr, goldenFile) {
  const want = fs.readFileSync(path.join(root, goldenFile), "utf8");
  const got = run(argStr);
  if (got === want) { console.log(`  ✓ ${name} matches golden`); passed++; }
  else { console.error(`  ✗ ${name} DIVERGED from golden\n   ${firstDiff(got, want)}`); failed++; }
}

console.log("golden regression (backtest replay parity)");
check("--matrix", `--matrix --data ${FIX} 5m`, "tests/golden/matrix.out");
check("--walk", `--walk --data ${FIX} 5m`, "tests/golden/walk.out");

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
