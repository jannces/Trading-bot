// ============================================================================
// mockprovider.js — Offline data provider that mimics the MEXC REST client
// interface (getKlines / get24hr / getAllPrices) using synthetic data.
//
// Used when the server runs with MOCK=1 (or --mock), so the whole pipeline —
// scanner, gate, signal lifecycle, ledger, SSE — can be exercised without any
// network (the build sandbox can't reach MEXC). Data "advances" ~1 candle per
// real second so signals actually form and resolve while you watch.
// ============================================================================
import { resampleToHTF, htfFactor } from "./htf.js";

const SYMBOLS = [
  "BTCUSDT", "ETHUSDT", "SOLUSDT", "BNBUSDT", "XRPUSDT", "DOGEUSDT",
  "ADAUSDT", "AVAXUSDT", "LINKUSDT", "TONUSDT", "TRXUSDT", "NEARUSDT",
];

export class MockProvider {
  constructor(opts = {}) {
    this.full = !!opts.full; // backtest: expose the whole series (ignore cursor)
    this.base = new Map(); // sym -> 1m candles
    this.start = Date.now();
    // Start with enough 1m history that 5m (÷5) and 15m (÷15) also clear the
    // 120-bar warmup immediately in streaming mode.
    this.startIdx = 800;
    this.tickMs = Number(process.env.MOCK_MS) || 1000; // synthetic candle cadence
    this.manual = null; // when set, overrides the wall-clock cursor (tests)
    SYMBOLS.forEach((s, i) => this.base.set(s, gen(s, 4000, 40 + i * 120)));
  }

  setCursor(n) { this.manual = n; }
  cursor() { return this.manual != null ? this.manual : this.startIdx + Math.floor((Date.now() - this.start) / this.tickMs); }

  async get24hr() {
    return SYMBOLS.map((symbol, i) => {
      const c = this.visible1m(symbol);
      const last = c[c.length - 1].close;
      return {
        symbol, lastPrice: last, priceChangePercent: 1.2 - i * 0.1,
        volume: 1e5, quoteVolume: (SYMBOLS.length - i) * 5e6, // deterministic ranking
      };
    });
  }

  async getAllPrices() {
    const m = new Map();
    for (const s of SYMBOLS) {
      const c = this.visible1m(s);
      const jitter = 1 + (Math.random() - 0.5) * 0.0006;
      m.set(s, c[c.length - 1].close * jitter);
    }
    return m;
  }

  async getKlines(symbol, tf, limit = 200) {
    const vis = this.visible1m(symbol);
    const factor = htfFactor("1m", tf); // 1m->1, 5m->5, 15m->15
    const cs = factor <= 1 ? vis : resampleToHTF(vis, factor);
    return cs.slice(-limit);
  }

  visible1m(symbol) {
    const base = this.base.get(symbol);
    if (this.full) return base; // backtest: whole series
    const cur = Math.max(this.startIdx, Math.min(base.length, this.cursor()));
    return base.slice(0, cur);
  }
}

// Deterministic-ish synthetic 1m series with trend regimes + injected sweeps.
function gen(symbol, n, price0) {
  const rnd = mulberry32(hash(symbol));
  const candles = [];
  let p = price0;
  const t0 = Date.now() - n * 60000;
  for (let i = 0; i < n; i++) {
    const regime = Math.floor(i / 80) % 4;
    const drift = regime === 0 || regime === 3 ? 0.05 * (price0 / 100) : regime === 1 ? -0.06 * (price0 / 100) : 0;
    p += drift + Math.sin(i / 9) * 0.2 * (price0 / 100) + (rnd() - 0.5) * 0.4 * (price0 / 100);
    p = Math.max(price0 * 0.2, p);
    let o = p - (rnd() - 0.5) * 0.2 * (price0 / 100);
    let c = p + (rnd() - 0.5) * 0.2 * (price0 / 100);
    let h = Math.max(o, c) + rnd() * 0.25 * (price0 / 100);
    let l = Math.min(o, c) - rnd() * 0.25 * (price0 / 100);
    if (i % 31 === 0 && i > 5) {
      const sweepDown = regime === 0 || regime === 3;
      const wick = 0.9 * (price0 / 100);
      if (sweepDown) { l -= wick; c = Math.max(o, c) + 0.15 * (price0 / 100); }
      else { h += wick; c = Math.min(o, c) - 0.15 * (price0 / 100); }
    }
    candles.push({ time: t0 + i * 60000, open: o, high: h, low: l, close: c, volume: 100 + rnd() * 400 });
  }
  return candles;
}

function hash(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
