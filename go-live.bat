@echo off
title FamilyCall Server + ngrok
cd /d "%~dp0"

taskkill /f /im node.exe >nul 2>&1
taskkill /f /im ngrok.exe >nul 2>&1

:: Start server
echo [1] Starting server...
start "FamilyCall Server" cmd /c "node server/index.js"
timeout /t 2 /nobreak >nul

:: Start ngrok
echo [2] Starting ngrok (public tunnel)...
start "ngrok" cmd /c "ngrok http 3000"
timeout /t 4 /nobreak >nul

echo.
echo ================ PUBLIC URL ================
echo Check this URL in your browser:
echo   http://127.0.0.1:4040
echo.
echo Or run this command to get URL:
echo   curl -s http://127.0.0.1:4040/api/tunnels
echo.
echo Copy the "public_url" value and SEND IT TO ME
echo I will rebuild APK with that URL.
echo ============================================
echo.
echo Close this window to stop server + ngrok.
pause
