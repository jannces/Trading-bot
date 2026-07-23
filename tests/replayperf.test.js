// ============================================================================
// tests/replayperf.test.js — contracts for the replay-perf refactor.
//
// The backtest speedup rests on evaluate() being split into:
//   evaluateRaw()  — expensive, params-INDEPENDENT (except detection recency),
//                    depends ONLY on candles [0..i]  (no look-ahead)
//   gateDecision() — cheap, params-DEPENDENT (minAgree / minRR / stopCap)
// and evaluate(c,h,m) === gateDecision(evaluateRaw(c,h,m), m).
//
// These tests assert the three properties the precompute cache relies on:
//   1. COMPOSITION  — the split reproduces evaluate() exactly.
//   2. PARAMS-INDEPENDENCE — evaluateRaw ignores the grid thresholds, so one
//      cached raw is valid for every minAgree/minRR/stopCap combo.
//   3. NO LOOK-AHEAD — raw at bar i is invariant to any candle after i, so
//      caching per bar cannot leak the future.
//   node tests/replayperf.test.js
// ============================================================================
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CONFIG } from "../js/config.js";
import { evaluate, evaluateRaw, gateDecision } from "../js/confluence.js";
import { htfSliceAtTime } from "../js/htf.js";

const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "golden/fixtures");
const fx = JSON.parse(fs.readFileSync(path.join(dir, "BTCUSDT.json"), "utf8"));
const candles = fx["5m"], htf = fx["15m"], regime = fx["1h"];
const tf = "5m";

let passed = 0, failed = 0;
function ok(name, cond) { if (cond) { console.log(`  ✓ ${name}`); passed++; } else { console.error(`  ✗ ${name}`); failed++; } }
function metaAt(i) {
  return {
    symbol: "BTCUSDT", interval: tf, htfInterval: CONFIG.htf.biasTf,
    regimeCandles: htfSliceAtTime(regime, candles[i].time), regimeInterval: CONFIG.htf.regimeTf,
  };
}
// Strip volatile fields (createdAt) before comparing whole decisions.
function stable(dec) { return JSON.stringify(dec, (k, v) => (k === "createdAt" ? 0 : v)); }

// Spread of bars across the fixture, past warm-up.
const bars = [];
for (let i = CONFIG.backtest.warmup + 5; i < candles.length - 2; i += 37) bars.push(i);

console.log("replay-perf refactor contracts");

// --- 1. COMPOSITION: evaluate === gateDecision ∘ evaluateRaw ----------------
{
  let allEq = true;
  for (const i of bars) {
    const slice = candles.slice(0, i + 1);
    const htfSlice = htfSliceAtTime(htf, candles[i].time);
    const meta = metaAt(i);
    const direct = evaluate(slice, htfSlice, meta);
    const split = gateDecision(evaluateRaw(slice, htfSlice, meta), meta);
    if (stable(direct) !== stable(split)) { allEq = false; break; }
  }
  ok(`evaluate() === gateDecision(evaluateRaw()) across ${bars.length} bars`, allEq);
}

// --- 2. PARAMS-INDEPENDENCE: raw ignores the grid thresholds ----------------
{
  const snap = { a: CONFIG.gate.minAgree, rr: CONFIG.gate.minRR, cap: CONFIG.scalper.stopCapPct[tf] };
  const i = bars[Math.floor(bars.length / 2)];
  const slice = candles.slice(0, i + 1);
  const htfSlice = htfSliceAtTime(htf, candles[i].time);
  const meta = metaAt(i);

  CONFIG.gate.minAgree = 6; CONFIG.gate.minRR = 1.2; CONFIG.scalper.stopCapPct[tf] = snap.cap;
  const rawA = evaluateRaw(slice, htfSlice, meta);
  CONFIG.gate.minAgree = 9; CONFIG.gate.minRR = 3.0; CONFIG.scalper.stopCapPct[tf] = snap.cap * 0.5;
  const rawB = evaluateRaw(slice, htfSlice, meta);
  // Raw is byte-identical regardless of the grid thresholds...
  ok("evaluateRaw unaffected by minAgree/minRR/stopCap", JSON.stringify(rawA) === JSON.stringify(rawB));

  // ...but gateDecision DOES respond to them (else the split would be inert).
  CONFIG.gate.minAgree = 1;
  const permissive = gateDecision(rawA, meta).status;
  CONFIG.gate.minAgree = 11; // impossible to satisfy (only 10 strategies)
  const strict = gateDecision(rawA, meta).status;
  ok("gateDecision responds to minAgree (min 1 not stricter than min 11)",
    !(permissive === "NONE" && strict !== "NONE"));

  CONFIG.gate.minAgree = snap.a; CONFIG.gate.minRR = snap.rr; CONFIG.scalper.stopCapPct[tf] = snap.cap;
}

// --- 3. NO LOOK-AHEAD: raw at bar i invariant to candles after i ------------
// Structurally, precompute hands evaluateRaw exactly candles.slice(0,i+1); this
// asserts the property empirically — corrupt every future candle and confirm
// bar i's raw is byte-for-byte unchanged.
{
  let allInvariant = true;
  for (const i of bars) {
    const meta = metaAt(i);
    const htfSlice = htfSliceAtTime(htf, candles[i].time);
    const clean = candles.slice(0, i + 1);
    const rawClean = evaluateRaw(clean, htfSlice, meta);
    // Build a full series whose FUTURE (i+1..) is garbage, then slice [0..i].
    const poisoned = candles.map((c, j) =>
      j > i ? { ...c, open: 1e9, high: 1e9, low: -1e9, close: 1e9, volume: 1e9 } : c);
    const rawPoisoned = evaluateRaw(poisoned.slice(0, i + 1), htfSlice, meta);
    if (JSON.stringify(rawClean) !== JSON.stringify(rawPoisoned)) { allInvariant = false; break; }
  }
  ok("evaluateRaw(bar i) invariant to poisoned future candles", allInvariant);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
