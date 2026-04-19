from fastapi import FastAPI, HTTPException
from fastapi.responses import StreamingResponse
import yt_dlp
import asyncio
import httpx
import os
from typing import Optional

app = FastAPI(title="YouTube Hybrid Pro Engine V6.3")

MAX_CHUNK_SIZE = 1024 * 1024 * 2
CONCURRENCY = 12
TIMEOUT = httpx.Timeout(30.0, connect=30.0)

BASE_DIR = os.path.dirname(os.path.abspath(__file__))

# Use the large cookies file if available, else fallback
COOKIES_FILE = None
for name in ["cookies (1).txt", "cookies.txt"]:
    path = os.path.join(BASE_DIR, name)
    if os.path.exists(path) and os.path.getsize(path) > 1000:
        COOKIES_FILE = path
        break

YDL_BASE_OPTS = {
    'quiet': True,
    'no_warnings': True,
    'ignoreerrors': False,
    'no_playlist': True,
    'cookiefile': COOKIES_FILE,
    'http_headers': {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept-Language': 'en-US,en;q=0.9',
        'Referer': 'https://www.youtube.com/',
    },
    'extractor_args': {
        'youtube': {
            'player_client': ['android', 'ios', 'web', 'mweb', 'web_embedded'],
            'po_token': ['web+PO_TOKEN', 'ios+PO_TOKEN'] # Placeholder for future PO Token integration
        }
    }
}

from http.cookiejar import MozillaCookieJar

def get_cookie_header():
    if not COOKIES_FILE or not os.path.exists(COOKIES_FILE):
        return None
    try:
        cj = MozillaCookieJar(COOKIES_FILE)
        cj.load(ignore_discard=True, ignore_expires=True)
        cookie_list = []
        for cookie in cj:
            cookie_list.append(f"{cookie.name}={cookie.value}")
        return "; ".join(cookie_list)
    except Exception as e:
        print(f"[COOKIE ERROR] {str(e)}")
        return None

COOKIE_STR = get_cookie_header()

