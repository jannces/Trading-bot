// ============================================================================
// api.js — Market data fetching with a graceful fallback chain.
//
// Order of preference:
//   1. api.binance.com   (full klines + volume + 24h ticker)
//   2. api.binance.us    (same shape; used when .com is geo-blocked)
//   3. CoinGecko OHLC     (no volume; mapped from a symbol whitelist)
//
// Each source is tried in turn; the first that succeeds wins and its name is
// reported back so the UI can tell the user which feed is live.
// ============================================================================

const BINANCE_COM = "https://api.binance.com";
const BINANCE_US = "https://api.binance.us";
const COINGECKO = "https://api.coingecko.com/api/v3";

// Minimal symbol -> CoinGecko id map for the fallback feed. Only pairs quoted
// in USDT/USD are meaningful here; anything else can't use the CoinGecko path.
const COINGECKO_IDS = {
  BTCUSDT: "bitcoin",
  ETHUSDT: "ethereum",
  SOLUSDT: "solana",
  BNBUSDT: "binancecoin",
  XRPUSDT: "ripple",
  DOGEUSDT: "dogecoin",
  ADAUSDT: "cardano",
  LTCUSDT: "litecoin",
  AVAXUSDT: "avalanche-2",
  LINKUSDT: "chainlink",
};

// Map our timeframe -> a CoinGecko `days` window that yields a similar candle
// granularity (CoinGecko chooses granularity automatically from the range).
const COINGECKO_DAYS = { "5m": 1, "15m": 1, "1h": 7, "4h": 30, "1d": 90 };

/**
 * Fetch OHLCV candles + a price ticker, trying each source in order.
 * @returns { candles, ticker, source } where
 *   candles: [{ time, open, high, low, close, volume }]
 *   ticker:  { lastPrice, priceChangePercent }  (24h)
 *   source:  human-readable name of the live feed
 * @throws if every source fails (message aggregates the reasons).
 */
export async function fetchMarketData(symbol, interval, limit) {
  const errors = [];

  // 1) Binance.com
  try {
    return await fetchBinance(BINANCE_COM, "Binance.com", symbol, interval, limit);
  } catch (e) {
    errors.push(`Binance.com: ${e.message}`);
  }

  // 2) Binance.us
  try {
    return await fetchBinance(BINANCE_US, "Binance.US", symbol, interval, limit);
  } catch (e) {
    errors.push(`Binance.US: ${e.message}`);
  }

  // 3) CoinGecko
  try {
    return await fetchCoinGecko(symbol, interval, limit);
  } catch (e) {
    errors.push(`CoinGecko: ${e.message}`);
  }

  throw new Error(`All data sources failed. ${errors.join(" | ")}`);
}

// --- Binance ---------------------------------------------------------------

async function fetchBinance(base, label, symbol, interval, limit) {
  const url = `${base}/api/v3/klines?symbol=${encodeURIComponent(symbol)}&interval=${interval}&limit=${limit}`;
  const raw = await getJSON(url);
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error("empty or invalid klines response");
  }
  const candles = raw.map(parseBinanceKline);

  // 24h ticker is best-effort; if it fails we synthesise from candles.
  let ticker;
  try {
    const t = await getJSON(`${base}/api/v3/ticker/24hr?symbol=${encodeURIComponent(symbol)}`);
    ticker = { lastPrice: Number(t.lastPrice), priceChangePercent: Number(t.priceChangePercent) };
  } catch {
    ticker = tickerFromCandles(candles);
  }
  return { candles, ticker, source: label };
}

/**
 * Binance kline row layout (indices we use):
 *   0 openTime, 1 open, 2 high, 3 low, 4 close, 5 volume, 6 closeTime ...
 */
function parseBinanceKline(k) {
  return {
    time: k[0],
    open: parseFloat(k[1]),
    high: parseFloat(k[2]),
    low: parseFloat(k[3]),
    close: parseFloat(k[4]),
    volume: parseFloat(k[5]),
  };
}

// --- CoinGecko -------------------------------------------------------------

async function fetchCoinGecko(symbol, interval, limit) {
  const id = COINGECKO_IDS[symbol.toUpperCase()];
  if (!id) {
    throw new Error(`no CoinGecko mapping for ${symbol} (try a Binance-reachable pair)`);
  }
  const days = COINGECKO_DAYS[interval] ?? 1;
  const url = `${COINGECKO}/coins/${id}/ohlc?vs_currency=usd&days=${days}`;
  const raw = await getJSON(url);
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error("empty OHLC response");
  }
  // CoinGecko OHLC rows: [time, open, high, low, close] — NO volume.
  let candles = raw.map((r) => ({
    time: r[0],
    open: r[1],
    high: r[2],
    low: r[3],
    close: r[4],
    volume: 0, // CoinGecko OHLC carries no volume; OBV/spike strategy degrades.
  }));
  if (candles.length > limit) candles = candles.slice(-limit);

  return {
    candles,
    ticker: tickerFromCandles(candles),
    source: "CoinGecko (no volume data)",
  };
}

// --- Shared helpers --------------------------------------------------------

/** Approximate a 24h ticker from the candle window when none is available. */
function tickerFromCandles(candles) {
  const lastPrice = candles[candles.length - 1].close;
  const first = candles[0].close;
  const priceChangePercent = first ? ((lastPrice - first) / first) * 100 : 0;
  return { lastPrice, priceChangePercent };
}

/** fetch + JSON with a timeout and clear error messages. */
async function getJSON(url, timeoutMs = 12000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal, headers: { Accept: "application/json" } });
    if (!res.ok) {
      // 451/403 typically => geo-block; surface the code so the UI can explain.
      throw new Error(`HTTP ${res.status}`);
    }
    return await res.json();
  } catch (e) {
    if (e.name === "AbortError") throw new Error("request timed out");
    throw new Error(e.message || "network error");
  } finally {
    clearTimeout(timer);
  }
}
