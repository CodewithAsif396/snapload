const express    = require('express');
const cors       = require('cors');
const path       = require('path');
const https      = require('https');
const http       = require('http');
const { spawn }  = require('child_process');

const { sanitizeUrl }    = require('./utils/sanitizer');
const { getTikTokCdnUrl } = require('./utils/tiktokBrowser');

const ffmpegPath = require('ffmpeg-static');


// ── Provider imports — one file per platform ──────────────────────────────────
const YouTubeProvider  = require('./providers/YouTubeProvider');
const TikTokProvider   = require('./providers/TikTokProvider');
const InstagramProvider = require('./providers/InstagramProvider');
const TwitterProvider  = require('./providers/TwitterProvider');
const FacebookProvider = require('./providers/FacebookProvider');
const SocialProvider   = require('./providers/SocialProvider');   // Snapchat + Pinterest + generic

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
// Each platform has its own SocialProvider instance (same class, different headers in getInfo).
// YouTubeProvider and TikTokProvider have dedicated logic for their complex APIs.
// ── Provider instances — one per platform ────────────────────────────────────
const providers = {
    youtube:   new YouTubeProvider(),
    tiktok:    new TikTokProvider(),
    instagram: new InstagramProvider(),
    twitter:   new TwitterProvider(),
    facebook:  new FacebookProvider(),
    social:    new SocialProvider(),   // Snapchat + Pinterest + generic fallback
};

/**
 * Pick the right provider based on the URL domain.
 * Falls back to SocialProvider for Snapchat, Pinterest, and unknown URLs.
 */
function getProvider(url) {
    if (url.includes('youtube.com') || url.includes('youtu.be'))        return providers.youtube;
    if (url.includes('tiktok.com'))                                      return providers.tiktok;
    if (url.includes('instagram.com'))                                   return providers.instagram;
    if (url.includes('x.com') || url.includes('twitter.com'))           return providers.twitter;
    if (url.includes('facebook.com') || url.includes('fb.watch'))       return providers.facebook;
    return providers.social; // handles Snapchat, Pinterest, and any other URL
}

// ─── Build format string ──────────────────────────────────────────────────────
// fid = exact yt-dlp format_id from the /api/info phase (e.g. "137", "18").
//       When provided we request that exact stream → correct resolution guaranteed.
// type = height number (720, 1080 …) or "audio" — used as fallback when fid is absent.
function buildFormat(type, fid) {
    if (type === 'audio') {
        return { format: 'bestaudio[ext=m4a]/bestaudio/best', ext: 'mp3', mime: 'audio/mpeg' };
    }

    // ── Exact format ID path (preferred) ─────────────────────────────────────
    // fid came from the info dump so we know this stream exists.
    // We still append bestaudio because most video-only streams need it merged in.
    if (fid && fid !== 'null' && fid !== 'undefined' && fid !== 'HD') {
        const format = [
            `${fid}+bestaudio[ext=m4a]`,
            `${fid}+bestaudio`,
            fid,            // combined stream (no separate audio needed)
            'best',         // ultimate fallback
        ].join('/');
        return { format, ext: 'mp4', mime: 'video/mp4' };
    }

    // ── Height-based fallback (used when fid is unavailable) ─────────────────
    // Priority: H.264 separate → H.264 combined → mp4 fallback → anything
    const h = parseInt(type) || 720;
    const format = [
        `bestvideo[height=${h}][ext=mp4][vcodec^=avc]+bestaudio[ext=m4a]`,
        `bestvideo[height=${h}][vcodec^=avc]+bestaudio`,
        `bestvideo[height<=${h}][ext=mp4][vcodec^=avc]+bestaudio[ext=m4a]`,
        `bestvideo[height<=${h}][vcodec^=avc]+bestaudio`,
        `best[height<=${h}][ext=mp4]`,
        `best[height<=${h}]`,
        'best',
    ].join('/');
    return { format, ext: 'mp4', mime: 'video/mp4' };
}

