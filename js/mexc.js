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
import { intervalMinutes } from "./htf.js";

const BASE = CONFIG.exchange.rest;

// MEXC caps a single klines request at ~500 rows. Deep history is assembled by
// paging backward via endTime (see getKlinesDeep).
export const KLINES_PAGE = 500;

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
  const candles = parseKlines(raw);
  // A single request is capped at ~KLINES_PAGE; surface silent truncation so a
  // consumer that asked for more than one page's worth isn't misled.
  if (limit > KLINES_PAGE && candles.length < limit) warnCapOnce(symbol, tf, limit, candles.length);
  return candles;
}

const _capWarned = new Set();
function warnCapOnce(symbol, tf, requested, received) {
  const k = `${symbol}:${tf}`;
  if (_capWarned.has(k)) return;
  _capWarned.add(k);
  console.warn(`[mexc] ${symbol} ${tf}: requested ${requested} klines, received ${received} (single-request cap ~${KLINES_PAGE}). Use getKlinesDeep / fetch-data.js for deep history.`);
}

// --- Deep history via backward pagination ----------------------------------

/**
 * Stitch fetched pages (each ascending by open time) into one continuous,
 * de-duplicated ascending series and keep the most recent `total`. Pure so it
 * can be unit-tested. Records continuity gaps (missing candles) — never fatal.
 * @returns { candles, gaps:[{after,before,missing}], uniqueTotal }
 */
export function stitchDeep(pages, intervalMs, total) {
  const map = new Map();
  for (const page of pages) for (const c of page) map.set(c.time, c); // dedupe by open time
  const all = [...map.values()].sort((a, b) => a.time - b.time);
  const gaps = [];
  for (let i = 1; i < all.length; i++) {
    const d = all[i].time - all[i - 1].time;
    if (d !== intervalMs) gaps.push({ after: all[i - 1].time, before: all[i].time, missing: Math.max(0, Math.round(d / intervalMs) - 1) });
  }
  return { candles: total > 0 ? all.slice(-total) : all, gaps, uniqueTotal: all.length };
}

/**
 * Assemble up to `total` candles by paging backward via endTime. Each page is
 * fetched newest-first; the earliest open time of a page becomes the next
 * page's endTime-1 (so the seam candle is excluded, and any residual overlap is
 * de-duplicated by stitchDeep). Honors rate-limit backoff.
 *
 * `opts.fetchPage(symbol, tf, limit, endTime) -> Promise<candles ascending>` is
 * injectable for testing (defaults to the real networked page fetch).
 * @returns { candles, requested, received, uniqueTotal, pages, gaps }
 */
export async function getKlinesDeep(symbol, tf, total, opts = {}) {
  const pageSize = opts.pageSize || KLINES_PAGE;
  const maxRetries = opts.maxRetries ?? 4;
  const onProgress = opts.onProgress || (() => {});
  const fetchPage = opts.fetchPage || ((sym, itf, limit, endTime) => fetchKlinePage(sym, itf, limit, endTime, maxRetries));
  const intMs = intervalMinutes(tf) * 60000;

  const pages = [];
  const seen = new Set();
  let end; // ms; undefined = latest
  const maxPages = Math.ceil(total / pageSize) + 5; // safety bound
  for (let p = 0; p < maxPages; p++) {
    const page = await fetchPage(symbol, tf, pageSize, end);
    if (!page || !page.length) break;
    pages.push(page);
    for (const c of page) seen.add(c.time);
    onProgress({ pages: pages.length, received: seen.size, total });
    if (seen.size >= total) break;
    if (page.length < pageSize) break; // reached the start of available history
    const nextEnd = page[0].time - 1; // page[0] is the earliest of this page
    if (end !== undefined && nextEnd >= end) break; // no backward progress -> stop
    end = nextEnd;
  }
  const { candles, gaps, uniqueTotal } = stitchDeep(pages, intMs, total);
  return { candles, requested: total, received: candles.length, uniqueTotal, pages: pages.length, gaps };
}

async function fetchKlinePage(symbol, tf, limit, endTime, maxRetries) {
  const q = `/api/v3/klines?symbol=${encodeURIComponent(symbol)}&interval=${mexcInterval(tf)}&limit=${limit}${endTime != null ? `&endTime=${endTime}` : ""}`;
  for (let attempt = 0; ; attempt++) {
    try { return parseKlines(await getJSON(q)); }
    catch (e) {
      if (e.rateLimited && attempt < maxRetries) { await sleep(CONFIG.timing.backoffBaseMs * 2 ** attempt); continue; }
      throw e;
    }
  }
}
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

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