STREAM_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Accept": "*/*",
    "Accept-Language": "en-US,en;q=0.9",
    "Origin": "https://www.youtube.com",
    "Referer": "https://www.youtube.com/",
}
if COOKIE_STR:
    STREAM_HEADERS["Cookie"] = COOKIE_STR

FFMPEG_PATH = os.environ.get("FFMPEG_PATH", "ffmpeg")


class ExplodeEngine:
    @staticmethod
    async def get_info(url: str):
        # Merge formats to get both adaptive and progressive
        opts = {**YDL_BASE_OPTS, 'format': 'bestvideo+bestaudio/best'}

        def extract():
            with yt_dlp.YoutubeDL(opts) as ydl:
                return ydl.extract_info(url, download=False)

        try:
            info = await asyncio.to_thread(extract)
        except Exception as e:
            err_msg = str(e)
            if "Sign in to confirm you’re not a bot" in err_msg:
                raise Exception("BOT_DETECTION_TRIGGERED: YouTube is blocking this request. Try clearing cookies or updating the server.")
            if "Private video" in err_msg:
                raise Exception("This video is private.")
            if "Incomplete YouTube ID" in err_msg or "is not a valid URL" in err_msg:
                raise Exception("Invalid YouTube URL.")
            raise e

        if not info:
            raise Exception("Could not extract metadata.")

        formats = info.get("formats", [])

        audio_formats = [
            f for f in formats
            if f.get('vcodec') == 'none' and f.get('acodec') != 'none' and f.get('ext') == 'm4a'
        ]
        best_audio = sorted(audio_formats, key=lambda x: x.get('abr', 0) or 0, reverse=True)
        best_audio = best_audio[0] if best_audio else {}
        audio_size = best_audio.get('filesize') or best_audio.get('filesize_approx') or 0

        height_map = {}
        for f in formats:
            h = f.get("height")
            if not h or h <= 0 or f.get("vcodec") == "none":
                continue
            is_avc = "avc" in (f.get("vcodec") or "").lower()
            existing = height_map.get(h)
            if not existing:
                height_map[h] = f
            elif is_avc and "avc" not in (existing.get("vcodec") or "").lower():
                height_map[h] = f
            elif is_avc == ("avc" in (existing.get("vcodec") or "").lower()):
                if f.get("ext") == "mp4" and existing.get("ext") != "mp4":
                    height_map[h] = f

        formatted_formats = []
        for h in sorted(height_map.keys(), reverse=True):
            f = height_map[h]
            v_size = f.get('filesize') or f.get('filesize_approx') or 0
            formatted_formats.append({
                "height": h,
                "ext": "mp4",
                "size": (v_size + audio_size) if v_size else None,
                "fid": f.get("format_id")
            })

        return {
            "title": info.get("title", "YouTube Video"),
            "thumbnail": info.get("thumbnail", ""),
            "duration": info.get("duration_string", "0:00"),
            "formats": formatted_formats,
            "provider": "youtube"
        }


async def stream_simple(url: str):
    async with httpx.AsyncClient(timeout=TIMEOUT, follow_redirects=True) as client:
        try:
            async with client.stream("GET", url, headers=STREAM_HEADERS) as r:
                if r.status_code != 200:
                    print(f"[DOWNLOAD ERROR] Status {r.status_code} for single stream")
                async for chunk in r.aiter_bytes(65536):
                    yield chunk
        except Exception as e:
            print(f"[STREAM ERROR] {str(e)}")


async def stream_with_ffmpeg_merge(video_url: str, audio_url: str, title: str = "video"):
    hdrs_str = "".join(f"{k}: {v}\r\n" for k, v in STREAM_HEADERS.items())

    cmd = [
        FFMPEG_PATH, '-hide_banner', '-loglevel', 'error',
        '-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '5',
        '-headers', hdrs_str, '-i', video_url,
        '-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '5',
        '-headers', hdrs_str, '-i', audio_url,
        '-c:v', 'copy', '-c:a', 'aac', '-strict', 'experimental',
        '-map', '0:v:0', '-map', '1:a:0',
        '-f', 'mp4', '-movflags', 'frag_keyframe+empty_moov+default_base_moof',
        'pipe:1'
    ]

    print(f"[DEBUG] Starting ffmpeg merge for: {title}")
    
    proc = await asyncio.create_subprocess_exec(
        *cmd,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE
    )

    try:
        # Read stdout in chunks and yield to response
        while True:
            chunk = await proc.stdout.read(1024 * 1024)
            if not chunk:
                # Check for errors if stdout is empty immediately
                stderr_data = await proc.stderr.read()
                if stderr_data:
                    print(f"[FFMPEG ERROR] {stderr_data.decode().strip()}")
                break
            yield chunk
    except Exception as e:
        print(f"[STREAM ERROR] {str(e)}")
    finally:
        try:
            if proc.returncode is None:
                proc.terminate()
                await proc.wait()
        except Exception:
            pass


@app.get("/health")
async def health():
    return {"status": "healthy"}


@app.get("/info")
async def get_info(url: str):
    try:
        info = await ExplodeEngine.get_info(url)
        return info
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/download")
async def download(url: str, height: Optional[str] = None):
    try:
        h = int(height) if height else None
        if h:
            fmt = f'bestvideo[height<={h}][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height<={h}]+bestaudio/best[height<={h}]'
        else:
            fmt = 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/bestvideo+bestaudio/best'

        opts = {**YDL_BASE_OPTS, 'format': fmt}

        def get_urls():
            with yt_dlp.YoutubeDL(opts) as ydl:
                info = ydl.extract_info(url, download=False)
                if not info:
                    raise Exception("No info returned")
                if 'entries' in info:
                    info = info['entries'][0]
                title = info.get('title', 'video')
                if info.get('requested_formats'):
                    urls = [f['url'] for f in info['requested_formats']]
                    return urls, title
                return [info['url']], title

        urls, title = await asyncio.to_thread(get_urls)

        if not urls:
            raise HTTPException(status_code=404, detail="No streams found")

        safe_title = "".join(c for c in title if c.isalnum() or c in (' ', '-', '_')).strip() or "doomsdaysnap"

        # Two streams = separate video + audio → merge with ffmpeg
        if len(urls) >= 2:
            return StreamingResponse(
                stream_with_ffmpeg_merge(urls[0], urls[1], title),
                media_type="video/mp4",
                headers={
                    "Content-Disposition": f'attachment; filename="{safe_title}.mp4"',
                }
            )

        # Single stream
        return StreamingResponse(
            stream_simple(urls[0]),
            media_type="video/mp4",
            headers={
                "Content-Disposition": f'attachment; filename="{safe_title}.mp4"',
                "Accept-Ranges": "bytes"
            }
        )
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


if __name__ == "__main__":
    import uvicorn
    print(f"[YouTube Engine] Cookies: {COOKIES_FILE or 'None'}")
    uvicorn.run(app, host="0.0.0.0", port=5002)
