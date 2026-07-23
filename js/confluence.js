// ============================================================================
// confluence.js — The GATE (the scalper "brain", unchanged in spirit).
//
// evaluate() turns a triggered setup + the 10 strategies + the HTF bias into one
// of three states for a pair/timeframe:
//   ACTIVE  — a lockable signal (all gate conditions pass)
//   FORMING — a setup fired and nothing hard-rejects it, but it still needs a
//             few more confirmations to lock (shows what's missing)
//   NONE    — no actionable setup
//
// Lock conditions (all, thresholds in config.js gate + scalper):
//   1. A named setup triggered on the timeframe (an event).
//   2. >= gate.minAgree of 10 strategies agree; none of gate.vetoStrategies
//      (RSI, SMC, S/R) actively contradicts.
//   3. HTF bias not counter.
//   4. R:R to TP1 >= gate.minRR with room to structure.
//   5. Scalper guardrail: stop distance % <= scalper.stopCapPct[tf].
// ============================================================================
import { CONFIG } from "./config.js";
import { runAll } from "./strategies/index.js";
import { buildContext, detectSetups } from "./setups.js";
import { htfBias, biasForDirection } from "./htf.js";
import { pivotHighs, pivotLows } from "./indicators.js";
import { computeR } from "./costs.js";

const SETUP_PRIORITY = ["sweep_reverse", "divergence_reversal", "breakout_retest", "trend_pullback"];
const SETUP_DISPLAY = {
  sweep_reverse: "Liquidity Sweep",
  divergence_reversal: "RSI Divergence",
  breakout_retest: "Breakout Retest",
  trend_pullback: "Trend Pullback",
};

export function evaluate(candles, htfCandles, meta = {}) {
  const results = runAll(candles);
  const ctx = buildContext(candles);
  const disabled = CONFIG.disabledSetups || [];
  const setups = detectSetups(candles, ctx).filter(
    (s) => !disabled.includes(s.id) && !disabled.includes(`${s.id}@${meta.interval}`)
  );
  const htf = htfBias(htfCandles);
  const htfLabel = meta.htfInterval || "HTF";

  const passing = [];
  const forming = [];

  for (const setup of setups) {
    const e = evaluateSetup(setup, results, htf, ctx, candles, meta.interval);
    if (e.pass) passing.push({ setup, ...e });
    else if (e.forming) forming.push({ setup, ...e });
  }

  if (passing.length) {
    passing.sort((a, b) => b.alignedCount - a.alignedCount || SETUP_PRIORITY.indexOf(a.setup.id) - SETUP_PRIORITY.indexOf(b.setup.id));
    const plan = buildPlan(passing[0], htf, htfLabel, meta, results, candles, false);
    return { status: "ACTIVE", plan, strategies: results, htf };
  }
  if (forming.length) {
    forming.sort((a, b) => b.alignedCount - a.alignedCount);
    const plan = buildPlan(forming[0], htf, htfLabel, meta, results, candles, true);
    plan.missing = forming[0].missing;
    return { status: "FORMING", plan, strategies: results, htf };
  }
  return { status: "NONE", strategies: results, htf };
}

