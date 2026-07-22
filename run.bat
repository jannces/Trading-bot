@echo off
REM ===========================================================================
REM  MEXC Scalper Scanner - one-click launcher for Windows. Needs Node.js 18+.
REM ===========================================================================
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js not found. Install Node 18+ from https://nodejs.org/ and re-run.
  pause
  exit /b 1
)

:menu
cls
echo ==========================================================
echo    MEXC Scalper Scanner
echo ==========================================================
echo.
echo    [1]  Start scanner (live MEXC)      -^> http://localhost:8000
echo    [2]  Start scanner (MOCK offline data)
echo    [3]  Run tests
echo    [4]  Backtest (live MEXC)
echo    [5]  Backtest (MOCK offline)
echo    [6]  Quit
echo.
set "choice="
set /p "choice=Choose [1-6]: "

if "%choice%"=="1" goto live
if "%choice%"=="2" goto mock
if "%choice%"=="3" goto tests
if "%choice%"=="4" goto bt
if "%choice%"=="5" goto btmock
if "%choice%"=="6" goto end
goto menu

:live
if not exist node_modules ( call npm install )
start "" http://localhost:8000
node server.js
goto menu

:mock
if not exist node_modules ( call npm install )
start "" http://localhost:8000
set MOCK=1
node server.js
set MOCK=
goto menu

:tests
call npm test
pause
goto menu

:bt
set "a="
set /p "a=SYMBOL TF CANDLES (e.g. BTCUSDT 5m 1000): "
node backtest.js %a%
pause
goto menu

:btmock
set "a="
set /p "a=TF CANDLES (e.g. 5m 1000): "
node backtest.js --demo %a%
pause
goto menu

:end
endlocal
