import json
import traceback
import yt_dlp

class ExplodeEngine:
    """
    Hybrid Pro Engine: Uses yt-dlp for robust metadata extraction
    to bypass signature errors (400/500/RegexMatchError).
    """
    
    @staticmethod
    def get_info(url: str):
        print(f"[HybridPro] Handshaking: {url}")
        try:
            ydl_opts = {
                'quiet': True,
                'no_warnings': True,
                'extract_flat': False,
                'extractor_args': {
                    'youtube': {
                        'player_client': ['android', 'ios', 'web', 'mweb', 'web_embedded'],
                    }
                }
            }
            
            with yt_dlp.YoutubeDL(ydl_opts) as ydl:
                info = ydl.extract_info(url, download=False)
                
                video_streams = []
                audio_streams = []
                
                formats = info.get('formats', [])
                for f in formats:
                    # Filter for DASH adaptive streams (Video only or Audio only)
                    vcodec = f.get('vcodec', 'none')
                    acodec = f.get('acodec', 'none')
                    ext = f.get('ext', '')
                    filesize = f.get('filesize') or f.get('filesize_approx') or 0
                    
                    if vcodec != 'none' and acodec == 'none':
                        # Video-only (DASH)
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
                        # Audio-only (DASH)
                        audio_streams.append({
                            "itag": f.get('format_id'),
                            "ext": ext,
                            "url": f.get('url'),
                            "bitrate": f"{int(f.get('abr', 0))}kbps" if f.get('abr') else "0kbps",
                            "filesize": filesize
                        })
                
                # Robust Sorting for Video
                def get_res_val(v):
                    res_str = v["resolution"].replace("p", "")
                    try: return int(res_str)
                    except: return 0

                video_streams.sort(key=lambda x: (get_res_val(x), x.get("fps", 0)), reverse=True)
                
                seen_res = set()
                final_v = []
                for v in video_streams:
                    if v["resolution"] not in seen_res:
                        final_v.append(v)
                        seen_res.add(v["resolution"])

                # Robust Sorting for Audio
                def get_bitrate_val(a):
                    bitrate_str = a["bitrate"].replace("kbps", "").strip()
                    try: return int(bitrate_str)
                    except: return 0

                audio_streams.sort(key=get_bitrate_val, reverse=True)

                return {
                    "title": info.get('title', 'Unknown Title'),
                    "thumbnail": info.get('thumbnail', ''),
                    "duration": info.get('duration', 0),
                    "view_count": info.get('view_count', 0),
                    "uploader": info.get('uploader', 'Unknown'),
                    "video_streams": final_v,
                    "audio_streams": audio_streams,
                    "engine": "HYBRID_PRO_V1"
                }
        except Exception as e:
            traceback.print_exc()
            return {"error": str(e)}

if __name__ == "__main__":
    test_url = "https://www.youtube.com/watch?v=hxMNYkLN7tI"
    print(json.dumps(ExplodeEngine.get_info(test_url), indent=2))
