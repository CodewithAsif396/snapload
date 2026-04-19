import os
import asyncio
import traceback
from fastapi import FastAPI, HTTPException
from fastapi.responses import StreamingResponse, FileResponse
from fastapi.staticfiles import StaticFiles
import httpx
from engine import ExplodeEngine

# Fix for Windows asyncio loop with FFmpeg/Subprocesses
if os.name == 'nt':
    import sys
    import io
    # Force UTF-8 encoding for stdout/stderr to handle emojis if any remain
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')
    asyncio.set_event_loop_policy(asyncio.WindowsProactorEventLoopPolicy())

app = FastAPI(title="ExplodeDownloader V6 - Hybrid Pro")

def get_safe_filename(name: str, ext: str) -> str:
    """Sanitize filename and ensure header compatibility."""
    # Keep only alphanumeric, space, period, hyphen, underscore
    safe_name = "".join(c for c in name if c.isalnum() or c in (' ', '.', '-', '_')).strip()
    if not safe_name:
        safe_name = "video"
    return f"{safe_name}.{ext}"

# Point to your FFmpeg path
FFMPEG_PATH = r"C:\Users\asifk\AppData\Local\Microsoft\WinGet\Packages\Gyan.FFmpeg_Microsoft.WinGet.Source_8wekyb3d8bbwe\ffmpeg-8.1-full_build\bin\ffmpeg.exe"

# Mount Static Files
if os.path.exists("static"):
    app.mount("/static", StaticFiles(directory="static"), name="static")

@app.get("/")
async def index():
    return FileResponse("static/index.html")

@app.get("/health")
async def health():
    import time
    return {"status": "ok", "uptime": time.time()}

@app.get("/info")
async def get_info(url: str):
    """
    Hybrid Pro extraction: yt-dlp handshake + metadata mapping
    """
    try:
        data = await asyncio.to_thread(ExplodeEngine.get_info, url)
        if "error" in data:
            raise HTTPException(status_code=400, detail=data["error"])
        return data
    except HTTPException:
        raise
    except Exception as e:
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/download/video")
async def download_video(url: str, itag: str, t: str = "0"):
    """
    High-Speed UHD Merger: Uses yt-dlp extracted URLs with our Parallel Engine
    """
    try:
        print(f"[Video] Starting Hybrid Pro: {url} (ID: {itag}, Seek: {t}s)")
        info = await asyncio.to_thread(ExplodeEngine.get_info, url)
        if "error" in info:
            raise HTTPException(status_code=400, detail=info["error"])
        
        v_stream = next((s for s in info["video_streams"] if str(s["itag"]) == str(itag)), None)
        if not v_stream:
            raise HTTPException(status_code=404, detail="Selected video stream not found")
            
        a_stream = info["audio_streams"][0] if info["audio_streams"] else None
        
        v_url = v_stream["url"]
        # In yt-dlp based Hybrid, DASH streams are separated already
        a_url = a_stream["url"] if a_stream and v_stream.get("is_dash") else None
        
        filename = get_safe_filename(f"{info['title']}_{v_stream['resolution']}", "mp4")
        
        return StreamingResponse(
            pipe_media(v_url, a_url, start_time=t, v_size=v_stream.get("filesize", 0)),
            media_type="video/mp4",
            headers={
                "Content-Disposition": f'attachment; filename="{filename}"',
                "Accept-Ranges": "bytes"
            }
        )
    except HTTPException:
        raise
    except Exception as e:
        traceback.print_exc()
        print(f"[Error] Download Error: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/download/audio")
async def download_audio(url: str, itag: str, t: str = "0"):
    """
    High-Quality MP3 Extraction using Parallel Engine
    """
    try:
        print(f"[Audio] Starting Hybrid Pro: {url} (ID: {itag}, Seek: {t}s)")
        info = await asyncio.to_thread(ExplodeEngine.get_info, url)
        if "error" in info:
            raise HTTPException(status_code=400, detail=info["error"])
            
        a_stream = next((s for s in info["audio_streams"] if str(s["itag"]) == str(itag)), None)
        if not a_stream:
            raise HTTPException(status_code=404, detail="Audio stream not found")
            
        filename = get_safe_filename(info['title'], "mp3")
        
        return StreamingResponse(
            pipe_media(None, a_stream["url"], is_audio_only=True, start_time=t, a_size=a_stream.get("filesize", 0)),
            media_type="audio/mpeg",
            headers={
                "Content-Disposition": f'attachment; filename="{filename}"',
                "Accept-Ranges": "bytes"
            }
        )
    except HTTPException:
        raise
    except Exception as e:
        traceback.print_exc()
        print(f"[Error] Audio Download Error: {e}")
        raise HTTPException(status_code=500, detail=str(e))

