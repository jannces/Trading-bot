#!/usr/bin/env bash
# ===========================================================================
#  Crypto Confluence Signal Dashboard - one-click launcher for macOS / Linux.
#  Run it with:   ./run.sh      (make it executable first: chmod +x run.sh)
#  Gives a menu: start the dashboard, run tests, or backtest.
# ===========================================================================
set -u
cd "$(dirname "$0")"

# --- Detect a Python launcher ----------------------------------------------
PY=""
for c in python3 python; do
  if command -v "$c" >/dev/null 2>&1; then PY="$c"; break; fi
done

# --- Detect Node ------------------------------------------------------------
NODE=""
command -v node >/dev/null 2>&1 && NODE="node"

# Pick an "open browser" command for this OS.
open_url() {
  local url="$1"
  if command -v xdg-open >/dev/null 2>&1; then xdg-open "$url" >/dev/null 2>&1 &
  elif command -v open >/dev/null 2>&1; then open "$url" >/dev/null 2>&1 &
  else echo "Open this in your browser: $url"; fi
}

start_dashboard() {
  if [ -n "$PY" ]; then
    echo "Starting server at http://localhost:8000  (press Ctrl+C to stop)"
    open_url "http://localhost:8000"
    "$PY" -m http.server 8000
  elif command -v npx >/dev/null 2>&1; then
    echo "Python not found - falling back to 'npx serve' at http://localhost:3000"
    open_url "http://localhost:3000"
    npx --yes serve -l 3000
  else
    echo "Neither Python nor npx found. Install Python 3 and re-run."
  fi
}

need_node() {
  echo "Node.js not found. Install it from https://nodejs.org/ and re-run."
  echo "(Only the dashboard works without Node; tests and backtest need it.)"
}

while true; do
  clear 2>/dev/null || true
  echo "=========================================================="
  echo "   Crypto Confluence Signal Dashboard"
  echo "=========================================================="
  echo
  [ -n "$PY" ]   && echo "   Python: $PY"   || echo "   Python: NOT FOUND (will try npx serve)"
  [ -n "$NODE" ] && echo "   Node:   node"   || echo "   Node:   NOT FOUND (tests/backtest need it)"
  echo
  echo "   [1]  Start dashboard  (opens in your browser)"
  echo "   [2]  Run indicator tests"
  echo "   [3]  Run backtest     (fetches live data)"
  echo "   [4]  Run backtest     (offline demo, no internet)"
  echo "   [5]  Quit"
  echo
  read -r -p "Choose an option [1-5]: " choice
  echo
  case "$choice" in
    1) start_dashboard ;;
    2) [ -n "$NODE" ] && node tests/indicators.test.js || need_node
       read -r -p "Press Enter to continue..." _ ;;
    3) if [ -n "$NODE" ]; then
         read -r -p "Pair (default BTCUSDT): " sym
         read -r -p "Timeframe 5m/15m/1h/4h/1d (default 15m): " itv
         read -r -p "Candles 300-1000 (default 500): " lim
         echo
         node backtest.js $sym $itv $lim
       else need_node; fi
       read -r -p "Press Enter to continue..." _ ;;
    4) [ -n "$NODE" ] && node backtest.js --demo || need_node
       read -r -p "Press Enter to continue..." _ ;;
    5) exit 0 ;;
    *) ;;
  esac
done
