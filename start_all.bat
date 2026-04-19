@echo off
TITLE Doomsdaysnap All-In-One Starter
echo ==========================================
echo    Doomsdaysnap Background Engines
echo ==========================================

echo [1/4] Starting YouTube Hybrid Pro Engine (Port 5002)...
start "YouTube Engine" /min cmd /c python youtube_server.py

echo [2/4] Starting TikTok Engine (Port 5000)...
start "TikTok Engine" /min cmd /c python tiktok_server.py

echo [3/4] Starting Social Engine (Port 5001)...
start "Social Engine" /min cmd /c python social_server.py

echo [4/4] Starting Doomsdaysnap Main Server...
echo Wait 3 seconds for engines to initialize...
timeout /t 3 >nul

node server.js

pause
