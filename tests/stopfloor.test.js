// ============================================================================
// tests/stopfloor.test.js — the stop floor in confluence.js buildPlan.
// Drives evaluate() over a committed fixture (windowed, like the backtest) and
// checks that scalper.stopFloorK/M widen tiny stops while keeping the plan
// geometry consistent (stop/TP recomputed from the floored risk).
//   node tests/stopfloor.test.js
// ============================================================================
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CONFIG } from "../js/config.js";
import { evaluate } from "../js/confluence.js";
import { htfSliceAtTime } from "../js/htf.js";

let passed = 0, failed = 0;
const ok = (c, l) => (c ? (console.log(`  ✓ ${l}`), passed++) : (console.error(`  ✗ ${l}`), failed++));

const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "golden/fixtures");
const fx = JSON.parse(fs.readFileSync(path.join(dir, "BTCUSDT.json"), "utf8"));
const candles = fx["5m"], htf = fx["15m"], regime = fx["1h"];

function collectPlans() {
  const W = CONFIG.replay.windowBars, warmup = CONFIG.backtest.warmup;
  const plans = [];
  for (let i = warmup; i < candles.length - 2; i++) {
    const slice = candles.slice(Math.max(0, i + 1 - W), i + 1);
    const dec = evaluate(slice, htfSliceAtTime(htf, candles[i].time), {
      symbol: "BTCUSDT", interval: "5m", htfInterval: CONFIG.htf.biasTf,
      regimeCandles: htfSliceAtTime(regime, candles[i].time), regimeInterval: CONFIG.htf.regimeTf,
    });
    if (dec.status === "ACTIVE") plans.push(dec.plan);
  }
  return plans;
}

const snap = { k: CONFIG.scalper.stopFloorK, m: CONFIG.scalper.stopFloorM };
console.log("stop floor");

// Floor OFF: no plan is floored; stop == structure stop.
CONFIG.scalper.stopFloorK = 0; CONFIG.scalper.stopFloorM = 0;
const off = collectPlans();
ok(off.length > 0, `produced plans to test (${off.length})`);
ok(off.every((p) => !p.stopFloored), "floor off -> no plan flagged floored");
ok(off.every((p) => Math.abs(p.stopPct - p.structStopPct) < 1e-9), "floor off -> stopPct == structStopPct");

// Floor ON, large k (5×ATR): stops widen, geometry stays consistent.
CONFIG.scalper.stopFloorK = 5; CONFIG.scalper.stopFloorM = 0;
const on = collectPlans();
ok(on.some((p) => p.stopFloored), "large floor -> some plans floored");
ok(on.every((p) => p.stopPct >= p.structStopPct - 1e-9), "floored stopPct is never below the structure stopPct");
// Geometry: |entry-stop| == riskPerUnit, and TPs sit at tp1R/tp2R × risk from entry.
let geomOk = true;
for (const p of on) {
  const R = Math.abs(p.entryPrice - p.stop);
  if (Math.abs(R - p.riskPerUnit) > 1e-6 * p.entryPrice) geomOk = false;
  const dir = p.direction === "LONG" ? 1 : -1;
  if (Math.abs(p.tp1 - (p.entryPrice + dir * CONFIG.gate.tp1R * R)) > 1e-6 * p.entryPrice) geomOk = false;
  if (Math.abs(p.tp2 - (p.entryPrice + dir * CONFIG.gate.tp2R * R)) > 1e-6 * p.entryPrice) geomOk = false;
}
ok(geomOk, "floored plans: stop/TP recomputed consistently from the floored risk");
// A floored plan actually has a wider stop than it would structurally.
const someFloored = on.find((p) => p.stopFloored);
ok(someFloored && someFloored.stopPct > someFloored.structStopPct, "a floored plan's stop is genuinely wider than structure");
// Entry fill zone is the structural trigger band — unchanged by the floor.
ok(on.every((p) => Number.isFinite(p.entryLow) && Number.isFinite(p.entryHigh)), "entry fill zone still present");

CONFIG.scalper.stopFloorK = snap.k; CONFIG.scalper.stopFloorM = snap.m;
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
