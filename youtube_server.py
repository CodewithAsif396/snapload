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
            'player_client': ['web', 'tv_embedded'],
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
        # Merge formats to get both adaptive and progressive (Exclude HLS/m3u8)
        opts = {**YDL_BASE_OPTS, 'format': '(bestvideo+bestaudio/best)[protocol^=http]'}

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

        # Fallback: progressive formats (Twitter/X, Instagram, etc.)
        if not formatted_formats:
            prog = [f for f in formats if f.get('vcodec') != 'none' and f.get('acodec') != 'none' and f.get('height')]
            prog = sorted(prog, key=lambda x: x.get('height', 0) or 0, reverse=True)
            seen_h = set()
            for f in prog:
                h = f.get('height')
                if h and h not in seen_h:
                    seen_h.add(h)
                    sz = f.get('filesize') or f.get('filesize_approx') or 0
                    formatted_formats.append({
                        "height": h,
                        "ext": f.get('ext', 'mp4'),
                        "size": sz or None,
                        "fid": f.get("format_id")
                    })

        provider = info.get("extractor_key", "youtube").lower()
        return {
            "title": info.get("title", ""),
            "thumbnail": info.get("thumbnail", ""),
            "duration": info.get("duration_string", "0:00"),
            "formats": formatted_formats,
            "provider": provider
        }




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


import tempfile
import glob as glob_mod

FFMPEG_LOCATION = os.environ.get("FFMPEG_PATH", None)  # set on VPS if ffmpeg not in PATH

async def download_and_stream(url: str, fmt: str, safe_title: str):
    """Download to temp file via yt-dlp, then stream to browser, then delete."""
    with tempfile.TemporaryDirectory() as tmpdir:
        out_tmpl = os.path.join(tmpdir, 'video.%(ext)s')

        opts = {
            **YDL_BASE_OPTS,
            'format': fmt,
            'outtmpl': out_tmpl,
            'merge_output_format': 'mp4',
            'postprocessors': [],
        }
        if FFMPEG_LOCATION:
            opts['ffmpeg_location'] = FFMPEG_LOCATION

        def do_download():
            with yt_dlp.YoutubeDL(opts) as ydl:
                ydl.download([url])

        print(f"[DOWNLOAD] Starting: {safe_title} | fmt={fmt}")
        try:
            await asyncio.to_thread(do_download)
        except Exception as e:
            print(f"[DOWNLOAD ERROR] {e}")
            raise

        # Find the output file
        files = glob_mod.glob(os.path.join(tmpdir, '*'))
        if not files:
            raise Exception("Download produced no output file")

        out_file = files[0]
        file_size = os.path.getsize(out_file)
        print(f"[DOWNLOAD] Done: {file_size // 1024 // 1024} MB → streaming")

        # Stream file to browser in chunks
        with open(out_file, 'rb') as f:
            while True:
                chunk = f.read(1024 * 1024)
                if not chunk:
                    break
                yield chunk


@app.get("/download")
async def download(url: str, height: Optional[str] = None, type: Optional[str] = None):
    try:
        # Support both ?height=1080 and ?type=1080 (frontend compat)
        raw = height or type
        is_audio = raw == 'audio'
        h = None if (not raw or is_audio) else int(raw)

        if is_audio:
            fmt = 'bestaudio/best'
        elif h:
            fmt = f'bestvideo[height<={h}][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height<={h}]+bestaudio/best[height<={h}]'
        else:
            fmt = 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/bestvideo+bestaudio/best'

        def get_title():
            with yt_dlp.YoutubeDL({**YDL_BASE_OPTS, 'quiet': True}) as ydl:
                info = ydl.extract_info(url, download=False)
                return (info or {}).get('title', 'video')

        title = await asyncio.to_thread(get_title)
        safe_title = "".join(c for c in title if c.isalnum() or c in (' ', '-', '_')).strip() or "doomsdaysnap"

        if is_audio:
            return StreamingResponse(
                download_and_stream(url, fmt, safe_title),
                media_type="audio/mpeg",
                headers={"Content-Disposition": f'attachment; filename="{safe_title}.mp3"'}
            )
        return StreamingResponse(
            download_and_stream(url, fmt, safe_title),
            media_type="video/mp4",
            headers={"Content-Disposition": f'attachment; filename="{safe_title}.mp4"'}
        )
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


if __name__ == "__main__":
    import uvicorn
    print(f"[YouTube Engine] Cookies: {COOKIES_FILE or 'None'}")
    uvicorn.run(app, host="0.0.0.0", port=5002)
