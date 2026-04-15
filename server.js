const express    = require('express');
const cors       = require('cors');
const path       = require('path');
const https      = require('https');
const http       = require('http');
const { spawn }  = require('child_process');

const { sanitizeUrl } = require('./utils/sanitizer');

const ffmpegPath      = require('ffmpeg-static');


const YouTubeProvider = require('./providers/YouTubeProvider');
const TikTokProvider  = require('./providers/TikTokProvider');
const SocialProvider  = require('./providers/SocialProvider');

const app  = express();
const PORT = process.env.PORT || 3000;

const isWin = process.platform === 'win32';

// Robust yt-dlp detection
function getYTdlpPath() {
    // 1. Check if 'yt-dlp' is in system PATH (via 'where' or 'which')
    // Note: In Node, we can just try to run 'yt-dlp' and see if it fails,
    // but for absolute paths in spawn, we check common locations.
    
    // 2. Check root directory (manual upload)
    const rootPath = path.join(__dirname, isWin ? 'yt-dlp.exe' : 'yt-dlp');
    if (require('fs').existsSync(rootPath)) return rootPath;

    // 3. System common paths
    const systemPaths = isWin 
        ? ['C:\\Program Files\\yt-dlp\\yt-dlp.exe', 'C:\\yt-dlp.exe']
        : ['/usr/local/bin/yt-dlp', '/usr/bin/yt-dlp'];
    
    for (const p of systemPaths) {
        if (require('fs').existsSync(p)) return p;
    }

    // 4. Fallback to node_modules (bundled)
    return isWin
        ? path.join(__dirname, 'node_modules', 'youtube-dl-exec', 'bin', 'yt-dlp.exe')
        : path.join(__dirname, 'node_modules', 'youtube-dl-exec', 'bin', 'yt-dlp');
}

const YTDLP = getYTdlpPath();

// Cookies file detection (must be netscape format)
const fs = require('fs');
const COOKIES_FILE        = path.join(__dirname, 'cookies.txt');   // YouTube
const TIKTOK_COOKIES_FILE = path.join(__dirname, 'cookiess.txt');  // TikTok

const COOKIES_ARGS        = fs.existsSync(COOKIES_FILE)
    ? ['--cookies', COOKIES_FILE]
    : [];
const TIKTOK_COOKIES_ARGS = fs.existsSync(TIKTOK_COOKIES_FILE)
    ? ['--cookies', TIKTOK_COOKIES_FILE]
    : COOKIES_ARGS; // fallback to main cookies.txt if no dedicated TikTok file

console.log('[Config] Using YTDLP:', YTDLP);
if (COOKIES_ARGS.length)        console.log('[Config] YouTube cookies:', COOKIES_FILE);
if (TIKTOK_COOKIES_ARGS.length) console.log('[Config] TikTok  cookies:', TIKTOK_COOKIES_FILE);


app.use(cors());
app.use(express.json({ limit: '10kb' }));
app.use(express.static(path.join(__dirname)));

// ─── Rate Limiter ─────────────────────────────────────────────────────────────
const rateLimitMap = new Map();
const RATE_LIMIT   = 40;
const RATE_WINDOW  = 60 * 1000;

function rateLimit(req, res, next) {
    const ip  = req.ip || req.connection.remoteAddress || 'unknown';
    const now = Date.now();
    const rec = rateLimitMap.get(ip);
    if (!rec || now > rec.resetAt) {
        rateLimitMap.set(ip, { count: 1, resetAt: now + RATE_WINDOW });
        return next();
    }
    if (rec.count >= RATE_LIMIT) {
        return res.status(429).json({ error: 'Too many requests. Please wait a moment.' });
    }
    rec.count++;
    next();
}

setInterval(() => {
    const now = Date.now();
    for (const [ip, rec] of rateLimitMap) {
        if (now > rec.resetAt) rateLimitMap.delete(ip);
    }
}, 5 * 60 * 1000);

// ─── URL Validation ───────────────────────────────────────────────────────────
function validateUrl(url) {
    if (!url || typeof url !== 'string' || url.length > 2000) return false;
    try {
        const p = new URL(url);
        return p.protocol === 'http:' || p.protocol === 'https:';
    } catch { return false; }
}

