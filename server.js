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

const YTDLP = path.join(
    __dirname, 'node_modules', 'youtube-dl-exec', 'bin', 'yt-dlp.exe'
);

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
            '--extractor-args', 'youtube:player_client=tv_embedded,ios,mweb',
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
function pipeCdnUrl(cdnUrl, res, req, extraHeaders = {}) {
    const lib     = cdnUrl.startsWith('https') ? https : http;
    const reqOpts = {
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            ...extraHeaders,
        },
    };
    const cdnReq = lib.get(cdnUrl, reqOpts, (cdnRes) => {
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
        '--ffmpeg-location', ffmpegPath,
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
    res.sendFile(path.join(__dirname, 'index.html'));
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

// ─── Platform-specific extra args for download ───────────────────────────────
const YT_ARGS = [
    '--extractor-args', 'youtube:player_client=tv_embedded,ios,mweb',
];
const TIKTOK_ARGS = [
    '--add-header', 'referer:https://www.tiktok.com/',
    '--add-header', 'origin:https://www.tiktok.com',
    '--add-header', 'user-agent:Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
    '--extractor-args', 'tiktok:api_hostname=api22-normal-c-useast2a.tiktokv.com',
    '--no-check-formats',
];
const INSTAGRAM_ARGS = [
    '--add-header', 'referer:https://www.instagram.com/',
    '--add-header', 'origin:https://www.instagram.com',
];
const TWITTER_ARGS = [
    '--add-header', 'referer:https://x.com/',
    '--add-header', 'origin:https://x.com',
    '--extractor-args', 'twitter:api=syndication',
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

    const filename = `snapload_${Date.now()}.${ext}`;

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
            console.log(`[DOWNLOAD] TikTok → yt-dlp stream`);
            spawnMergeStream(safeUrl, format, res, req, TIKTOK_ARGS);
        } else if (isInstagram) {
            console.log(`[DOWNLOAD] Instagram → yt-dlp stream`);
            spawnMergeStream(safeUrl, format, res, req, INSTAGRAM_ARGS);
        } else if (isTwitter) {
            console.log(`[DOWNLOAD] Twitter/X → yt-dlp stream`);
            spawnMergeStream(safeUrl, format, res, req, TWITTER_ARGS);
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
    console.log(`🚀 SnapLoad running at http://localhost:${PORT}`);
});
