@echo off
title FamilyCall Test - Server + ngrok
cd /d "%~dp0"

echo =============================================
echo  FamilyCall - Local Test Setup
echo =============================================
echo.

:: Kill any existing node/ngrok
taskkill /f /im node.exe >nul 2>&1
taskkill /f /im ngrok.exe >nul 2>&1
timeout /t 2 /nobreak >nul

:: Start server
echo [1/3] Starting server...
start /b "" "node" "server/index.js"
timeout /t 3 /nobreak >nul

:: Verify server
curl -s http://localhost:3000/api/users >nul
if %ERRORLEVEL% NEQ 0 (
    echo ERROR: Server failed to start!
    pause
    exit /b 1
)
echo   OK - Server running on http://localhost:3000

:: Start ngrok
echo [2/3] Starting ngrok tunnel (public URL)...
start /b "" "ngrok" "http" "3000" "--log=stdout"
timeout /t 5 /nobreak >nul

:: Get ngrok URL
echo [3/3] Fetching public URL...
for /f "tokens=*" %%a in ('curl -s http://127.0.0.1:4040/api/tunnels ^| findstr "public_url"') do set NGROK_LINE=%%a
echo.
echo =============================================
echo  Your public URL (send this to anyone):
echo  (Extract from above or check http://127.0.0.1:4040)
echo =============================================
echo.
echo  PHONE SETUP:
echo  1. Both phones must be on same WiFi (for LAN mode)
echo     OR use ngrok URL above (works from anywhere)
echo  2. Install FamilyCall.apk on both phones
echo  3. Open http://localhost:3000 in browser for web version
echo.
echo  NOTE: Current APK connects to 10.185.29.215:3000
echo  For ngrok testing, update Constants.kt and rebuild.
echo.
echo  Press Ctrl+C to stop server + ngrok
echo =============================================
pause >nul
