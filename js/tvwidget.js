// ============================================================================
// tvwidget.js — TradingView Advanced Chart widget (embedded, full TV tools).
//
// Loads TradingView's tv.js once, then mounts the Advanced Chart for the current
// symbol/interval. This is a separate tab from the Lightweight chart because the
// embedded widget is a black box: you get all of TradingView's drawing/analysis
// tools, but the app's programmatic trade-plan levels can only be drawn on the
// Lightweight chart. The UI notes this.
// ============================================================================

const TV_INTERVAL = { "5m": "5", "15m": "15", "1h": "60", "4h": "240", "1d": "D" };

let scriptPromise = null;
function loadTvScript() {
  if (window.TradingView) return Promise.resolve();
  if (scriptPromise) return scriptPromise;
  scriptPromise = new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = "https://s3.tradingview.com/tv.js";
    s.async = true;
    s.onload = resolve;
    s.onerror = () => reject(new Error("tv.js failed to load"));
    document.head.appendChild(s);
  });
  return scriptPromise;
}

/**
 * Mount / remount the Advanced widget into `container` for a symbol/interval.
 * `symbol` is a plain Binance pair like BTCUSDT (prefixed with BINANCE: here).
 */
export async function mountAdvancedWidget(container, symbol, interval) {
  try {
    await loadTvScript();
  } catch {
    container.innerHTML =
      '<div class="chart-fallback">TradingView widget failed to load (offline or blocked).</div>';
    return;
  }
  container.innerHTML = '<div id="tv_adv_inner" style="height:100%"></div>';
  // eslint-disable-next-line no-new
  new TradingView.widget({
    container_id: "tv_adv_inner",
    autosize: true,
    symbol: `MEXC:${symbol.toUpperCase()}`,
    interval: TV_INTERVAL[interval] || "15",
    timezone: "Etc/UTC",
    theme: "dark",
    style: "1",
    locale: "en",
    toolbar_bg: "#0f1620",
    enable_publishing: false,
    allow_symbol_change: true,
    hide_side_toolbar: false,
    studies: [],
  });
}
