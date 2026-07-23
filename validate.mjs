// ============================================================================
// validate.mjs — one-command measurement pass over a fetch-data.js snapshot.
//   npm run validate            (uses ./data)
//   node validate.mjs ./data    (explicit dir)
//
// Runs, in sequence, saving human tables AND machine JSON to results/<timestamp>/:
//   a) backtest --matrix --data <dir> <primaryTf>
//   b) backtest --compare 1m <primaryTf> --data <dir>   (ONLY if 1m present)
//   c) backtest --walk <primaryTf> --data <dir>         (pooled, full grid)
//
// Before the heavy walk it prints a CALIBRATION estimate (single-pair walk timing
// x pair count) and ABORTS if the projection exceeds the safety budget (2h).
// Nothing here fetches or synthesizes data — it only reads <dir>.
// ============================================================================
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { CONFIG } from "./js/config.js";
import { intervalMinutes } from "./js/htf.js";
import { verifyManifest } from "./verify-manifest.js";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const BUDGET_SEC = 2 * 3600; // abort if projected walk time exceeds this

function listPairFiles(dir) {
  return fs.readdirSync(dir).filter((f) => f.endsWith(".json") && f !== "manifest.json");
}
function loadObj(dir, file) { return JSON.parse(fs.readFileSync(path.join(dir, file), "utf8")); }
function tfLen(obj, tf) { return Array.isArray(obj[tf]) ? obj[tf].length : 0; }

// Run backtest.js, tee stdout to <outDir>/<name>.txt, and point --json at
// <outDir>/<name>.json. Returns { seconds, status }.
function runBacktest(name, argv, outDir) {
  const jsonPath = path.join(outDir, `${name}.json`);
  const t0 = Date.now();
  const res = spawnSync("node", ["backtest.js", ...argv, "--json", jsonPath], { cwd: ROOT, encoding: "utf8", maxBuffer: 1e9 });
  const seconds = (Date.now() - t0) / 1000;
  const out = (res.stdout || "") + (res.stderr ? `\n[stderr]\n${res.stderr}` : "");
  fs.writeFileSync(path.join(outDir, `${name}.txt`), out);
  return { seconds, status: res.status, out };
}

