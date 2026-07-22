// ============================================================================
// config.js — All tunable knobs for the MEXC multi-pair scalper scanner.
// Plain data only (no DOM, no network). Shared by the server and the backtest.
// ============================================================================

export const CONFIG = {
  // -- Exchange / data ------------------------------------------------------
  exchange: {
    rest: "https://api.mexc.com",
    ws: "wss://wbs.mexc.com/ws",
    // MEXC spot v3 uses Binance-style paths but its own interval strings
    // (note: 1h == "60m" on MEXC). We map our names -> MEXC intervals.
    intervalMap: { "1m": "1m", "5m": "5m", "15m": "15m", "30m": "30m", "1h": "60m", "4h": "4h", "1d": "1d" },
  },

  // -- Scanner --------------------------------------------------------------
  scanner: {
    topN: 50, // scan the top-N USDT pairs by 24h quote volume
    listRefreshMs: 60 * 60 * 1000, // refresh the top-N list hourly
    scanTimeframes: ["1m", "5m"], // scalper timeframes
    htfTimeframe: "15m", // higher-timeframe bias filter
    require5mAgreeFor1m: true, // 1m signals also need 5m direction agreement
    klineLimit: 200, // candles held per pair/timeframe
    // Exclude leveraged tokens (…3L/3S/5L/5S…) and stable-vs-stable pairs.
    excludeLeveraged: /(\d+[LS])USDT$/i,
    stableBases: ["USDC", "USDT", "TUSD", "BUSD", "DAI", "FDUSD", "USDD", "USDP", "EURS"],
  },

  // -- Live price + scan cadence (server-side) ------------------------------
  timing: {
    pricePollMs: 1500, // poll all-symbol prices every 1.5s (WS fallback)
    scanIntervalMs: 15 * 1000, // re-run the scanner loop at least this often
    klineStaggerMs: 40, // gap between per-pair kline fetches (politeness)
    maxConcurrentFetches: 6,
    backoffBaseMs: 800, // 429 backoff base (exponential)
  },

  // -- Live feed mode -------------------------------------------------------
  // "poll" = fast REST polling for prices (default, verified path).
  // "ws"   = MEXC websocket (js/mexcws.js) — UNVERIFIED from the build env,
  //          test locally before enabling (see README).
  liveMode: "poll",

  // -- Server ---------------------------------------------------------------
  server: {
    port: 8000,
    ledgerPath: "./ledger.json", // persisted signal ledger (survives restarts)
  },

  // -- Strategy weights (confirmation count / veto set) ---------------------
  weights: {
    ema: 1.0, rsi: 1.3, macd: 1.0, bollinger: 0.9, ichimoku: 1.0,
    stochastic: 0.8, vwap: 0.9, sr: 1.3, smc: 1.3, volume: 0.8,
  },

  // -- The confluence GATE --------------------------------------------------
  gate: {
    minAgree: 6, // >=6 of 10 strategies must agree with the setup direction
    vetoStrategies: ["rsi", "smc", "sr"], // none may actively contradict
    triggerRecencyBars: 3, // setup event must be within the last N closed bars
    minRR: 1.2, // reward:risk to TP1 must be >= this
    tp1R: 1.5,
    tp2R: 3.0,
    tiers: { aPlusAgree: 8, aAgree: 7, bAgree: 6 },
    requireHtfAlignment: true,
    // "Forming" = setup fired and nothing hard-rejects it, but it still needs
    // this many more aligned strategies to lock. (minAgree - formingSlack ..)
    formingSlack: 2,
  },

  // -- Scalper economics guardrail ------------------------------------------
  scalper: {
    stopCapPct: { "1m": 0.6, "5m": 1.2, "15m": 2.0 }, // max stop distance (%)
    expireBars: { "1m": 10, "5m": 10, "15m": 12 }, // no fill within N bars -> expired
  },

  // -- Setup switches -------------------------------------------------------
  setups: {
    sweep_reverse: { enabled: true, atrBuffer: 0.5 },
    divergence_reversal: { enabled: true, atrBuffer: 0.5 },
    breakout_retest: { enabled: true, atrBuffer: 0.35, retestPad: 0.25 },
    trend_pullback: { enabled: true, atrBuffer: 0.6, nearBand: 0.6 },
  },

  risk: { atrPeriod: 14 },

  indicators: {
    emaFast: 9, emaSlow: 21, rsiPeriod: 14,
    macdFast: 12, macdSlow: 26, macdSignal: 9,
    bbPeriod: 20, bbMult: 2, stochK: 14, stochSmooth: 3, stochD: 3,
    pivotLeft: 2, pivotRight: 2,
  },

  // HTF used by the backtest per timeframe (scanner uses scanner.htfTimeframe).
  htfMap: { "1m": "15m", "5m": "15m", "15m": "1h", "1h": "4h", "4h": "1d", "1d": "1w" },

  backtest: { maxBarsToFill: 10, warmup: 120 },

  notifications: { minTierForAlert: "A" }, // browser alert on A/A+
};
