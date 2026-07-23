// ============================================================================
// tests/htflayer.test.js — two-layer HTF bias (Task 2).
// The slower regime layer (config.htf.regimeTf): when its structure opposes the
// signal, "downgrade" lowers the tier, "veto" rejects it, "off" ignores it.
//   node tests/htflayer.test.js
// ============================================================================
import { CONFIG } from "../js/config.js";
import { evaluate } from "../js/confluence.js";

let passed = 0, failed = 0;
const ok = (c, l) => (c ? (console.log(`  ✓ ${l}`), passed++) : (console.error(`  ✗ ${l}`), failed++));
const eq = (a, b, l) => ok(a === b, `${l} (got ${JSON.stringify(a)})`);
const mk = (o, h, l, c, v = 200) => ({ time: 0, open: o, high: h, low: l, close: c, volume: v });

// A crafted candle set that triggers a LONG sweep-&-reverse (from setups test).
function longSweep() {
  const cs = [];
  let px = 100;
  for (let i = 0; i < 52; i++) { const o = px; px += 0.25; const c = px; cs.push(mk(o, Math.max(o, c) + 0.1, Math.min(o, c) - 0.1, c)); }
  cs.push(mk(px, px + 0.1, px - 0.2, px - 0.15));
  cs.push(mk(px - 0.15, px - 0.1, px - 1.6, px - 1.4));
  cs.push(mk(px - 1.4, px - 1.3, px - 2.2, px - 1.5));
  cs.push(mk(px - 1.5, px - 0.9, px - 1.6, px - 1.0));
  cs.push(mk(px - 1.0, px - 0.4, px - 1.1, px - 0.6));
  cs.push(mk(px - 0.7, px + 0.8, px - 2.6, px + 0.6));
  cs.push(mk(px + 0.6, px + 0.9, px + 0.4, px + 0.75));
  cs.push(mk(px + 0.75, px + 1.0, px + 0.6, px + 0.9));
  return cs;
}
const rising = Array.from({ length: 40 }, (_, i) => mk(100 + i, 100 + i + 0.5, 100 + i - 0.5, 100 + i + 0.4)); // BULL bias
const falling = Array.from({ length: 40 }, (_, i) => mk(200 - i, 200 - i + 0.5, 200 - i - 0.5, 200 - i - 0.4)); // BEAR regime

// Isolate the regime effect: relax the OTHER gate conditions (veto set, R:R,
// stop cap, single setup) so a plan reliably forms and only the regime varies.
const snap = {
  minRR: CONFIG.gate.minRR, cap: CONFIG.scalper.stopCapPct["5m"], mode: CONFIG.htf.regimeMode,
  veto: CONFIG.gate.vetoStrategies, setups: JSON.parse(JSON.stringify(CONFIG.setups)),
};
CONFIG.gate.minRR = 0.05;
CONFIG.scalper.stopCapPct["5m"] = 100;
CONFIG.gate.vetoStrategies = []; // don't let a bearish confirmation hard-veto the long
for (const k of Object.keys(CONFIG.setups)) CONFIG.setups[k].enabled = k === "sweep_reverse";

const candles = longSweep();
const run = () => evaluate(candles, rising, { symbol: "T", interval: "5m", htfInterval: "15m", regimeCandles: falling, regimeInterval: "1h" });
const down = (t) => (t === "A+" ? "A" : "B");
const hasLong = (d) => d.plan && d.plan.direction === "LONG";

console.log("regime layer");
CONFIG.htf.regimeMode = "off";
const dOff = run();
ok(hasLong(dOff), `baseline produces a LONG plan (status ${dOff.status})`);
if (hasLong(dOff)) {
  const t0 = dOff.plan.tier;
  ok(dOff.plan.regimeDowngraded === false, "off: not downgraded");

  CONFIG.htf.regimeMode = "downgrade";
  const dDown = run();
  ok(hasLong(dDown), "downgrade: LONG plan still present (not vetoed)");
  eq(dDown.plan.tier, down(t0), "downgrade: tier = downgrade(base tier)");
  ok(dDown.plan.regimeDowngraded === true, "downgrade: flagged regimeDowngraded");
  eq(dDown.plan.regimeBias, "BEAR", "downgrade: regimeBias recorded (BEAR)");

  CONFIG.htf.regimeMode = "veto";
  const dVeto = run();
  ok(!hasLong(dVeto), `veto: counter-regime LONG rejected (status ${dVeto.status})`);
}

// restore
CONFIG.gate.minRR = snap.minRR; CONFIG.scalper.stopCapPct["5m"] = snap.cap;
CONFIG.htf.regimeMode = snap.mode; CONFIG.gate.vetoStrategies = snap.veto; CONFIG.setups = snap.setups;

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
