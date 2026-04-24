import os
import json
import yt_dlp

PROJECT_DIR = os.path.dirname(os.path.abspath(__file__))

PLAYER_CLIENTS = [
    ['tvhtml5_embedded'],
    ['android_vr'],
    ['ios', 'android'],
    ['android'],
    ['web_embedded'],
    ['web', 'mweb'],
]


def find_cookie_file():
    """Dynamically find the best cookie file, picking the largest available one."""
    search_dirs = [
        os.path.join(PROJECT_DIR, "ads-backend", "data"),
        PROJECT_DIR
    ]
    
    potential_files = []
    for directory in search_dirs:
        if not os.path.exists(directory):
            continue
        try:
            for name in os.listdir(directory):
                if name.endswith(".txt") and "cookie" in name.lower():
                    path = os.path.join(directory, name)
                    if os.path.isfile(path):
                        potential_files.append(path)
        except:
            continue

    # Filter by minimum size (ensure it's not empty)
    valid_files = [f for f in potential_files if os.path.getsize(f) > 500]
    if not valid_files:
        return None
        
    # Pick the largest file - usually the most complete one
    valid_files.sort(key=lambda x: os.path.getsize(x), reverse=True)
    return valid_files[0]


class ExplodeEngine:
    """
    Hybrid Pro Engine V2: cookie support + player client rotation.
    Reads cookies fresh from disk on every call.
    """

    @staticmethod
    def get_info(url: str):
        print(f"[HybridPro] Extracting: {url}")
        last_err = None

        for clients in PLAYER_CLIENTS:
            opts = {
                'quiet': True,
                'no_warnings': True,
                'extract_flat': False,
                'cookiefile': find_cookie_file(),
                'http_headers': {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
                    'Accept-Language': 'en-US,en;q=0.9',
                    'Origin': 'https://www.youtube.com',
                    'Referer': 'https://www.youtube.com/',
                },
                'extractor_args': {'youtube': {'player_client': clients}},
            }

            try:
                with yt_dlp.YoutubeDL(opts) as ydl:
                    info = ydl.extract_info(url, download=False)

                if not info:
                    continue

                formats = info.get('formats', [])
                video_streams = []
                audio_streams = []

                for f in formats:
                    vcodec = f.get('vcodec', 'none')
                    acodec = f.get('acodec', 'none')
                    ext = f.get('ext', '')
                    filesize = f.get('filesize') or f.get('filesize_approx') or 0

                    if vcodec != 'none' and acodec == 'none':
                        video_streams.append({
                            "itag": f.get('format_id'),
                            "resolution": f"{f.get('height')}p" if f.get('height') else "0p",
                            "ext": ext,
                            "url": f.get('url'),
                            "is_dash": True,
                            "filesize": filesize,
                            "fps": f.get('fps', 30)
                        })
                    elif acodec != 'none' and vcodec == 'none':
                        audio_streams.append({
                            "itag": f.get('format_id'),
                            "ext": ext,
                            "url": f.get('url'),
                            "bitrate": f"{int(f.get('abr', 0))}kbps" if f.get('abr') else "0kbps",
                            "filesize": filesize
                        })

                def get_res(v):
                    try: return int(v["resolution"].replace("p", ""))
                    except: return 0

                video_streams.sort(key=lambda x: (get_res(x), x.get("fps", 0)), reverse=True)
                seen = set()
                final_v = []
                for v in video_streams:
                    if v["resolution"] not in seen:
                        final_v.append(v)
                        seen.add(v["resolution"])

                def get_abr(a):
                    try: return int(a["bitrate"].replace("kbps", "").strip())
                    except: return 0

                audio_streams.sort(key=get_abr, reverse=True)

                print(f"[HybridPro] OK with {clients} | cookies: {find_cookie_file() or 'NONE'}")
                return {
                    "title": info.get('title', 'Unknown Title'),
                    "thumbnail": info.get('thumbnail', ''),
                    "duration": info.get('duration', 0),
                    "view_count": info.get('view_count', 0),
                    "uploader": info.get('uploader', 'Unknown'),
                    "video_streams": final_v,
                    "audio_streams": audio_streams,
                    "engine": "HYBRID_PRO_V2"
                }

            except Exception as e:
                last_err = e
                err_str = str(e).lower()
                if "private video" in err_str or "invalid youtube url" in err_str:
                    return {"error": str(e)}
                print(f"[HybridPro] {clients} failed: {str(e)[:100]}")
                continue

        err_msg = str(last_err) if last_err else "All clients failed"
        return {"error": err_msg}


if __name__ == "__main__":
    test_url = "https://www.youtube.com/watch?v=BaW_jenozKc"
    print(json.dumps(ExplodeEngine.get_info(test_url), indent=2))