// ─── Provider Registry ────────────────────────────────────────────────────────
const providers = {
    youtube:   new YouTubeProvider(),
    tiktok:    new TikTokProvider(),
    instagram: new SocialProvider(),
    twitter:   new SocialProvider(),
    generic:   new SocialProvider()
};

function getProvider(url) {
    if (url.includes('youtube.com') || url.includes('youtu.be')) return providers.youtube;
    if (url.includes('tiktok.com'))                               return providers.tiktok;
    if (url.includes('instagram.com'))                            return providers.instagram;
    if (url.includes('x.com') || url.includes('twitter.com'))    return providers.twitter;
    return providers.generic;
}

// ─── Build format string ──────────────────────────────────────────────────────
function buildFormat(type) {
    if (type === 'audio') {
        return { format: 'bestaudio[ext=m4a]/bestaudio/best', ext: 'mp3', mime: 'audio/mpeg' };
    }
    const h = parseInt(type) || 720;
    // Priority: H.264 separate → H.264 combined → mp4 fallback → anything
    const format = [
        `bestvideo[height<=${h}][ext=mp4][vcodec^=avc]+bestaudio[ext=m4a]`,
        `bestvideo[height<=${h}][vcodec^=avc]+bestaudio`,
        `best[height<=${h}][vcodec^=h264][ext=mp4]`,
        `best[height<=${h}][vcodec^=h264]`,
        `best[height<=${h}][ext=mp4]`,
        `best[height<=${h}]`,
        'best',
    ].join('/');
    return { format, ext: 'mp4', mime: 'video/mp4' };
}

// ─── Get direct CDN url(s) from yt-dlp ───────────────────────────────────────
// Returns array of URLs. 1 url = single stream, 2 urls = needs merge.
function getDirectUrls(safeUrl, format) {
    return new Promise((resolve) => {
        const args = [
            safeUrl, '-f', format,
            '--no-warnings', '--no-check-certificate', '--no-playlist',
            '--force-ipv4', '--geo-bypass',
            ...COOKIES_ARGS,
            '--get-url',
        ];
        const proc  = spawn(YTDLP, args, { stdio: ['ignore', 'pipe', 'pipe'] });
        let   out   = '';
        proc.stdout.on('data', d => out += d.toString());
        proc.on('close', () => {
            resolve(out.trim().split('\n').filter(l => l.startsWith('http')));
        });
        proc.on('error', () => resolve([]));
        setTimeout(() => { proc.kill('SIGKILL'); resolve([]); }, 35000);
    });
}

// ─── Pipe a single CDN URL directly to response ───────────────────────────────
// Returns Promise<true> on success, Promise<false> on failure (so caller can fallback).
// Follows HTTP 301/302/307/308 redirects. Only pipes 200 OK — error responses are NOT piped.
function pipeCdnUrl(cdnUrl, res, req, extraHeaders = {}, maxRedirects = 8) {
    return new Promise((resolve) => {
        if (maxRedirects === 0) {
            console.error('[CDN] Too many redirects, giving up');
            resolve(false);
            return;
        }
        const lib = cdnUrl.startsWith('https') ? https : http;
        const cdnReq = lib.get(cdnUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
                'Accept':     '*/*',
                ...extraHeaders,
            },
        }, (cdnRes) => {
            // Follow redirects — TikTok CDN often 302s to actual file
            if ([301, 302, 307, 308].includes(cdnRes.statusCode) && cdnRes.headers.location) {
                cdnRes.resume();
                const loc     = cdnRes.headers.location;
                const nextUrl = loc.startsWith('http') ? loc : new URL(loc, cdnUrl).href;
                console.log(`[CDN Redirect] ${cdnRes.statusCode} → ${nextUrl.slice(0, 80)}`);
                pipeCdnUrl(nextUrl, res, req, extraHeaders, maxRedirects - 1).then(resolve);
                return;
            }
            // Only stream 200 OK — don't pipe error pages (403/429/404 HTML = tiny "file")
            if (cdnRes.statusCode !== 200) {
                cdnRes.resume();
                console.error(`[CDN] Status ${cdnRes.statusCode} — will try fallback`);
                resolve(false);
                return;
            }
            const cl = cdnRes.headers['content-length'];
            if (cl) res.setHeader('Content-Length', cl);
            cdnRes.pipe(res);
            cdnRes.on('end',   () => resolve(true));
            cdnRes.on('error', () => resolve(false));
        });
        cdnReq.on('error', (err) => {
            console.error('[CDN Pipe Error]:', err.message);
            resolve(false);
        });
        req.on('close', () => cdnReq.destroy());
    });
}

