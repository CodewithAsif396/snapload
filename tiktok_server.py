from flask import Flask, request, Response, jsonify, render_template_string
import requests
import json
import re

app = Flask(__name__)

HEADERS_BASE = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36",
    "Referer": "https://www.tiktok.com/",
}

MOBILE_HEADERS = {
    "User-Agent": "TikTok 26.2.0 rv:262018 (iPhone; iOS 14.4.2; en_US) Cronet",
    "Accept": "application/json",
}

HTML_PAGE = """
<!DOCTYPE html>
<html>
<head>
    <title>TikTok Original Downloader</title>
    <style>
        body { font-family: Arial, sans-serif; max-width: 700px; margin: 60px auto; padding: 0 20px; background: #111; color: #fff; }
        h1 { color: #fe2c55; }
        input[type=text] { width: 100%; padding: 12px; font-size: 15px; border-radius: 6px; border: none; margin-bottom: 10px; }
        button { background: #fe2c55; color: #fff; border: none; padding: 12px 30px; font-size: 15px; border-radius: 6px; cursor: pointer; }
        button:hover { background: #cc0033; }
        #result { margin-top: 30px; }
        .video-box { background: #222; border-radius: 10px; padding: 20px; }
        .video-box img { max-height: 120px; border-radius: 8px; }
        .btn-dl { display: inline-block; margin-top: 15px; background: #25d366; color: #fff; padding: 10px 25px; border-radius: 6px; text-decoration: none; font-weight: bold; }
        .error { color: #ff6b6b; background: #2a1010; padding: 15px; border-radius: 6px; }
        .loading { color: #aaa; font-style: italic; }
        label { font-size: 13px; color: #aaa; }
    </style>
</head>
<body>
    <h1>TikTok Original Downloader</h1>
    <p style="color:#aaa;">No watermark · Original source quality</p>

    <input type="text" id="urlInput" placeholder="https://www.tiktok.com/@xxx/video/xxx" />
    <br>
    <label>Session ID (optional — for private videos):</label><br>
    <input type="text" id="sessionInput" placeholder="your tiktok sessionid cookie" style="margin-top:5px;" />
    <br><br>
    <button onclick="download()">Get Video</button>

    <div id="result"></div>

    <script>
        async function download() {
            const url = document.getElementById('urlInput').value.trim();
            const session = document.getElementById('sessionInput').value.trim();
            if (!url) { document.getElementById('result').innerHTML = '<p class="error">URL daalo pehle!</p>'; return; }

            document.getElementById('result').innerHTML = '<p class="loading">Fetching video info... please wait</p>';

            const res = await fetch('/get_video', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ url, session_id: session })
            });
            const data = await res.json();

            if (data.error) {
                document.getElementById('result').innerHTML = '<p class="error">Error: ' + data.error + '</p>';
                return;
            }

            document.getElementById('result').innerHTML = `
                <div class="video-box">
                    <img src="${data.cover}" alt="cover">
                    <h3>${data.title}</h3>
                    <p style="color:#aaa;">@${data.author} &nbsp;|&nbsp; Size: ${data.size_mb} MB &nbsp;|&nbsp; Quality: ${data.quality}</p>
                    <a class="btn-dl" href="/proxy?url=${encodeURIComponent(data.video_url)}&session=${encodeURIComponent(data.session_id || '')}" target="_blank">
                        Download Original MP4
                    </a>
                </div>
            `;
        }
    </script>
</body>
</html>
"""

def extract_video_id(tiktok_url):
    match = re.search(r'/video/(\d+)', tiktok_url)
    return match.group(1) if match else None


