// ============================================================================
// mexc.js — MEXC spot v3 REST client (Binance-style paths, MEXC intervals).
//
// The PURE parse/rank functions (parseKlines, parseTicker24hr, rankTopPairs)
// are exported separately so they can be tested against a recorded fixture
// without any network. The networked functions (getKlines, get24hr,
// getAllPrices) wrap fetch with a timeout and clear errors.
//
// Endpoints used:
//   GET /api/v3/klines?symbol=&interval=&limit=   -> array of kline arrays
//   GET /api/v3/ticker/24hr                        -> array of ticker objects
//   GET /api/v3/ticker/price                       -> array of {symbol, price}
// ============================================================================
import { CONFIG } from "./config.js";

const BASE = CONFIG.exchange.rest;

/** Map our timeframe name to a MEXC interval string (1h -> "60m"). */
export function mexcInterval(tf) {
  return CONFIG.exchange.intervalMap[tf] || tf;
}

// --- Pure parsers (unit-tested against a fixture) --------------------------

/**
 * MEXC kline row: [ openTime, open, high, low, close, volume, closeTime,
 * quoteVolume ] (8 fields; Binance-compatible on the first six).
 * @returns [{ time, open, high, low, close, volume }] ascending by time.
 */
export function parseKlines(raw) {
  if (!Array.isArray(raw)) throw new Error("klines: expected an array");
  return raw.map((k) => ({
    time: Number(k[0]),
    open: parseFloat(k[1]),
    high: parseFloat(k[2]),
    low: parseFloat(k[3]),
    close: parseFloat(k[4]),
    volume: parseFloat(k[5]),
  }));
}

/**
 * Parse /ticker/24hr objects into a compact shape.
 * `quoteVolume` is 24h volume in the quote asset (USDT) — the ranking key.
 * Falls back to volume*lastPrice if quoteVolume is missing.
 */
export function parseTicker24hr(raw) {
  const arr = Array.isArray(raw) ? raw : [raw];
  return arr.map((t) => {
    const lastPrice = parseFloat(t.lastPrice);
    const volume = parseFloat(t.volume);
    let quoteVolume = t.quoteVolume != null ? parseFloat(t.quoteVolume) : NaN;
    if (!Number.isFinite(quoteVolume)) quoteVolume = (volume || 0) * (lastPrice || 0);
    return {
      symbol: t.symbol,
      lastPrice,
      priceChangePercent: parseFloat(t.priceChangePercent),
      quoteVolume,
    };
  });
}

/**
 * Rank tradable USDT pairs by 24h quote volume and take the top N, excluding
 * leveraged tokens (…3L/3S) and stablecoin-vs-stablecoin pairs.
 */
export function rankTopPairs(tickers, n = CONFIG.scanner.topN) {
  const { excludeLeveraged, stableBases } = CONFIG.scanner;
  const usdt = tickers.filter((t) => {
    if (!t.symbol || !t.symbol.endsWith("USDT")) return false;
    if (excludeLeveraged.test(t.symbol)) return false;
    const base = t.symbol.slice(0, -4); // strip "USDT"
    if (stableBases.includes(base)) return false; // stable-vs-stable
    return Number.isFinite(t.quoteVolume) && t.quoteVolume > 0;
  });
  usdt.sort((a, b) => b.quoteVolume - a.quoteVolume);
  return usdt.slice(0, n);
}

// --- Networked (Node 18+ global fetch) -------------------------------------

async function getJSON(path, timeoutMs = 12000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${BASE}${path}`, { signal: controller.signal, headers: { Accept: "application/json" } });
    if (res.status === 429 || res.status === 418) { const e = new Error(`rate limited (${res.status})`); e.rateLimited = true; throw e; }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (e) {
    if (e.name === "AbortError") throw new Error("request timed out");
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

export async function getKlines(symbol, tf, limit = 200) {
  const raw = await getJSON(`/api/v3/klines?symbol=${encodeURIComponent(symbol)}&interval=${mexcInterval(tf)}&limit=${limit}`);
  return parseKlines(raw);
}

export async function get24hr() {
  return parseTicker24hr(await getJSON(`/api/v3/ticker/24hr`));
}

/** All-symbol last prices in one call -> Map(symbol -> price). */
export async function getAllPrices() {
  const raw = await getJSON(`/api/v3/ticker/price`);
  const map = new Map();
  for (const t of raw) map.set(t.symbol, parseFloat(t.price));
  return map;
}
