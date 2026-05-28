@echo off
echo Starting FamilyCall Server...
cd /d "%~dp0server"
start /b "" "node" "index.js"
timeout /t 3 /nobreak >nul

echo Testing server...
curl -s http://localhost:3000/api/users
echo.

echo.
echo ==================================================
echo Server is running on http://localhost:3000
echo.
echo To test from phone, use your LAN IP:
echo   ipconfig  (look for IPv4 Address under your WiFi)
echo.
echo Then install FamilyCall.apk on both phones.
echo Make sure both phones are on the same WiFi.
echo ==================================================
echo.
pause