def fetch_via_tikwm(tiktok_url, session_id=""):
    # Step 1: Submit task
    headers = {"x-proxy-cookie": f"sessionid={session_id}" if session_id else ""}
    r = requests.post(
        "https://www.tikwm.com/api/video/task/submit",
        data={"url": tiktok_url, "web": 1},
        headers=headers,
        timeout=15
    )
    data = r.json()
    if data.get("code") != 0:
        return None

    task_id = data["data"]["task_id"]

    # Step 2: Poll for result
    import time
    for _ in range(15):
        time.sleep(2)
        r2 = requests.get(
            f"https://www.tikwm.com/api/video/task/result?task_id={task_id}",
            timeout=15
        )
        res = r2.json()
        if res.get("code") == 0:
            status = res["data"]["status"]
            if status == 2:
                detail = res["data"]["detail"]
                return {
                    "video_url": detail.get("play_url") or detail.get("download_url"),
                    "cover": detail.get("cover", ""),
                    "title": detail.get("title", "No title")[:80],
                    "author": detail.get("author", {}).get("unique_id", "unknown"),
                    "quality": "Original",
                    "size_mb": round(detail.get("size", 0) / 1024 / 1024, 2),
                    "session_id": session_id,
                }
            elif status == 3:
                return None
    return None


def fetch_tiktok_data(tiktok_url, session_id=""):
    video_id = extract_video_id(tiktok_url)
    if not video_id:
        return None, "Valid TikTok URL nahi hai"

    # Try TikWM for original quality
    try:
        result = fetch_via_tikwm(tiktok_url, session_id)
        if result and result.get("video_url"):
            return result, None
    except Exception:
        pass

    # Fallback: web page scraping
    headers = dict(HEADERS_BASE)
    if session_id:
        headers["Cookie"] = f"sessionid={session_id}"

    resp = requests.get(tiktok_url, headers=headers, allow_redirects=True, timeout=15)
    match = re.search(
        r'<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__"[^>]*>(.*?)</script>',
        resp.text, re.DOTALL
    )
    if not match:
        return None, "TikTok page data nahi mila"

    data = json.loads(match.group(1))
    scope = data.get("__DEFAULT_SCOPE__", {})
    item = (scope.get("webapp.video-detail", {}).get("itemInfo", {}).get("itemStruct")
            or (scope.get("webapp.updated-items") or [None])[0])

    if not item:
        return None, "Video info nahi mili"

    video = item.get("video", {})
    bitrate_info = video.get("bitrateInfo", [])
    if bitrate_info:
        best = sorted(bitrate_info, key=lambda x: x.get("Bitrate", 0), reverse=True)[0]
        video_url = best["PlayAddr"]["UrlList"][0]
        size_bytes = best.get("PlayAddr", {}).get("DataSize", 0)
        quality = f"{best.get('Bitrate', 0) // 1000}kbps"
    else:
        video_url = video.get("playAddr") or video.get("downloadAddr", "")
        size_bytes = 0
        quality = "standard"

    author = item.get("author", {})
    return {
        "video_url": video_url,
        "cover": video.get("cover", ""),
        "title": item.get("desc", "No title")[:80],
        "author": author.get("uniqueId", "unknown"),
        "quality": quality,
        "size_mb": round(int(size_bytes) / 1024 / 1024, 2) if size_bytes else "?",
        "session_id": session_id,
    }, None


@app.route("/")
def index():
    return render_template_string(HTML_PAGE)


@app.route("/get_video", methods=["POST"])
def get_video():
    body = request.get_json()
    tiktok_url = body.get("url", "")
    session_id = body.get("session_id", "")

    if not tiktok_url:
        return jsonify({"error": "URL missing"})

    result, err = fetch_tiktok_data(tiktok_url, session_id)
    if err:
        return jsonify({"error": err})

    return jsonify(result)


@app.route("/proxy")
def proxy():
    video_url = request.args.get("url", "")
    session_id = request.args.get("session", "")

    if not video_url:
        return "URL missing", 400

    headers = dict(HEADERS_BASE)
    headers["Range"] = request.headers.get("Range", "bytes=0-")
    if session_id:
        headers["Cookie"] = f"sessionid={session_id}"

    r = requests.get(video_url, headers=headers, stream=True, timeout=30)

    return Response(
        r.iter_content(chunk_size=1024 * 64),
        status=r.status_code,
        headers={
            "Content-Type": "video/mp4",
            "Content-Disposition": "attachment; filename=tiktok_original.mp4",
            "Content-Length": r.headers.get("Content-Length", ""),
            "Accept-Ranges": "bytes",
        }
    )


if __name__ == "__main__":
    print("Server chal raha hai: http://localhost:5000")
    app.run(debug=False, host="0.0.0.0", port=5000)
