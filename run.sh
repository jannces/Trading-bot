#!/usr/bin/env bash
# ===========================================================================
#  MEXC Scalper Scanner — one-click launcher for macOS / Linux.
#  Runs the Node backend (server.js). Requires Node.js 18+.
# ===========================================================================
set -u
cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js not found. Install Node 18+ from https://nodejs.org/ and re-run."
  exit 1
fi

open_url() {
  local url="$1"; sleep 2
  if command -v xdg-open >/dev/null 2>&1; then xdg-open "$url" >/dev/null 2>&1 &
  elif command -v open >/dev/null 2>&1; then open "$url" >/dev/null 2>&1 &
  else echo "Open $url in your browser."; fi
}

while true; do
  clear 2>/dev/null || true
  echo "=========================================================="
  echo "   MEXC Scalper Scanner"
  echo "=========================================================="
  echo
  echo "   [1]  Start scanner (live MEXC)      -> http://localhost:8000"
  echo "   [2]  Start scanner (MOCK offline data)"
  echo "   [3]  Run tests"
  echo "   [4]  Backtest (live MEXC)   e.g. BTCUSDT 5m 1000"
  echo "   [5]  Backtest (MOCK offline)"
  echo "   [6]  Quit"
  echo
  read -r -p "Choose [1-6]: " choice
  echo
  case "$choice" in
    1) [ -d node_modules ] || npm install; open_url "http://localhost:8000"; node server.js ;;
    2) [ -d node_modules ] || npm install; open_url "http://localhost:8000"; MOCK=1 node server.js ;;
    3) npm test; read -r -p "Enter to continue..." _ ;;
    4) read -r -p "SYMBOL TF CANDLES (e.g. BTCUSDT 5m 1000): " a; node backtest.js $a; read -r -p "Enter..." _ ;;
    5) read -r -p "TF CANDLES (e.g. 5m 1000): " a; node backtest.js --demo $a; read -r -p "Enter..." _ ;;
    6) exit 0 ;;
    *) ;;
  esac
done
