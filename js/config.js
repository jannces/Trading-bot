// ============================================================================
// config.js — All tunable knobs in one place.
//
// This build is a *trade-plan generator*, not a verdict meter. The important
// knobs are the confluence GATE (what must be true to emit a plan) and the
// SETUP definitions. Everything here is plain data — no DOM, no network.
// ============================================================================

export const CONFIG = {
  // -- Data / UI defaults ---------------------------------------------------
  defaultPair: "BTCUSDT",
  defaultInterval: "15m",
  candleLimit: 400, // how many klines to request for the active timeframe
  htfCandleLimit: 300, // klines for the higher timeframe bias
  autoRefreshSeconds: 60,

  pairs: ["BTCUSDT", "ETHUSDT", "SOLUSDT", "BNBUSDT", "XRPUSDT", "DOGEUSDT"],
  intervals: ["5m", "15m", "1h", "4h", "1d"],

  // Higher-timeframe used for bias per active timeframe. Lower timeframes lean
  // on ~1h so a scalper isn't fighting the intraday trend.
  htfMap: { "5m": "1h", "15m": "1h", "1h": "4h", "4h": "1d", "1d": "1w" },

  // -- Strategy weights (used for the confirmation count / tie-breaks) -------
  // The three "top-weighted" strategies whose active disagreement VETOES a
  // setup are listed in `gate.vetoStrategies`.
  weights: {
    ema: 1.0,
    rsi: 1.3, // RSI + divergence
    macd: 1.0,
    bollinger: 0.9,
    ichimoku: 1.0,
    stochastic: 0.8,
    vwap: 0.9,
    sr: 1.3, // Support/Resistance
    smc: 1.3, // Smart Money Concepts
    volume: 0.8,
  },

  // -- The confluence GATE (the "high quality" filter) ----------------------
  gate: {
    minAgree: 6, // >=6 of 10 strategies must agree with the setup direction
    vetoStrategies: ["rsi", "smc", "sr"], // none of these may actively contradict
    triggerRecencyBars: 3, // a setup "event" must be within the last N closed bars
    minRR: 1.2, // reward:risk to TP1 must be >= this after entry/stop computed
    tp1R: 1.5, // TP1 at 1.5R
    tp2R: 3.0, // TP2 at 3.0R
    // Tiering by number of aligned strategies (setup already required):
    tiers: {
      aPlusAgree: 8, // A+ needs >=8 aligned AND HTF strongly agrees
      aAgree: 7, // A needs >=7 aligned
      bAgree: 6, // B needs >=6 aligned
    },
    requireHtfAlignment: true, // reject setups that fight the HTF bias
  },

  // -- Setup definitions / enable switches ----------------------------------
  // Set enabled:false to disable a setup by default (e.g. if the backtest shows
  // negative expectancy on your market/timeframe).
  setups: {
    sweep_reverse: { enabled: true, atrBuffer: 0.5 },
    divergence_reversal: { enabled: true, atrBuffer: 0.5 },
    breakout_retest: { enabled: true, atrBuffer: 0.35, retestPad: 0.25 },
    trend_pullback: { enabled: true, atrBuffer: 0.6, nearBand: 0.6 },
  },

  // -- Risk-management scaffold ---------------------------------------------
  risk: {
    atrPeriod: 14,
    entryZonePct: 0.0015, // fallback zone half-width when a setup has no natural zone
  },

  // -- Indicator periods ----------------------------------------------------
  indicators: {
    emaFast: 9,
    emaSlow: 21,
    rsiPeriod: 14,
    macdFast: 12,
    macdSlow: 26,
    macdSignal: 9,
    bbPeriod: 20,
    bbMult: 2,
    stochK: 14,
    stochSmooth: 3,
    stochD: 3,
    pivotLeft: 2,
    pivotRight: 2,
  },

  // -- Backtest defaults ----------------------------------------------------
  backtest: {
    maxBarsToFill: 20, // give up on an unfilled limit entry after N bars
    warmup: 120, // bars of history before the first evaluated signal
  },

  // -- UI niceties ----------------------------------------------------------
  notifications: {
    enabled: false, // toggled from the UI; browser notification + sound on A/A+
    minTierForAlert: "A", // "A+" | "A" | "B"
  },
};
