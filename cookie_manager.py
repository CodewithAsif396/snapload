"""
Cookie Manager - VPS Mode
User manually uploads platform-specific cookies via Admin Panel.
This module validates and monitors cookie health for each platform.
"""
import os
import time
import yt_dlp

PROJECT_DIR = os.path.dirname(os.path.abspath(__file__))
LOG_FILE = os.path.join(PROJECT_DIR, "maintenance.log")

PLATFORMS = {
    "facebook": {
        "file": "cookies_facebook.txt",
        "test_url": "https://www.facebook.com/facebook/videos/10153231379941729/", # Official FB video
        "max_age_days": 15
    },
    "youtube": {
        "file": "cookies_youtube.txt",
        "test_url": "https://www.youtube.com/watch?v=jNQXAC9IVRw", # Me at the zoo (Very stable)
        "max_age_days": 10
    },
    "instagram": {
        "file": "cookies_instagram.txt",
        "test_url": "https://www.instagram.com/p/C3m8h-Xv7mY/", # Public post
        "max_age_days": 7
    },
    "tiktok": {
        "file": "cookies_tiktok.txt",
        "test_url": "https://www.tiktok.com/@tiktok/video/7106594312290110766", # Official TikTok
        "max_age_days": 7
    }
}

# Legacy support
DEFAULT_COOKIE_FILE = os.path.join(PROJECT_DIR, "cookies.txt")

def log(msg):
    timestamp = time.strftime("%Y-%m-%d %H:%M:%S")
    line = f"[{timestamp}] [CookieManager] {msg}"
    print(line, flush=True)
    with open(LOG_FILE, "a", encoding="utf-8") as f:
        f.write(line + "\n")

def get_cookie_path(platform):
    filename = PLATFORMS.get(platform, {}).get("file", "cookies.txt")
    
    # Check 1: ads-backend/data/ folder (New preferred location)
    data_path = os.path.join(PROJECT_DIR, "ads-backend", "data", filename)
    if os.path.exists(data_path) and os.path.getsize(data_path) > 100:
        return data_path
        
    # Check 2: Root folder
    root_path = os.path.join(PROJECT_DIR, filename)
    if os.path.exists(root_path) and os.path.getsize(root_path) > 100:
        return root_path
        
    # Default fallback
    return data_path if platform in PLATFORMS else DEFAULT_COOKIE_FILE

def cookie_age_days(platform) -> float:
    path = get_cookie_path(platform)
    if not os.path.exists(path):
        return 999.0
    if os.path.getsize(path) < 100: # Smaller threshold
        return 998.0
    return (time.time() - os.path.getmtime(path)) / 86400

def validate_cookies(platform) -> tuple[bool, str]:
    path = get_cookie_path(platform)
    exists = os.path.exists(path) and os.path.getsize(path) > 100
    
    if not exists:
        # Fallback to legacy cookies.txt for facebook ONLY if specifically missing
        if platform == "facebook" and os.path.exists(DEFAULT_COOKIE_FILE):
            path = DEFAULT_COOKIE_FILE
        else:
            return False, f"Missing: {os.path.basename(path)}"

    test_url = PLATFORMS.get(platform, {}).get("test_url", "https://www.google.com")
    
    opts = {
        'quiet': True,
        'no_warnings': True,
        'skip_download': True,
        'cookiefile': path,
        'no_check_certificate': True,
    }
    
    # Platform specific tweaks
    if platform == "youtube":
        opts['extractor_args'] = {'youtube': {'player_client': ['tvhtml5_embedded']}}

    try:
        with yt_dlp.YoutubeDL(opts) as ydl:
            info = ydl.extract_info(test_url, download=False)
            if info:
                return True, "OK"
            return False, "No data returned"
    except Exception as e:
        err = str(e)
        if "Sign in" in err or "bot" in err.lower() or "login" in err.lower():
            return False, "EXPIRED/BLOCKED"
        return False, err[:100]

def get_all_status():
    status = {}
    for p in PLATFORMS:
        age = cookie_age_days(p)
        valid, reason = validate_cookies(p)
        
        needs_update = False
        if age > PLATFORMS[p]["max_age_days"] or not valid:
            needs_update = True
            
        status[p] = {
            "exists": age < 900,
            "age_days": round(age, 1) if age < 900 else None,
            "valid": valid,
            "reason": reason,
            "needs_update": needs_update
        }
    return status

if __name__ == "__main__":
    import argparse
    import json
    parser = argparse.ArgumentParser()
    parser.add_argument("--check", action="store_true")
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()
    
    if args.json:
        print(json.dumps(get_all_status()))
    else:
        for p, s in get_all_status().items():
            print(f"[{p}] Valid: {s['valid']}, Age: {s['age_days']}d, Needs Update: {s['needs_update']}")
