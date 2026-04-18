from flask import Flask, request, Response, jsonify
import requests
import re
import json

app = Flask(__name__)

HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36",
}

# ─── FACEBOOK ────────────────────────────────────────────────────────────────

def fetch_facebook(url):
    """Extract Facebook video URL directly from page HTML"""
    try:
        clean_url = url.replace("m.facebook.com", "www.facebook.com")
        r = requests.get(
            clean_url,
            headers={
                **HEADERS,
                "Accept-Language": "en-US,en;q=0.9",
                "Sec-Fetch-Site": "none",
                "Sec-Fetch-Mode": "navigate",
            },
            timeout=20
        )
        html = r.text

        # Try HD first
        hd = re.search(r'"hd_src_no_ratelimit"\s*:\s*"([^"]+)"', html)
        if not hd:
            hd = re.search(r'"hd_src"\s*:\s*"([^"]+)"', html)
        sd = re.search(r'"sd_src_no_ratelimit"\s*:\s*"([^"]+)"', html)
        if not sd:
            sd = re.search(r'"sd_src"\s*:\s*"([^"]+)"', html)

        match = hd or sd
        if match:
            video_url = match.group(1).replace("\\u0026", "&").replace("\\/", "/")
            quality = "HD" if hd else "SD"
            print(f"[Facebook] Found {quality} URL from page")
            return {"video_url": video_url, "title": "Facebook Video", "platform": "facebook"}

    except Exception as e:
        print(f"[Facebook] page scrape error: {e}")

    # Fallback: fdown.net
    try:
        r = requests.post(
            "https://fdown.net/download.php",
            data={"URLz": url},
            headers={**HEADERS, "Referer": "https://fdown.net/"},
            timeout=15
        )
        html = r.text
        hd = re.search(r'href="(https://[^"]+\.mp4[^"]*)"[^>]*>\s*HD', html, re.IGNORECASE)
        sd = re.search(r'href="(https://[^"]+\.mp4[^"]*)"[^>]*>\s*SD', html, re.IGNORECASE)
        match = hd or sd
        if match:
            print("[Facebook] fdown.net success")
            return {"video_url": match.group(1), "title": "Facebook Video", "platform": "facebook"}
    except Exception as e:
        print(f"[Facebook] fdown.net error: {e}")

    # Fallback 2: savefrom.net worker
    try:
        r = requests.get(
            f"https://worker.sf-tools.com/savefrom.php?sf_url={requests.utils.quote(url)}&new=1",
            headers={**HEADERS, "Referer": "https://en.savefrom.net/"},
            timeout=15
        )
        data = r.json()
        links = data.get("url", [])
        if links:
            best = sorted(links, key=lambda x: int(x.get("id", 0)), reverse=True)
            video_url = best[0].get("url", "")
            if video_url:
                print("[Facebook] savefrom success")
                return {"video_url": video_url, "title": data.get("meta", {}).get("title", "Facebook Video"), "platform": "facebook"}
    except Exception as e:
        print(f"[Facebook] savefrom error: {e}")

    return None


# ─── SNAPCHAT ────────────────────────────────────────────────────────────────

def fetch_snapchat(url):
    """Direct Snapchat page scrape — no watermark"""
    try:
        r = requests.get(
            url,
            headers={
                **HEADERS,
                "Referer": "https://www.snapchat.com/",
                "Accept-Language": "en-US,en;q=0.9",
            },
            allow_redirects=True,
            timeout=20
        )
        html = r.text

        # Method 1: playbackUrl in page JSON
        match = re.search(r'"playbackUrl"\s*:\s*"(https://[^"]+)"', html)
        if match:
            video_url = match.group(1).replace("\\u0026", "&")
            print("[Snapchat] Found via playbackUrl")
            return {"video_url": video_url, "title": "Snapchat Video", "platform": "snapchat"}

        # Method 2: snapchat CDN URL pattern
        match = re.search(r'(https://cf-st\.sc-cdn\.net/[^"\'>\s]+\.mp4[^"\'>\s]*)', html)
        if match:
            video_url = match.group(1).replace("\\u0026", "&")
            print("[Snapchat] Found via sc-cdn.net")
            return {"video_url": video_url, "title": "Snapchat Video", "platform": "snapchat"}

        # Method 3: extract from JSON-LD or __NEXT_DATA__
        next_data = re.search(r'<script id="__NEXT_DATA__"[^>]*>(.*?)</script>', html, re.DOTALL)
        if next_data:
            try:
                data = json.loads(next_data.group(1))
                # Walk the JSON looking for video URLs
                text = json.dumps(data)
                cdn = re.search(r'(https://cf-st\.sc-cdn\.net/[^"\\]+\.mp4)', text)
                if cdn:
                    video_url = cdn.group(1)
                    print("[Snapchat] Found via __NEXT_DATA__")
                    return {"video_url": video_url, "title": "Snapchat Video", "platform": "snapchat"}
            except Exception:
                pass

        # Method 4: any .mp4 from snapchat CDN
        match = re.search(r'"(https://[^"]*sc-cdn\.net[^"]+\.mp4[^"]*)"', html)
        if match:
            video_url = match.group(1).replace("\\u0026", "&").replace("\\/", "/")
            print("[Snapchat] Found via sc-cdn fallback")
            return {"video_url": video_url, "title": "Snapchat Video", "platform": "snapchat"}

    except Exception as e:
        print(f"[Snapchat] scrape error: {e}")

    return None


# ─── PROXY ───────────────────────────────────────────────────────────────────

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
    platform  = request.args.get("platform", "")
    if not video_url:
        return "URL missing", 400

    referers = {
        "facebook":  "https://www.facebook.com/",
        "snapchat":  "https://www.snapchat.com/",
    }
    hdrs = {
        **HEADERS,
        "Referer": referers.get(platform, "https://www.google.com/"),
        "Range": request.headers.get("Range", "bytes=0-"),
    }

    r = requests.get(video_url, headers=hdrs, stream=True, timeout=30)
    return Response(
        r.iter_content(chunk_size=1024 * 64),
        status=r.status_code,
        headers={
            "Content-Type": "video/mp4",
            "Content-Disposition": f"attachment; filename={platform}_video.mp4",
            "Content-Length": r.headers.get("Content-Length", ""),
            "Accept-Ranges": "bytes",
        }
    )


if __name__ == "__main__":
    print("Social server running: http://localhost:5001")
    app.run(debug=False, host="0.0.0.0", port=5001)
