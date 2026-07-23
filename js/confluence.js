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

// evaluate = the expensive, params-INDEPENDENT scan (evaluateRaw) composed with
// the cheap, params-DEPENDENT gate (gateDecision). The live scanner calls
// evaluate() and is therefore byte-identical to before this split; the backtest
// caches evaluateRaw per bar and re-applies gateDecision across grid combos.
export function evaluate(candles, htfCandles, meta = {}) {
  return gateDecision(evaluateRaw(candles, htfCandles, meta), meta);
}

/**
 * Expensive, PARAMS-INDEPENDENT part: strategies, indicators, setup detection,
 * HTF + regime bias, and each setup's raw metrics. Depends ONLY on the candles
 * passed in ([0..now] — no look-ahead) plus detection settings
 * (triggerRecencyBars, disabledSetups); it does NOT read the grid thresholds
 * (minAgree / minRR / stopCap). The returned object carries no indicator arrays,
 * so it is cheap to cache per bar and reuse across grid combos and folds.
 */
export function evaluateRaw(candles, htfCandles, meta = {}) {
  const results = runAll(candles);
  const ctx = buildContext(candles);
  const disabled = CONFIG.disabledSetups || [];
  const setups = detectSetups(candles, ctx).filter(
    (s) => !disabled.includes(s.id) && !disabled.includes(`${s.id}@${meta.interval}`)
  );
  const htf = htfBias(htfCandles);
  const htfLabel = meta.htfInterval || "HTF";
  // Second (slower) HTF layer: regime. Structure that opposes the signal either
  // downgrades the tier or vetoes it, per config.htf.regimeMode.
  const regime = meta.regimeCandles && meta.regimeCandles.length ? htfBias(meta.regimeCandles) : { bias: "NEUTRAL", strong: false, reason: "no regime data" };
  const regimeMode = (CONFIG.htf && CONFIG.htf.regimeMode) || "off";
  const rctx = { regime, regimeMode, regimeLabel: meta.regimeInterval || "regime" };
  const setupsMetrics = setups.map((s) => evaluateSetupMetrics(s, results, htf, ctx, rctx));
  return { setupsMetrics, results, htf, htfLabel, regime, rctx, interval: meta.interval };
}

/**
 * Cheap, PARAMS-DEPENDENT part: apply the thresholds to each precomputed setup,
 * pick the best, build the plan. Identical selection/ordering to the pre-split
 * evaluate(), so output is byte-for-byte the same.
 */
export function gateDecision(raw, meta = {}) {
  const passing = [];
  const forming = [];
  for (const m of raw.setupsMetrics) {
    const g = setupGate(m, raw.interval, raw.htf, raw.rctx);
    if (g.pass) passing.push({ ...m, ...g });
    else if (g.forming) forming.push({ ...m, ...g });
  }
  if (passing.length) {
    passing.sort((a, b) => b.alignedCount - a.alignedCount || SETUP_PRIORITY.indexOf(a.setup.id) - SETUP_PRIORITY.indexOf(b.setup.id));
    const plan = buildPlan(passing[0], raw.htf, raw.htfLabel, meta, raw.results, null, false, raw.rctx);
    return { status: "ACTIVE", plan, strategies: raw.results, htf: raw.htf, regime: raw.regime };
  }
  if (forming.length) {
    forming.sort((a, b) => b.alignedCount - a.alignedCount);
    const plan = buildPlan(forming[0], raw.htf, raw.htfLabel, meta, raw.results, null, true, raw.rctx);
    plan.missing = forming[0].missing;
    return { status: "FORMING", plan, strategies: raw.results, htf: raw.htf, regime: raw.regime };
  }
  return { status: "NONE", strategies: raw.results, htf: raw.htf, regime: raw.regime };
}

/** Is the regime bias opposite to a setup direction? */
function regimeOpposes(regime, direction) {
  if (!regime || regime.bias === "NEUTRAL") return false;
  return direction === "LONG" ? regime.bias === "BEAR" : regime.bias === "BULL";
}

// ---------------------------------------------------------------------------
// Params-INDEPENDENT metrics for one setup (no grid thresholds read here).
function evaluateSetupMetrics(setup, results, htf, ctx, rctx) {
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
  const stopPct = setup.entryPrice > 0 ? (R / setup.entryPrice) * 100 : Infinity;
  const regimeCounter = rctx ? regimeOpposes(rctx.regime, setup.direction) : false;
  return { setup, aligned, alignedCount, veto, counter, htfAligned, htfStrong: htf.strong, R, room, stopPct, regimeCounter };
}

