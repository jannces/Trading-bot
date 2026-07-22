// ============================================================================
// confluence.js — The GATE. Turns a triggered setup + the 10 strategies + the
// higher-timeframe bias into either ONE actionable trade plan or an explicit
// NO-TRADE with a reason. There is no averaged "verdict" anymore.
//
// A plan is emitted ONLY when ALL of these hold (all thresholds in config.js):
//   1. A named setup actually triggered on the active timeframe (an event).
//   2. >= gate.minAgree of 10 strategies agree with the setup direction, and
//      none of gate.vetoStrategies (RSI, SMC, S/R) actively contradicts it.
//   3. HTF bias is not counter to the setup direction.
//   4. There is >= gate.minRR room to TP1 before the nearest opposing structure.
// Tier: A+ (>=8 aligned & HTF strong-aligned), A (>=7), B (>=6).
// ============================================================================
import { CONFIG } from "./config.js";
import { runAll } from "./strategies/index.js";
import { buildContext, detectSetups } from "./setups.js";
import { htfBias, biasForDirection } from "./htf.js";
import { pivotHighs, pivotLows, last } from "./indicators.js";

const SETUP_PRIORITY = ["sweep_reverse", "divergence_reversal", "breakout_retest", "trend_pullback"];

/**
 * @param candles active-timeframe candles
 * @param htfCandles higher-timeframe candles (already fetched or resampled)
 * @param meta { symbol, interval, htfInterval }
 * @returns decision object (see file header).
 */
export function evaluate(candles, htfCandles, meta = {}) {
  const results = runAll(candles);
  const ctx = buildContext(candles);
  const setups = detectSetups(candles, ctx);
  const htf = htfBias(htfCandles);
  const htfLabel = meta.htfInterval || "HTF";

  const passing = [];
  const rejected = [];

  for (const setup of setups) {
    const evald = evaluateSetup(setup, results, htf, ctx, candles);
    if (evald.pass) passing.push({ setup, ...evald });
    else rejected.push({ setup, ...evald });
  }

  if (passing.length) {
    // Prefer the highest aligned count, then setup priority order.
    passing.sort((a, b) =>
      b.alignedCount - a.alignedCount ||
      SETUP_PRIORITY.indexOf(a.setup.id) - SETUP_PRIORITY.indexOf(b.setup.id)
    );
    const best = passing[0];
    const plan = buildPlan(best, htf, htfLabel, meta, results, candles);
    return { status: "ACTIVE", plan, strategies: results, htf };
  }

  return {
    status: "NO_TRADE",
    strategies: results,
    htf,
    noTrade: buildNoTrade(rejected, results, htf, htfLabel, meta),
  };
}

// ---------------------------------------------------------------------------
// Evaluate one setup against the gate.
// ---------------------------------------------------------------------------
function evaluateSetup(setup, results, htf, ctx, candles) {
  const wantSignal = setup.direction === "LONG" ? "BUY" : "SELL";
  const oppSignal = setup.direction === "LONG" ? "SELL" : "BUY";

  const aligned = results.filter((r) => r.signal === wantSignal);
  const alignedKeys = aligned.map((r) => r.key);
  const alignedCount = aligned.length;

  // Veto: any top-weighted strategy actively pointing the other way.
  const veto = CONFIG.gate.vetoStrategies.find((k) => {
    const r = results.find((x) => x.key === k);
    return r && r.signal === oppSignal;
  });

  // HTF must not be counter.
  const need = biasForDirection(setup.direction); // BULL / BEAR
  const counter = need === "BULL" ? htf.bias === "BEAR" : htf.bias === "BULL";
  const htfAligned = htf.bias === need;

  // Room-to-structure check for the min-R:R gate.
  const R = Math.abs(setup.entryPrice - setup.stop);
  const room = roomToStructure(setup, ctx, candles);
  const rrRoomOk = R > 0 && room >= CONFIG.gate.minRR * R;

  const reasons = [];
  if (alignedCount < CONFIG.gate.minAgree) reasons.push(`only ${alignedCount}/10 aligned (need ${CONFIG.gate.minAgree})`);
  if (veto) reasons.push(`${veto.toUpperCase()} contradicts`);
  if (CONFIG.gate.requireHtfAlignment && counter) reasons.push(`counter to ${htf.reason}`);
  if (!rrRoomOk) reasons.push(`insufficient room to structure (R:R to TP1 < ${CONFIG.gate.minRR})`);

  const pass = reasons.length === 0;
  const tier = tierFor(alignedCount, htfAligned && htf.strong);
  return { pass, alignedCount, alignedKeys, tier, htfAligned, failReasons: reasons };
}

function tierFor(aligned, htfStrongAligned) {
  const t = CONFIG.gate.tiers;
  if (aligned >= t.aPlusAgree && htfStrongAligned) return "A+";
  if (aligned >= t.aAgree) return "A";
  if (aligned >= t.bAgree) return "B";
  return "B";
}

/** Nearest opposing structural level distance from the entry (price units). */
function roomToStructure(setup, ctx, candles) {
  const { pivotLeft, pivotRight } = CONFIG.indicators;
  if (setup.direction === "LONG") {
    const highs = (ctx?.pivH || pivotHighs(candles, pivotLeft, pivotRight))
      .map((p) => p.price)
      .filter((p) => p > setup.entryPrice)
      .sort((a, b) => a - b);
    return highs.length ? highs[0] - setup.entryPrice : Infinity;
  }
  const lows = (ctx?.pivL || pivotLows(candles, pivotLeft, pivotRight))
    .map((p) => p.price)
    .filter((p) => p < setup.entryPrice)
    .sort((a, b) => b - a);
  return lows.length ? setup.entryPrice - lows[0] : Infinity;
}

