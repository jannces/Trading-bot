// ============================================================================
// chart.js — TradingView Lightweight Charts wrapper.
//
// Uses the global `LightweightCharts` loaded from a CDN <script> in index.html
// (v4 standalone build). Draws candlesticks + a volume histogram, and — when a
// trade plan is active — price lines for the entry zone, stop, TP1 and TP2, plus
// a marker on the trigger candle. Programmatic levels live HERE (the embedded
// Advanced widget can't be drawn on).
// ============================================================================

export function createChartManager(container) {
  if (typeof LightweightCharts === "undefined") {
    container.innerHTML =
      '<div class="chart-fallback">TradingView Lightweight Charts failed to load ' +
      "(offline or CDN blocked). Candles are unavailable, but signals still work.</div>";
    return { update() {}, setPlan() {}, clearPlan() {}, remove() {} };
  }

  const chart = LightweightCharts.createChart(container, {
    layout: { background: { color: "#0f1620" }, textColor: "#9fb0c3" },
    grid: { vertLines: { color: "#182231" }, horzLines: { color: "#182231" } },
    rightPriceScale: { borderColor: "#1e2a3a" },
    timeScale: { borderColor: "#1e2a3a", timeVisible: true, secondsVisible: false },
    crosshair: { mode: LightweightCharts.CrosshairMode.Normal },
    autoSize: true,
  });

  const candleSeries = chart.addCandlestickSeries({
    upColor: "#26a37b", downColor: "#e5484d",
    borderUpColor: "#26a37b", borderDownColor: "#e5484d",
    wickUpColor: "#26a37b", wickDownColor: "#e5484d",
  });

  const volumeSeries = chart.addHistogramSeries({
    priceFormat: { type: "volume" },
    priceScaleId: "", // overlay on its own hidden scale
  });
  volumeSeries.priceScale().applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });

  let priceLines = [];

  function toSec(ms) { return Math.floor(ms / 1000); }

  function update(candles) {
    candleSeries.setData(
      candles.map((c) => ({ time: toSec(c.time), open: c.open, high: c.high, low: c.low, close: c.close }))
    );
    volumeSeries.setData(
      candles.map((c) => ({
        time: toSec(c.time),
        value: c.volume,
        color: c.close >= c.open ? "rgba(38,163,123,0.5)" : "rgba(229,72,77,0.5)",
      }))
    );
  }

  function clearPlan() {
    for (const l of priceLines) candleSeries.removePriceLine(l);
    priceLines = [];
    candleSeries.setMarkers([]);
  }

  function setPlan(plan, candles) {
    clearPlan();
    if (!plan) return;
    const line = (price, color, title, style) =>
      priceLines.push(
        candleSeries.createPriceLine({
          price,
          color,
          lineWidth: 1,
          lineStyle: style ?? LightweightCharts.LineStyle.Dashed,
          axisLabelVisible: true,
          title,
        })
      );
    line(plan.entryHigh, "#3d7dff", "Entry", LightweightCharts.LineStyle.Solid);
    line(plan.entryLow, "#3d7dff", "Entry", LightweightCharts.LineStyle.Solid);
    line(plan.stop, "#e5484d", "SL");
    line(plan.tp1, "#26a37b", "TP1");
    line(plan.tp2, "#7d8ea3", "TP2");

    // Marker on the trigger candle — located by TIME (indices go stale as the
    // frozen signal's candle window rolls forward).
    const trig = candles.find((c) => c.time === plan.triggerTime) || candles[plan.triggerIndex];
    if (trig) {
      const long = plan.direction === "LONG";
      candleSeries.setMarkers([
        {
          time: toSec(trig.time),
          position: long ? "belowBar" : "aboveBar",
          color: long ? "#26a37b" : "#e5484d",
          shape: long ? "arrowUp" : "arrowDown",
          text: `${plan.tier} ${plan.direction}`,
        },
      ]);
    }
  }

  function remove() { chart.remove(); }

  return { update, setPlan, clearPlan, remove, chart };
}