// ─── Merge video+audio via yt-dlp+ffmpeg streaming ───────────────────────────
function spawnMergeStream(safeUrl, format, res, req, extraArgs = [], cookiesArgs = COOKIES_ARGS) {
    const args = [
        safeUrl,
        '-f', format,
        '--no-warnings', '--no-check-certificate', '--no-playlist',
        '--ffmpeg-location', ffmpegPath,
        ...cookiesArgs,
        ...extraArgs,
        '-o', '-',
    ];
    const proc = spawn(YTDLP, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    proc.stdout.pipe(res);
    proc.stderr.on('data', d => {
        const line = d.toString();
        if (!line.includes('ETA') && !line.includes('[download]')) {
            console.error('[MERGE]', line.trim());
        }
    });
    proc.on('error', err => {
        console.error('[MERGE spawn error]', err.message);
        if (!res.headersSent) res.status(500).send('Download failed.');
    });
    proc.on('close', code => {
        if (code !== 0) console.error('[MERGE] yt-dlp exited', code);
    });
    req.on('close', () => { if (!proc.killed) proc.kill('SIGKILL'); });
}

// ─── Routes ───────────────────────────────────────────────────────────────────
app.get('/api/health', (_req, res) => {
    res.json({ status: 'ok', uptime: Math.floor(process.uptime()) });
});

app.get('/', (_req, res) => {
    res.sendFile(path.join(__dirname, 'landing.html'));
});

app.get('/app', (_req, res) => {
    res.sendFile(path.join(__dirname, 'app.html'));
});

// ─── SEO ──────────────────────────────────────────────────────────────────────
app.get('/sitemap.xml', (_req, res) => {
    const base = process.env.SITE_URL || 'https://doomsdaysnap.online';
    const now = new Date().toISOString().split('T')[0];
    res.header('Content-Type', 'application/xml');
    res.send(`<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>${base}/</loc><lastmod>${now}</lastmod><priority>1.0</priority><changefreq>weekly</changefreq></url>
  <url><loc>${base}/app</loc><lastmod>${now}</lastmod><priority>0.9</priority><changefreq>weekly</changefreq></url>
</urlset>`);
});

app.get('/robots.txt', (_req, res) => {
    const base = process.env.SITE_URL || 'https://doomsdaysnap.online';
    res.header('Content-Type', 'text/plain');
    res.send(`User-agent: *\nAllow: /\nDisallow: /api/\nSitemap: ${base}/sitemap.xml`);
});

// Info — metadata only, nothing stored
app.post('/api/info', rateLimit, async (req, res) => {
    try {
        const { url } = req.body;
        if (!validateUrl(url)) {
            return res.status(400).json({ error: 'Please provide a valid video URL.' });
        }
        const safeUrl  = sanitizeUrl(url);
        const provider = getProvider(safeUrl);
        console.log(`[INFO] ${provider.constructor.name} → ${safeUrl}`);
        const info = await provider.getInfo(safeUrl);
        return res.json({ ...info, originalUrl: url });
    } catch (err) {
        console.error('[INFO Error]:', err.message);
        let msg = 'Could not extract video info. The link may be invalid or private.';
        const m = err.message || '';
        if (m.includes('Private video'))                          msg = 'This video is private.';
        else if (m.includes('age'))                               msg = 'Age-restricted content cannot be downloaded.';
        else if (m.includes('Sign in to confirm'))                msg = 'YouTube has blocked this request (Bot detection). Try again later.';
        else if (m.includes('not available in your country') || m.includes('blocked in your country')) msg = 'This video is not available in your region.';
        else if (m.includes('HTTP Error 404'))                    msg = 'Video not found — please check the URL.';
        else if (m.includes('is not a valid URL') || m.includes('truncated')) msg = 'Invalid URL. Please copy the complete link directly.';
        else if (m.includes('No video') && m.includes('tweet'))  msg = 'X/Twitter now requires login to download videos. This tweet may have no video or be private.';
        else if (m.includes('tiktok') || m.includes('TikTok'))   msg = 'Could not fetch TikTok video. The video may be private or region-restricted.';
        return res.status(500).json({ error: msg, details: m.slice(0, 300) });
    }
});

// Platform-specific extra args for download
const YT_ARGS = [
    '--extractor-args', 'youtube:player_client=android,web',
    '--add-header', 'User-Agent:Mozilla/5.0 (Linux; Android 11; Pixel 5) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/90.0.4430.91 Mobile Safari/537.36',
];
const TIKTOK_ARGS = [
    '--add-header', 'referer:https://www.tiktok.com/',
    '--add-header', 'origin:https://www.tiktok.com',
    '--add-header', 'user-agent:Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
    '--extractor-args', 'tiktok:api_hostname=api22-normal-c-useast2a.tiktokv.com;app_version=33.4.3;manifest_app_version=2023304030',
    '--no-check-formats',
    '--geo-bypass-country', 'US',
];
const INSTAGRAM_ARGS = [
    '--add-header', 'referer:https://www.instagram.com/',
    '--add-header', 'origin:https://www.instagram.com',
];
const TWITTER_ARGS = [
    '--add-header', 'referer:https://x.com/',
    '--add-header', 'origin:https://x.com',
    '--merge-output-format', 'mp4',
];

// Download — smart routing:
//   YouTube  → get-url first: 1 url = direct CDN pipe, 2 urls = ffmpeg merge
//   TikTok   → yt-dlp with mobile UA + TikTok extractor args
//   Others   → yt-dlp stream directly
app.get('/api/download', rateLimit, async (req, res) => {
    const { url, type } = req.query;
    if (!validateUrl(url)) return res.status(400).send('Invalid URL.');

    const safeUrl    = sanitizeUrl(url);
    const isYouTube  = safeUrl.includes('youtube.com') || safeUrl.includes('youtu.be');
    const isTikTok   = safeUrl.includes('tiktok.com');
    const isInstagram = safeUrl.includes('instagram.com');
    const isTwitter  = safeUrl.includes('x.com') || safeUrl.includes('twitter.com');

    // TikTok serves combined video+audio — avoid split-stream format selector
    const { format: rawFormat, ext, mime } = buildFormat(type);
    const format = isTikTok
        ? `bestvideo*[height<=${parseInt(type) || 1080}]+bestaudio/best[height<=${parseInt(type) || 1080}]/best`
        : rawFormat;

    const filename = `doomsdaysnap_${Date.now()}.${ext}`;

    console.log(`[DOWNLOAD] type=${type} → ${safeUrl}`);

    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Type', mime);
    res.setHeader('X-Content-Type-Options', 'nosniff');

    try {
        if (isYouTube) {
            // YouTube CDN URLs work without cookies → try direct pipe first
            const urls = await getDirectUrls(safeUrl, format);

            if (urls.length === 0) {
                return res.status(500).send('Could not resolve download URL.');
            }

            if (urls.length === 1) {
                // Progressive format (≤480p usually) — direct CDN, full speed
                console.log(`[DOWNLOAD] YT single-stream → CDN direct`);
                pipeCdnUrl(urls[0], res, req);
            } else {
                // Separate video+audio (720p+) — merge via ffmpeg
                console.log(`[DOWNLOAD] YT multi-stream → ffmpeg merge`);
                spawnMergeStream(safeUrl, format, res, req, YT_ARGS);
            }
        } else if (isTikTok) {
            const isAudio = type === 'audio';

            // Override headers for TikTok before any pipe
            if (isAudio) {
                res.setHeader('Content-Type', 'audio/mpeg');
                res.setHeader('Content-Disposition', `attachment; filename="doomsdaysnap_${Date.now()}.mp3"`);
            } else {
                res.setHeader('Content-Type', 'video/mp4');
                res.setHeader('Content-Disposition', `attachment; filename="doomsdaysnap_${Date.now()}.mp4"`);
            }

            // Step 0: tikwm RapidAPI — returns original quality hdplay URL (~71MB)
            // Requires RAPIDAPI_KEY env var. Free tier: 500 req/month on rapidapi.com
            if (process.env.RAPIDAPI_KEY) {
                const rapidData = await new Promise((resolve) => {
                    const apiUrl = `https://tiktok-scraper7.p.rapidapi.com/video/data?url=${encodeURIComponent(safeUrl)}&hd=1`;
                    const r = https.get(apiUrl, {
                        headers: {
                            'X-RapidAPI-Key':  process.env.RAPIDAPI_KEY,
                            'X-RapidAPI-Host': 'tiktok-scraper7.p.rapidapi.com',
                        },
                    }, (resp) => {
                        let d = ''; resp.on('data', c => d += c);
                        resp.on('end', () => {
                            try { const j = JSON.parse(d); resolve(j?.code === 0 ? j.data : null); }
                            catch { resolve(null); }
                        });
                    });
                    r.on('error', () => resolve(null));
                    setTimeout(() => { r.destroy(); resolve(null); }, 10000);
                });

                if (rapidData) {
                    const cdnUrl = isAudio
                        ? (rapidData.music || rapidData.hdplay)
                        : (rapidData.hdplay || rapidData.play);
                    console.log(`[DOWNLOAD] TikTok RapidAPI: hd_size=${rapidData.hd_size} url=${!!cdnUrl}`);
                    if (cdnUrl) {
                        const ok = await pipeCdnUrl(cdnUrl, res, req, {
                            'User-Agent': 'Mozilla/5.0',
                            'Referer':    'https://www.tiktok.com/',
                        });
                        if (ok) return;
                    }
                }
            }

            // Step 1: TikTok /api/item/detail/ + tt_chain_token CDN cookie
            // tt_chain_token is TikTok's CDN pass — without it the CDN silently
            // serves the compressed stream. It arrives in Set-Cookie of the API response.

            // Resolve short URLs (vt.tiktok.com, vm.tiktok.com) — extractVideoId fails without this
            const resolvedTikTokUrl = await new Promise((resolve) => {
                if (!safeUrl.includes('vt.tiktok.com') && !safeUrl.includes('vm.tiktok.com')) return resolve(safeUrl);
                const r = https.get(safeUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res2) => {
                    res2.resume();
                    if ([301, 302, 307, 308].includes(res2.statusCode) && res2.headers.location) {
                        const loc = res2.headers.location;
                        resolve(loc.startsWith('http') ? loc : `https://www.tiktok.com${loc}`);
                    } else { resolve(safeUrl); }
                });
                r.on('error', () => resolve(safeUrl));
                setTimeout(() => { r.destroy(); resolve(safeUrl); }, 6000);
            });
            const videoId = resolvedTikTokUrl.match(/video\/(\d+)/)?.[1];
            if (videoId) {
                const { item, ttToken } = await new Promise((resolve) => {
                    const qs = [
                        `itemId=${videoId}`, 'aid=1988', 'app_language=en', 'app_name=tiktok_web',
                        'browser_language=en-US', 'browser_name=Mozilla', 'browser_platform=Win32',
                        'browser_version=5.0', 'channel=tiktok_web', 'device_platform=web_pc',
                        'focus_state=true', 'from_page=video', 'history_len=2',
                        'is_fullscreen=false', 'is_page_visible=true',
                        'language=en', 'os=windows', 'region=US',
                        'screen_height=1080', 'screen_width=1920',
                    ].join('&');
                    const apiUrl = `https://www.tiktok.com/api/item/detail/?${qs}`;
                    const headers = {
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
                        'Accept': 'application/json, text/plain, */*',
                        'Accept-Language': 'en-US,en;q=0.9',
                        'Referer': 'https://www.tiktok.com/',
                        'Sec-Fetch-Dest': 'empty',
                        'Sec-Fetch-Mode': 'cors',
                        'Sec-Fetch-Site': 'same-origin',
                    };
                    if (process.env.TIKTOK_COOKIE) headers['Cookie'] = process.env.TIKTOK_COOKIE;
                    const r = https.get(apiUrl, { headers }, (resp) => {
                        // Extract tt_chain_token — the CDN key for HD quality
                        let ttToken = null;
                        for (const c of (resp.headers['set-cookie'] || [])) {
                            const m = c.match(/tt_chain_token=([^;]+)/);
                            if (m) { ttToken = m[1]; break; }
                        }
                        let d = ''; resp.on('data', c => d += c);
                        resp.on('end', () => {
                            try {
                                const j = JSON.parse(d);
                                resolve({ item: j?.itemInfo?.itemStruct || null, ttToken });
                            } catch { resolve({ item: null, ttToken }); }
                        });
                    });
                    r.on('error', () => resolve({ item: null, ttToken: null }));
                    setTimeout(() => { r.destroy(); resolve({ item: null, ttToken: null }); }, 12000);
                });

                if (item?.video) {
                    const video = item.video;
                    let cdnUrl = null;

                    if (isAudio) {
                        cdnUrl = item.music?.playUrl;
                    } else {
                        // Pick highest quality from bitrateInfo
                        if (Array.isArray(video.bitrateInfo) && video.bitrateInfo.length > 0) {
                            const gearRes = (name = '') => { const m = name.match(/(\d{3,4})/); return m ? parseInt(m[1]) : 0; };
                            const best = [...video.bitrateInfo].sort((a, b) => {
                                const diff = gearRes(b.GearName) - gearRes(a.GearName);
                                return diff !== 0 ? diff : (b.Bitrate || 0) - (a.Bitrate || 0);
                            })[0];
                            cdnUrl = best?.PlayAddr?.UrlList?.[0];
                            console.log(`[DOWNLOAD] TikTok item/detail: gear=${best?.GearName} ttToken=${!!ttToken} url=${!!cdnUrl}`);
                        }
                        if (!cdnUrl) cdnUrl = video.downloadAddr || video.playAddr;
                    }

                    if (cdnUrl) {
                        // tt_chain_token cookie unlocks HD quality from TikTok CDN
                        const dlHeaders = { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://www.tiktok.com/' };
                        if (ttToken)                         dlHeaders['Cookie'] = `tt_chain_token=${ttToken}`;
                        else if (process.env.TIKTOK_COOKIE) dlHeaders['Cookie'] = process.env.TIKTOK_COOKIE;
                        const ok = await pipeCdnUrl(cdnUrl, res, req, dlHeaders);
                        if (ok) return;
                    }
                }
            }

            // Step 2: Direct page scraping — Tikorgzo-style __UNIVERSAL_DATA_FOR_REHYDRATION__
            // Fetches the TikTok video page HTML and parses the embedded SSR JSON to get
            // original-quality downloadAddr/playAddr directly from TikTok CDN.
            if (!res.headersSent && videoId) {
                const pageItem = await new Promise((resolve) => {
                    const pageUrl = `https://www.tiktok.com/video/${videoId}`;
                    const reqHeaders = {
                        'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
                        'Accept':          'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                        'Accept-Language': 'en-US,en;q=0.9',
                        'Accept-Encoding': 'gzip, deflate, br',
                        'Referer':         'https://www.tiktok.com/',
                        'Sec-Fetch-Dest':  'document',
                        'Sec-Fetch-Mode':  'navigate',
                        'Sec-Fetch-Site':  'none',
                    };
                    if (process.env.TIKTOK_COOKIE) reqHeaders['Cookie'] = process.env.TIKTOK_COOKIE;
                    const r = https.get(pageUrl, { headers: reqHeaders }, (resp) => {
                        const zlib = require('zlib');
                        let stream = resp;
                        const enc = resp.headers['content-encoding'];
                        if (enc === 'gzip')    stream = resp.pipe(zlib.createGunzip());
                        else if (enc === 'br') stream = resp.pipe(zlib.createBrotliDecompress());
                        else if (enc === 'deflate') stream = resp.pipe(zlib.createInflate());
                        const chunks = [];
                        stream.on('data', c => chunks.push(c));
                        stream.on('end', () => {
                            const html = Buffer.concat(chunks).toString('utf8');
                            const m = html.match(/<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__"[^>]*>([\s\S]*?)<\/script>/);
                            if (!m) return resolve(null);
                            try {
                                const d2 = JSON.parse(m[1]);
                                resolve(d2?.['__DEFAULT_SCOPE__']?.['webapp.video-detail']?.itemInfo?.itemStruct || null);
                            } catch { resolve(null); }
                        });
                        stream.on('error', () => resolve(null));
                    });
                    r.on('error', () => resolve(null));
                    setTimeout(() => { r.destroy(); resolve(null); }, 15000);
                });

                if (pageItem?.video) {
                    const video = pageItem.video;
                    let cdnUrl = null;
                    if (isAudio) {
                        cdnUrl = pageItem.music?.playUrl;
                    } else {
                        const best = (() => {
                            if (!Array.isArray(video.bitrateInfo) || !video.bitrateInfo.length) return null;
                            const gearRes = (n = '') => { const m = n.match(/(\d{3,4})/); return m ? parseInt(m[1]) : 0; };
                            return [...video.bitrateInfo].sort((a, b) => {
                                const d = gearRes(b.GearName) - gearRes(a.GearName);
                                return d !== 0 ? d : (b.Bitrate || 0) - (a.Bitrate || 0);
                            })[0];
                        })();
                        cdnUrl = best?.PlayAddr?.UrlList?.[0] || video.downloadAddr || video.playAddr;
                        console.log(`[DOWNLOAD] TikTok direct-page: gear=${best?.GearName || 'n/a'} url=${!!cdnUrl}`);
                    }
                    if (cdnUrl) {
                        const dlHeaders = { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://www.tiktok.com/' };
                        if (process.env.TIKTOK_COOKIE) dlHeaders['Cookie'] = process.env.TIKTOK_COOKIE;
                        const ok = await pipeCdnUrl(cdnUrl, res, req, dlHeaders);
                        if (ok) return;
                    }
                }
            }

            // Step 3: yt-dlp with TikTok-specific cookies (cookiess.txt)
            // With valid TikTok session cookie → htdefbr format (~71MB original quality)
            // Without cookie (datacenter IP)  → bytevc1_1080p (~9MB, best available)
            if (!res.headersSent) {
                console.log(`[DOWNLOAD] TikTok → yt-dlp tiktok-cookies=${TIKTOK_COOKIES_ARGS.length > 0}`);
                // bytevc1_1080p (h265, 9.35MB) > h264_540p (h264, 9.98MB despite larger size)
                // height>=1920 targets portrait 1080x1920, width>=1080 as fallback
                spawnMergeStream(
                    safeUrl,
                    'bestvideo[height>=1920]/bestvideo[width>=1080]/bestvideo/best',
                    res, req,
                    TIKTOK_ARGS,
                    TIKTOK_COOKIES_ARGS
                );
            }
        } else if (isInstagram) {
            console.log(`[DOWNLOAD] Instagram → yt-dlp stream`);
            spawnMergeStream(safeUrl, format, res, req, INSTAGRAM_ARGS);
        } else if (isTwitter) {
            console.log(`[DOWNLOAD] Twitter/X → yt-dlp stream`);
            // 'best' picks the muxed stream (video+audio combined) — avoids merge failures
            const twitterFormat = 'best[ext=mp4]/best/bestvideo+bestaudio';
            spawnMergeStream(safeUrl, twitterFormat, res, req, TWITTER_ARGS);
        } else {
            console.log(`[DOWNLOAD] generic → yt-dlp stream`);
            spawnMergeStream(safeUrl, format, res, req);
        }

    } catch (err) {
        console.error('[DOWNLOAD Error]:', err.message);
        if (!res.headersSent) res.status(500).send('Download failed. Please try again.');
    }
});

app.listen(PORT, () => {
    console.log(`🚀 Doomsdaysnap running at http://localhost:${PORT}`);
});
