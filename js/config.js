// ============================================================================
// config.js — All tunable knobs for the MEXC multi-pair scalper scanner.
// Plain data only (no DOM, no network). Shared by the server and the backtest.
// ============================================================================

// Rolling evaluation window (bars) — the SINGLE SOURCE OF TRUTH for how much
// trailing history the gate ever sees. The live scanner caches this many candles
// per pair/TF (scanner.klineLimit) and the backtest replays each bar on the same
// trailing window (replay.windowBars), so a replayed signal is evaluated on the
// SAME amount of history the live scanner would have. Change this ONE constant to
// change both; it also keeps per-bar replay cost flat regardless of how deep the
// fetched history is.
const WINDOW_BARS = 200;

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
    // Timeframes actually scanned/evaluated. 5m is the primary scalping TF.
    // Add "1m" here to re-enable 1m scanning (nothing 1m-specific was removed):
    //   timeframes: ["1m", "5m"]
    // When "1m" is not listed, its klines are never fetched (less API load).
    timeframes: ["5m"],
    require5mAgreeFor1m: true, // when 1m IS scanned, its signals need 5m agreement
    klineLimit: WINDOW_BARS, // candles held per pair/timeframe (== replay.windowBars)
    // Exclude leveraged tokens (…3L/3S/5L/5S…) and stable-vs-stable pairs.
    excludeLeveraged: /(\d+[LS])USDT$/i,
    // Stablecoin BASES to drop when quoted vs USDT (a stable-vs-stable pair is not
    // a scalp). This is THE list to extend when a new stable lists on MEXC — add
    // the base symbol here (e.g. a new "FOOUSD" stable that trades as FOOUSDUSDT
    // would need "FOOUSD"). Matched exactly against symbol.slice(0, -4).
    stableBases: [
      "USDC", "USDT", "TUSD", "BUSD", "DAI", "FDUSD", "USDD", "USDP", "EURS",
      "USD1", "PYUSD", "USDE", "GUSD", "LUSD", "USTC", "USDJ", "EURT", "EURI",
      "CRVUSD", "FRAX", "USDG", "USDY",
    ],
  },

  // -- Live price + scan cadence (server-side) ------------------------------
  timing: {
    pricePollMs: 1500, // poll all-symbol prices every 1.5s (WS fallback)
    scanIntervalMs: 15 * 1000, // fallback/safety scan cadence
    klineStaggerMs: 40, // gap between per-pair kline fetches (politeness)
    maxConcurrentFetches: 6,
    backoffBaseMs: 800, // 429 backoff base (exponential)
    incrementalKlineLimit: 3, // per cycle, fetch only the last N candles and merge
    candleCloseGraceMs: 1500, // scan this long after each 1m candle close (live mode)
  },

  // -- Two-layer higher-timeframe bias --------------------------------------
  // biasTf   = directional bias, a HARD gate (counter-bias setups are rejected).
  // regimeTf = a slower regime check: if its structure OPPOSES the signal,
  //            regimeMode decides what happens:
  //              "downgrade" -> lower tier by one (A+->A->B)  [default]
  //              "veto"      -> reject the signal (hard, like biasTf)
  //              "off"       -> ignore the regime layer
  // The backtest consumes real regimeTf klines the same way it does biasTf.
  htf: { biasTf: "15m", regimeTf: "1h", regimeMode: "downgrade" },

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
    // Stop FLOOR (applied in confluence.js buildPlan): effective risk R =
    // max(structure stop, stopFloorK × ATR(14) at trigger, stopFloorM × spread).
    // Micro-stops (e.g. 0.06% of price) make round-trip costs dominate R
    // (costs_in_R = costPct / stopPct); the floor widens tiny stops so costs stay
    // a sane fraction of R. Set both to 0 to disable. The --walk grid A/Bs
    // {off} vs {these values}.
    stopFloorK: 0.5, // × ATR(14) on the entry timeframe
    stopFloorM: 3,   // × modeled spread (costs.spreadPct × price)
  },

  // -- Realistic cost model (fractions of price; 0.0005 = 0.05%) -------------
  // Applied identically in live outcome tracking and the backtest (js/costs.js).
  // These are conservative estimates — tune per exchange/tier/pair. Entries and
  // take-profits are treated as MAKER limit fills; stops and the breakeven exit
  // as TAKER market fills that also cross the spread. `entryTicks` is accepted
  // but not applied (no per-symbol tick size is tracked); use the pct fields.
  costs: {
    fees: { makerPct: 0.0002, takerPct: 0.0005 }, // per-fill trading fee
    slippage: { entryTicks: 0, entryPct: 0.0002, stopPct: 0.0005 }, // adverse fill
    spreadPct: 0.0003, // half-spread crossed on taker (stop/BE) fills
  },

  // -- Setup switches -------------------------------------------------------
  setups: {
    sweep_reverse: { enabled: true, atrBuffer: 0.5 },
    divergence_reversal: { enabled: true, atrBuffer: 0.5 },
    breakout_retest: { enabled: true, atrBuffer: 0.35, retestPad: 0.25 },
    trend_pullback: { enabled: true, atrBuffer: 0.6, nearBand: 0.6 },
  },

  // Setups disabled globally or per-timeframe. Entries are a setup id (e.g.
  // "breakout_retest") or "id@tf" (e.g. "breakout_retest@1m"). The backtest's
  // negative-expectancy report suggests entries for this list.
  disabledSetups: [],

  // -- Portfolio / regime awareness -----------------------------------------
  regime: {
    btcFilter: "suppress", // "off" | "suppress" (drop counter-BTC alts) | "downgrade" (lower tier)
    btcSymbol: "BTCUSDT",
    btcTimeframe: "15m", // BTC bias computed from this timeframe (existing HTF logic)
  },
  exposure: {
    maxSameDirection: 5, // beyond this many ACTIVE same-direction signals, new ones are flagged
  },

  // -- Optional session (hour-of-day) filter --------------------------------
  // When enabled, signals triggered OUTSIDE allowedUtcHours are DOWNGRADED and
  // flagged offSession (never dropped) — so the ledger can measure whether
  // restricting to these hours would have helped before you trust it. Disabled
  // by default (no behavior change). The default window is illustrative.
  sessionFilter: {
    enabled: false,
    allowedUtcHours: [12, 13, 14, 15, 16, 17, 18, 19, 20], // UTC hours "in session"
  },

  risk: { atrPeriod: 14 },

  indicators: {
    emaFast: 9, emaSlow: 21, rsiPeriod: 14,
    macdFast: 12, macdSlow: 26, macdSignal: 9,
    bbPeriod: 20, bbMult: 2, stochK: 14, stochSmooth: 3, stochD: 3,
    pivotLeft: 2, pivotRight: 2,
  },

  // HTF used by the standalone backtest per timeframe (scanner uses config.htf).
  htfMap: { "1m": "15m", "5m": "15m", "15m": "1h", "1h": "4h", "4h": "1d", "1d": "1w" },

  // -- Backtest replay window (live parity) ---------------------------------
  // Every replay path (--scan/--matrix/--compare/--walk) evaluates each bar on
  // ONLY the last windowBars candles — the same trailing window the live scanner
  // holds (scanner.klineLimit). Mirrors WINDOW_BARS (one source of truth), so
  // backtest and live evaluate identical history depth and per-bar cost stays
  // flat no matter how deep the fetched series is.
  replay: { windowBars: WINDOW_BARS },

  backtest: {
    maxBarsToFill: 10,
    warmup: 120,
    // `--compare` needs at least this many trades on a TF before it will issue a
    // keep/disable verdict for a setup; below it the verdict is "insufficient data".
    minTradesForVerdict: 50,
    // Walk-forward: fixed window sizes (bars). Fold COUNT is derived from the
    // candles actually available (after warm-up) so folds cover the full range.
    walk: {
      trainBars: 200, // train window per fold
      testBars: 100, // out-of-sample window per fold
      minTrainTrades: 10, // below this, a fold makes "no selection" (excluded)
      minTestTrades: 10, // below this, a fold's OOS is excluded from the aggregate
      minTradesPerFoldWarn: 20, // sizing sanity: warn if expected trades/fold is below this
    },
  },

  notifications: { minTierForAlert: "A" }, // browser alert on A/A+
};
