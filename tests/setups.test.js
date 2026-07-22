// ============================================================================
// tests/setups.test.js — Tests for the new engine: HTF bias, HTF resampling,
// setup triggering, the gate, and live outcome tracking. Zero dependencies.
//   node tests/setups.test.js
// ============================================================================
import { htfBias, resampleToHTF, htfFactor, intervalMinutes } from "../js/htf.js";
import { detectSetups } from "../js/setups.js";
import { evaluate, trackOutcome } from "../js/confluence.js";

let passed = 0;
let failed = 0;
function ok(cond, label) {
  if (cond) { console.log(`  ✓ ${label}`); passed++; }
  else { console.error(`  ✗ ${label}`); failed++; }
}
function eq(a, b, label) { ok(a === b, `${label} (got ${JSON.stringify(a)})`); }

const mk = (o, h, l, c, v = 200) => ({ time: 0, open: o, high: h, low: l, close: c, volume: v });

// --- interval math ---------------------------------------------------------
console.log("interval minutes / factor");
eq(intervalMinutes("5m"), 5, "5m = 5 minutes");
eq(intervalMinutes("1h"), 60, "1h = 60 minutes");
eq(htfFactor("5m", "1h"), 12, "5m->1h factor = 12");
eq(htfFactor("15m", "1h"), 4, "15m->1h factor = 4");

// --- resampleToHTF ---------------------------------------------------------
console.log("resampleToHTF aggregation");
{
  const base = [mk(1, 4, 0, 3, 10), mk(3, 5, 2, 4, 20), mk(4, 6, 3, 5, 30), mk(5, 7, 1, 2, 40)];
  const htf = resampleToHTF(base, 2);
  eq(htf.length, 2, "2 base candles per bucket -> 2 HTF candles");
  eq(htf[0].open, 1, "bucket open = first open");
  eq(htf[0].close, 4, "bucket close = last close");
  eq(htf[0].high, 5, "bucket high = max high");
  eq(htf[0].low, 0, "bucket low = min low");
  eq(htf[0].volume, 30, "bucket volume = sum");
  eq(htf[1].close, 2, "second bucket close");
  eq(htf[1].high, 7, "second bucket high");
}

// --- htfBias ---------------------------------------------------------------
console.log("htfBias direction");
{
  const up = Array.from({ length: 60 }, (_, i) => mk(100 + i, 100 + i + 0.5, 100 + i - 0.5, 100 + i + 0.4));
  const dn = Array.from({ length: 60 }, (_, i) => mk(200 - i, 200 - i + 0.5, 200 - i - 0.5, 200 - i - 0.4));
  eq(htfBias(up).bias, "BULL", "rising series -> BULL");
  eq(htfBias(dn).bias, "BEAR", "falling series -> BEAR");
  eq(htfBias([mk(1, 1, 1, 1)]).bias, "NEUTRAL", "insufficient data -> NEUTRAL");
}

// --- Setup trigger: Sweep & Reverse ---------------------------------------
console.log("detectSetups: sweep & reverse (long)");
{
  const cs = [];
  let px = 100;
  for (let i = 0; i < 52; i++) { const o = px; px += 0.25; const c = px; cs.push(mk(o, Math.max(o, c) + 0.1, Math.min(o, c) - 0.1, c)); }
  cs.push(mk(px, px + 0.1, px - 0.2, px - 0.15));          // 52
  cs.push(mk(px - 0.15, px - 0.1, px - 1.6, px - 1.4));    // 53
  cs.push(mk(px - 1.4, px - 1.3, px - 2.2, px - 1.5));     // 54 swing low
  cs.push(mk(px - 1.5, px - 0.9, px - 1.6, px - 1.0));     // 55
  cs.push(mk(px - 1.0, px - 0.4, px - 1.1, px - 0.6));     // 56 confirms pivot
  cs.push(mk(px - 0.7, px + 0.8, px - 2.6, px + 0.6));     // 57 sweep + bullish displacement
  cs.push(mk(px + 0.6, px + 0.9, px + 0.4, px + 0.75));    // 58
  cs.push(mk(px + 0.75, px + 1.0, px + 0.6, px + 0.9));    // 59
  const setups = detectSetups(cs);
  const sweep = setups.find((s) => s.id === "sweep_reverse");
  ok(!!sweep, "sweep_reverse setup detected");
  if (sweep) {
    eq(sweep.direction, "LONG", "sweep direction LONG");
    ok(sweep.stop < sweep.entryLow, "stop is below the entry zone");
    ok(sweep.entryPrice === sweep.entryHigh, "long entryPrice = top of zone");
  }
}

// --- Gate sanity: flat data -> NO TRADE ------------------------------------
console.log("evaluate gate");
{
  const flat = Array.from({ length: 150 }, (_, i) => {
    const c = 100 + Math.sin(i / 3) * 0.2; // tiny oscillation, no structure
    return mk(c, c + 0.05, c - 0.05, c);
  });
  const dec = evaluate(flat, flat, { symbol: "T", interval: "5m", htfInterval: "15m" });
  ok(["ACTIVE", "FORMING", "NONE"].includes(dec.status), "evaluate returns a valid status");
  eq(dec.strategies.length, 10, "evaluate reports all 10 strategies");
  eq(dec.status, "NONE", "flat structureless data -> NONE (no setup)");
}

// --- trackOutcome ----------------------------------------------------------
console.log("trackOutcome states");
{
  // LONG plan: entry 100, stop 99 (R=1), tp1 101.5, tp2 103.
  const plan = { direction: "LONG", interval: "5m", entryLow: 99.5, entryHigh: 100, entryPrice: 100, stop: 99, tp1: 101.5, tp2: 103, triggerTime: 0 };
  const bar = (t, l, h, c = (l + h) / 2) => ({ time: t, open: c, high: h, low: l, close: c, volume: 1 });

  // TP2 path: fill, hit TP1, then TP2.
  const tp2 = trackOutcome(plan, [bar(1, 99.7, 100.2), bar(2, 100.1, 101.6), bar(3, 101.0, 103.2)]);
  eq(tp2.state, "tp2", "reaches TP2");

  // Stop path: fill, then stop before TP1.
  const stopped = trackOutcome(plan, [bar(1, 99.7, 100.2), bar(2, 98.8, 99.5)]);
  eq(stopped.state, "stopped", "stops out before TP1");

  // Runner path: fill, hit TP1, then drift without TP2 or breakeven.
  const runner = trackOutcome(plan, [bar(1, 99.7, 100.2), bar(2, 100.2, 101.6), bar(3, 101.2, 102.0)]);
  eq(runner.state, "tp1", "TP1 hit, runner still active");

  // Awaiting: never fills (price stays above the entry zone), within expiry.
  const awaiting = trackOutcome(plan, [bar(1, 100.5, 101.0), bar(2, 100.6, 101.2)]);
  eq(awaiting.state, "waiting", "never filled (within expiry) -> waiting");

  // Expired: never fills for more than expireBars (default 10 on 5m).
  const many = Array.from({ length: 12 }, (_, i) => bar(i + 1, 100.5, 101.0));
  eq(trackOutcome(plan, many).state, "expired", "no fill past expiry -> expired");
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