async def download_stream_parallel(url: str, start_time="0", chunk_size=1024*1024, concurrency=12, total_size=0):
    """
    IDM-Style Parallel Chunk Downloader
    """
    headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        "Accept": "*/*",
        "Accept-Language": "en-US,en;q=0.9",
        "Connection": "keep-alive",
        "Origin": "https://www.youtube.com",
        "Referer": "https://www.youtube.com/",
        "Sec-Fetch-Dest": "video",
        "Sec-Fetch-Mode": "cors",
        "Sec-Fetch-Site": "cross-site",
    }
    
    async with httpx.AsyncClient(timeout=60, follow_redirects=True) as client:
        # Avoid the HEAD request if size is already known
        if total_size <= 0:
            try:
                print(f"[Debug] Attempting HEAD for size: {url[:60]}...")
                head = await client.head(url, headers=headers, timeout=3.0)
                total_size = int(head.headers.get("content-length", 0))
            except Exception as e:
                print(f"[Debug] HEAD failed or timed out: {e}")
                total_size = 0
        
        if total_size == 0:
            print("[Warning] Unknown size, falling back to sequential")
            async with client.stream("GET", url, headers=headers) as r:
                async for chunk in r.aiter_bytes():
                    yield chunk
            return

        print(f"[Speed] Parallel Download Initialized: {total_size // 1024 // 1024} MB ({concurrency} Threads)")

        queue = asyncio.Queue(maxsize=concurrency * 2)
        current_byte = 0
        
        async def worker(worker_client):
            nonlocal current_byte
            while current_byte < total_size:
                start = current_byte
                end = min(current_byte + chunk_size - 1, total_size - 1)
                idx = current_byte // chunk_size
                current_byte += chunk_size
                
                # Fetch Chunk
                range_header = {"Range": f"bytes={start}-{end}"}
                range_header.update(headers)
                try:
                    resp = await worker_client.get(url, headers=range_header, timeout=30)
                    await queue.put((idx, resp.content))
                except Exception as e:
                    print(f"[Error] Chunk {idx} failed: {e}")
                    await queue.put((idx, b""))

        # Reuse clients across workers
        async with httpx.AsyncClient(timeout=60, limits=httpx.Limits(max_connections=concurrency)) as worker_client:
            workers = [asyncio.create_task(worker(worker_client)) for _ in range(concurrency)]
            
            chunks = {}
            next_index = 0
            
            try:
                while next_index * chunk_size < total_size:
                    if next_index in chunks:
                        yield chunks.pop(next_index)
                        next_index += 1
                    else:
                        idx, data = await queue.get()
                        chunks[idx] = data
            finally:
                for w in workers:
                    w.cancel()

async def pipe_media(v_url: str, a_url: str, is_audio_only=False, start_time="0", v_size=0, a_size=0):
    """
    Optimized Async FFmpeg Piper
    """
    cmd = [FFMPEG_PATH, '-hide_banner', '-loglevel', 'error']
    
    if not is_audio_only:
        cmd.extend(['-i', 'pipe:0']) # Video from Parallel Engine (stdin)
        
        if a_url:
            # For audio, standard network input is usually fine
            headers_str = "User-Agent: Mozilla/5.0\r\n"
            cmd.extend(['-reconnect', '1', '-reconnect_streamed', '1', '-headers', headers_str, '-i', a_url])
            cmd.extend(['-c:v', 'copy', '-c:a', 'aac', '-map', '0:v:0', '-map', '1:a:0'])
        else:
            cmd.extend(['-c', 'copy'])
            
        cmd.extend(['-f', 'mp4', '-movflags', 'frag_keyframe+empty_moov+default_base_moof'])
    else:
        cmd.extend(['-i', 'pipe:0'])
        cmd.extend(['-vn', '-acodec', 'libmp3lame', '-q:a', '2', '-f', 'mp3'])

    cmd.append('pipe:1')

    process = await asyncio.create_subprocess_exec(
        *cmd,
        stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE
    )

    async def feed_input():
        target_url = v_url if v_url else a_url
        target_size = v_size if v_url else a_size
        try:
            print(f"[Debug] Feeding FFmpeg from: {target_url[:60]}...")
            async for chunk in download_stream_parallel(target_url, start_time=start_time, total_size=target_size):
                if not chunk: continue
                process.stdin.write(chunk)
                await process.stdin.drain()
            print("[Debug] Parallel Feed Complete")
            process.stdin.close()
        except Exception as e:
            print(f"[Error] Feed Input Failed: {e}")
            traceback.print_exc()
            try: process.stdin.close()
            except: pass

    input_task = asyncio.create_task(feed_input())

    try:
        while True:
            chunk = await process.stdout.read(1024 * 1024)
            if not chunk:
                break
            yield chunk
    finally:
        try:
            process.terminate()
            await process.wait()
        except:
            pass

if __name__ == "__main__":
    import uvicorn
    # V6.3 Port: 8088
    print("\n[HybridPro] Explode Engine V6.3 Starting on http://localhost:8088")
    uvicorn.run(app, host="0.0.0.0", port=8088)
