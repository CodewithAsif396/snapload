from flask import Flask, request, Response, jsonify
import requests
import re
import json

app = Flask(__name__)

BROWSER_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    "Accept-Encoding": "gzip, deflate, br",
    "Connection": "keep-alive",
    "Upgrade-Insecure-Requests": "1",
    "Sec-Fetch-Dest": "document",
    "Sec-Fetch-Mode": "navigate",
    "Sec-Fetch-Site": "none",
    "Sec-Fetch-User": "?1",
}

# ─── helpers ─────────────────────────────────────────────────────────────────

def fix_url(u):
    return u.replace("\\u0026", "&").replace("\\/", "/").replace("\\\\", "\\")


# ─── FACEBOOK ────────────────────────────────────────────────────────────────

def fetch_facebook(url):
    """
    Extract Facebook video using yt-dlp engine.
    Supports multi-quality (HD/SD).
    """
    import subprocess
    import json
    import os
    import sys

    try:
        # Base directory of the project
        BASE = os.path.dirname(os.path.abspath(__file__))
        
        # ── Cookie Detection ──
        search_dirs = [os.path.join(BASE, 'ads-backend', 'data'), BASE]
        potential_files = []
        for d in search_dirs:
            if not os.path.exists(d): continue
            for name in os.listdir(d):
                if name.endswith(".txt") and "cookie" in name.lower():
                    p = os.path.join(d, name)
                    if os.path.isfile(p) and os.path.getsize(p) > 100:
                        potential_files.append(p)
        
        # Priority: cookies_facebook.txt first, then largest
        cookie_file = None
        if potential_files:
            fb_specific = [f for f in potential_files if "facebook" in os.path.basename(f).lower()]
            if fb_specific:
                fb_specific.sort(key=os.path.getsize, reverse=True)
                cookie_file = fb_specific[0]
            else:
                potential_files.sort(key=os.path.getsize, reverse=True)
                cookie_file = potential_files[0]
        
        # Command to get metadata in JSON format
        cmd = [
            sys.executable, '-m', 'yt_dlp',
            '--dump-single-json',
            '--no-playlist',
            '--quiet',
            '--no-warnings',
            '--no-check-certificate',
            url
        ]
        
        if os.path.exists(cookie_file):
            cmd.extend(['--cookies', cookie_file])

        print(f"[Facebook] yt-dlp extracting: {url}")
        result = subprocess.run(cmd, capture_output=True, text=True)
        
        if result.returncode != 0:
            print(f"[Facebook] yt-dlp error: {result.stderr}")
            return None
            
        data = json.loads(result.stdout)
        
        # Parse results
        videos = []
        formats = data.get('formats', [])
        
        # 1. Look for specific Facebook 'hd' and 'sd' tags
        for f in formats:
            fid = f.get('format_id')
            if fid in ['hd', 'sd']:
                videos.append({
                    'url': f['url'],
                    'fid': fid,
                    'quality': 'HD Quality (Best)' if fid == 'hd' else 'SD Quality',
                    'height': f.get('height') or (720 if fid == 'hd' else 360),
                    'ext': f.get('ext', 'mp4')
                })

        # 2. Add other combined formats if not already found
        for f in formats:
            if f.get('vcodec') != 'none' and f.get('acodec') != 'none' and f.get('ext') == 'mp4':
                height = f.get('height', 0)
                quality = f.get('format_note') or f.get('quality_label') or f'{height}p MP4'
                # Don't add duplicates
                if not any(v['height'] == height for v in videos):
                    videos.append({
                        'url': f['url'],
                        'fid': f.get('format_id'),
                        'quality': quality,
                        'height': height,
                        'ext': f.get('ext', 'mp4')
                    })
        
        # Sort by height descending
        videos.sort(key=lambda x: x['height'], reverse=True)
        
        # Deduplicate
        seen = set()
        unique_videos = []
        for v in videos:
            if v['quality'] not in seen:
                seen.add(v['quality'])
                unique_videos.append(v)

        if unique_videos:
            return {
                "video_url": unique_videos[0]["url"], # For backward compatibility
                "formats": unique_videos,
                "title": data.get('title', 'Facebook Video'),
                "platform": "facebook",
                "thumbnail": data.get('thumbnail'),
                "duration": data.get('duration_string')
            }
            
    except Exception as e:
        print(f"[Facebook] yt-dlp exception: {e}")
        
    return None




