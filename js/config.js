// ============================================================================
// config.js — All tunable knobs in one place. Edit this file to change how the
// dashboard behaves: strategy weights, classification thresholds, indicator
// periods, default pair/timeframe, refresh cadence, risk-management multiples.
//
// Nothing here touches the DOM or the network — it is plain data.
// ============================================================================

export const CONFIG = {
  // -- Data / UI defaults ---------------------------------------------------
  defaultPair: "BTCUSDT",
  defaultInterval: "15m",
  candleLimit: 300, // how many klines to request
  autoRefreshSeconds: 60,

  // Quick-pick pairs for the dropdown. The free-text box accepts ANY Binance
  // symbol, so this is just for convenience.
  pairs: ["BTCUSDT", "ETHUSDT", "SOLUSDT", "BNBUSDT", "XRPUSDT", "DOGEUSDT"],

  // Supported timeframes. Value = Binance interval string.
  intervals: ["5m", "15m", "1h", "4h", "1d"],

  // -- Strategy weights -----------------------------------------------------
  // Used by the confluence engine. They do NOT need to sum to any particular
  // number — the composite is a weighted average, so only the RELATIVE sizes
  // matter. Per request, RSI-divergence, SMC and S/R breakout carry a bit more
  // weight than the trend/oscillator strategies.
  weights: {
    ema: 1.0,
    rsi: 1.3, // RSI + divergence — emphasised
    macd: 1.0,
    bollinger: 0.9,
    ichimoku: 1.0,
    stochastic: 0.8,
    vwap: 0.9,
    sr: 1.3, // Support/Resistance breakout — emphasised
    smc: 1.3, // Smart Money Concepts — emphasised
    volume: 0.8,
  },

  // -- Confluence classification (composite ranges from -100..+100) ---------
  thresholds: {
    strongBuy: 60, // composite >=  60  => STRONG BUY
    buy: 25, // composite >=  25  => BUY
    sell: -25, // composite <= -25  => SELL
    strongSell: -60, // composite <= -60  => STRONG SELL
    // anything strictly between sell and buy (-24..24) => NEUTRAL
  },

  // -- "High Quality Signal" gate -------------------------------------------
  highQuality: {
    minAgreeing: 7, // >= 7 of 10 strategies must agree on the direction
    minComposite: 60, // AND |composite| must be >= 60
  },

  // -- Risk-management scaffold for high-quality signals --------------------
  risk: {
    atrPeriod: 14,
    atrStopMultiplier: 1.5, // stop = entry -/+ ATR * this (fallback if no swing)
    tp1R: 1.5, // first take-profit at 1.5 R
    tp2R: 3.0, // second take-profit at 3.0 R
    entryZonePct: 0.0015, // +/- 0.15% band around price for the entry zone
  },

  // -- Indicator periods (shared defaults; individual strategies read these) -
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
    pivotLeft: 2, // fractal pivot lookback (swing detection)
    pivotRight: 2,
  },
};
