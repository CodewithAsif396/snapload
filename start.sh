#!/bin/bash
cd "$(dirname "$0")"

# ─── Environment Setup ──────────────────────────────────────────────────────────
pip3 install -q flask requests gunicorn uvicorn yt-dlp

# ─── Process Management (PM2) ───────────────────────────────────────────────────
# We use PM2 Ecosystem for centralized logging and 45-minute auto-restarts.
# To start everything: ./start.sh
# To monitor: pm2 list
# To check logs: pm2 logs

pm2 start ecosystem.config.js --env production

echo "----------------------------------------------------------------"
echo "🚀 Doomsdaysnap Ecosystem Started!"
echo "🔄 All services configured to refresh every 45 minutes."
echo "----------------------------------------------------------------"

# Legacy manual startup (commented out as requested - do not delete)
# gunicorn --bind 127.0.0.1:5000 tiktok_server:app --daemon --log-file /tmp/tiktok_flask.log
# gunicorn --bind 127.0.0.1:5001 social_server:app --daemon --log-file /tmp/social_flask.log
# uvicorn youtube_server:app --port 5002 --host 127.0.0.1 > /tmp/youtube_fastapi.log 2>&1 &
# node server.js