# ─── SNAPCHAT ────────────────────────────────────────────────────────────────

def fetch_snapchat(url):
    try:
        r = requests.get(
            url,
            headers={**BROWSER_HEADERS, "Referer": "https://www.snapchat.com/"},
            allow_redirects=True,
            timeout=20,
        )
        html = r.text

        m = re.search(r'"playbackUrl"\s*:\s*"(https://[^"]+)"', html)
        if m:
            print("[Snapchat] Found via playbackUrl")
            return {"video_url": m.group(1).replace("\\u0026", "&"), "title": "Snapchat Video", "platform": "snapchat"}

        m = re.search(r'(https://cf-st\.sc-cdn\.net/[^"\'>\s]+\.mp4[^"\'>\s]*)', html)
        if m:
            print("[Snapchat] Found via sc-cdn.net")
            return {"video_url": m.group(1).replace("\\u0026", "&"), "title": "Snapchat Video", "platform": "snapchat"}

        nd = re.search(r'<script id="__NEXT_DATA__"[^>]*>(.*?)</script>', html, re.DOTALL)
        if nd:
            try:
                text = json.dumps(json.loads(nd.group(1)))
                cdn = re.search(r'(https://cf-st\.sc-cdn\.net/[^"\\]+\.mp4)', text)
                if cdn:
                    print("[Snapchat] Found via __NEXT_DATA__")
                    return {"video_url": cdn.group(1), "title": "Snapchat Video", "platform": "snapchat"}
            except Exception:
                pass

        m = re.search(r'"(https://[^"]*sc-cdn\.net[^"]+\.mp4[^"]*)"', html)
        if m:
            print("[Snapchat] Found via sc-cdn fallback")
            return {"video_url": m.group(1).replace("\\u0026", "&").replace("\\/", "/"), "title": "Snapchat Video", "platform": "snapchat"}

    except Exception as e:
        print(f"[Snapchat] scrape error: {e}")

    return None


# ─── ROUTES ──────────────────────────────────────────────────────────────────

@app.route("/social/download", methods=["POST"])
def social_download():
    body = request.get_json()
    url = body.get("url", "").strip()
    if not url:
        return jsonify({"error": "URL missing"}), 400

    result = None
    if "facebook.com" in url or "fb.watch" in url:
        result = fetch_facebook(url)
    elif "snapchat.com" in url or "t.snapchat.com" in url:
        result = fetch_snapchat(url)
    else:
        return jsonify({"error": "Unsupported platform"}), 400

    if not result:
        return jsonify({"error": "Could not extract video. Make sure the video is public."}), 404

    return jsonify(result)


@app.route("/social/proxy")
def social_proxy():
    video_url = request.args.get("url", "")
    platform  = request.args.get("platform", "facebook")
    if not video_url:
        return "URL missing", 400

    referers = {
        "facebook": "https://www.facebook.com/",
        "snapchat": "https://www.snapchat.com/",
    }

    hdrs = {
        "User-Agent": BROWSER_HEADERS["User-Agent"],
        "Referer": referers.get(platform, "https://www.google.com/"),
        "Accept": "*/*",
        "Accept-Encoding": "identity",
        "Connection": "keep-alive",
    }
    range_header = request.headers.get("Range")
    if range_header:
        hdrs["Range"] = range_header

    try:
        r = requests.get(video_url, headers=hdrs, stream=True, timeout=60)
        resp_headers = {
            "Content-Type": r.headers.get("Content-Type", "video/mp4"),
            "Accept-Ranges": "bytes",
            "Content-Disposition": f'attachment; filename="{platform}_video.mp4"',
        }
        if "Content-Length" in r.headers:
            resp_headers["Content-Length"] = r.headers["Content-Length"]
        if "Content-Range" in r.headers:
            resp_headers["Content-Range"] = r.headers["Content-Range"]

        return Response(
            r.iter_content(chunk_size=1024 * 1024),
            status=r.status_code,
            headers=resp_headers,
        )
    except Exception as e:
        print(f"[Proxy] error: {e}")
        return "Proxy error", 502


if __name__ == "__main__":
    print("Social server running: http://localhost:5001")
    app.run(debug=False, host="0.0.0.0", port=5001)
