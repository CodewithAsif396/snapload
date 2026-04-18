#!/bin/bash
# Start Python TikTok Flask server
cd "$(dirname "$0")"
pip3 install -q flask requests gunicorn
gunicorn --bind 127.0.0.1:5000 tiktok_server:app --daemon --log-file /tmp/tiktok_flask.log
echo "Flask started on port 5000"

# Start Node.js server
node server.js
