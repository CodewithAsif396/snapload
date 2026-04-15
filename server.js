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
const COOKIES_FILE = path.join(__dirname, 'cookies.txt');
const COOKIES_ARGS = require('fs').existsSync(COOKIES_FILE)
    ? ['--cookies', COOKIES_FILE]
    : [];

console.log('[Config] Using YTDLP:', YTDLP);
if (COOKIES_ARGS.length) console.log('[Config] Using COOKIES_FILE:', COOKIES_FILE);


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
function spawnMergeStream(safeUrl, format, res, req, extraArgs = []) {
    const args = [
        safeUrl,
        '-f', format,
        '--no-warnings', '--no-check-certificate', '--no-playlist',
        '--ffmpeg-location', ffmpegPath,
        ...COOKIES_ARGS,
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
    '--add-header', 'user-agent:Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
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

            // Step 0: TikTok internal API — pick highest-quality URL from bit_rate array
            const videoId = safeUrl.match(/video\/(\d+)/)?.[1];
            if (videoId) {
                const aweme = await new Promise((resolve) => {
                    const apiUrl = `https://api22-normal-c-useast2a.tiktokv.com/aweme/v1/feed/?aweme_id=${videoId}&aid=1233&app_name=musical_ly&version_code=26.1.3&device_type=Pixel+4&os=android`;
                    const headers = { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://www.tiktok.com/' };
                    if (process.env.TIKTOK_COOKIE) headers['Cookie'] = process.env.TIKTOK_COOKIE;
                    https.get(apiUrl, { headers }, (r) => {
                        let d = ''; r.on('data', c => d += c);
                        r.on('end', () => {
                            try { const j = JSON.parse(d); resolve(j?.status_code === 0 ? (j.aweme_list?.[0] || null) : null); }
                            catch { resolve(null); }
                        });
                    }).on('error', () => resolve(null));
                });

                if (aweme?.video) {
                    const video = aweme.video;
                    let cdnUrl = null;

                    if (isAudio) {
                        cdnUrl = aweme.music?.play_url?.url_list?.[0];
                    } else {
                        // Sort bit_rate[] by resolution encoded in gear_name, pick highest
                        if (Array.isArray(video.bit_rate) && video.bit_rate.length > 0) {
                            const gearRes = (name = '') => { const m = name.match(/(\d{3,4})/); return m ? parseInt(m[1]) : 0; };
                            const best = [...video.bit_rate].sort((a, b) => {
                                const diff = gearRes(b.gear_name) - gearRes(a.gear_name);
                                return diff !== 0 ? diff : (b.bit_rate || 0) - (a.bit_rate || 0);
                            })[0];
                            cdnUrl = best?.play_addr?.url_list?.[0];
                            console.log(`[DOWNLOAD] TikTok internal API: gear=${best?.gear_name} url=${!!cdnUrl}`);
                        }
                        // Fallback within internal API: download_addr → play_addr
                        if (!cdnUrl) cdnUrl = video.download_addr?.url_list?.[0] || video.play_addr?.url_list?.[0];
                    }

                    if (cdnUrl) {
                        const tiktokHeaders = { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://www.tiktok.com/' };
                        if (process.env.TIKTOK_COOKIE) tiktokHeaders['Cookie'] = process.env.TIKTOK_COOKIE;
                        const ok = await pipeCdnUrl(cdnUrl, res, req, tiktokHeaders);
                        if (ok) return;
                    }
                }
            }

            // Step 1: tikwm.com API → get CDN URL
            const tikwmData = await new Promise((resolve) => {
                const apiUrl = `https://www.tikwm.com/api/?url=${encodeURIComponent(safeUrl)}&hd=1`;
                https.get(apiUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (r) => {
                    let d = ''; r.on('data', c => d += c);
                    r.on('end', () => { try { const j = JSON.parse(d); resolve(j?.code === 0 ? j.data : null); } catch { resolve(null); } });
                }).on('error', () => resolve(null));
            });

            if (tikwmData) {
                const cdnUrl = isAudio
                    ? (tikwmData.music || tikwmData.hdplay)
                    : (tikwmData.hdplay || tikwmData.play);

                console.log(`[DOWNLOAD] TikTok tikwm: id=${tikwmData.id} hd_size=${tikwmData.hd_size} hdplay=${!!tikwmData.hdplay}`);

                // Step 2: Try CDN URL (follows redirects, only pipes 200 OK)
                if (cdnUrl) {
                    const ok = await pipeCdnUrl(cdnUrl, res, req, {
                        'Referer': 'https://www.tiktok.com/',
                        'Origin':  'https://www.tiktok.com',
                    });
                    if (ok) return;
                }

                // Step 3: CDN URL blocked/expired → try tikwm's own download endpoint
                if (!isAudio && tikwmData.id) {
                    const directUrl = `https://www.tikwm.com/video/media/hdplay/${tikwmData.id}.mp4`;
                    console.log(`[DOWNLOAD] TikTok → tikwm direct endpoint`);
                    const ok2 = await pipeCdnUrl(directUrl, res, req, { 'Referer': 'https://www.tikwm.com/' });
                    if (ok2) return;
                }
            }

            // Step 4: Final fallback — yt-dlp with TikTok mobile UA
            if (!res.headersSent) {
                console.log(`[DOWNLOAD] TikTok → yt-dlp fallback`);
                spawnMergeStream(safeUrl, 'bestvideo*+bestaudio/best', res, req, TIKTOK_ARGS);
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