// ─── Get direct CDN url(s) from yt-dlp ───────────────────────────────────────
// Returns array of URLs:
//   1 URL  → combined stream, pipe directly to client at full CDN speed
//   2 URLs → separate video+audio streams, must merge via ffmpeg
//   0 URLs → yt-dlp could not resolve (fall back to spawnMergeStream)
//
// extraArgs allows passing platform-specific headers (referer, UA, etc.)
function getDirectUrls(safeUrl, format, extraArgs = []) {
    return new Promise((resolve) => {
        const args = [
            safeUrl, '-f', format,
            '--no-warnings', '--no-check-certificate', '--no-playlist',
            '--force-ipv4', '--geo-bypass',
            ...COOKIES_ARGS,
            ...extraArgs,
            '--get-url',
        ];
        const proc = spawn(YTDLP, args, { stdio: ['ignore', 'pipe', 'pipe'] });
        let   out  = '';
        proc.stdout.on('data', d => out += d.toString());
        proc.on('close', () => {
            resolve(out.trim().split('\n').filter(l => l.startsWith('http')));
        });
        proc.on('error', () => resolve([]));
        setTimeout(() => { proc.kill('SIGKILL'); resolve([]); }, 30000);
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
// Used when direct CDN pipe is not possible (separate video+audio streams need merging,
// or the platform blocks direct hotlinking).
// --concurrent-fragments speeds up fragment-based streams (HLS/DASH).
function spawnMergeStream(safeUrl, format, res, req, extraArgs = [], cookiesArgs = COOKIES_ARGS) {
    const args = [
        safeUrl,
        '-f', format,
        '--no-warnings', '--no-check-certificate', '--no-playlist',
        '--concurrent-fragments', '4',   // download 4 fragments in parallel → faster
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
        else if (m.includes('tiktok') || m.includes('TikTok'))   msg = 'Could not fetch TikTok video. The video may be private or region-restricted.'
        else if (m.includes('facebook') || m.includes('Facebook'))   msg = 'Could not fetch Facebook video. Only public videos are supported.'
        else if (m.includes('snapchat') || m.includes('Snapchat'))   msg = 'Could not fetch Snapchat video. Only public Spotlight/Story videos are supported.'
        else if (m.includes('pinterest') || m.includes('Pinterest')) msg = 'Could not fetch Pinterest video. Make sure the pin contains a video.';
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
// Facebook: realistic browser UA is required to access public video CDN URLs
const FACEBOOK_ARGS = [
    '--add-header', 'referer:https://www.facebook.com/',
    '--add-header', 'origin:https://www.facebook.com',
    '--add-header', 'user-agent:Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    '--merge-output-format', 'mp4',
];
// Snapchat: public Spotlight & story videos — referer needed for CDN access
const SNAPCHAT_ARGS = [
    '--add-header', 'referer:https://www.snapchat.com/',
    '--add-header', 'origin:https://www.snapchat.com',
    '--add-header', 'user-agent:Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    '--merge-output-format', 'mp4',
];
// Pinterest: video pins — referer + desktop UA for best yt-dlp extraction
const PINTEREST_ARGS = [
    '--add-header', 'referer:https://www.pinterest.com/',
    '--add-header', 'origin:https://www.pinterest.com',
    '--add-header', 'user-agent:Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    '--merge-output-format', 'mp4',
];

// ─── Direct-then-merge helper ─────────────────────────────────────────────────
// Used for Instagram, Twitter, Facebook, Snapchat, Pinterest.
// 1. Ask yt-dlp to resolve CDN URL(s) with --get-url (fast, no ffmpeg).
// 2. One URL  → pipe directly to client at full CDN speed.
// 3. Two URLs → separate video+audio streams, merge via ffmpeg.
// 4. Zero URLs → fall back to spawnMergeStream (yt-dlp handles everything).
async function tryDirectThenMerge(safeUrl, format, res, req, extraArgs, cdnHeaders = {}) {
    const urls = await getDirectUrls(safeUrl, format, extraArgs);

    if (urls.length === 1) {
        console.log(`[DOWNLOAD] direct CDN pipe → ${safeUrl.slice(0, 60)}`);
        const ok = await pipeCdnUrl(urls[0], res, req, cdnHeaders);
        if (ok) return;
        // CDN rejected us (403/429) — fall through to merge stream
        console.warn('[DOWNLOAD] CDN pipe failed, falling back to merge stream');
    } else if (urls.length >= 2) {
        console.log(`[DOWNLOAD] 2-stream CDN merge → ${safeUrl.slice(0, 60)}`);
        // Separate video+audio — merge on the fly
        spawnMergeStream(safeUrl, format, res, req, extraArgs);
        return;
    }

    // urls.length === 0, or CDN pipe failed
    console.log(`[DOWNLOAD] merge-stream fallback → ${safeUrl.slice(0, 60)}`);
    if (!res.headersSent) {
        spawnMergeStream(safeUrl, format, res, req, extraArgs);
    }
}

// ─── Download route ───────────────────────────────────────────────────────────
// Strategy (fastest → slowest):
//   1. Direct CDN pipe  — yt-dlp --get-url resolves CDN link, Node pipes it at full speed
//   2. ffmpeg merge     — separate video+audio streams, merged on the fly
//   3. spawnMergeStream — yt-dlp handles everything (fallback, always works)
//
// fid (format_id) from /api/info ensures we download the exact stream shown in the UI.
app.get('/api/download', rateLimit, async (req, res) => {
    const { url, type, fid } = req.query;
    if (!validateUrl(url)) return res.status(400).send('Invalid URL.');

    const safeUrl     = sanitizeUrl(url);
    const isYouTube   = safeUrl.includes('youtube.com') || safeUrl.includes('youtu.be');
    const isTikTok    = safeUrl.includes('tiktok.com');
    const isInstagram = safeUrl.includes('instagram.com');
    const isTwitter   = safeUrl.includes('x.com') || safeUrl.includes('twitter.com');
    const isFacebook  = safeUrl.includes('facebook.com') || safeUrl.includes('fb.watch');
    const isSnapchat  = safeUrl.includes('snapchat.com') || safeUrl.includes('t.snapchat.com');
    const isPinterest = safeUrl.includes('pinterest.com') || safeUrl.includes('pin.it');

    // Build format selector — prefer exact fid over height guess
    // TikTok uses combined stream selector (video+audio in one file)
    const { format: rawFormat, ext, mime } = buildFormat(type, fid);
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

            if (isAudio) {
                res.setHeader('Content-Type', 'audio/mpeg');
                res.setHeader('Content-Disposition', `attachment; filename="doomsdaysnap_${Date.now()}.mp3"`);
            } else {
                res.setHeader('Content-Type', 'video/mp4');
                res.setHeader('Content-Disposition', `attachment; filename="doomsdaysnap_${Date.now()}.mp4"`);
            }

            // ── AUDIO: tikwm music URL ─────────────────────────────────────────
            if (isAudio) {
                const tikwmAudio = await new Promise((resolve) => {
                    const apiUrl = `https://www.tikwm.com/api/?url=${encodeURIComponent(safeUrl)}&hd=1`;
                    https.get(apiUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (r) => {
                        let d = ''; r.on('data', c => d += c);
                        r.on('end', () => { try { const j = JSON.parse(d); resolve(j?.code === 0 ? j.data : null); } catch { resolve(null); } });
                    }).on('error', () => resolve(null));
                });
                if (tikwmAudio?.music) {
                    const ok = await pipeCdnUrl(tikwmAudio.music, res, req, { 'Referer': 'https://www.tiktok.com/' });
                    if (ok) return;
                }
                if (!res.headersSent) res.status(500).send('Audio download failed.');
                return;
            }

            // ── VIDEO: real browser session only ──────────────────────────────
            // Resolve short URL first (vt.tiktok.com → full URL)
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

            console.log('[DOWNLOAD] TikTok → Puppeteer browser (original quality)');
            const captured = await getTikTokCdnUrl(resolvedTikTokUrl).catch(err => {
                console.error('[TikTokBrowser]', err.message);
                return null;
            });

            if (captured?.url) {
                const ok = await pipeCdnUrl(captured.url, res, req, captured.headers);
                if (ok) return;
                console.log('[DOWNLOAD] TikTok browser pipe failed — trying tikwm fallback');
            }

            // ── FALLBACK: tikwm hdplay (if browser fails) ─────────────────────
            const tikwmVideo = await new Promise((resolve) => {
                const apiUrl = `https://www.tikwm.com/api/?url=${encodeURIComponent(safeUrl)}&hd=1`;
                https.get(apiUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (r) => {
                    let d = ''; r.on('data', c => d += c);
                    r.on('end', () => { try { const j = JSON.parse(d); resolve(j?.code === 0 ? j.data : null); } catch { resolve(null); } });
                }).on('error', () => resolve(null));
            });
            if (tikwmVideo) {
                const cdnUrl = tikwmVideo.hdplay || tikwmVideo.play;
                if (cdnUrl) {
                    const ok = await pipeCdnUrl(cdnUrl, res, req, { 'Referer': 'https://www.tiktok.com/' });
                    if (ok) return;
                }
                if (tikwmVideo.id) {
                    const direct = `https://www.tikwm.com/video/media/hdplay/${tikwmVideo.id}.mp4`;
                    const ok = await pipeCdnUrl(direct, res, req, { 'Referer': 'https://www.tikwm.com/' });
                    if (ok) return;
                }
            }

            if (!res.headersSent) res.status(500).send('TikTok video download failed. Try again.');

        } else if (isInstagram) {
            // Try direct CDN first (fastest) — fall back to merge stream
            await tryDirectThenMerge(safeUrl, format, res, req, INSTAGRAM_ARGS, {
                'Referer': 'https://www.instagram.com/',
                'Origin':  'https://www.instagram.com',
            });

        } else if (isTwitter) {
            // Twitter usually serves combined streams — try direct first
            const twitterFormat = fid
                ? format
                : `best[ext=mp4]/best[height<=${parseInt(type)||720}][ext=mp4]/best`;
            await tryDirectThenMerge(safeUrl, twitterFormat, res, req, TWITTER_ARGS, {
                'Referer': 'https://x.com/',
            });

        } else if (isFacebook) {
            await tryDirectThenMerge(safeUrl, format, res, req, FACEBOOK_ARGS, {
                'Referer':    'https://www.facebook.com/',
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
            });

        } else if (isSnapchat) {
            await tryDirectThenMerge(safeUrl, format, res, req, SNAPCHAT_ARGS, {
                'Referer': 'https://www.snapchat.com/',
            });

        } else if (isPinterest) {
            await tryDirectThenMerge(safeUrl, format, res, req, PINTEREST_ARGS, {
                'Referer': 'https://www.pinterest.com/',
            });

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
