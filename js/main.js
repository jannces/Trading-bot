// ============================================================================
// main.js — App state, fetch loop, and rendering orchestration.
//
// Wires the controls to the data layer (api.js), runs the strategies
// (strategies/index.js), scores them (confluence.js), draws the chart
// (chart.js), and paints the DOM. Keeps a session-only signal history.
// ============================================================================
import { CONFIG } from "./config.js";
import { fetchMarketData } from "./api.js";
import { runAll } from "./strategies/index.js";
import { computeConfluence } from "./confluence.js";
import { drawChart } from "./chart.js";

// --- App state -------------------------------------------------------------
const state = {
  symbol: CONFIG.defaultPair,
  interval: CONFIG.defaultInterval,
  autoRefresh: false,
  timer: null,
  loading: false,
  candles: [],
  lastSource: null,
  history: [], // { time, symbol, interval, verdict, composite, highQuality }
};

// --- Element references ----------------------------------------------------
const el = {};
function cacheEls() {
  const ids = [
    "pairSelect", "pairInput", "intervalSelect", "refreshBtn", "autoToggle",
    "price", "change", "sourceTag", "statusBar",
    "gaugeFill", "gaugeValue", "verdict", "agree", "hqBadge", "plan",
    "chart", "strategyGrid", "history", "lastUpdate",
  ];
  for (const id of ids) el[id] = document.getElementById(id);
}

// --- Init ------------------------------------------------------------------
export function init() {
  cacheEls();
  buildControls();
  bindEvents();
  refresh();
  // Redraw the chart on resize (chart is responsive to its container).
  window.addEventListener("resize", debounce(() => drawChart(el.chart, state.candles), 150));
}

function buildControls() {
  // Pair dropdown.
  for (const p of CONFIG.pairs) {
    const opt = document.createElement("option");
    opt.value = p;
    opt.textContent = p;
    if (p === state.symbol) opt.selected = true;
    el.pairSelect.appendChild(opt);
  }
  // Timeframe buttons/select.
  for (const iv of CONFIG.intervals) {
    const opt = document.createElement("option");
    opt.value = iv;
    opt.textContent = iv;
    if (iv === state.interval) opt.selected = true;
    el.intervalSelect.appendChild(opt);
  }
  el.autoToggle.textContent = `Auto-refresh: OFF`;
}

function bindEvents() {
  el.pairSelect.addEventListener("change", () => {
    state.symbol = el.pairSelect.value;
    el.pairInput.value = "";
    refresh();
  });
  el.pairInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      const v = el.pairInput.value.trim().toUpperCase();
      if (v) {
        state.symbol = v;
        refresh();
      }
    }
  });
  el.intervalSelect.addEventListener("change", () => {
    state.interval = el.intervalSelect.value;
    refresh();
  });
  el.refreshBtn.addEventListener("click", refresh);
  el.autoToggle.addEventListener("click", toggleAuto);
}

function toggleAuto() {
  state.autoRefresh = !state.autoRefresh;
  el.autoToggle.textContent = `Auto-refresh: ${state.autoRefresh ? "ON" : "OFF"}`;
  el.autoToggle.classList.toggle("on", state.autoRefresh);
  if (state.timer) clearInterval(state.timer);
  if (state.autoRefresh) {
    state.timer = setInterval(refresh, CONFIG.autoRefreshSeconds * 1000);
  }
}

// --- Fetch + render loop ---------------------------------------------------
async function refresh() {
  if (state.loading) return;
  state.loading = true;
  setStatus(`Loading ${state.symbol} ${state.interval}…`, "loading");
  el.refreshBtn.disabled = true;

  try {
    const { candles, ticker, source } = await fetchMarketData(
      state.symbol,
      state.interval,
      CONFIG.candleLimit
    );
    state.candles = candles;
    state.lastSource = source;

    renderPrice(ticker);
    drawChart(el.chart, candles);

    const results = runAll(candles);
    const conf = computeConfluence(results, candles);
    renderStrategies(results);
    renderConfluence(conf);
    pushHistory(conf);

    el.sourceTag.textContent = `Source: ${source}`;
    el.lastUpdate.textContent = `Updated ${new Date().toLocaleTimeString()}`;
    const warn = source.includes("CoinGecko") ? " — volume-based signals limited on this feed" : "";
    setStatus(`Live · ${candles.length} candles via ${source}${warn}`, "ok");
  } catch (err) {
    setStatus(`Error: ${err.message}`, "error");
    el.sourceTag.textContent = "Source: none (all feeds failed)";
  } finally {
    state.loading = false;
    el.refreshBtn.disabled = false;
  }
}

