@echo off
cd /d "%~dp0server"
echo Starting FamilyCall server...
start "FamilyCall Server" cmd /c "node index.js"
timeout /t 3 /nobreak >nul
echo Starting public tunnel via serveo.net...
ssh -o StrictHostKeyChecking=no -o ServerAliveInterval=30 -R 80:localhost:3000 serveo.net
pause