// Params-DEPENDENT gate for one setup (the thresholds that the grid varies).
function setupGate(m, interval, htf, rctx) {
  const rrRoomOk = m.R > 0 && m.room >= CONFIG.gate.minRR * m.R;
  const cap = CONFIG.scalper.stopCapPct[interval] ?? Infinity;
  const stopOk = m.stopPct <= cap;

  const hard = [];
  if (m.veto) hard.push(`${m.veto.toUpperCase()} contradicts`);
  if (CONFIG.gate.requireHtfAlignment && m.counter) hard.push(`counter to ${htf.reason}`);
  if (rctx && rctx.regimeMode === "veto" && m.regimeCounter) hard.push(`counter to ${rctx.regimeLabel} regime (${rctx.regime.reason})`);
  if (!rrRoomOk) hard.push(`R:R to TP1 < ${CONFIG.gate.minRR}`);
  if (!stopOk) hard.push(`stop ${m.stopPct.toFixed(2)}% > ${cap}% cap`);

  const enough = m.alignedCount >= CONFIG.gate.minAgree;
  const pass = enough && hard.length === 0;
  const forming = !pass && hard.length === 0 && m.alignedCount >= CONFIG.gate.minAgree - CONFIG.gate.formingSlack;
  const missing = forming ? [`needs ${CONFIG.gate.minAgree - m.alignedCount} more confirmation(s)`] : hard;
  return { pass, forming, missing };
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
function buildPlan(evald, htf, htfLabel, meta, results, candles, isForming, rctx) {
  const s = evald.setup;
  const R = Math.abs(s.entryPrice - s.stop);
  const long = s.direction === "LONG";
  const tp1 = long ? s.entryPrice + CONFIG.gate.tp1R * R : s.entryPrice - CONFIG.gate.tp1R * R;
  const tp2 = long ? s.entryPrice + CONFIG.gate.tp2R * R : s.entryPrice - CONFIG.gate.tp2R * R;
  const wantSignal = long ? "BUY" : "SELL";
  const tfl = meta.interval || "";

  // Contributors: the setup itself + each aligned strategy, with a score AND its
  // own direction (so a bullish-sounding strategy name on a SHORT is clearly a
  // bearish read, not a contradiction).
  const contributors = [{ name: SETUP_DISPLAY[s.id] || s.name, score: s.strength, dir: s.direction }];
  const alignedStrengths = [];
  for (const r of results) {
    if (r.signal === wantSignal && r.strength >= 20) {
      contributors.push({ name: r.name, score: r.strength, dir: r.signal === "BUY" ? "LONG" : "SHORT" });
      alignedStrengths.push(r.strength);
    }
  }
  const avgAligned = alignedStrengths.length ? alignedStrengths.reduce((a, b) => a + b, 0) / alignedStrengths.length : 0;
  const score = clamp(Math.round(s.strength * 0.4 + avgAligned * 0.4 + evald.alignedCount * 2.5 + (evald.htfStrong && evald.htfAligned ? 6 : 0)));
  let tier = tierFor(evald.alignedCount, evald.htfStrong && evald.htfAligned);

  // Regime layer: downgrade tier by one when the slower TF opposes (and mode is
  // "downgrade"). "veto" was already handled as a hard reject in evaluateSetup.
  const regimeBias = rctx ? rctx.regime.bias : "NEUTRAL";
  const regimeCounter = !!evald.regimeCounter;
  const regimeDowngraded = regimeCounter && rctx && rctx.regimeMode === "downgrade";
  if (regimeDowngraded) tier = downgradeTier(tier);

  // Optional session filter: signals triggered outside allowedUtcHours are
  // downgraded and flagged (never dropped), so the ledger can measure the effect.
  const sf = CONFIG.sessionFilter;
  const sessionHour = new Date(s.triggerTime).getUTCHours();
  const offSession = !!(sf && sf.enabled && Array.isArray(sf.allowedUtcHours) && !sf.allowedUtcHours.includes(sessionHour));
  if (offSession) tier = downgradeTier(tier);

  const confluences = [];
  for (const h of s.hints) confluences.push(`${tfl} ${h}`.trim());
  confluences.push(htf.reason.replace(/^HTF/, htfLabel));
  if (rctx && rctx.regime.bias !== "NEUTRAL") {
    confluences.push(`${rctx.regimeLabel} regime ${rctx.regime.bias.toLowerCase()}${regimeDowngraded ? " — tier downgraded" : ""}`);
  }
  if (offSession) confluences.push(`off-session (${sessionHour}:00 UTC) — tier downgraded`);
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
    regimeBias,
    regimeCounter,
    regimeDowngraded,
    offSession,
    sessionHour,
    createdAt: Date.now(),
  };
}

function downgradeTier(t) { return t === "A+" ? "A" : "B"; }

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
