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
    clean = url.replace("m.facebook.com", "www.facebook.com")

    # ── Method 1: snapsave.app (most reliable for public FB videos) ──────────
    try:
        r = requests.post(
            "https://snapsave.app/action.php",
            data={"url": url},
            headers={
                **BROWSER_HEADERS,
                "Referer": "https://snapsave.app/",
                "Origin": "https://snapsave.app",
                "Content-Type": "application/x-www-form-urlencoded",
            },
            timeout=20,
            allow_redirects=True,
        )
        html = r.text
        # snapsave returns links in <a href="..."> with HD/SD labels
        links = re.findall(r'href="(https://[^"]+\.mp4[^"]*)"', html, re.IGNORECASE)
        if not links:
            links = re.findall(r'href="(https://[^"]+fbcdn[^"]*)"', html, re.IGNORECASE)
        if links:
            video_url = fix_url(links[0])
            print("[Facebook] snapsave.app success")
            return {"video_url": video_url, "title": "Facebook Video", "platform": "facebook"}
    except Exception as e:
        print(f"[Facebook] snapsave error: {e}")

    # ── Method 2: fdownloader.net API ────────────────────────────────────────
    try:
        r = requests.post(
            "https://fdownloader.net/api/ajaxSearch",
            data={"q": url, "lang": "en", "v": "a2"},
            headers={
                **BROWSER_HEADERS,
                "Referer": "https://fdownloader.net/",
                "Origin": "https://fdownloader.net",
                "Content-Type": "application/x-www-form-urlencoded",
                "X-Requested-With": "XMLHttpRequest",
            },
            timeout=20,
        )
        data = r.json()
        html_data = data.get("data", "")
        links = re.findall(r'href="(https://[^"]+\.mp4[^"]*)"', html_data, re.IGNORECASE)
        if not links:
            links = re.findall(r'href="(https://[^"]+fbcdn[^"]*)"', html_data, re.IGNORECASE)
        if links:
            video_url = fix_url(links[0])
            print("[Facebook] fdownloader.net success")
            return {"video_url": video_url, "title": "Facebook Video", "platform": "facebook"}
    except Exception as e:
        print(f"[Facebook] fdownloader.net error: {e}")

    # ── Method 3: Direct page scrape (many patterns) ─────────────────────────
    try:
        r = requests.get(clean, headers=BROWSER_HEADERS, timeout=20, allow_redirects=True)
        html = r.text
        patterns = [
            r'"hd_src_no_ratelimit"\s*:\s*"([^"]+)"',
            r'"hd_src"\s*:\s*"([^"]+)"',
            r'"browser_native_hd_url"\s*:\s*"([^"]+)"',
            r'"browser_native_sd_url"\s*:\s*"([^"]+)"',
            r'"playable_url_quality_hd"\s*:\s*"([^"]+)"',
            r'"playable_url"\s*:\s*"([^"]+)"',
            r'"sd_src_no_ratelimit"\s*:\s*"([^"]+)"',
            r'"sd_src"\s*:\s*"([^"]+)"',
        ]
        for pat in patterns:
            m = re.search(pat, html)
            if m:
                video_url = fix_url(m.group(1))
                if ("fbcdn" in video_url or "fna.fbcdn" in video_url or ".mp4" in video_url) and len(video_url) > 30:
                    print(f"[Facebook] page scrape success: {pat[:30]}")
                    return {"video_url": video_url, "title": "Facebook Video", "platform": "facebook"}
    except Exception as e:
        print(f"[Facebook] page scrape error: {e}")

    # ── Method 4: fdown.net ──────────────────────────────────────────────────
    try:
        r = requests.post(
            "https://fdown.net/download.php",
            data={"URLz": url},
            headers={**BROWSER_HEADERS, "Referer": "https://fdown.net/"},
            timeout=15,
        )
        html = r.text
        hd = re.search(r'href="(https://[^"]+\.mp4[^"]*)"[^>]*>\s*HD', html, re.IGNORECASE)
        sd = re.search(r'href="(https://[^"]+\.mp4[^"]*)"[^>]*>\s*SD', html, re.IGNORECASE)
        m = hd or sd
        if m:
            print("[Facebook] fdown.net success")
            return {"video_url": m.group(1), "title": "Facebook Video", "platform": "facebook"}
    except Exception as e:
        print(f"[Facebook] fdown.net error: {e}")

    # ── Method 5: savefrom.net worker ────────────────────────────────────────
    try:
        r = requests.get(
            f"https://worker.sf-tools.com/savefrom.php?sf_url={requests.utils.quote(url)}&new=1",
            headers={**BROWSER_HEADERS, "Referer": "https://en.savefrom.net/"},
            timeout=15,
        )
        data = r.json()
        links = data.get("url", [])
        if links:
            best = sorted(links, key=lambda x: int(x.get("id", 0) or 0), reverse=True)
            video_url = best[0].get("url", "")
            if video_url:
                print("[Facebook] savefrom.net success")
                return {"video_url": video_url, "title": data.get("meta", {}).get("title", "Facebook Video"), "platform": "facebook"}
    except Exception as e:
        print(f"[Facebook] savefrom error: {e}")

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