// ---------------------------------------------------------------------------
// Build the emitted plan (targets, tier, plain-language confluence checklist).
// ---------------------------------------------------------------------------
function buildPlan(best, htf, htfLabel, meta, results, candles) {
  const s = best.setup;
  const R = Math.abs(s.entryPrice - s.stop);
  const tp1 = s.direction === "LONG" ? s.entryPrice + CONFIG.gate.tp1R * R : s.entryPrice - CONFIG.gate.tp1R * R;
  const tp2 = s.direction === "LONG" ? s.entryPrice + CONFIG.gate.tp2R * R : s.entryPrice - CONFIG.gate.tp2R * R;

  const tfl = meta.interval || "";
  const confluences = [];
  // The triggering setup's own structural evidence.
  for (const h of s.hints) confluences.push(`${tfl} ${h}`.trim());
  // HTF bias line.
  confluences.push(htf.reason.replace(/^HTF/, htfLabel));
  // Agreeing strategies, in plain language.
  const wantSignal = s.direction === "LONG" ? "BUY" : "SELL";
  for (const r of results) {
    if (r.signal === wantSignal && r.strength >= 25) {
      confluences.push(`${tfl} ${shortPhrase(r)}`.trim());
    }
  }

  return {
    id: s.id,
    name: s.name,
    direction: s.direction,
    symbol: meta.symbol,
    interval: meta.interval,
    entryLow: s.entryLow,
    entryHigh: s.entryHigh,
    entryPrice: s.entryPrice,
    stop: s.stop,
    tp1,
    tp2,
    rr1: CONFIG.gate.tp1R,
    rr2: CONFIG.gate.tp2R,
    riskPerUnit: R,
    tier: best.tier,
    alignedCount: best.alignedCount,
    triggerIndex: s.triggerIndex,
    triggerTime: s.triggerTime,
    rationale: s.rationale,
    confluences: dedupe(confluences).slice(0, 8),
    createdAt: Date.now(),
  };
}

function buildNoTrade(rejected, results, htf, htfLabel, meta) {
  const buys = results.filter((r) => r.signal === "BUY").length;
  const sells = results.filter((r) => r.signal === "SELL").length;
  const neutrals = results.filter((r) => r.signal === "NEUTRAL").length;

  let reason;
  if (rejected.length) {
    // Explain the closest miss (the setup with the most aligned strategies).
    rejected.sort((a, b) => b.alignedCount - a.alignedCount);
    const r = rejected[0];
    const dir = r.setup.direction;
    reason = `${r.setup.name} ${dir} triggered but ${r.failReasons.join("; ")} — standing aside.`;
  } else {
    const lean = buys > sells ? `${buys}/10 lean long` : sells > buys ? `${sells}/10 lean short` : "no directional lean";
    reason = `No setup event on ${meta.interval || "this timeframe"} (${lean}). Waiting for a sweep, divergence, breakout-retest, or trend pullback with confluence.`;
  }
  return {
    reason,
    htfReason: htf.reason.replace(/^HTF/, htfLabel),
    snapshot: { buys, sells, neutrals },
  };
}

// ---------------------------------------------------------------------------
// Live outcome tracking for an already-emitted plan.
//   Returns { state, tp1HitTime, exitTime, note }
//   state: "running" | "tp1" | "tp2" | "stopped" | "invalidated"
// Simulation rule (matches the backtest): after TP1 the stop moves to
// breakeven; the plan is "invalidated" if price closes beyond the stop before
// ever filling/hitting TP1.
// ---------------------------------------------------------------------------
export function trackOutcome(plan, candles) {
  const long = plan.direction === "LONG";
  let filled = false;
  let tp1 = false;
  let stop = plan.stop;

  for (const c of candles) {
    if (c.time <= plan.triggerTime) continue;
    // Fill the limit entry.
    if (!filled) {
      const touched = long ? c.low <= plan.entryHigh : c.high >= plan.entryLow;
      if (touched) filled = true;
      else {
        // Invalidation before fill: a close beyond the stop.
        if (long ? c.close < plan.stop : c.close > plan.stop) return { state: "invalidated", note: "closed beyond stop before entry filled" };
        continue;
      }
    }
    const hitStop = long ? c.low <= stop : c.high >= stop;
    const hitTp1 = long ? c.high >= plan.tp1 : c.low <= plan.tp1;
    const hitTp2 = long ? c.high >= plan.tp2 : c.low <= plan.tp2;

    if (!tp1) {
      if (hitStop) return { state: "stopped", exitTime: c.time };
      if (hitTp2) return { state: "tp2", exitTime: c.time };
      if (hitTp1) { tp1 = true; stop = plan.entryPrice; /* move to breakeven */ }
    } else {
      if (hitTp2) return { state: "tp2", exitTime: c.time };
      if (long ? c.low <= stop : c.high >= stop) return { state: "tp1", exitTime: c.time, note: "TP1 hit, rest stopped at breakeven" };
    }
  }
  return { state: tp1 ? "tp1" : filled ? "running" : "running", note: tp1 ? "TP1 hit, runner active" : filled ? "in trade" : "awaiting entry" };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function shortPhrase(r) {
  // Trim the strategy reason to a compact clause.
  return r.reason.replace(/\.$/, "").replace(/\s*\(.*?\)\s*/g, " ").trim();
}
function dedupe(arr) {
  const seen = new Set();
  const out = [];
  for (const x of arr) {
    const key = x.toLowerCase();
    if (!seen.has(key) && x) { seen.add(key); out.push(x); }
  }
  return out;
}