// ---------------------------------------------------------------------------
function evaluateSetup(setup, results, htf, ctx, candles, interval) {
  const wantSignal = setup.direction === "LONG" ? "BUY" : "SELL";
  const oppSignal = setup.direction === "LONG" ? "SELL" : "BUY";
  const aligned = results.filter((r) => r.signal === wantSignal);
  const alignedCount = aligned.length;

  const veto = CONFIG.gate.vetoStrategies.find((k) => {
    const r = results.find((x) => x.key === k);
    return r && r.signal === oppSignal;
  });

  const need = biasForDirection(setup.direction);
  const counter = need === "BULL" ? htf.bias === "BEAR" : htf.bias === "BULL";
  const htfAligned = htf.bias === need;

  const R = Math.abs(setup.entryPrice - setup.stop);
  const room = roomToStructure(setup, ctx);
  const rrRoomOk = R > 0 && room >= CONFIG.gate.minRR * R;

  // Scalper guardrail: stop distance as a % of entry.
  const stopPct = setup.entryPrice > 0 ? (R / setup.entryPrice) * 100 : Infinity;
  const cap = CONFIG.scalper.stopCapPct[interval] ?? Infinity;
  const stopOk = stopPct <= cap;

  // Hard rejections (disqualify even from FORMING).
  const hard = [];
  if (veto) hard.push(`${veto.toUpperCase()} contradicts`);
  if (CONFIG.gate.requireHtfAlignment && counter) hard.push(`counter to ${htf.reason}`);
  if (!rrRoomOk) hard.push(`R:R to TP1 < ${CONFIG.gate.minRR}`);
  if (!stopOk) hard.push(`stop ${stopPct.toFixed(2)}% > ${cap}% cap`);

  const enough = alignedCount >= CONFIG.gate.minAgree;
  const pass = enough && hard.length === 0;

  // FORMING: no hard reject, only short on confirmations (within slack).
  const forming = !pass && hard.length === 0 && alignedCount >= CONFIG.gate.minAgree - CONFIG.gate.formingSlack;
  const missing = forming ? [`needs ${CONFIG.gate.minAgree - alignedCount} more confirmation(s)`] : hard;

  return { pass, forming, alignedCount, aligned, htfAligned, htfStrong: htf.strong, stopPct, missing };
}

function roomToStructure(setup, ctx) {
  if (setup.direction === "LONG") {
    const highs = ctx.pivH.map((p) => p.price).filter((p) => p > setup.entryPrice).sort((a, b) => a - b);
    return highs.length ? highs[0] - setup.entryPrice : Infinity;
  }
  const lows = ctx.pivL.map((p) => p.price).filter((p) => p < setup.entryPrice).sort((a, b) => b - a);
  return lows.length ? setup.entryPrice - lows[0] : Infinity;
}

// ---------------------------------------------------------------------------
function buildPlan(evald, htf, htfLabel, meta, results, candles, isForming) {
  const s = evald.setup;
  const R = Math.abs(s.entryPrice - s.stop);
  const long = s.direction === "LONG";
  const tp1 = long ? s.entryPrice + CONFIG.gate.tp1R * R : s.entryPrice - CONFIG.gate.tp1R * R;
  const tp2 = long ? s.entryPrice + CONFIG.gate.tp2R * R : s.entryPrice - CONFIG.gate.tp2R * R;
  const wantSignal = long ? "BUY" : "SELL";
  const tfl = meta.interval || "";

  // Contributors: the setup itself + each aligned strategy, with a score.
  const contributors = [{ name: SETUP_DISPLAY[s.id] || s.name, score: s.strength }];
  const alignedStrengths = [];
  for (const r of results) {
    if (r.signal === wantSignal && r.strength >= 20) {
      contributors.push({ name: r.name, score: r.strength });
      alignedStrengths.push(r.strength);
    }
  }
  const avgAligned = alignedStrengths.length ? alignedStrengths.reduce((a, b) => a + b, 0) / alignedStrengths.length : 0;
  const score = clamp(Math.round(s.strength * 0.4 + avgAligned * 0.4 + evald.alignedCount * 2.5 + (evald.htfStrong && evald.htfAligned ? 6 : 0)));
  const tier = tierFor(evald.alignedCount, evald.htfStrong && evald.htfAligned);

  const confluences = [];
  for (const h of s.hints) confluences.push(`${tfl} ${h}`.trim());
  confluences.push(htf.reason.replace(/^HTF/, htfLabel));
  for (const c of contributors.slice(1)) confluences.push(`${tfl} ${c.name} · ${c.score}`.trim());

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
    tp1, tp2,
    rr1: CONFIG.gate.tp1R,
    rr2: CONFIG.gate.tp2R,
    riskPerUnit: R,
    stopPct: evald.stopPct,
    score,
    tier,
    alignedCount: evald.alignedCount,
    contributors: contributors.slice(0, 6),
    confluences: dedupe(confluences).slice(0, 8),
    triggerIndex: s.triggerIndex,
    triggerTime: s.triggerTime,
    rationale: s.rationale,
    forming: isForming,
    createdAt: Date.now(),
  };
}

