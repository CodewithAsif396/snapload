from fastapi import FastAPI, HTTPException
from fastapi.responses import StreamingResponse
import yt_dlp
import asyncio
import os
import tempfile
import glob as glob_mod
from typing import Optional

app = FastAPI(title="YouTube Engine V7")

BASE_DIR = os.path.dirname(os.path.abspath(__file__))

# Auto-detect cookies file
COOKIES_FILE = None
for name in ["cookies (1).txt", "cookies.txt"]:
    path = os.path.join(BASE_DIR, name)
    if os.path.exists(path) and os.path.getsize(path) > 1000:
        COOKIES_FILE = path
        break

YDL_BASE_OPTS = {
    'quiet': False,
    'no_warnings': False,
    'ignoreerrors': False,
    'no_playlist': True,
    'cookiefile': COOKIES_FILE,
    'http_headers': {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept-Language': 'en-US,en;q=0.9',
        'Referer': 'https://www.youtube.com/',
    }
}

FFMPEG_LOCATION = os.environ.get("FFMPEG_PATH", None)


@app.get("/health")
async def health():
    return {"status": "healthy"}


@app.get("/info")
async def get_info(url: str):
    def extract():
        # No format filter — get ALL formats for listing
        opts = {**YDL_BASE_OPTS}
        with yt_dlp.YoutubeDL(opts) as ydl:
            return ydl.extract_info(url, download=False)

    try:
        info = await asyncio.to_thread(extract)
    except Exception as e:
        err = str(e)
        print(f"[INFO ERROR] {err}")
        if "Sign in" in err or "bot" in err.lower():
            raise HTTPException(status_code=403, detail="YouTube bot detection. Update cookies.")
        if "Private video" in err:
            raise HTTPException(status_code=403, detail="This video is private.")
        raise HTTPException(status_code=500, detail=err)

    if not info:
        raise HTTPException(status_code=500, detail="Could not extract video info.")

    formats = info.get("formats", [])

    # Best audio (m4a or any)
    audio_formats = [f for f in formats if f.get('vcodec') == 'none' and f.get('acodec') != 'none']
    best_audio = sorted(audio_formats, key=lambda x: x.get('abr', 0) or 0, reverse=True)
    audio_size = (best_audio[0].get('filesize') or best_audio[0].get('filesize_approx') or 0) if best_audio else 0

    # Build height map — prefer avc/mp4, adaptive streams only
    height_map = {}
    for f in formats:
        h = f.get("height")
        if not h or h <= 0 or f.get("vcodec") == "none":
            continue
        existing = height_map.get(h)
        if not existing:
            height_map[h] = f
        else:
            # prefer avc over vp9/av1
            is_avc = "avc" in (f.get("vcodec") or "").lower()
            was_avc = "avc" in (existing.get("vcodec") or "").lower()
            if is_avc and not was_avc:
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

    # Fallback for non-YouTube (Twitter/Instagram — progressive streams)
    if not formatted_formats:
        prog = [f for f in formats if f.get('vcodec') != 'none' and f.get('acodec') != 'none' and f.get('height')]
        seen = set()
        for f in sorted(prog, key=lambda x: x.get('height', 0) or 0, reverse=True):
            h = f.get('height')
            if h and h not in seen:
                seen.add(h)
                formatted_formats.append({
                    "height": h,
                    "ext": f.get('ext', 'mp4'),
                    "size": f.get('filesize') or f.get('filesize_approx') or None,
                    "fid": f.get("format_id")
                })

    return {
        "title": info.get("title", ""),
        "thumbnail": info.get("thumbnail", ""),
        "duration": info.get("duration_string", "0:00"),
        "formats": formatted_formats,
        "provider": info.get("extractor_key", "youtube").lower()
    }


async def download_and_stream(url: str, fmt: str, safe_title: str):
    with tempfile.TemporaryDirectory() as tmpdir:
        out_tmpl = os.path.join(tmpdir, 'video.%(ext)s')

        opts = {
            **YDL_BASE_OPTS,
            'format': fmt,
            'outtmpl': out_tmpl,
            'merge_output_format': 'mp4',
        }
        if FFMPEG_LOCATION:
            opts['ffmpeg_location'] = FFMPEG_LOCATION

        def do_download():
            with yt_dlp.YoutubeDL(opts) as ydl:
                ydl.download([url])

        print(f"[DOWNLOAD] Start: {safe_title} | fmt={fmt}")
        try:
            await asyncio.to_thread(do_download)
        except Exception as e:
            print(f"[DOWNLOAD ERROR] {e}")
            raise

        files = glob_mod.glob(os.path.join(tmpdir, '*'))
        if not files:
            raise Exception("yt-dlp produced no output file")

        out_file = files[0]
        file_size = os.path.getsize(out_file)
        print(f"[DOWNLOAD] Done: {file_size // 1024 // 1024} MB, streaming...")

        with open(out_file, 'rb') as f:
            while True:
                chunk = f.read(1024 * 1024)
                if not chunk:
                    break
                yield chunk


@app.get("/download")
async def download(url: str, height: Optional[str] = None, type: Optional[str] = None):
    try:
        raw = height or type
        is_audio = raw == 'audio'
        h = None if (not raw or is_audio) else int(raw)

        if is_audio:
            fmt = 'bestaudio/best'
        elif h:
            fmt = f'bestvideo[height<={h}]+bestaudio/best'
        else:
            fmt = 'bestvideo+bestaudio/best'

        # Extract title without a format filter (fast)
        def get_title():
            opts = {**YDL_BASE_OPTS, 'skip_download': True}
            with yt_dlp.YoutubeDL(opts) as ydl:
                info = ydl.extract_info(url, download=False)
                return (info or {}).get('title', 'video')

        try:
            title = await asyncio.to_thread(get_title)
        except Exception:
            title = "video"

        safe_title = "".join(c for c in title if c.isalnum() or c in (' ', '-', '_')).strip() or "doomsdaysnap"

        media_type = "audio/mpeg" if is_audio else "video/mp4"
        ext = "mp3" if is_audio else "mp4"

        return StreamingResponse(
            download_and_stream(url, fmt, safe_title),
            media_type=media_type,
            headers={"Content-Disposition": f'attachment; filename="{safe_title}.{ext}"'}
        )
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


if __name__ == "__main__":
    import uvicorn
    print(f"[YouTube Engine V7] Cookies: {COOKIES_FILE or 'None'}")
    uvicorn.run(app, host="0.0.0.0", port=5002)
