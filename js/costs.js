// ============================================================================
// costs.js — Realistic cost model, shared by live outcome tracking
// (js/confluence.js trackOutcome) and the backtest (backtest.js) so both apply
// fees + slippage IDENTICALLY.
//
// It converts a resolved trade "path" into a P/L expressed in R (multiples of
// the planned risk R0 = |entryPrice - stop|), both GROSS (ideal fills, no costs)
// and NET (adverse fills + fees). The gross values reproduce the old hardcoded
// constants (stopped −1R, TP1→BE +0.75R, TP1+TP2 +2.25R); net subtracts costs.
//
// Fill assumptions (documented so they can be audited/tuned in config.costs):
//   - Entry: a limit order resting in the zone -> MAKER fee, plus adverse
//     `slippage.entryPct` (models getting a worse fill inside the zone).
//   - Take-profits (TP1, TP2): limit orders -> MAKER fee, filled at the level.
//   - Stop-loss and the breakeven stop on the runner: stop-market -> TAKER fee,
//     plus adverse `slippage.stopPct` + `spreadPct` (crossing the spread).
// Costs are fractions of price (e.g. 0.0005 = 0.05%). `slippage.entryTicks` is
// accepted in config but NOT applied (no per-symbol tick size is tracked); use
// the pct fields.
//
// Paths:
//   stopped   whole position stops before TP1
//   tp1_tp2   half at TP1, runner to TP2
//   tp1_be    half at TP1, runner stopped at breakeven
//   tp1_open  half booked at TP1, runner still open (interim; runner ignored)
//   running   filled, nothing booked yet (interim; only the sunk entry cost)
//   expired / waiting / (anything else): never filled -> 0R
// ============================================================================
import { CONFIG } from "./config.js";

const ZERO = { fees: { makerPct: 0, takerPct: 0 }, slippage: { entryPct: 0, stopPct: 0 }, spreadPct: 0 };

/** Core P/L in R for a path given a cost spec. */
function core(plan, path, c) {
  const dir = plan.direction === "LONG" ? 1 : -1;
  const Ep = plan.entryPrice, Sp = plan.stop, T1 = plan.tp1, T2 = plan.tp2;
  const R0 = Math.abs(Ep - Sp);
  if (!(R0 > 0)) return 0;

  const eS = c.slippage?.entryPct || 0;
  const sS = (c.slippage?.stopPct || 0) + (c.spreadPct || 0);
  const fM = c.fees?.makerPct || 0;
  const fT = c.fees?.takerPct || 0;

  const Ef = Ep * (1 + dir * eS);  // entry limit fill, adverse (long higher / short lower)
  const Sf = Sp * (1 - dir * sS);  // stop market fill, adverse beyond the stop
  const BEf = Ep * (1 - dir * sS); // breakeven stop, market fill adverse
  const entryFee = fM * Ef;        // full position, maker

  let pl = 0;
  let fees = 0;
  switch (path) {
    case "stopped":
      pl = dir * (Sf - Ef);
      fees = entryFee + fT * Sf;
      break;
    case "tp1_be":
      pl = 0.5 * dir * (T1 - Ef) + 0.5 * dir * (BEf - Ef);
      fees = entryFee + 0.5 * fM * T1 + 0.5 * fT * BEf;
      break;
    case "tp1_tp2":
      pl = 0.5 * dir * (T1 - Ef) + 0.5 * dir * (T2 - Ef);
      fees = entryFee + 0.5 * fM * T1 + 0.5 * fM * T2;
      break;
    case "tp1_open":
      pl = 0.5 * dir * (T1 - Ef);
      fees = entryFee + 0.5 * fM * T1;
      break;
    case "running":
      pl = 0;
      fees = entryFee; // entry cost is already sunk once filled
      break;
    default: // expired / waiting: never filled
      return 0;
  }
  return (pl - fees) / R0;
}

/**
 * @returns { grossR, netR } for a resolved/interim path.
 * gross = ideal fills (matches the legacy −1 / +0.75 / +2.25 constants);
 * net = after fees + slippage from `costs` (defaults to CONFIG.costs).
 */
export function computeR(plan, path, costs = CONFIG.costs) {
  return { grossR: core(plan, path, ZERO), netR: core(plan, path, costs || ZERO) };
}