function tierFor(aligned, htfStrongAligned) {
  const t = CONFIG.gate.tiers;
  if (aligned >= t.aPlusAgree && htfStrongAligned) return "A+";
  if (aligned >= t.aAgree) return "A";
  return "B";
}

// ---------------------------------------------------------------------------
// Outcome tracking for a FROZEN signal. Levels never change; only status does.
//   states: waiting | running | tp1 | tp2 | stopped | expired
//   returns { state, done, path, grossR, netR, realizedR, note, barsSinceTrigger }
//   realizedR == netR (after fees + slippage); grossR is the ideal-fill value.
// Sim rule (same as backtest): half off at TP1, stop -> breakeven, runner to
// TP2; conservative intrabar (stop/BE before target). Expires if unfilled
// within scalper.expireBars[tf]. Costs from CONFIG.costs (js/costs.js).
// ---------------------------------------------------------------------------
export function trackOutcome(plan, candles) {
  const long = plan.direction === "LONG";
  const expireBars = CONFIG.scalper.expireBars[plan.interval] ?? 10;
  let filled = false;
  let barsSince = 0;
  let tp1 = false;
  let stop = plan.stop;
  let state = null;
  let done = false;
  let note = "";

  for (const c of candles) {
    if (c.time <= plan.triggerTime) continue;
    barsSince++;
    if (!filled) {
      const touched = long ? c.low <= plan.entryHigh : c.high >= plan.entryLow;
      if (touched) filled = true;
      else {
        if (barsSince > expireBars) { state = "expired"; done = true; note = "no fill within expiry window"; break; }
        continue;
      }
    }
    const hitStop = long ? c.low <= stop : c.high >= stop;
    const hitTp1 = long ? c.high >= plan.tp1 : c.low <= plan.tp1;
    const hitTp2 = long ? c.high >= plan.tp2 : c.low <= plan.tp2;
    if (!tp1) {
      if (hitStop) { state = "stopped"; done = true; note = "stopped before TP1"; break; }
      if (hitTp1) { tp1 = true; stop = plan.entryPrice; }
    } else {
      if (long ? c.low <= stop : c.high >= stop) { state = "tp1"; done = true; note = "TP1 hit, runner stopped at breakeven"; break; }
      if (hitTp2) { state = "tp2"; done = true; note = "TP1 + TP2 hit"; break; }
    }
  }
  if (!state) {
    if (tp1) { state = "tp1"; note = "TP1 hit, runner active"; }
    else if (filled) { state = "running"; note = "in trade"; }
    else { state = "waiting"; note = "awaiting entry"; }
  }

  const path = pathFor(state, done);
  const { grossR, netR } = computeR(plan, path);
  return { state, done, path, grossR, netR, realizedR: netR, note, barsSinceTrigger: barsSince };
}

/** Map an outcome state to a cost-model path. */
function pathFor(state, done) {
  if (state === "stopped") return "stopped";
  if (state === "tp2") return "tp1_tp2";
  if (state === "tp1") return done ? "tp1_be" : "tp1_open";
  if (state === "running") return "running";
  return "expired"; // waiting / expired -> never filled -> 0R
}

// ---------------------------------------------------------------------------
function clamp(v) { return Math.max(0, Math.min(100, v)); }
function dedupe(arr) {
  const seen = new Set();
  const out = [];
  for (const x of arr) { const k = String(x).toLowerCase(); if (x && !seen.has(k)) { seen.add(k); out.push(x); } }
  return out;
}