function main() {
  const dataDir = path.resolve(process.argv[2] || "./data");
  if (!fs.existsSync(dataDir)) { console.error(`No data dir at ${dataDir}. Run fetch-data.js first (see RUN_ME.md).`); process.exit(2); }

  // Provenance / integrity.
  let vm;
  try { vm = verifyManifest(dataDir); } catch (e) { console.error(e.message); process.exit(2); }
  // The primary SCALPING timeframe (what matrix/walk run on) is the LONGEST of the
  // scanned timeframes — 5m by default; 1m (if scanned) is the faster confirm TF,
  // never the primary. This is config-driven, NOT the manifest's primaryTf (which
  // is just the smallest TF fetched, used only for span sizing).
  const primaryTf = [...CONFIG.scanner.timeframes].sort((a, b) => intervalMinutes(b) - intervalMinutes(a))[0] || "5m";
  const pairFiles = listPairFiles(dataDir);
  if (!pairFiles.length) { console.error(`No <SYMBOL>.json files in ${dataDir}.`); process.exit(2); }
  const nPairs = pairFiles.length;

  // Is 1m present (with enough depth to evaluate)?
  const has1m = pairFiles.some((f) => tfLen(loadObj(dataDir, f), "1m") >= CONFIG.backtest.warmup + 30);

  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const resultsRoot = process.env.VALIDATE_OUT ? path.resolve(process.env.VALIDATE_OUT) : path.join(ROOT, "results");
  const outDir = path.join(resultsRoot, ts);
  fs.mkdirSync(outDir, { recursive: true });
  // Snapshot the provenance INTO the results folder so a run is self-contained.
  fs.copyFileSync(path.join(dataDir, "manifest.json"), path.join(outDir, "data-manifest.json"));

  console.log(`VALIDATE — ${nPairs} pairs · primary ${primaryTf} · 1m ${has1m ? "present" : "absent"} · data ${dataDir}`);
  console.log(`  results -> ${outDir}`);
  if (vm.issues.length) console.log(`  ⚠ ${vm.issues.length} manifest issue(s) (see verify-manifest.js); proceeding, treat thin pairs with skepticism.`);

  // --- CALIBRATION: time ONE pair's walk, project across the universe --------
  const biggest = pairFiles
    .map((f) => ({ f, n: tfLen(loadObj(dataDir, f), primaryTf) }))
    .sort((a, b) => b.n - a.n)[0];
  const probeDir = fs.mkdtempSync(path.join(os.tmpdir(), "validate-probe-"));
  fs.copyFileSync(path.join(dataDir, biggest.f), path.join(probeDir, biggest.f));
  console.log(`\nCalibration: timing a single-pair walk (${biggest.f.replace(/\.json$/, "")}, ${biggest.n} ${primaryTf} candles)…`);
  const t0 = Date.now();
  const probe = spawnSync("node", ["backtest.js", "--walk", "--data", probeDir, primaryTf], { cwd: ROOT, encoding: "utf8", maxBuffer: 1e9 });
  const singleSec = (Date.now() - t0) / 1000;
  fs.rmSync(probeDir, { recursive: true, force: true });
  if (probe.status !== 0) console.log(`  (probe walk exited ${probe.status}; using measured wall-clock anyway)`);

  const projectedSec = singleSec * nPairs;
  const fmtDur = (s) => (s < 90 ? `${s.toFixed(1)}s` : s < 5400 ? `${(s / 60).toFixed(1)} min` : `${(s / 3600).toFixed(2)} h`);
  console.log(`  single-pair walk ≈ ${fmtDur(singleSec)} · ${nPairs} pairs → projected pooled walk ≈ ${fmtDur(projectedSec)} (budget ${fmtDur(BUDGET_SEC)})`);
  if (projectedSec > BUDGET_SEC) {
    console.error(`\n✗ ABORT: projected walk ${fmtDur(projectedSec)} exceeds the ${fmtDur(BUDGET_SEC)} budget.`);
    console.error(`  Reduce the universe (fewer pairs) or the depth (--limit) and re-fetch, then re-run.`);
    fs.writeFileSync(path.join(outDir, "ABORTED.txt"), `Aborted: projected ${projectedSec.toFixed(0)}s > budget ${BUDGET_SEC}s (single ${singleSec.toFixed(1)}s x ${nPairs} pairs).\n`);
    process.exit(3);
  }

  // --- The three measurements ------------------------------------------------
  const runs = {};
  console.log(`\n[1/${has1m ? 3 : 2}] --matrix …`);
  runs.matrix = runBacktest("matrix", ["--matrix", "--data", dataDir, primaryTf], outDir);
  console.log(`      done in ${fmtDur(runs.matrix.seconds)} (status ${runs.matrix.status})`);

  if (has1m) {
    console.log(`\n[2/3] --compare 1m ${primaryTf} …`);
    runs.compare = runBacktest("compare", ["--compare", "1m", primaryTf, "--data", dataDir], outDir);
    console.log(`      done in ${fmtDur(runs.compare.seconds)} (status ${runs.compare.status})`);
  } else {
    console.log(`\n[2/2] --compare SKIPPED — no 1m data (5m-only run).`);
    fs.writeFileSync(path.join(outDir, "compare.txt"), "5m-only run — no 1m timeframe in the snapshot; comparison skipped.\n");
    fs.writeFileSync(path.join(outDir, "compare.json"), JSON.stringify({ mode: "compare", skipped: true, reason: "no 1m data (5m-only run)" }, null, 2));
  }

  const walkStep = has1m ? "3/3" : "2/2";
  console.log(`\n[${walkStep}] --walk ${primaryTf} (pooled, full grid) …`);
  runs.walk = runBacktest("walk", ["--walk", "--data", dataDir, primaryTf], outDir);
  console.log(`      done in ${fmtDur(runs.walk.seconds)} (status ${runs.walk.status})`);

  // --- Run meta --------------------------------------------------------------
  const meta = {
    generatedAt: new Date().toISOString(), dataDir, primaryTf, nPairs, has1m,
    pairs: pairFiles.map((f) => f.replace(/\.json$/, "")),
    manifestIssues: vm.issues,
    calibration: { singleSec, projectedSec, budgetSec: BUDGET_SEC, probePair: biggest.f.replace(/\.json$/, ""), probeCandles: biggest.n },
    timings: Object.fromEntries(Object.entries(runs).map(([k, v]) => [k, v.seconds])),
    replayWindowBars: CONFIG.replay.windowBars, minTradesForVerdict: CONFIG.backtest.minTradesForVerdict,
  };
  fs.writeFileSync(path.join(outDir, "run-meta.json"), JSON.stringify(meta, null, 2));

  console.log(`\n✓ VALIDATION COMPLETE → ${outDir}`);
  console.log(`  files: matrix.{txt,json} · ${has1m ? "compare.{txt,json}" : "compare.{txt,json} (skipped)"} · walk.{txt,json} · data-manifest.json · run-meta.json`);
  console.log(`\nNext: node analyze-results.js ${path.relative(ROOT, outDir)}`);
}

main();
