@echo off
REM ===========================================================================
REM  Crypto Confluence Signal Dashboard - one-click launcher for Windows.
REM  Double-click this file, or run it from a terminal. It finds Python / Node
REM  for you and gives a menu: start the dashboard, run the tests, or backtest.
REM ===========================================================================
setlocal enabledelayedexpansion
cd /d "%~dp0"
title Crypto Confluence Dashboard

REM --- Detect a Python launcher (for the static server) ----------------------
set "PY="
for %%C in ("py -3" "python" "python3") do (
  if not defined PY (
    %%~C --version >nul 2>nul && set "PY=%%~C"
  )
)

REM --- Detect Node (for tests + backtest) ------------------------------------
set "NODE="
where node >nul 2>nul && set "NODE=node"

:menu
cls
echo ==========================================================
echo    Crypto Confluence Signal Dashboard
echo ==========================================================
echo.
if defined PY (echo    Python: %PY%) else (echo    Python: NOT FOUND ^(will try "npx serve"^))
if defined NODE (echo    Node:   node) else (echo    Node:   NOT FOUND ^(tests/backtest need it^))
echo.
echo    [1]  Start dashboard  ^(opens in your browser^)
echo    [2]  Run indicator tests
echo    [3]  Run backtest     ^(fetches live data^)
echo    [4]  Run backtest     ^(offline demo, no internet^)
echo    [5]  Quit
echo.
set "choice="
set /p "choice=Choose an option [1-5]: "

if "%choice%"=="1" goto dashboard
if "%choice%"=="2" goto tests
if "%choice%"=="3" goto backtest
if "%choice%"=="4" goto demo
if "%choice%"=="5" goto end
goto menu

REM ---------------------------------------------------------------------------
:dashboard
if not defined PY goto dashboard_npx
echo.
echo Starting server at http://localhost:8000
echo A separate "Dashboard Server" window will open - close it to stop.
start "Dashboard Server" cmd /k "%PY% -m http.server 8000"
REM Give the server a moment, then open the browser.
timeout /t 2 >nul
start "" http://localhost:8000
goto menu

:dashboard_npx
where npx >nul 2>nul
if errorlevel 1 (
  echo.
  echo Neither Python nor npx was found.
  echo Install Python from https://www.python.org/downloads/ ^(tick "Add to PATH"^) and re-run.
  echo.
  pause
  goto menu
)
echo.
echo Python not found - falling back to "npx serve" at http://localhost:3000
start "Dashboard Server" cmd /k "npx --yes serve -l 3000"
timeout /t 3 >nul
start "" http://localhost:3000
goto menu

REM ---------------------------------------------------------------------------
:tests
if not defined NODE goto need_node
echo.
node tests\indicators.test.js
echo.
pause
goto menu

REM ---------------------------------------------------------------------------
:backtest
if not defined NODE goto need_node
echo.
echo Leave a field blank to use its default.
set "sym="
set "itv="
set "lim="
set /p "sym=Pair (default BTCUSDT): "
set /p "itv=Timeframe 5m/15m/1h/4h/1d (default 15m): "
set /p "lim=Candles 300-1000 (default 500): "
echo.
node backtest.js %sym% %itv% %lim%
echo.
pause
goto menu

REM ---------------------------------------------------------------------------
:demo
if not defined NODE goto need_node
echo.
node backtest.js --demo
echo.
pause
goto menu

REM ---------------------------------------------------------------------------
:need_node
echo.
echo Node.js was not found. Install it from https://nodejs.org/ and re-run.
echo ^(Only the dashboard works without Node; tests and backtest need it.^)
echo.
pause
goto menu

:end
endlocal
