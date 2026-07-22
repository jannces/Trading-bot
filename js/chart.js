// ============================================================================
// chart.js — Dependency-free canvas candlestick chart.
//
// Draws the fetched candles with a price grid, a volume histogram along the
// bottom, and a dashed last-price line. Handles high-DPI (devicePixelRatio)
// so it stays crisp on phones, and is fully responsive to its container width.
// ============================================================================

const COLORS = {
  bg: "#0d1117",
  grid: "#1b2430",
  text: "#7d8ea3",
  up: "#26a37b",
  down: "#e5484d",
  volUp: "rgba(38,163,123,0.35)",
  volDown: "rgba(229,72,77,0.35)",
  lastLine: "#e3b341",
};

/**
 * @param canvas HTMLCanvasElement
 * @param candles [{ time, open, high, low, close, volume }]
 */
export function drawChart(canvas, candles) {
  const ctx = canvas.getContext("2d");
  const dpr = window.devicePixelRatio || 1;

  // Size the backing store to the CSS box * dpr for crisp lines.
  const cssW = canvas.clientWidth || 800;
  const cssH = canvas.clientHeight || 380;
  canvas.width = Math.round(cssW * dpr);
  canvas.height = Math.round(cssH * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  ctx.clearRect(0, 0, cssW, cssH);
  ctx.fillStyle = COLORS.bg;
  ctx.fillRect(0, 0, cssW, cssH);

  if (!candles || candles.length === 0) {
    drawText(ctx, "No data", cssW / 2, cssH / 2, COLORS.text, "center");
    return;
  }

  // Layout: price panel on top, volume strip at bottom.
  const padL = 8;
  const padR = 62; // room for the price axis labels on the right
  const padT = 10;
  const padB = 18;
  const volH = Math.min(70, cssH * 0.22);
  const priceH = cssH - padT - padB - volH;
  const plotW = cssW - padL - padR;

  // Show at most the last N candles that fit comfortably.
  const maxBars = Math.max(30, Math.floor(plotW / 6));
  const view = candles.slice(-maxBars);
  const n = view.length;

  let hi = -Infinity;
  let lo = Infinity;
  let maxVol = 0;
  for (const c of view) {
    if (c.high > hi) hi = c.high;
    if (c.low < lo) lo = c.low;
    if (c.volume > maxVol) maxVol = c.volume;
  }
  const range = hi - lo || hi * 0.01 || 1;
  hi += range * 0.04;
  lo -= range * 0.04;

  const priceToY = (p) => padT + ((hi - p) / (hi - lo)) * priceH;
  const volTop = padT + priceH + 6;
  const step = plotW / n;
  const bodyW = Math.max(1, Math.min(step * 0.7, 14));

  // --- Grid + price axis (5 horizontal lines) ----------------------------
  ctx.strokeStyle = COLORS.grid;
  ctx.lineWidth = 1;
  ctx.font = "11px ui-monospace, monospace";
  ctx.textBaseline = "middle";
  const gridLines = 5;
  for (let g = 0; g <= gridLines; g++) {
    const p = hi - ((hi - lo) * g) / gridLines;
    const y = priceToY(p);
    ctx.beginPath();
    ctx.moveTo(padL, y);
    ctx.lineTo(padL + plotW, y);
    ctx.stroke();
    drawText(ctx, formatPrice(p), padL + plotW + 4, y, COLORS.text, "left");
  }

  // --- Candles + volume --------------------------------------------------
  for (let i = 0; i < n; i++) {
    const c = view[i];
    const cx = padL + i * step + step / 2;
    const up = c.close >= c.open;
    const color = up ? COLORS.up : COLORS.down;

    // Wick.
    ctx.strokeStyle = color;
    ctx.beginPath();
    ctx.moveTo(cx, priceToY(c.high));
    ctx.lineTo(cx, priceToY(c.low));
    ctx.stroke();

    // Body.
    const yOpen = priceToY(c.open);
    const yClose = priceToY(c.close);
    const top = Math.min(yOpen, yClose);
    const h = Math.max(1, Math.abs(yClose - yOpen));
    ctx.fillStyle = color;
    ctx.fillRect(cx - bodyW / 2, top, bodyW, h);

    // Volume bar.
    if (maxVol > 0) {
      const vh = (c.volume / maxVol) * volH;
      ctx.fillStyle = up ? COLORS.volUp : COLORS.volDown;
      ctx.fillRect(cx - bodyW / 2, volTop + (volH - vh), bodyW, vh);
    }
  }

  // --- Last price dashed line + tag --------------------------------------
  const lastP = view[n - 1].close;
  const lastY = priceToY(lastP);
  ctx.strokeStyle = COLORS.lastLine;
  ctx.setLineDash([4, 3]);
  ctx.beginPath();
  ctx.moveTo(padL, lastY);
  ctx.lineTo(padL + plotW, lastY);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = COLORS.lastLine;
  ctx.fillRect(padL + plotW, lastY - 8, padR, 16);
  drawText(ctx, formatPrice(lastP), padL + plotW + 4, lastY, "#0d1117", "left");
}

function drawText(ctx, text, x, y, color, align) {
  ctx.fillStyle = color;
  ctx.textAlign = align;
  ctx.fillText(text, x, y);
}

/** Compact price formatting that adapts to magnitude (crypto spans orders). */
function formatPrice(p) {
  if (p >= 1000) return p.toLocaleString("en-US", { maximumFractionDigits: 1 });
  if (p >= 1) return p.toFixed(2);
  if (p >= 0.01) return p.toFixed(4);
  return p.toPrecision(3);
}
