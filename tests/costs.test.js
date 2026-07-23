// ============================================================================
// tests/costs.test.js — Realistic cost model (js/costs.js).
//   node tests/costs.test.js
//
// Verifies: (1) gross R reproduces the legacy constants, (2) zero costs => net
// equals gross, (3) net values match hand-computed numbers for a fixed plan and
// cost spec (long AND short), (4) net is strictly worse than gross with costs.
// ============================================================================
import { computeR, costPct, costsInR } from "../js/costs.js";

let passed = 0, failed = 0;
const approx = (a, b, tol, l) => {
  if (a != null && isFinite(a) && Math.abs(a - b) <= tol) { console.log(`  ✓ ${l}: ${a}`); passed++; }
  else { console.error(`  ✗ ${l}: expected ≈ ${b}, got ${a}`); failed++; }
};
const ok = (c, l) => (c ? (console.log(`  ✓ ${l}`), passed++) : (console.error(`  ✗ ${l}`), failed++));

// Fixed plan: LONG entry 100, stop 99.4 (R0 = 0.6 = 0.6%), TP1 100.9, TP2 101.8.
const longPlan = { direction: "LONG", entryPrice: 100, stop: 99.4, tp1: 100.9, tp2: 101.8 };
const shortPlan = { direction: "SHORT", entryPrice: 100, stop: 100.6, tp1: 99.1, tp2: 98.2 };
const ZERO = { fees: { makerPct: 0, takerPct: 0 }, slippage: { entryPct: 0, stopPct: 0 }, spreadPct: 0 };
const COST = { fees: { makerPct: 0.0002, takerPct: 0.0005 }, slippage: { entryPct: 0.0002, stopPct: 0.0005 }, spreadPct: 0.0003 };

// --- gross reproduces the legacy constants ---------------------------------
console.log("gross R constants");
approx(computeR(longPlan, "stopped", COST).grossR, -1, 1e-9, "stopped gross = -1R");
approx(computeR(longPlan, "tp1_be", COST).grossR, 0.75, 1e-9, "TP1->BE gross = +0.75R");
approx(computeR(longPlan, "tp1_tp2", COST).grossR, 2.25, 1e-9, "TP1+TP2 gross = +2.25R");
approx(computeR(longPlan, "tp1_open", COST).grossR, 0.75, 1e-9, "TP1 open gross = +0.75R");
approx(computeR(longPlan, "running", COST).grossR, 0, 1e-9, "running gross = 0R");
approx(computeR(longPlan, "expired", COST).grossR, 0, 1e-9, "expired gross = 0R");

// --- zero costs => net equals gross ----------------------------------------
console.log("zero costs => net == gross");
for (const p of ["stopped", "tp1_be", "tp1_tp2"]) {
  const r = computeR(longPlan, p, ZERO);
  approx(r.netR, r.grossR, 1e-9, `${p} net==gross when costs are zero`);
}

// --- hand-computed net (LONG) ----------------------------------------------
// Ef=100.02, Sf=99.32048, BEf=99.92, entryFee(maker)=0.020004
// stopped: (99.32048-100.02 - 0.020004 - 0.0005*99.32048)/0.6 = -1.2820
// tp1_tp2: (1.33 - 0.040274)/0.6 = 2.1495
// tp1_be : (0.39 - 0.055074)/0.6 = 0.5582
console.log("net R (long) hand-computed");
approx(computeR(longPlan, "stopped", COST).netR, -1.2820, 0.001, "stopped net ≈ -1.282");
approx(computeR(longPlan, "tp1_tp2", COST).netR, 2.1495, 0.001, "TP1+TP2 net ≈ +2.150");
approx(computeR(longPlan, "tp1_be", COST).netR, 0.5582, 0.001, "TP1->BE net ≈ +0.558");

// --- net strictly worse than gross with costs (long + short) ---------------
console.log("net < gross with costs");
for (const plan of [longPlan, shortPlan]) {
  const side = plan.direction;
  for (const p of ["stopped", "tp1_be", "tp1_tp2"]) {
    const r = computeR(plan, p, COST);
    ok(r.netR < r.grossR, `${side} ${p}: net (${r.netR.toFixed(3)}) < gross (${r.grossR})`);
  }
}
// Short symmetry: stopped gross is still -1.
approx(computeR(shortPlan, "stopped", COST).grossR, -1, 1e-9, "short stopped gross = -1R");
ok(computeR(shortPlan, "stopped", COST).netR < -1, "short stopped net worse than -1R");

// --- costs_in_R = costPct / stopFrac, and it IS the stopped-path floor -------
console.log("costs_in_R conversion");
{
  // COST round-trip = entrySlip + (stopSlip+spread) + makerFee + takerFee
  //                 = 0.0002 + (0.0005+0.0003) + 0.0002 + 0.0005 = 0.0017 (0.17%).
  approx(costPct(COST), 0.0017, 1e-12, "costPct = 0.17% round-trip");

  // longPlan stop = 0.6% of entry -> costs_in_R = 0.17%/0.6% ≈ 0.283.
  const cir = costsInR(longPlan, COST);
  approx(cir, 0.0017 / 0.006, 1e-9, "costs_in_R = costPct / stopFrac");
  // The stopped-path net IS -(1 + costs_in_R) within the price-approximation tol.
  const stopFloor = computeR(longPlan, "stopped", COST).netR;
  approx(stopFloor, -(1 + cir), 0.02, "stopped net ≈ -(1 + costs_in_R)");
  ok(stopFloor >= -(1 + cir) - 0.02, "net never below -(1+costs_in_R)");
}

// --- MICRO-STOP confirmation: -2.9R is real, not a conversion bug -----------
console.log("micro-stop -> costs dominate (the real -2.9R)");
{
  // A 0.065%-of-entry stop, like the reported real data.
  const micro = { direction: "LONG", entryPrice: 100, stop: 100 * (1 - 0.00065), tp1: 100.1, tp2: 100.2 };
  const cir = costsInR(micro, COST);
  approx(cir, 0.0017 / 0.00065, 1e-6, "costs_in_R ≈ 2.6 at a 0.065% stop");
  const net = computeR(micro, "stopped", COST).netR;
  ok(net < -3 && net > -4, `stopped net ≈ -${(1 + cir).toFixed(2)}R (got ${net.toFixed(2)}) — real micro-stop, not a unit bug`);
  // Sanity: at a healthy 0.6% stop the same costs are only ~0.28R.
  ok(costsInR(longPlan, COST) < 0.4, "same costs at a 0.6% stop are a minor drag");
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
