const express    = require('express');
const cors       = require('cors');
const path       = require('path');
const https      = require('https');
const http       = require('http');
const { spawn }  = require('child_process');

const { sanitizeUrl } = require('./utils/sanitizer');
const { quoteArg }    = require('./utils/shell');
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
// This skips yt-dlp in the data path — client gets CDN speed directly.
// Follows HTTP 301/302/307/308 redirects (TikTok CDN often redirects to actual file).
function pipeCdnUrl(cdnUrl, res, req, extraHeaders = {}, maxRedirects = 8) {
    if (maxRedirects === 0) {
        if (!res.headersSent) res.status(500).send('Download failed: too many redirects.');
        return;
    }
    const lib     = cdnUrl.startsWith('https') ? https : http;
    const reqOpts = {
        headers: {
            'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
            ...extraHeaders,
        },
    };
    const cdnReq = lib.get(cdnUrl, reqOpts, (cdnRes) => {
        // Follow redirects — TikTok CDN returns 302 to actual video
        if ([301, 302, 307, 308].includes(cdnRes.statusCode) && cdnRes.headers.location) {
            cdnRes.resume(); // discard redirect body
            console.log(`[CDN Redirect] ${cdnRes.statusCode} → ${cdnRes.headers.location.slice(0, 80)}...`);
            return pipeCdnUrl(cdnRes.headers.location, res, req, extraHeaders, maxRedirects - 1);
        }
        // Forward content-length so browser shows download progress
        const cl = cdnRes.headers['content-length'];
        if (cl) res.setHeader('Content-Length', cl);
        cdnRes.pipe(res);
    });
    cdnReq.on('error', (err) => {
        console.error('[CDN Pipe Error]:', err.message);
        if (!res.headersSent) res.status(500).send('Download failed.');
    });
    req.on('close', () => cdnReq.destroy());
}

// ─── Merge video+audio via yt-dlp+ffmpeg streaming ───────────────────────────
function spawnMergeStream(safeUrl, format, res, req, extraArgs = []) {
    const args = [
        safeUrl,
        '-f', format,
        '--no-warnings', '--no-check-certificate', '--no-playlist',
        '--ffmpeg-location', quoteArg(ffmpegPath),
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
    '--extractor-args', 'twitter:api=syndication',
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
            // Use tikwm.com API — works on datacenter IPs, removes watermark
            const tikwmData = await new Promise((resolve) => {
                const apiUrl = `https://www.tikwm.com/api/?url=${encodeURIComponent(safeUrl)}&hd=1`;
                https.get(apiUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (r) => {
                    let d = ''; r.on('data', c => d += c);
                    r.on('end', () => { try { const j = JSON.parse(d); resolve(j?.code === 0 ? j.data : null); } catch { resolve(null); } });
                }).on('error', () => resolve(null));
            });

            if (tikwmData) {
                console.log(`[DOWNLOAD] TikTok tikwm fields: hdplay=${!!tikwmData.hdplay} play=${!!tikwmData.play} music=${!!tikwmData.music}`);
                let cdnUrl;
                if (type === 'audio') {
                    cdnUrl = tikwmData.music || tikwmData.hdplay || tikwmData.play;
                    res.setHeader('Content-Type', 'audio/mpeg');
                    res.setHeader('Content-Disposition', `attachment; filename="doomsdaysnap_${Date.now()}.mp3"`);
                } else {
                    // Always prefer hdplay (HD no-watermark), fallback to play
                    cdnUrl = tikwmData.hdplay || tikwmData.play;
                    res.setHeader('Content-Type', 'video/mp4');
                    res.setHeader('Content-Disposition', `attachment; filename="doomsdaysnap_${Date.now()}.mp4"`);
                }
                if (cdnUrl) {
                    console.log(`[DOWNLOAD] TikTok → tikwm CDN (${type})`);
                    return pipeCdnUrl(cdnUrl, res, req, {
                        'Referer': 'https://www.tiktok.com/',
                    });
                }
            }
            // Fallback to yt-dlp
            console.log(`[DOWNLOAD] TikTok → yt-dlp fallback`);
            spawnMergeStream(safeUrl, format, res, req, TIKTOK_ARGS);
        } else if (isInstagram) {
            console.log(`[DOWNLOAD] Instagram → yt-dlp stream`);
            spawnMergeStream(safeUrl, format, res, req, INSTAGRAM_ARGS);
        } else if (isTwitter) {
            console.log(`[DOWNLOAD] Twitter/X → yt-dlp stream`);
            const twitterFormat = 'bestvideo+bestaudio/best';
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
