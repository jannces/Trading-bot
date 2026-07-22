// ============================================================================
// mexcws.js — OPTIONAL MEXC spot websocket client for live prices.
//
// ⚠ UNVERIFIED FROM THE BUILD ENVIRONMENT. The sandbox this was built in cannot
// reach wbs.mexc.com, so this subscription format could NOT be tested against
// the live exchange. It is therefore NOT wired into server.js by default
// (server uses REST polling, CONFIG.liveMode = "poll"). Test this locally
// before enabling it — see the README "Live prices" section.
//
// What to check when you enable it:
//   * MEXC has migrated several spot streams to PROTOBUF. The JSON stream
//     "spot@public.deals.v3.api@<SYMBOL>" may or may not still deliver JSON.
//     If you receive binary frames, decode them with MEXC's protobuf schema
//     (https://github.com/mexcdevelop/websocket-proto) OR keep REST polling.
//   * MEXC expects a heartbeat: send {"method":"PING"} periodically; it replies
//     {"method":"PONG"} (or sends its own PING you must answer).
//   * A single connection has a subscription cap (~30 params) — batch symbols.
//
// Usage (after verifying):
//   import { MexcWs } from "./js/mexcws.js";
//   const ws = new MexcWs(symbols, ({symbol, price}) => { ... });
//   ws.connect();
// Requires the `ws` package (listed in package.json).
// ============================================================================
import { CONFIG } from "./config.js";

export class MexcWs {
  constructor(symbols, onPrice, { WebSocketImpl } = {}) {
    this.symbols = symbols;
    this.onPrice = onPrice;
    this.WS = WebSocketImpl; // inject `ws` to avoid a hard dep at import time
    this.ws = null;
    this.heartbeat = null;
    this.status = "disconnected";
  }

  async connect() {
    if (!this.WS) {
      // Lazily load `ws` only when the WS path is actually used.
      const mod = await import("ws").catch(() => null);
      if (!mod) throw new Error("`ws` package not installed (npm install ws)");
      this.WS = mod.default || mod.WebSocket;
    }
    const ws = new this.WS(CONFIG.exchange.ws);
    this.ws = ws;
    ws.on("open", () => {
      this.status = "connected";
      // Batch subscriptions to respect the per-connection cap.
      const params = this.symbols.map((s) => `spot@public.deals.v3.api@${s}`);
      for (let i = 0; i < params.length; i += 25) {
        ws.send(JSON.stringify({ method: "SUBSCRIPTION", params: params.slice(i, i + 25) }));
      }
      this.heartbeat = setInterval(() => { try { ws.send(JSON.stringify({ method: "PING" })); } catch { /* */ } }, 20000);
    });
    ws.on("message", (data, isBinary) => {
      if (isBinary) { this.status = "binary/protobuf — decode required"; return; } // see header note
      let msg;
      try { msg = JSON.parse(data.toString()); } catch { return; }
      // Expected JSON deals frame: { c: "spot@public.deals.v3.api@BTCUSDT", d: { deals:[{p:"price",...}] }, s:"BTCUSDT" }
      const sym = msg.s || (msg.c && msg.c.split("@").pop());
      const price = msg.d?.deals?.[0]?.p ?? msg.d?.p;
      if (sym && price != null) this.onPrice({ symbol: sym, price: parseFloat(price) });
    });
    ws.on("close", () => { this.status = "disconnected"; clearInterval(this.heartbeat); });
    ws.on("error", (e) => { this.status = `error: ${e.message}`; });
  }

  close() { clearInterval(this.heartbeat); try { this.ws?.close(); } catch { /* */ } }
}