// --- Rendering -------------------------------------------------------------
function renderPrice(ticker) {
  el.price.textContent = formatPrice(ticker.lastPrice);
  const pct = ticker.priceChangePercent;
  el.change.textContent = `${pct >= 0 ? "+" : ""}${pct.toFixed(2)}%`;
  el.change.className = "change " + (pct >= 0 ? "pos" : "neg");
}

function renderConfluence(conf) {
  // Gauge: composite -100..100 mapped to 0..100% fill width.
  const pct = (conf.composite + 100) / 2;
  el.gaugeFill.style.width = `${pct}%`;
  el.gaugeFill.className = "gauge-fill " + verdictClass(conf.verdict);
  el.gaugeValue.textContent = (conf.composite > 0 ? "+" : "") + conf.composite;

  el.verdict.textContent = conf.verdict;
  el.verdict.className = "verdict " + verdictClass(conf.verdict);
  el.agree.textContent = `${conf.buys} buy · ${conf.neutrals} neutral · ${conf.sells} sell`;

  el.hqBadge.hidden = !conf.highQuality;
  el.plan.innerHTML = "";
  if (conf.highQuality && conf.plan) {
    el.plan.appendChild(renderPlan(conf.plan));
  }
}

function renderPlan(plan) {
  const wrap = document.createElement("div");
  wrap.className = "plan-card " + (plan.direction === "BUY" ? "buy" : "sell");
  wrap.innerHTML = `
    <div class="plan-head">High-Quality ${plan.direction} setup <span class="illustrative">(illustrative — not financial advice)</span></div>
    <div class="plan-grid">
      <div><span>Entry zone</span><b>${formatPrice(plan.entryLow)} – ${formatPrice(plan.entryHigh)}</b></div>
      <div><span>Stop loss</span><b>${formatPrice(plan.stop)}</b></div>
      <div><span>TP1 (${plan.rr1}R)</span><b>${formatPrice(plan.tp1)}</b></div>
      <div><span>TP2 (${plan.rr2}R)</span><b>${formatPrice(plan.tp2)}</b></div>
    </div>`;
  return wrap;
}

function renderStrategies(results) {
  el.strategyGrid.innerHTML = "";
  for (const r of results) {
    const card = document.createElement("div");
    card.className = "strategy-card " + r.signal.toLowerCase();
    card.innerHTML = `
      <div class="sc-top">
        <span class="sc-name">${r.name}</span>
        <span class="sc-signal ${r.signal.toLowerCase()}">${r.signal}</span>
      </div>
      <div class="sc-bar"><div class="sc-bar-fill ${r.signal.toLowerCase()}" style="width:${r.strength}%"></div></div>
      <div class="sc-meta"><span class="sc-strength">${r.strength}</span><span class="sc-reason">${escapeHtml(r.reason)}</span></div>`;
    el.strategyGrid.appendChild(card);
  }
}

function pushHistory(conf) {
  state.history.unshift({
    time: new Date().toLocaleTimeString(),
    symbol: state.symbol,
    interval: state.interval,
    verdict: conf.verdict,
    composite: conf.composite,
    highQuality: conf.highQuality,
  });
  if (state.history.length > 50) state.history.pop();

  el.history.innerHTML = "";
  for (const h of state.history) {
    const row = document.createElement("div");
    row.className = "hist-row";
    row.innerHTML = `
      <span class="ht-time">${h.time}</span>
      <span class="ht-sym">${h.symbol} ${h.interval}</span>
      <span class="ht-verdict ${verdictClass(h.verdict)}">${h.verdict}${h.highQuality ? " ★" : ""}</span>
      <span class="ht-score">${h.composite > 0 ? "+" : ""}${h.composite}</span>`;
    el.history.appendChild(row);
  }
}

// --- Small helpers ---------------------------------------------------------
function verdictClass(v) {
  return v.toLowerCase().replace(/\s+/g, "-"); // "STRONG BUY" -> "strong-buy"
}

function setStatus(msg, kind) {
  el.statusBar.textContent = msg;
  el.statusBar.className = "status-bar " + (kind || "");
}

function formatPrice(p) {
  if (p == null || !isFinite(p)) return "—";
  if (p >= 1000) return "$" + p.toLocaleString("en-US", { maximumFractionDigits: 2 });
  if (p >= 1) return "$" + p.toFixed(2);
  if (p >= 0.01) return "$" + p.toFixed(4);
  return "$" + p.toPrecision(4);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function debounce(fn, ms) {
  let t;
  return (...a) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...a), ms);
  };
}

// Kick things off once the DOM is ready.
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}
