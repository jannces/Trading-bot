// strategies/index.js — Registry of all 10 strategies in display order.
// Every strategy module exports { meta, analyze } with the SAME interface,
// so the app can iterate over them generically.
import * as ema from "./ema.js";
import * as rsi from "./rsi.js";
import * as macd from "./macd.js";
import * as bollinger from "./bollinger.js";
import * as ichimoku from "./ichimoku.js";
import * as stochastic from "./stochastic.js";
import * as vwap from "./vwap.js";
import * as sr from "./sr_breakout.js";
import * as smc from "./smc.js";
import * as volume from "./volume.js";

export const STRATEGIES = [ema, rsi, macd, bollinger, ichimoku, stochastic, vwap, sr, smc, volume];

/**
 * Run every strategy against the candle set. Each strategy is wrapped so a
 * throw in one module can never take down the whole dashboard.
 * @returns array of { key, name, blurb, signal, strength, reason }
 */
export function runAll(candles) {
  return STRATEGIES.map((mod) => {
    try {
      const res = mod.analyze(candles);
      return { ...mod.meta, ...normalise(res) };
    } catch (err) {
      return { ...mod.meta, signal: "NEUTRAL", strength: 0, reason: `Error: ${err.message}` };
    }
  });
}

function normalise(res) {
  const signal = ["BUY", "SELL", "NEUTRAL"].includes(res?.signal) ? res.signal : "NEUTRAL";
  let strength = Number(res?.strength);
  if (!Number.isFinite(strength)) strength = 0;
  strength = Math.max(0, Math.min(100, Math.round(strength)));
  return { signal, strength, reason: res?.reason || "" };
}
