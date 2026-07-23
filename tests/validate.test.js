// ============================================================================
// tests/validate.test.js — validate.mjs plumbing (Stage 3).
// Builds a tiny synthetic --data dir (NOT market data — this only exercises the
// orchestration: file layout, JSON shapes, 5m-only compare skip) and runs
// validate.mjs against it, writing results to a throwaway dir via VALIDATE_OUT.
//   node tests/validate.test.js
// ============================================================================
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resampleToHTF } from "../js/htf.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let passed = 0, failed = 0;
function ok(name, cond) { if (cond) { console.log(`  ✓ ${name}`); passed++; } else { console.error(`  ✗ ${name}`); failed++; } }

function mul(a) { return function () { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
function gen(n, seed, p0) {
  const r = mul(seed); const out = []; let p = p0; let t = 1600000000000;
  for (let i = 0; i < n; i++) { const o = p, c = Math.max(0.01, o + (r() - 0.5) * p * 0.006); out.push({ time: t, open: o, high: Math.max(o, c) * 1.001, low: Math.min(o, c) * 0.999, close: c, volume: 100 + r() * 900 }); p = c; t += 300000; }
  return out;
}
function writeData(dir, pairs, n) {
  fs.mkdirSync(dir, { recursive: true });
  const perPair = {};
  pairs.forEach((sym, i) => {
    const c5 = gen(n, i + 1, 100 + i * 10);
    fs.writeFileSync(path.join(dir, `${sym}.json`), JSON.stringify({ symbol: sym, "5m": c5, "15m": resampleToHTF(c5, 3), "1h": resampleToHTF(c5, 12) }));
    perPair[sym] = { "5m": { requested: n, received: n, pages: 1, gaps: 0 }, "15m": { requested: n / 3 | 0, received: resampleToHTF(c5, 3).length, pages: 1, gaps: 0 }, "1h": { requested: n / 12 | 0, received: resampleToHTF(c5, 12).length, pages: 1, gaps: 0 } };
  });
  fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify({ fetchedAt: "2026-01-01T00:00:00Z", source: "synthetic-test", primaryTf: "5m", target: n, tfs: ["5m", "15m", "1h"], perPair }));
}

console.log("validate.mjs plumbing");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "validate-test-"));
const dataDir = path.join(tmp, "data");
const outRoot = path.join(tmp, "out");
// 560 5m candles per pair: enough for warmup(120)+train(200)+test(100) => folds run.
writeData(dataDir, ["AAAUSDT", "BBBUSDT"], 560);

const res = spawnSync("node", ["validate.mjs", dataDir], { cwd: ROOT, encoding: "utf8", env: { ...process.env, VALIDATE_OUT: outRoot }, maxBuffer: 1e9 });
ok("validate exits 0", res.status === 0);

const runDirs = fs.existsSync(outRoot) ? fs.readdirSync(outRoot) : [];
ok("one results/<timestamp> dir created", runDirs.length === 1);
const outDir = path.join(outRoot, runDirs[0] || "");

for (const f of ["matrix.txt", "matrix.json", "walk.txt", "walk.json", "compare.txt", "compare.json", "data-manifest.json", "run-meta.json"]) {
  ok(`wrote ${f}`, fs.existsSync(path.join(outDir, f)));
}

const walk = JSON.parse(fs.readFileSync(path.join(outDir, "walk.json"), "utf8"));
ok("walk.json mode=walk", walk.mode === "walk");
ok("walk.json has foldRows + oos", Array.isArray(walk.foldRows) && typeof walk.oos === "object");
ok("walk.json pooled 2 pairs", walk.pairs === 2);

const matrix = JSON.parse(fs.readFileSync(path.join(outDir, "matrix.json"), "utf8"));
ok("matrix.json mode=matrix", matrix.mode === "matrix");
ok("matrix.json has bySetupTf + negCombos", typeof matrix.bySetupTf === "object" && Array.isArray(matrix.negCombos));

const cmp = JSON.parse(fs.readFileSync(path.join(outDir, "compare.json"), "utf8"));
ok("compare skipped (5m-only, no 1m)", cmp.skipped === true);

const meta = JSON.parse(fs.readFileSync(path.join(outDir, "run-meta.json"), "utf8"));
ok("run-meta records calibration + budget", meta.calibration && meta.calibration.budgetSec === 7200);
ok("run-meta has1m=false", meta.has1m === false);
ok("run-meta records dataQuality (clean)", meta.dataQuality && meta.dataQuality.badPairs.length === 0 && meta.dataQuality.stalls === 0);

// --- Data-quality abort gate: a stalled snapshot must NOT be validated -------
{
  const badDir = path.join(tmp, "baddata");
  const outBad = path.join(tmp, "outbad");
  fs.mkdirSync(badDir, { recursive: true });
  // 2 pairs, one with a pagination stall -> 50% bad + stalls>0 -> must abort.
  const c5 = gen(560, 9, 100);
  fs.writeFileSync(path.join(badDir, "AAAUSDT.json"), JSON.stringify({ symbol: "AAAUSDT", "5m": c5, "15m": resampleToHTF(c5, 3), "1h": resampleToHTF(c5, 12) }));
  fs.writeFileSync(path.join(badDir, "BBBUSDT.json"), JSON.stringify({ symbol: "BBBUSDT", "5m": c5.slice(-500) }));
  fs.writeFileSync(path.join(badDir, "manifest.json"), JSON.stringify({
    source: "mexc", primaryTf: "5m", target: 20000, tfs: ["5m", "15m", "1h"], stalls: 1,
    perPair: {
      AAAUSDT: { "5m": { requested: 560, received: 560, pages: 1, gaps: 0 }, "15m": { requested: 187, received: resampleToHTF(c5, 3).length, pages: 1, gaps: 0 }, "1h": { requested: 47, received: resampleToHTF(c5, 12).length, pages: 1, gaps: 0 } },
      BBBUSDT: { "5m": { requested: 20000, received: 500, pages: 2, gaps: 0, stalled: true, error: "pagination stall — endTime not advancing" } },
    },
  }));
  const bad = spawnSync("node", ["validate.mjs", badDir], { cwd: ROOT, encoding: "utf8", env: { ...process.env, VALIDATE_OUT: outBad }, maxBuffer: 1e9 });
  ok("validate ABORTS on stalled snapshot (exit 4)", bad.status === 4);
  ok("abort message names the stall", /PAGINATION|stall/i.test((bad.stderr || "") + (bad.stdout || "")));
  ok("no results dir created on abort", !fs.existsSync(outBad) || fs.readdirSync(outBad).length === 0);
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
