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
// paging FORWARD via startTime (see getKlinesDeep — MEXC's time param is a lower
// bound, so backward paging via endTime does not work).
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
 * Assemble the latest `total` candles by paging FORWARD via startTime.
 *
 * Why forward: MEXC's spot /klines time parameter behaves as a LOWER bound — a
 * request returns candles whose openTime is at/after the timestamp, ascending, up
 * to `limit`, clamped to the data that exists (confirmed on a live --debug run:
 * endTime=…00:04:59.999 returned candles opening 00:05:00 onward, up to latest).
 * Backward paging via endTime is therefore impossible; we page forward instead.
 *
 * Cursor: start at `windowStart = now - total * intervalMs` (optionally clamped to
 * a known listing date), then advance `startTime = newestOpenTime + 1ms` each
 * page — 1ms past the last candle we hold, which excludes it and (given the ms
 * grid) cannot skip the next one, regardless of whether the bound is inclusive or
 * exclusive. Any residual overlap is de-duped by stitchDeep. Continue while pages
 * add NEW candles and we haven't caught up to `now`.
 *
 * Ends:
 *   - a partial page (< pageSize) or newest reaching `now` -> reached the latest.
 *   - the FIRST window returns 0 rows -> the pair listed later than the window; we
 *     step the window forward and mark `listedLate` (a "limited history" warning,
 *     not a stall). received < requested with a clean earliest boundary is normal
 *     for a newly-listed pair.
 *   - a page returns rows that ALL merge to nothing (newAdded === 0) -> the API
 *     is not advancing startTime: a PAGINATION STALL, flagged as an error.
 *
 * `opts.fetchPage(symbol, tf, limit, startTime) -> Promise<candles ascending>` is
 * injectable for testing; `opts.now` overrides Date.now(); `opts.listingDate`
 * clamps the window start; `opts.debug` (true|fn) logs a per-request trace.
 * @returns { candles, requested, received, uniqueTotal, pages, gaps, stalled, listedLate }
 */
export async function getKlinesDeep(symbol, tf, total, opts = {}) {
  const pageSize = opts.pageSize || KLINES_PAGE;
  const maxRetries = opts.maxRetries ?? 4;
  const onProgress = opts.onProgress || (() => {});
  const debug = opts.debug ? (typeof opts.debug === "function" ? opts.debug : (m) => console.error(m)) : null;
  const fetchPage = opts.fetchPage || ((sym, itf, limit, startTime) => fetchKlinePage(sym, itf, limit, startTime, maxRetries));
  const intMs = intervalMinutes(tf) * 60000;
  const now = opts.now ?? Date.now();

  const windowStart = Math.max(0, now - total * intMs);
  let startTime = opts.listingDate != null ? Math.max(windowStart, opts.listingDate) : windowStart;

  const pages = [];
  const seen = new Set();
  let stalled = false;
  let listedLate = false;
  const maxPages = Math.ceil(total / pageSize) * 2 + 20; // safety (covers empty-window skips)
  for (let p = 0; p < maxPages; p++) {
    const page = await fetchPage(symbol, tf, pageSize, startTime);
    const count = page ? page.length : 0;
    let newAdded = 0, oldest = Infinity, newest = -Infinity;
    if (count) for (const c of page) { if (!seen.has(c.time)) newAdded++; if (c.time < oldest) oldest = c.time; if (c.time > newest) newest = c.time; }
    if (debug) {
      debug(`[deep] ${symbol} ${mexcInterval(tf)} req#${p + 1}: symbol=${symbol} interval=${mexcInterval(tf)} limit=${pageSize} startTime=${startTime} [${isoMs(startTime)}] -> returned ${count}`
        + (count ? `, openTime ${isoMs(oldest)}..${isoMs(newest)}, new-after-merge ${newAdded}` : ""));
    }
    if (!count) {
      if (seen.size === 0) {
        // No data at the window start -> the pair listed later than the window.
        // Step the window forward and keep looking (bounded by maxPages).
        listedLate = true;
        const advanced = startTime + pageSize * intMs;
        if (advanced >= now) break; // no candles anywhere up to now
        startTime = advanced;
        continue;
      }
      break; // reached the newest available candle (nothing ahead)
    }
    pages.push(page);
    for (const c of page) seen.add(c.time);
    onProgress({ pages: pages.length, received: seen.size, total });
    if (newAdded === 0) { stalled = true; break; } // startTime not advancing -> stall
    if (count < pageSize) break;         // partial page -> reached the latest available
    if (newest >= now - intMs) break;    // caught up to the present
    startTime = newest + 1;              // next window strictly after the last openTime (ms)
  }
  const { candles, gaps, uniqueTotal } = stitchDeep(pages, intMs, total);
  // Listed-late = the earliest candle we could get begins after the window we asked
  // for (a newly-listed pair). Its history is complete-for-existence, just short.
  if (candles.length && candles[0].time > windowStart + intMs) listedLate = true;
  return { candles, requested: total, received: candles.length, uniqueTotal, pages: pages.length, gaps, stalled, listedLate };
}

function isoMs(ms) { return Number.isFinite(ms) ? new Date(ms).toISOString() : String(ms); }

async function fetchKlinePage(symbol, tf, limit, startTime, maxRetries) {
  const q = `/api/v3/klines?symbol=${encodeURIComponent(symbol)}&interval=${mexcInterval(tf)}&limit=${limit}${startTime != null ? `&startTime=${startTime}` : ""}`;
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
