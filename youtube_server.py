from fastapi import FastAPI, HTTPException
from fastapi.responses import StreamingResponse, RedirectResponse
import yt_dlp
import asyncio
import os
import tempfile
import glob as glob_mod
from typing import Optional

app = FastAPI(title="YouTube Engine V7")

BASE_DIR = os.path.dirname(os.path.abspath(__file__))

def get_cookies_file():
    """Dynamically look for the best cookies file available."""
    for name in ["cookies_youtube.txt", "cookies (1).txt", "cookies.txt"]:
        path = os.path.join(BASE_DIR, name)
        if os.path.exists(path) and os.path.getsize(path) > 100:
            return path
    return None

def get_ydl_opts(extra=None):
    """Generate yt-dlp options with the latest cookie path."""
    opts = {
        'quiet': False,
        'no_warnings': False,
        'ignoreerrors': False,
        'no_playlist': True,
        'cookiefile': get_cookies_file(),
        'http_headers': {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
            'Accept-Language': 'en-US,en;q=0.9',
            'Referer': 'https://www.youtube.com/',
        }
    }
    if extra:
        opts.update(extra)
    return opts

FFMPEG_LOCATION = os.environ.get("FFMPEG_PATH", None)


@app.get("/health")
async def health():
    return {"status": "healthy"}


@app.get("/info")
async def get_info(url: str):
    def extract():
        # No format filter — get ALL formats for listing
        opts = get_ydl_opts()
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
    best_audio_stream = best_audio[0] if best_audio else None
    audio_size = (best_audio_stream.get('filesize') or best_audio_stream.get('filesize_approx') or 0) if best_audio_stream else 0
    audio_url = best_audio_stream.get('url') if best_audio_stream else None

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
        is_progressive = f.get('acodec') != 'none' and f.get('vcodec') != 'none'
        
        entry = {
            "height": h,
            "ext": "mp4",
            "size": (v_size + audio_size) if (v_size and not is_progressive) else (v_size or None),
            "fid": f.get("format_id"),
            "progressive": is_progressive
        }
        if is_progressive:
            entry["url"] = f.get("url")
        else:
            entry["video_url"] = f.get("url")
            entry["audio_url"] = audio_url
            
        formatted_formats.append(entry)

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
                    "fid": f.get("format_id"),
                    "progressive": True,
                    "url": f.get("url")
                })

    return {
        "title": info.get("title", ""),
        "thumbnail": info.get("thumbnail", ""),
        "duration": info.get("duration_string", "0:00"),
        "formats": formatted_formats,
        "provider": info.get("extractor_key", "youtube").lower()
    }


async def download_and_stream(url: str, fmt: str, safe_title: str, is_audio: bool = False):
    with tempfile.TemporaryDirectory() as tmpdir:
        out_tmpl = os.path.join(tmpdir, 'video.%(ext)s')

        opts = get_ydl_opts({
            'format': fmt,
            'outtmpl': out_tmpl,
        })
        
        if is_audio:
            opts['postprocessors'] = [{
                'key': 'FFmpegExtractAudio',
                'preferredcodec': 'mp3',
                'preferredquality': '192',
            }]
        else:
            opts['merge_output_format'] = 'mp4'

        if FFMPEG_LOCATION:
            opts['ffmpeg_location'] = FFMPEG_LOCATION

        def do_download():
            with yt_dlp.YoutubeDL(opts) as ydl:
                ydl.download([url])

        print(f"[DOWNLOAD] Start: {safe_title} | fmt={fmt} | audio={is_audio}")
        try:
            await asyncio.to_thread(do_download)
        except Exception as e:
            print(f"[DOWNLOAD ERROR] {e}")
            raise

        # Find the output file
        out_file = None
        # Order matters: check mp3 first for audio
        exts = ['mp3', 'mp4', 'm4a', 'webm', 'mkv'] if is_audio else ['mp4', 'mkv', 'webm', 'm4a', 'mp3']
        for ext in exts:
            p = os.path.join(tmpdir, f'video.{ext}')
            if os.path.exists(p):
                out_file = p
                break
        
        if not out_file:
            all_files = [f for f in glob_mod.glob(os.path.join(tmpdir, '*')) if not f.endswith('.part')]
            if all_files:
                out_file = sorted(all_files, key=os.path.getsize, reverse=True)[0]

        if not out_file:
            raise Exception("yt-dlp produced no usable output file")

        file_size = os.path.getsize(out_file)
        print(f"[DOWNLOAD] Final File: {os.path.basename(out_file)} | Size: {file_size // 1024 // 1024} MB")

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

        # For optimization, we try to see if it's a progressive stream that can be redirected
        def get_format_info():
            opts = get_ydl_opts({'skip_download': True, 'format': fmt})
            with yt_dlp.YoutubeDL(opts) as ydl:
                info = ydl.extract_info(url, download=False)
                requested_formats = info.get('requested_formats')
                if not requested_formats and info.get('url'):
                    return info
                if requested_formats and len(requested_formats) == 1:
                    return requested_formats[0]
                return info

        try:
            # FORCE DOWNLOAD ON VPS FOR AUDIO (to allow MP3 conversion)
            if is_audio:
                title = "audio" 
                direct_url = None
            else:
                f_info = await asyncio.to_thread(get_format_info)
                title = f_info.get('title') or "video"
                direct_url = f_info.get('url')
            
            # If it's a video and has a direct URL, REDIRECT to save VPS resources
            if not is_audio and direct_url and "manifest" not in direct_url:
                print(f"[DOWNLOAD] Redirecting to CDN: {title[:50]}...")
                return RedirectResponse(url=direct_url)
        except Exception as e:
            print(f"[DOWNLOAD INFO ERROR] {e}")
            title = "video"

        safe_title = "".join(c for c in title if c.isalnum() or c in (' ', '-', '_')).strip() or "doomsdaysnap"
        media_type = "audio/mpeg" if is_audio else "video/mp4"
        ext = "mp3" if is_audio else "mp4"

        print(f"[DOWNLOAD] Falling back to VPS stream for: {safe_title}")
        return StreamingResponse(
            download_and_stream(url, fmt, safe_title, is_audio=is_audio),
            media_type=media_type,
            headers={"Content-Disposition": f'attachment; filename="{safe_title}.{ext}"'}
        )
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


if __name__ == "__main__":
    import uvicorn
    print(f"[YouTube Engine V7] Dynamic Cookie Detection Active.")
    uvicorn.run(app, host="0.0.0.0", port=5002)
