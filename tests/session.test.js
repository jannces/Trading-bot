// ============================================================================
// tests/session.test.js — optional session (hour-of-day) filter (Task 5).
// When enabled, off-session signals are DOWNGRADED and flagged (not dropped).
//   node tests/session.test.js
// ============================================================================
import { CONFIG } from "../js/config.js";
import { evaluate } from "../js/confluence.js";

let passed = 0, failed = 0;
const ok = (c, l) => (c ? (console.log(`  ✓ ${l}`), passed++) : (console.error(`  ✗ ${l}`), failed++));
const eq = (a, b, l) => ok(a === b, `${l} (got ${JSON.stringify(a)})`);
const mk = (o, h, l, c, v = 200) => ({ time: 0, open: o, high: h, low: l, close: c, volume: v }); // time 0 -> hour 0 UTC

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
const rising = Array.from({ length: 40 }, (_, i) => mk(100 + i, 100 + i + 0.5, 100 + i - 0.5, 100 + i + 0.4));

// Relax the other gate conditions so a plan reliably forms; vary only the session.
const snap = {
  minRR: CONFIG.gate.minRR, cap: CONFIG.scalper.stopCapPct["5m"],
  veto: CONFIG.gate.vetoStrategies, setups: JSON.parse(JSON.stringify(CONFIG.setups)),
  sf: JSON.parse(JSON.stringify(CONFIG.sessionFilter)),
};
CONFIG.gate.minRR = 0.05;
CONFIG.scalper.stopCapPct["5m"] = 100;
CONFIG.gate.vetoStrategies = [];
for (const k of Object.keys(CONFIG.setups)) CONFIG.setups[k].enabled = k === "sweep_reverse";

const candles = longSweep(); // trigger time 0 -> hour 0 UTC
const run = () => evaluate(candles, rising, { symbol: "T", interval: "5m", htfInterval: "15m" });
const down = (t) => (t === "A+" ? "A" : "B");
const hasLong = (d) => d.plan && d.plan.direction === "LONG";

console.log("session filter");
// Disabled -> never off-session.
CONFIG.sessionFilter.enabled = false;
const dOff = run();
ok(hasLong(dOff), `baseline LONG plan (status ${dOff.status})`);
const tBase = dOff.plan.tier;
ok(dOff.plan.offSession === false, "disabled: offSession false");

// Enabled, hour 0 IS allowed -> on-session, no downgrade.
CONFIG.sessionFilter.enabled = true;
CONFIG.sessionFilter.allowedUtcHours = [0];
const dIn = run();
ok(dIn.plan.offSession === false, "hour in window: on-session");
eq(dIn.plan.tier, tBase, "on-session: tier unchanged");

// Enabled, hour 0 NOT allowed -> off-session, downgraded + flagged.
CONFIG.sessionFilter.allowedUtcHours = [12, 13, 14];
const dOut = run();
ok(dOut.plan.offSession === true, "hour outside window: off-session flagged");
eq(dOut.plan.tier, down(tBase), "off-session: tier downgraded");
ok(hasLong(dOut), "off-session: signal kept (not dropped)");

// restore
CONFIG.gate.minRR = snap.minRR; CONFIG.scalper.stopCapPct["5m"] = snap.cap;
CONFIG.gate.vetoStrategies = snap.veto; CONFIG.setups = snap.setups; CONFIG.sessionFilter = snap.sf;

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
