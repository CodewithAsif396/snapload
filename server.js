const express    = require('express');
const cors       = require('cors');
const path       = require('path');
const fs         = require('fs');
const https      = require('https');
const http       = require('http');
const { spawn }  = require('child_process');

const { sanitizeUrl }    = require('./utils/sanitizer');

// ─── Maintenance Mode ─────────────────────────────────────────────────────────
const MAINTENANCE_FILE   = path.join(__dirname, 'maintenance.json');

function loadMaintenance() {
    try { return JSON.parse(fs.readFileSync(MAINTENANCE_FILE, 'utf8')); }
    catch { return { global: false, pages: {}, message: 'Down for maintenance.', estimatedTime: '' }; }
}
function saveMaintenance(data) {
    fs.writeFileSync(MAINTENANCE_FILE, JSON.stringify(data, null, 2));
}
function isInMaintenance(pathname) {
    const m = loadMaintenance();
    if (m.global) return true;
    return m.pages?.[pathname] === true;
}
function maintenancePage(message, estimatedTime) {
    const eta = estimatedTime ? `<p class="eta">Estimated time: <strong>${estimatedTime}</strong></p>` : '';
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Under Maintenance — Doomsdaysnap</title>
<style>
  *{margin:0;padding:0;box-sizing:border-box}
  body{min-height:100vh;display:flex;align-items:center;justify-content:center;background:#0f0f0f;color:#fff;font-family:'Segoe UI',sans-serif;text-align:center;padding:20px}
  .card{max-width:480px;width:100%}
  .icon{font-size:80px;margin-bottom:24px;animation:spin 3s linear infinite}
  @keyframes spin{0%,100%{transform:rotate(0deg)}50%{transform:rotate(15deg)}75%{transform:rotate(-10deg)}}
  h1{font-size:2rem;font-weight:800;margin-bottom:12px;background:linear-gradient(135deg,#a855f7,#ec4899);-webkit-background-clip:text;-webkit-text-fill-color:transparent}
  p{color:#9ca3af;line-height:1.6;margin-bottom:8px;font-size:1rem}
  .eta{margin-top:16px;color:#d1d5db;font-size:.9rem}
  .eta strong{color:#a855f7}
  .back{display:inline-block;margin-top:28px;padding:12px 28px;background:linear-gradient(135deg,#7c3aed,#db2777);border-radius:12px;color:#fff;text-decoration:none;font-weight:600;font-size:.9rem;transition:opacity .2s}
  .back:hover{opacity:.85}
  .brand{margin-top:32px;color:#374151;font-size:.8rem}
  .brand span{color:#6b7280}
</style>
</head>
<body>
<div class="card">
  <div class="icon">🔧</div>
  <h1>Under Maintenance</h1>
  <p>${message || 'We\'re upgrading our systems to serve you better.'}</p>
  ${eta}
  <a href="/" class="back">← Back to Home</a>
  <p class="brand">Doomsdaysnap <span>· We'll be back soon</span></p>
</div>
</body>
</html>`;
}
const { getTikTokCdnUrl } = require('./utils/tiktokBrowser');
const { getRandomUA }     = require('./utils/userAgent');
const { cobaltExtract }       = require('./utils/cobalt');
const { facebookDirectExtract } = require('./utils/facebookDirect');

const ffmpegPath = require('ffmpeg-static');


// ── Provider imports — one file per platform ──────────────────────────────────
const YouTubeProvider  = require('./providers/YouTubeProvider');
const TikTokProvider   = require('./providers/TikTokProvider');
const InstagramProvider = require('./providers/InstagramProvider');
const TwitterProvider  = require('./providers/TwitterProvider');
const FacebookProvider = require('./providers/FacebookProvider');
const SocialProvider   = require('./providers/SocialProvider');   // Snapchat + generic

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
// Check multiple possible filenames (browser exports often add " (1)" suffix)
function findCookiesFile(...names) {
    for (const name of names) {
        const p = path.join(__dirname, name);
        if (fs.existsSync(p)) return p;
    }
    return null;
}

const COOKIES_FILE        = findCookiesFile('cookies.txt', 'cookies (1).txt', 'cookie.txt');
const COOKIES_ARGS = COOKIES_FILE
    ? ['--cookies', COOKIES_FILE]
    : [];

console.log('[Config] Using YTDLP:', YTDLP);
if (COOKIES_FILE) console.log('[Config] Cookies file:', COOKIES_FILE);


app.use(cors());
app.use(express.json({ limit: '10kb' }));
app.use(express.static(path.join(__dirname)));

// ─── Maintenance Middleware ───────────────────────────────────────────────────
// Intercepts page requests (not API/asset) and shows maintenance page if enabled.
app.use((req, res, next) => {
    const p = req.path;
    // Skip: API routes, static assets, admin, health check
    if (p.startsWith('/api/') || p.startsWith('/admin/') || p.startsWith('/social/')
        || p.startsWith('/proxy') || p.startsWith('/get_video')
        || p.match(/\.(js|css|png|jpg|jpeg|gif|ico|svg|woff|woff2|ttf|map|webp)$/)) {
        return next();
    }
    const m = loadMaintenance();
    const inMaintenance = m.global || m.pages?.[p] === true;
    if (inMaintenance) {
        return res.status(503).send(maintenancePage(m.message, m.estimatedTime));
    }
    next();
});



// ─── CDN URL Cache ─────────────────────────────────────────────────────────────
// Pre-fetched during /api/info so /api/download can start instantly (no second yt-dlp call).
const cdnCache = new Map();
const CDN_TTL  = 4 * 60 * 1000; // 4 minutes

function cdnCacheGet(key) {
    const e = cdnCache.get(key);
    if (!e) return null;
    if (Date.now() - e.ts > CDN_TTL) { cdnCache.delete(key); return null; }
    return e;
}
function cdnCacheSet(key, urls, headers = {}) {
    cdnCache.set(key, { urls, headers, ts: Date.now() });
    if (cdnCache.size > 300) { // keep map small
        const oldest = [...cdnCache.entries()].sort((a, b) => a[1].ts - b[1].ts)[0];
        if (oldest) cdnCache.delete(oldest[0]);
    }
}

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
    social:    new SocialProvider(),   // Snapchat + generic fallback
};

/**
 * Pick the right provider based on the URL domain.
 * Falls back to SocialProvider for Snapchat and unknown URLs.
 */
function getProvider(url) {
    if (url.includes('youtube.com') || url.includes('youtu.be'))        return providers.youtube;
    if (url.includes('tiktok.com'))                                      return providers.tiktok;
    if (url.includes('instagram.com'))                                   return providers.instagram;
    if (url.includes('x.com') || url.includes('twitter.com'))           return providers.twitter;
    if (url.includes('facebook.com') || url.includes('fb.watch'))       return providers.facebook;
    return providers.social; // handles Snapchat and any other URL
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
    fs.readFile(path.join(__dirname, 'app.html'), 'utf8', (err, data) => {
        if (err) return res.status(500).send('Error');
        
        // Hide small tab row for home page
        let modified = data.replace('id="platform-tabs-row"', 'id="platform-tabs-row" style="display:none !important"');
        
        // Hide downloader input on home page as per user request (Selection hub only)
        modified = modified.replace('id="downloader-input-section"', 'id="downloader-input-section" style="display:none !important"');
        modified = modified.replace('id="mobile-paste-sample-row"', 'id="mobile-paste-sample-row" style="display:none !important"');
        
        // Generate Large Premium Grid for Home Page
        const gridHtml = `
            <div class="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-4 sm:gap-6 stagger-reveal">
                ${Object.keys(PLATFORM_SEO_DATA).map(key => {
                    const p = PLATFORM_SEO_DATA[key];
                    const name = key.split('-')[0].charAt(0).toUpperCase() + key.split('-')[0].slice(1);
                    return `
                        <a href="/${key}" class="group relative flex flex-col items-center justify-center p-8 rounded-3xl glass-card border border-white/5 hover:border-white/20 transition-all duration-500 hover-lift overflow-hidden stagger-item">
                            <div class="absolute inset-0 bg-gradient-to-br ${p.bg.replace('10', '20')} opacity-0 group-hover:opacity-100 transition-opacity duration-500"></div>
                            <div class="relative z-10 w-20 h-20 rounded-2xl ${p.bg} flex items-center justify-center mb-6 transform group-hover:scale-110 transition-transform duration-500 shadow-xl shadow-black/20">
                                <i class="fa-brands ${p.icon} text-4xl ${p.color}"></i>
                            </div>
                            <h3 class="relative z-10 text-xl font-bold text-white mb-2 group-hover:text-purple-400 transition-colors">${name}</h3>
                            <p class="relative z-10 text-[10px] text-gray-500 uppercase tracking-widest font-semibold">Download Now</p>
                            <div class="absolute bottom-4 right-4 text-white/5 group-hover:text-white/20 transition-colors">
                                <i class="fa-solid fa-arrow-right-long text-xl"></i>
                            </div>
                        </a>
                    `;
                }).join('')}
            </div>
        `;
        
        modified = modified.replace('<!-- HOME_PLATFORM_GRID -->', gridHtml);
        
        // Ensure tool-specific sections are empty on home page
        modified = modified.replace('<!-- TOOL_STEPS -->', '');
        modified = modified.replace('<!-- TOOL_FAQ -->', '');
        modified = modified.replace('<!-- TOOL_GRID_ITEMS -->', '');
        modified = modified.replace('<!-- TOOL_RICH_CONTENT -->', '');
        
        res.send(modified);
    });
});

app.get('/app', (_req, res) => {
    res.redirect(301, '/');
});

// ─── Platform-specific SEO pages with Dynamic Metadata ────────────────────────
const PLATFORM_SEO_DATA = {
    'youtube-downloader': {
        title: 'YouTube Video Downloader - Download Shorts & HD Videos | Doomsdaysnap',
        desc: 'Fast and free YouTube video downloader. Download high-quality YouTube videos and Shorts in MP4 or MP3 format with Doomsdaysnap.',
        h1: 'YouTube Video Downloader',
        icon: 'fa-youtube', color: 'text-red-500', border: 'border-t-red-500/40', bg: 'bg-red-500/10',
        longContent: `
            <div class="prose prose-invert max-w-none">
                <p class="text-lg text-gray-300 leading-relaxed mb-6">
                    Doomsdaysnap is the premier destination for high-performance YouTube video downloads. Our engine is engineered to bypass complex platform restrictions, providing you with direct access to your favorite content in stunning 4K and 1080p resolutions. Whether you're looking to save a trending YouTube Short, a music video, or a long-form documentary, our tool ensures a lightning-fast experience with no watermark and zero registration required.
                </p>
                <div class="grid grid-cols-1 md:grid-cols-2 gap-8 my-10">
                    <div class="glass-card p-6 rounded-2xl">
                        <h3 class="text-xl font-bold mb-3 text-red-400">High-Resolution Downloads</h3>
                        <p class="text-gray-400 text-sm">We don't compromise on quality. If the source is 4K, you get 4K. Our tool fetches the highest bitrate streams available directly from the source.</p>
                    </div>
                    <div class="glass-card p-6 rounded-2xl">
                        <h3 class="text-xl font-bold mb-3 text-red-400">YouTube Shorts Specialist</h3>
                        <p class="text-gray-400 text-sm">Download unlimited YouTube Shorts in high definition. Our mobile-first design makes it incredibly easy to save Shorts directly to your phone's gallery.</p>
                    </div>
                </div>
                <p class="text-gray-400 leading-relaxed">
                    Why settle for low-quality screen recordings? With Doomsdaysnap, you get the actual file data. Our system analyzes the YouTube URL, identifies all available formats (MP4, WEBM, MP3), and presents them to you in an easy-to-use interface. It is 100% free, safe from malware, and compatible with all modern browsers across Windows, macOS, Android, and iOS.
                </p>
            </div>
        `,
        steps: [
            { icon: 'fa-copy', text: 'Copy YouTube URL', desc: 'Copy the link of the video or Short from YouTube.' },
            { icon: 'fa-paste', text: 'Paste in Search', desc: 'Paste the link into the box above and hit enter.' },
            { icon: 'fa-file-video', text: 'Select & Save', desc: 'Choose your quality (4K/1080p) or MP3 and download.' }
        ],
        faqs: [
            { q: "Can I download YouTube Shorts?", a: "Yes! Doomsdaysnap fully supports high-quality YouTube Shorts downloads without watermarks." },
            { q: "How to save YouTube as MP3?", a: "Simply paste the link and select the 'Audio/MP3' option from the result list." },
            { q: "Is 4K resolution supported?", a: "Yes, we fetch the highest available resolution, including 4K and 8K where available." },
            { q: "Do I need an account?", a: "No, our tool is 100% anonymous and requires no registration or login." },
            { q: "Is it free for unlimited use?", a: "Absolutely. You can download as many videos as you want without any cost." },
            { q: "How fast are the downloads?", a: "We use high-speed proxy servers to ensure you download at the maximum speed allowed by your ISP." },
            { q: "Does it work on mobile?", a: "Yes, Doomsdaysnap is fully optimized for Chrome, Safari, and other mobile browsers." },
            { q: "Are the downloads safe?", a: "Yes, we provide direct file links and do not serve intrusive ads or malware." },
            { q: "Can I download private videos?", a: "No, for security and privacy reasons, we only support public YouTube content." },
            { q: "Is there a browser extension?", a: "Currently, we focus on providing a perfect web experience that requires no installation." }
        ]
    },
    'tiktok-downloader': {
        title: 'TikTok Video Downloader Without Watermark - Fast & HD | Doomsdaysnap',
        desc: 'Download TikTok videos without watermark in HD quality. The best TikTok downloader tool for watermark-free videos on mobile and PC.',
        h1: 'TikTok Video Downloader',
        icon: 'fa-tiktok', color: 'text-white', border: 'border-t-[#25F4EE]/40', bg: 'bg-[#25F4EE]/10',
        longContent: `
            <div class="prose prose-invert max-w-none">
                <p class="text-lg text-gray-300 leading-relaxed mb-6">
                    Tired of TikTok logos ruining your edits? Doomsdaysnap offers a professional-grade solution for downloading TikTok videos without watermarks. Our unique extraction technology identifies the original source file before TikTok applies its overlay, giving you the cleanest possible footage for your own projects or offline viewing.
                </p>
                <div class="grid grid-cols-1 md:grid-cols-2 gap-8 my-10">
                    <div class="glass-card p-6 rounded-2xl border-l-4 border-[#25F4EE]">
                        <h3 class="text-xl font-bold mb-3 text-[#25F4EE]">Watermark Free</h3>
                        <p class="text-gray-400 text-sm">Our most popular feature. Download any public TikTok and receive the clean, original version instantly.</p>
                    </div>
                    <div class="glass-card p-6 rounded-2xl border-l-4 border-[#FE2C55]">
                        <h3 class="text-xl font-bold mb-3 text-[#FE2C55]">Audio Extraction</h3>
                        <p class="text-gray-400 text-sm">Love a TikTok sound? Use our tool to convert any TikTok video into a high-quality MP3 file in seconds.</p>
                    </div>
                </div>
                <p class="text-gray-400 leading-relaxed">
                    Social media managers and creators trust Doomsdaysnap for its reliability and speed. Simply copy the link from the TikTok app, paste it here, and our servers will handle the rest. No apps to install, no annoying ads—just pure, high-definition content delivered straight to your device.
                </p>
            </div>
        `,
        steps: [
            { icon: 'fa-copy', text: 'Copy TikTok Link', desc: 'Tap Share on the TikTok app and select Copy Link.' },
            { icon: 'fa-bolt', text: 'Extract Video', desc: 'Paste the link above; our engine removes the watermark instantly.' },
            { icon: 'fa-check', text: 'Download No-Watermark', desc: 'Save the clean, original-quality video to your device.' }
        ],
        faqs: [
            { q: "Is the video really watermark-free?", a: "Yes, we fetch the original HD source before TikTok's branding is applied." },
            { q: "Can I download TikTok on iPhone?", a: "Yes, use our website in Safari and the video will save to your Photos or Files app." },
            { q: "Is there a limit on downloads?", a: "No, there are zero limits. You can download 100s of videos daily for free." },
            { q: "Can I save TikTok as MP3?", a: "Yes, we provide high-bitrate MP3 download options for every video." },
            { q: "Is my history saved?", a: "No, your privacy is our priority. We do not track or store your download history." },
            { q: "Do I need to sign in to TikTok?", a: "No, the tool works perfectly without any TikTok account required." },
            { q: "What if the video is private?", a: "We can only download public videos. If the account is private, we cannot access the content." },
            { q: "Is the quality changed?", a: "No, we provide the original file quality as uploaded by the creator." },
            { q: "Does it work for TikTok Slideshows?", a: "Yes, we can extract the images or the generated video from slideshows." },
            { q: "Is it safe to use?", a: "100%. We use secure connections and don't require any personal info." }
        ]
    },
    'instagram-downloader': {
        title: 'Instagram Reels & Video Downloader - Fast & HD | Doomsdaysnap',
        desc: 'Download Instagram Reels, videos, and IGTV posts instantly. Free HD Instagram downloader for high-quality content extraction.',
        h1: 'Instagram Video Downloader',
        icon: 'fa-instagram', color: 'text-pink-500', border: 'border-t-pink-500/40', bg: 'bg-pink-500/10',
        longContent: `
            <div class="prose prose-invert max-w-none">
                <p class="text-lg text-gray-300 leading-relaxed mb-6">
                    Capture the best of Instagram with Doomsdaysnap. Our Instagram downloader is optimized for Reels, Stories, and Long-form videos. We understand that Instagram's interface can make saving content difficult, so we've built a one-click solution that provides the highest resolution MP4 files available.
                </p>
                <div class="grid grid-cols-1 md:grid-cols-2 gap-8 my-10">
                    <div class="glass-card p-6 rounded-2xl border-t-2 border-pink-500/50">
                        <h3 class="text-xl font-bold mb-3 text-pink-400">Reels Downloader</h3>
                        <p class="text-gray-400 text-sm">Save any Instagram Reel in full HD. Perfect for keeping your favorite creators' content for offline inspiration.</p>
                    </div>
                    <div class="glass-card p-6 rounded-2xl border-t-2 border-orange-500/50">
                        <h3 class="text-xl font-bold mb-3 text-orange-400">Story Saver</h3>
                        <p class="text-gray-400 text-sm">Download public Instagram stories before they disappear. Stay up to date with the latest content easily.</p>
                    </div>
                </div>
                <p class="text-gray-400 leading-relaxed">
                    Our tool is designed to be as simple as possible. No need to deal with cluttered apps or "log-in to continue" prompts. Instagram content is vibrant and visual; our downloader ensures that every pixel is preserved during the transfer to your device.
                </p>
            </div>
        `,
        steps: [
            { icon: 'fa-copy', text: 'Copy Instagram URL', desc: 'Copy the link of the Reel, Story, or Video from Instagram.' },
            { icon: 'fa-wand-magic-sparkles', text: 'Fetch Content', desc: 'Paste the link above and our engine will grab the high-res file.' },
            { icon: 'fa-download', text: 'Save to Device', desc: 'Hit Download to save the Instagram video in its highest quality.' }
        ],
        faqs: [
            { q: "Can I download Instagram Reels?", a: "Yes, we support all Reels, Stories, and regular feed videos." },
            { q: "Does the user know I downloaded?", a: "No, our service is completely anonymous and private." },
            { q: "Is HD quality maintained?", a: "Absolutely. We fetch the original resolution from Instagram's servers." },
            { q: "Can I download from private accounts?", a: "No, for safety and legal reasons, only public content is supported." },
            { q: "Is it safe for my device?", a: "Yes, we use secure SSL and provide direct file links with no malware." },
            { q: "Can I download multiple videos?", a: "Yes, there is no cooling-off period. Download as much as you want." },
            { q: "How to save videos to iPad?", a: "Follow the same process as iPhone: use Safari and save to Files or Photos." },
            { q: "Are Stories supported?", a: "Yes, as long as the story is from a public profile." },
            { q: "Do you store the videos?", a: "No, we act as a bridge. Videos are fetched and served directly to you." },
            { q: "What format are the videos?", a: "All videos are saved in the universal MP4 format, playable anywhere." }
        ]
    },
    'twitter-downloader': {
        title: 'Twitter Video Downloader - Download X Videos HD | Doomsdaysnap',
        desc: 'Free Twitter (X) video downloader. Save videos and GIFs from Twitter in high-resolution MP4 format quickly and easily.',
        h1: 'Twitter Video Downloader',
        icon: 'fa-x-twitter', color: 'text-white', border: 'border-t-white/20', bg: 'bg-white/10',
        longContent: `
            <div class="prose prose-invert max-w-none">
                <p class="text-lg text-gray-300 leading-relaxed mb-6">
                    X (formerly Twitter) is the pulse of the internet, where breaking news and viral moments happen first. Doomsdaysnap's Twitter Video Downloader allows you to archive those fleeting moments in high definition. We provide multiple resolution options for every tweet, ensuring you can choose between data-saving SD or crystal-clear HD quality.
                </p>
                <div class="grid grid-cols-1 md:grid-cols-2 gap-8 my-10">
                    <div class="glass-card p-6 rounded-2xl border-l-4 border-gray-400">
                        <h3 class="text-xl font-bold mb-3 text-white">X GIF Conversion</h3>
                        <p class="text-gray-400 text-sm">Twitter GIFs are technically served as small video loops. Our tool converts these back into native MP4 files so you can share them across any messaging platform without quality loss.</p>
                    </div>
                </div>
                <p class="text-gray-400 leading-relaxed">
                    Whether you're looking to save a thread's video or a viral clip from your feed, our X downloader is optimized for speed and reliability. Simply copy the post link, paste it above, and enjoy instant access to your media.
                </p>
            </div>
        `,
        steps: [
            { icon: 'fa-copy', text: 'Copy Post Link', desc: 'Tap the Share icon on an X post and select Copy Link.' },
            { icon: 'fa-magnifying-glass', text: 'Analyze Tweet', desc: 'Paste the link above to extract the video or GIF content.' },
            { icon: 'fa-file-arrow-down', text: 'Download MP4', desc: 'Choose your desired resolution and save the X video instantly.' }
        ],
        faqs: [
            { q: "Does it work for X (Twitter) GIFs?", a: "Yes, Doomsdaysnap can save X GIFs as high-quality MP4 files." },
            { q: "Can I download long videos?", a: "Yes, any duration is supported as long as it is a public post." },
            { q: "Is 1080p resolution available?", a: "We provide the highest possible resolution offered by X for that specific post." },
            { q: "Do I need to log in to X?", a: "No login is required to use our Twitter downloader." },
            { q: "Is the service free?", a: "100% free with no hidden charges or premium versions." },
            { q: "How to save videos on Android?", a: "Paste the link in Chrome, select quality, and it will save to your downloads folder." },
            { q: "Can I download from private accounts?", a: "No, we cannot access videos protected by privacy settings." },
            { q: "Are there any size limits?", a: "Currently, we support videos up to 1GB in size." },
            { q: "Why did my download fail?", a: "The tweet might have been deleted, or the user restricted access. Try another link." },
            { q: "Is it safe to use?", a: "Yes, we don't ask for any permissions or social media API access." }
        ]
    },
    'facebook-downloader': {
        title: 'Facebook Video Downloader - Download FB Reels & Videos | Doomsdaysnap',
        desc: 'The best Facebook video downloader for Reels and public videos. Download Facebook videos in HD quality instantly with Doomsdaysnap.',
        h1: 'Facebook Video Downloader',
        icon: 'fa-facebook', color: 'text-blue-500', border: 'border-t-blue-500/40', bg: 'bg-blue-500/10',
        longContent: `
            <div class="prose prose-invert max-w-none">
                <p class="text-lg text-gray-300 leading-relaxed mb-6">
                    Facebook Reels and Videos contain a massive library of tutorials, entertainment, and memories. Doomsdaysnap provides a seamless way to save these videos directly to your device. We use advanced scraping technology to find the high-bitrate HD mirrors of public Facebook videos.
                </p>
                <div class="grid grid-cols-1 md:grid-cols-2 gap-8 my-10">
                    <div class="glass-card p-6 rounded-2xl border-l-4 border-blue-600">
                        <h3 class="text-xl font-bold mb-3 text-blue-400">FB Reels HD</h3>
                        <p class="text-gray-400 text-sm">Download the latest trending Facebook Reels in crisp 1080p quality with absolute zero quality loss during the process.</p>
                    </div>
                    <div class="glass-card p-6 rounded-2xl border-l-4 border-blue-300">
                        <h3 class="text-xl font-bold mb-3 text-blue-300">Facebook Watch Archive</h3>
                        <p class="text-gray-400 text-sm">Easily save long-form content from Facebook Watch for offline viewing on your commute or at home.</p>
                    </div>
                </div>
                 <p class="text-gray-400 leading-relaxed">
                    Our Facebook tool is designed for compatibility. Whether the video is on a public page, a group, or a user's timeline, our engine identifies the safest and fastest route to the source file.
                </p>
            </div>
        `,
        steps: [
            { icon: 'fa-copy', text: 'Copy FB Link', desc: 'Click Share on any Facebook Video or Reel and select Copy Link.' },
            { icon: 'fa-server', text: 'Ready HD Link', desc: 'Paste the link above for our engine to identify the HD source mirror.' },
            { icon: 'fa-circle-check', text: 'Save Video', desc: 'Select HD or SD quality and save it to your local gallery or desktop.' }
        ],
        faqs: [
            { q: "Can I download Facebook Reels?", a: "Yes, we fully support the new Facebook Reels format in HD quality." },
            { q: "How to download in HD?", a: "Paste the link and look for the 'HD Quality' tag in the results list provided." },
            { q: "Are private videos supported?", a: "No, we only support public Facebook videos for privacy compliance." },
            { q: "Is it compatible with Android?", a: "Yes, works perfectly on all Android phones using Chrome or Edge." },
            { q: "Do I need to install an app?", a: "No, Doomsdaysnap is a 100% web-based tool. No installation needed." },
            { q: "Can I save long FB videos?", a: "Yes, there are no duration limits for public videos on our platform." },
            { q: "Is the video quality lowered?", a: "No, we provide the exact same file that Facebook serves to its users." },
            { q: "Can I download from groups?", a: "Yes, if the group is public, the downloader will work instantly." },
            { q: "How to save on iPhone?", a: "Use Safari, paste the link, and choose 'Download' when prompt appears." },
            { q: "Is it free for commercial use?", a: "Please check the original creator's copyright. Our tool is for personal use." }
        ]
    },
    'snapchat-downloader': {
        title: 'Snapchat Video Downloader - Save Snapchat Spotlight | Doomsdaysnap',
        desc: 'Download Snapchat Spotlight videos and public stories. Free Snapchat downloader for high-quality video extraction without limits.',
        h1: 'Snapchat Video Downloader',
        icon: 'fa-snapchat', color: 'text-yellow-400', border: 'border-t-yellow-400/40', bg: 'bg-yellow-400/10',
        longContent: `
             <div class="prose prose-invert max-w-none">
                <p class="text-lg text-gray-300 leading-relaxed mb-6">
                    Snapchat Spotlights and Public Stories are ephemeral by design, but some memories deserve to be saved. Doomsdaysnap's Snapchat Downloader allows you to keep those public snaps permanently. By using the official public sharing link, we extract the high-quality MP4 file for you to store safely on your device.
                </p>
                <div class="grid grid-cols-1 md:grid-cols-2 gap-8 my-10">
                    <div class="glass-card p-6 rounded-2xl border-l-4 border-yellow-400">
                        <h3 class="text-xl font-bold mb-3 text-yellow-400">Spotlight Extractor</h3>
                        <p class="text-gray-400 text-sm">Archive the latest viral Snapchat Spotlights in 1080p directly to your device with one click.</p>
                    </div>
                </div>
                <p class="text-gray-400 leading-relaxed">
                    Our platform respects user privacy; therefore, we only facilitate the download of content intended for public sharing through Snapchat's web portals. No login is required, ensuring your account details remain private.
                </p>
            </div>
        `,
        steps: [
            { icon: 'fa-copy', text: 'Share Spotlight', desc: 'On Snapchat, tap the Share icon on a Spotlight and select Copy Link.' },
            { icon: 'fa-link', text: 'Paste URL', desc: 'Put the link in the search bar above and let us process the Snap.' },
            { icon: 'fa-save', text: 'Save Snap', desc: 'Download the Spotlight video in its original crisp quality.' }
        ],
        faqs: [
            { q: "Can I save Snapchat Spotlight videos?", a: "Yes! Doomsdaysnap is specifically optimized for Spotlight downloads." },
            { q: "Is it safe to use?", a: "Yes, we use the legal public sharing API to fetch the videos safely." },
            { q: "Does Snapchat notify the user?", a: "No, because we access the public URL, no notification is sent." },
            { q: "What quality are the Snaps?", a: "Most public Spotlights are 1080p, and we provide that exact file." },
            { q: "Is there a limit?", a: "No, feel free to archive as many public snaps as you wish." },
            { q: "Can I download private stories?", a: "No, only publicly shared stories and spotlights are accessible." },
            { q: "Do I need to login?", a: "Never. We do not require any of your Snapchat credentials." },
            { q: "Does it work on Mac?", a: "Yes, works on any desktop or mobile browser." },
            { q: "How long does it take?", a: "Usually under 2 seconds for a standard-length snap." },
            { q: "Is it compatible with iOS?", a: "Yes, Safari on iOS 13+ supports direct downloads flawlessly." }
        ]
    },
};

const PLATFORM_ROUTES = Object.keys(PLATFORM_SEO_DATA).map(key => `/${key}`);

PLATFORM_ROUTES.forEach(route => {
    app.get(route, (req, res) => {
        const platformKey = req.path.replace('/', '');
        const seo = PLATFORM_SEO_DATA[platformKey];

        if (!seo) {
            return res.sendFile(path.join(__dirname, 'app.html'));
        }

        // Read app.html and replace metadata markers
        fs.readFile(path.join(__dirname, 'app.html'), 'utf8', (err, data) => {
            if (err) return res.status(500).send('Error loading page');

            let modifiedContent = data;
            
            // Replace Title / Meta
            modifiedContent = modifiedContent
                .replace(/<title>.*?<\/title>/, `<title>${seo.title}</title>`)
                .replace(/<meta name="description" content=".*?">/, `<meta name="description" content="${seo.desc}">`)
                .replace(/<meta property="og:title" content=".*?">/, `<meta property="og:title" content="${seo.title}">`)
                .replace(/<link rel="canonical" href=".*?">/, `<link rel="canonical" href="https://doomsdaysnap.online${route}">`);

            // Update H1 and Platform Title
            modifiedContent = modifiedContent.replace(
                /<h1 id="main-title".*?>.*?<\/h1>/s,
                `<h1 id="main-title" class="text-4xl sm:text-5xl md:text-7xl font-extrabold tracking-tight mb-4 sm:mb-6 leading-tight">${seo.h1}</h1>`
            );

            // Hide home-specific grid container on tool pages
            modifiedContent = modifiedContent.replace('id="home-platform-grid"', 'id="home-platform-grid" style="display:none !important"');

            // Hide tab row as requested for a cleaner look on specific pages
            // We use a regex to find the div with the specific ID and inject a hidden class or style
            modifiedContent = modifiedContent.replace(
                /id="platform-tabs-row"/g,
                'id="platform-tabs-row" style="display:none !important"'
            );

            // INJECT STEPS
            const stepsHtml = `
                <div class="hidden md:block absolute top-12 left-[15%] right-[15%] h-px bg-gradient-to-r from-purple-500/0 via-purple-500/40 to-pink-500/0"></div>
                ${seo.steps.map((s, idx) => `
                    <div class="relative z-10 flex flex-col items-center stagger-item">
                        <div class="w-24 h-24 rounded-2xl glass-card hover-lift flex items-center justify-center mb-6 shadow-[0_0_30px_rgba(168,85,247,0.2)]">
                            <i class="fa-solid ${s.icon} text-4xl text-purple-400"></i>
                        </div>
                        <h4 class="text-xl font-bold mb-2">${idx + 1}. ${s.text}</h4>
                        <p class="text-gray-400 text-sm px-4">${s.desc}</p>
                    </div>
                `).join('')}
            `;
            modifiedContent = modifiedContent.replace('<!-- TOOL_STEPS -->', stepsHtml);

            // INJECT FAQ
            const faqHtml = seo.faqs.map(f => `
                <div class="glass-card rounded-xl overflow-hidden hover-lift stagger-item">
                    <button class="faq-btn w-full px-6 py-4 text-left flex justify-between items-center focus:outline-none">
                        <span class="font-semibold text-gray-200">${f.q}</span>
                        <i class="fa-solid fa-chevron-down text-gray-500 transition-transform duration-300 flex-shrink-0 ml-4"></i>
                    </button>
                    <div class="faq-content hidden px-6 pb-5 text-gray-400 text-sm leading-relaxed border-t border-white/5 pt-4">
                        ${f.a}
                    </div>
                </div>
            `).join('');
            modifiedContent = modifiedContent.replace('<!-- TOOL_FAQ -->', faqHtml);

            // INJECT OTHER TOOLS GRID
            const otherTools = Object.keys(PLATFORM_SEO_DATA)
                .filter(key => key !== platformKey)
                .map(key => {
                    const p = PLATFORM_SEO_DATA[key];
                    return `
                        <a href="/${key}" class="glass-card rounded-2xl p-5 hover-lift transition-all duration-300 border-t-2 ${p.border} stagger-item">
                            <div class="w-10 h-10 rounded-full ${p.bg} flex items-center justify-center mb-4">
                                <i class="fa-brands ${p.icon} text-xl ${p.color}"></i>
                            </div>
                            <h3 class="text-base font-bold mb-1 text-white">${key.split('-')[0].charAt(0).toUpperCase() + key.split('-')[0].slice(1)}</h3>
                            <p class="text-gray-400 text-xs">${p.desc.split('.')[0]}.</p>
                        </a>
                    `;
                }).join('');
            modifiedContent = modifiedContent.replace('<!-- TOOL_GRID_ITEMS -->', otherTools);

            // INJECT RICH SEO CONTENT
            const richHtml = `
                <div class="flex flex-col gap-12">
                    <div class="space-y-8">
                        <div class="flex items-center gap-4 mb-2">
                             <div class="w-12 h-12 rounded-xl ${seo.bg} flex items-center justify-center shadow-lg">
                                <i class="fa-brands ${seo.icon} text-2xl ${seo.color}"></i>
                            </div>
                            <h2 class="text-3xl md:text-4xl font-extrabold">Professional ${seo.h1.split(' ')[0]} Downloader</h2>
                        </div>
                        ${seo.longContent}
                    </div>
                    
                    <!-- Top 3 Features Grid -->
                    <div class="grid grid-cols-1 md:grid-cols-3 gap-6">
                        ${seo.faqs.slice(0, 3).map(f => `
                            <div class="glass-card p-6 rounded-2xl border-b-2 ${seo.border}">
                                <div class="w-8 h-8 rounded-full bg-white/5 flex items-center justify-center mb-4">
                                    <i class="fa-solid fa-check text-purple-400 text-sm"></i>
                                </div>
                                <h4 class="text-white font-bold mb-2">${f.q}</h4>
                                <p class="text-gray-500 text-sm leading-relaxed">${f.a}</p>
                            </div>
                        `).join('')}
                    </div>
                </div>
            `;
            modifiedContent = modifiedContent.replace('<!-- TOOL_RICH_CONTENT -->', richHtml);

            res.send(modifiedContent);
        });
    });
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
  ${PLATFORM_ROUTES.map(route => `<url><loc>${base}${route}</loc><lastmod>${now}</lastmod><priority>0.8</priority><changefreq>weekly</changefreq></url>`).join('\n  ')}
</urlset>`);
});

app.get('/robots.txt', (_req, res) => {
    const base = process.env.SITE_URL || 'https://doomsdaysnap.online';
    res.header('Content-Type', 'text/plain');
    res.send(`User-agent: *\nAllow: /\nDisallow: /api/\nSitemap: ${base}/sitemap.xml`);
});

// ─── Background CDN pre-fetch ─────────────────────────────────────────────────
// Called after /api/info succeeds. Resolves the best-quality CDN URL and caches
// it so the next /api/download call returns immediately (no second yt-dlp run).
async function preFetchCdnUrl(safeUrl, info) {
    const isFB   = safeUrl.includes('facebook.com') || safeUrl.includes('fb.watch');
    const isSnap = safeUrl.includes('snapchat.com');

    if (!isFB && !isSnap) return; // only needed for slow platforms

    const referer = isFB ? 'https://www.facebook.com/' : 'https://www.snapchat.com/';

    // For FB / Snapchat: run yt-dlp --get-url in background
    const extraArgs = ['--referer', referer, '--merge-output-format', 'mp4'];
    if (COOKIES_FILE) extraArgs.push('--cookies', COOKIES_FILE);

    const fmt = info?.formats?.[0]?.fid
        ? `${info.formats[0].fid}+bestaudio/best`
        : 'bestvideo[ext=mp4]+bestaudio/best[ext=mp4]/best';

    const urls = await getDirectUrls(safeUrl, fmt, extraArgs);
    if (urls.length > 0) {
        cdnCacheSet(safeUrl, urls, { 'Referer': referer });
        console.log(`[Cache] Pre-fetched ${urls.length} CDN URL(s) for ${safeUrl.slice(0, 60)}`);
    }
}

// Info — metadata only, nothing stored
app.post('/api/info', rateLimit, async (req, res) => {
    try {
        const { url } = req.body;
        if (!validateUrl(url)) {
            return res.status(400).json({ error: 'Please provide a valid video URL.' });
        }
        const safeUrl  = sanitizeUrl(url);
        const isTikTok = safeUrl.includes('tiktok.com');
        const provider = getProvider(safeUrl);
        console.log(`[INFO] ${provider.constructor.name} → ${safeUrl}`);
        const info = await provider.getInfo(safeUrl);

        // TikTok: replace compressed bitrateInfo formats with single Original Quality option
        if (isTikTok) {
            info.formats = [
                { label: 'Original Quality', ext: 'mp4', height: 'original', size: null },
            ];
            info.audioFormats = info.audioFormats || [];
        }

        // Pre-fetch CDN URL in background so /api/download is instant
        if (!isTikTok) setImmediate(() => preFetchCdnUrl(safeUrl, info).catch(() => {}));

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
        return res.status(500).json({ error: msg, details: m.slice(0, 300) });
    }
});

// Platform-specific extra args for download
const YT_ARGS = [
    '--extractor-args', 'youtube:player_client=android,web',
    '--add-header', 'User-Agent:Mozilla/5.0 (Linux; Android 11; Pixel 5) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/90.0.4430.91 Mobile Safari/537.36',
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
// ─── Direct-then-merge helper ─────────────────────────────────────────────────
// Used for Instagram, Twitter, Facebook, Snapchat.
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

            // ── VIDEO: tikwm task API → original quality _original.mp4 ──────────
            console.log('[DOWNLOAD] TikTok → tikwm task API (original quality)');
            const tikwmOriginal = await (async () => {
                try {
                    // Step 1: submit task
                    const postData = `url=${encodeURIComponent(safeUrl)}&web=1`;
                    const submitRes = await new Promise((resolve) => {
                        const opts = {
                            hostname: 'www.tikwm.com', path: '/api/video/task/submit',
                            method: 'POST',
                            headers: {
                                'Content-Type': 'application/x-www-form-urlencoded',
                                'Content-Length': Buffer.byteLength(postData),
                                'User-Agent': 'Mozilla/5.0',
                            },
                        };
                        const req2 = https.request(opts, (r) => {
                            let d = ''; r.on('data', c => d += c);
                            r.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve(null); } });
                        });
                        req2.on('error', () => resolve(null));
                        req2.write(postData); req2.end();
                    });
                    console.log('[DOWNLOAD] tikwm submit:', JSON.stringify(submitRes)?.slice(0, 120));
                    if (submitRes?.code !== 0 || !submitRes?.data?.task_id) return null;
                    const taskId = submitRes.data.task_id;
                    // Step 2: poll for result (max 30s)
                    for (let i = 0; i < 15; i++) {
                        await new Promise(r => setTimeout(r, 2000));
                        const result = await new Promise((resolve) => {
                            https.get(`https://www.tikwm.com/api/video/task/result?task_id=${taskId}`,
                                { headers: { 'User-Agent': 'Mozilla/5.0' } }, (r) => {
                                let d = ''; r.on('data', c => d += c);
                                r.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve(null); } });
                            }).on('error', () => resolve(null));
                        });
                        if (result?.code === 0) {
                            const status = result.data?.status;
                            console.log(`[DOWNLOAD] tikwm poll ${i+1}: status=${status}`);
                            if (status === 2) {
                                const detail = result.data.detail;
                                return detail?.play_url || detail?.download_url || null;
                            }
                            if (status === 3) return null;
                        }
                    }
                } catch (e) {
                    console.error('[DOWNLOAD] tikwm task error:', e.message);
                }
                return null;
            })();

            if (tikwmOriginal) {
                console.log('[DOWNLOAD] tikwm original URL:', tikwmOriginal.slice(0, 100));
                const ok = await pipeCdnUrl(tikwmOriginal, res, req, {
                    'Referer': 'https://www.tiktok.com/',
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
                });
                if (ok) return;
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

        } else if (isFacebook || isSnapchat) {
            const uaData  = getRandomUA();
            const referer = isFacebook ? 'https://www.facebook.com/' : 'https://www.snapchat.com/';

            const ytdlpArgs = [
                '--user-agent', uaData.ua,
                '--referer', referer,
                '--merge-output-format', 'mp4',
                '--no-check-certificate',
                '--force-ipv4',
                '--geo-bypass',
            ];
            if (COOKIES_FILE) ytdlpArgs.push('--cookies', COOKIES_FILE);
            const cdnHeaders = { 'User-Agent': uaData.ua, 'Referer': referer };

            const platform = isFacebook ? 'facebook' : 'snapchat';

            // ── helper: call social_server and proxy the result ───────────────
            async function trySocialServer() {
                const body = JSON.stringify({ url: safeUrl });
                const result = await new Promise((resolve) => {
                    const r2 = http.request(
                        { hostname: '127.0.0.1', port: SOCIAL_PORT, path: '/social/download',
                          method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } },
                        (r) => { let d = ''; r.on('data', c => d += c); r.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve(null); } }); }
                    );
                    r2.on('error', () => resolve(null));
                    setTimeout(() => resolve(null), 25000);
                    r2.write(body); r2.end();
                });
                if (!result?.video_url) return false;

                console.log(`[DOWNLOAD] social_server ok → proxying ${platform}`);
                return new Promise((resolve) => {
                    const proxyPath = `/social/proxy?url=${encodeURIComponent(result.video_url)}&platform=${platform}`;
                    const pr = http.request(
                        { hostname: '127.0.0.1', port: SOCIAL_PORT, path: proxyPath, method: 'GET' },
                        (r) => {
                            if (r.statusCode !== 200 && r.statusCode !== 206) { r.resume(); resolve(false); return; }
                            const h = { 'Content-Type': 'video/mp4', 'Accept-Ranges': 'bytes',
                                        'Content-Disposition': `attachment; filename="${platform}_video.mp4"` };
                            if (r.headers['content-length']) h['Content-Length'] = r.headers['content-length'];
                            res.writeHead(200, h);
                            r.pipe(res);
                            r.on('end', () => resolve(true));
                            r.on('error', () => resolve(false));
                        }
                    );
                    pr.on('error', () => resolve(false));
                    pr.end();
                });
            }

            // ── Facebook: direct scraper → yt-dlp → social_server → cobalt ──
            if (isFacebook) {
                // Step 1: Node.js-native scrapers (snapsave, fdownloader, getfvid, savefrom, fdown) in parallel
                console.log('[DOWNLOAD] Facebook → direct scrapers (parallel)');
                const directUrl = await facebookDirectExtract(safeUrl).catch(() => null);
                if (directUrl) {
                    const ok = await pipeCdnUrl(directUrl, res, req, { 'Referer': 'https://www.facebook.com/' });
                    if (ok) return;
                    console.log('[DOWNLOAD] FB direct URL got but CDN rejected → continuing fallbacks');
                }

                // Step 2: yt-dlp --get-url with cookies
                console.log('[DOWNLOAD] Facebook → yt-dlp with cookies');
                const urls = await getDirectUrls(safeUrl, format, ytdlpArgs);
                if (urls.length === 1) {
                    const ok = await pipeCdnUrl(urls[0], res, req, cdnHeaders);
                    if (ok) return;
                } else if (urls.length >= 2) {
                    spawnMergeStream(safeUrl, format, res, req, ytdlpArgs);
                    return;
                }

                // Step 3: social_server (Python fallback)
                console.log('[DOWNLOAD] Facebook → social_server');
                const socialOk = await trySocialServer();
                if (socialOk) return;

                // Step 4: cobalt
                console.log('[DOWNLOAD] Facebook → cobalt');
                const cobalt = await cobaltExtract(safeUrl).catch(() => null);
                if (cobalt?.url) {
                    const ok = await pipeCdnUrl(cobalt.url, res, req, cdnHeaders);
                    if (ok) return;
                }

                // Step 5: yt-dlp spawnMerge (absolute last resort)
                console.log('[DOWNLOAD] Facebook → yt-dlp spawnMerge (last resort)');
                if (!res.headersSent) spawnMergeStream(safeUrl, format, res, req, ytdlpArgs);
                return;
            }

            // ── Snapchat: social_server → cobalt → yt-dlp ────────────────────
            console.log('[DOWNLOAD] Snapchat → social_server');
            const snapSocialOk = await trySocialServer();
            if (snapSocialOk) return;

            console.log('[DOWNLOAD] Snapchat social_server failed → cobalt');
            const cobaltSnap = await cobaltExtract(safeUrl).catch(() => null);
            if (cobaltSnap?.url) {
                const ok = await pipeCdnUrl(cobaltSnap.url, res, req, cdnHeaders);
                if (ok) return;
            }
            if (!res.headersSent) spawnMergeStream(safeUrl, format, res, req, ytdlpArgs);

        } else {
            console.log(`[DOWNLOAD] generic → yt-dlp stream`);
            spawnMergeStream(safeUrl, format, res, req);
        }

    } catch (err) {
        console.error('[DOWNLOAD Error]:', err.message);
        if (!res.headersSent) res.status(500).send('Download failed. Please try again.');
    }
});

// ─── TikTok Original Downloader Page ─────────────────────────────────────────
const FLASK_PORT = 5000;

app.get('/tiktok-downloader', (req, res) => {
    res.send(`<!DOCTYPE html>
<html lang="en" class="dark">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>TikTok Original Downloader — Doomsdaysnap</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800&display=swap" rel="stylesheet">
<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.1/css/all.min.css">
<script src="https://cdn.tailwindcss.com"></script>
<script>tailwind.config={darkMode:'class',theme:{extend:{fontFamily:{sans:['Inter','sans-serif']}}}}</script>
<style>
  html,body{overflow-x:hidden;background:#0f0f0f;color:#fff;font-family:'Inter',sans-serif}
  .gradient-text{background:linear-gradient(135deg,#fe2c55,#ff6b35);-webkit-background-clip:text;-webkit-text-fill-color:transparent}
  .glass{background:rgba(255,255,255,0.05);backdrop-filter:blur(10px);border:1px solid rgba(255,255,255,0.1)}
  .btn-primary{background:linear-gradient(135deg,#fe2c55,#ff4757);transition:all .3s}
  .btn-primary:hover{transform:translateY(-2px);box-shadow:0 8px 25px rgba(254,44,85,0.4)}
  .btn-dl{background:linear-gradient(135deg,#00c853,#00e676);transition:all .3s}
  .btn-dl:hover{transform:translateY(-2px);box-shadow:0 8px 25px rgba(0,200,83,0.4)}
  #spinner{display:none}
</style>
</head>
<body class="min-h-screen flex flex-col">

<!-- Nav -->
<nav class="glass sticky top-0 z-50 px-6 py-4 flex items-center justify-between">
  <a href="/" class="flex items-center gap-2 text-xl font-bold">
    <i class="fa-solid fa-bolt text-pink-500"></i>
    <span class="gradient-text">Doomsdaysnap</span>
  </a>
  <a href="/" class="text-sm text-gray-400 hover:text-white transition">← Back to Home</a>
</nav>

<!-- Hero -->
<main class="flex-1 flex flex-col items-center px-4 pt-16 pb-20">
  <div class="text-center mb-10">
    <div class="inline-flex items-center gap-2 bg-pink-500/10 border border-pink-500/30 rounded-full px-4 py-1.5 text-sm text-pink-400 mb-6">
      <i class="fab fa-tiktok"></i> Original Quality · No Watermark
    </div>
    <h1 class="text-4xl md:text-5xl font-extrabold mb-4">
      TikTok <span class="gradient-text">Original</span> Downloader
    </h1>
    <p class="text-gray-400 text-lg max-w-xl mx-auto">
      Download TikTok videos in original source quality — same file the creator uploaded.
    </p>
  </div>

  <!-- Input Box -->
  <div class="w-full max-w-2xl glass rounded-2xl p-6 mb-8">
    <div class="flex gap-3">
      <div class="flex-1 flex items-center gap-3 bg-white/5 border border-white/10 rounded-xl px-4">
        <i class="fab fa-tiktok text-pink-500 text-lg"></i>
        <input id="urlInput" type="text" placeholder="Paste TikTok video URL here..."
          class="flex-1 bg-transparent py-4 text-sm outline-none placeholder-gray-500"
          onkeydown="if(event.key==='Enter')fetchVideo()">
      </div>
      <button onclick="fetchVideo()" class="btn-primary text-white font-semibold px-6 py-4 rounded-xl flex items-center gap-2 whitespace-nowrap">
        <i class="fa-solid fa-magnifying-glass"></i>
        <span>Fetch Video</span>
      </button>
    </div>
  </div>

  <!-- Spinner -->
  <div id="spinner" class="flex flex-col items-center gap-4 my-8">
    <div class="w-12 h-12 border-4 border-pink-500/30 border-t-pink-500 rounded-full animate-spin"></div>
    <p class="text-gray-400 text-sm">Fetching original quality... this may take 20-30 seconds</p>
  </div>

  <!-- Result -->
  <div id="result" class="w-full max-w-2xl"></div>

  <!-- How it works -->
  <div class="w-full max-w-2xl mt-16 grid grid-cols-1 md:grid-cols-3 gap-4">
    <div class="glass rounded-xl p-5 text-center">
      <div class="text-3xl mb-3">📋</div>
      <h3 class="font-semibold mb-1">Paste URL</h3>
      <p class="text-gray-400 text-sm">Copy any TikTok video link</p>
    </div>
    <div class="glass rounded-xl p-5 text-center">
      <div class="text-3xl mb-3">⚡</div>
      <h3 class="font-semibold mb-1">Fetch Video</h3>
      <p class="text-gray-400 text-sm">We get the original source file</p>
    </div>
    <div class="glass rounded-xl p-5 text-center">
      <div class="text-3xl mb-3">💾</div>
      <h3 class="font-semibold mb-1">Download</h3>
      <p class="text-gray-400 text-sm">Save in full original quality</p>
    </div>
  </div>
</main>

<script>
async function fetchVideo() {
  const url = document.getElementById('urlInput').value.trim();
  if (!url) { showError('Please paste a TikTok URL first.'); return; }

  document.getElementById('result').innerHTML = '';
  document.getElementById('spinner').style.display = 'flex';

  try {
    const res = await fetch('/get_video', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, session_id: '' })
    });
    const data = await res.json();
    document.getElementById('spinner').style.display = 'none';

    if (data.error) { showError(data.error); return; }

    const sizeTxt = data.size_mb && data.size_mb !== '?' ? data.size_mb + ' MB' : 'Original';
    document.getElementById('result').innerHTML = \`
      <div class="glass rounded-2xl p-6 animate-fade-in">
        <div class="flex gap-5 items-start">
          <img src="\${data.cover}" alt="cover" class="w-24 h-24 object-cover rounded-xl flex-shrink-0">
          <div class="flex-1 min-w-0">
            <h2 class="font-bold text-lg leading-snug mb-1 line-clamp-2">\${data.title || 'TikTok Video'}</h2>
            <p class="text-gray-400 text-sm mb-1">@\${data.author || ''}</p>
            <span class="inline-flex items-center gap-1.5 bg-pink-500/10 border border-pink-500/30 text-pink-400 text-xs rounded-full px-3 py-1">
              <i class="fa-solid fa-star text-xs"></i> Original Quality · \${sizeTxt}
            </span>
          </div>
        </div>
        <div class="mt-5">
          <a href="/proxy?url=\${encodeURIComponent(data.video_url)}&session="
             class="btn-dl w-full flex items-center justify-center gap-2 text-white font-bold py-4 rounded-xl text-base"
             download="tiktok_original.mp4">
            <i class="fa-solid fa-download"></i>
            Download Original MP4
          </a>
        </div>
      </div>
    \`;
  } catch(e) {
    document.getElementById('spinner').style.display = 'none';
    showError('Something went wrong. Please try again.');
  }
}

function showError(msg) {
  document.getElementById('spinner').style.display = 'none';
  document.getElementById('result').innerHTML = \`
    <div class="glass border border-red-500/30 rounded-2xl p-5 text-center">
      <i class="fa-solid fa-circle-exclamation text-red-400 text-2xl mb-3"></i>
      <p class="text-red-400">\${msg}</p>
    </div>
  \`;
}
</script>
</body>
</html>`);
});

app.post('/get_video', (req, res) => {
    const body = JSON.stringify(req.body);
    const opts = {
        hostname: '127.0.0.1', port: FLASK_PORT, path: '/get_video', method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    };
    const proxy = http.request(opts, (r) => {
        res.writeHead(r.statusCode, r.headers);
        r.pipe(res);
    });
    proxy.on('error', () => res.status(503).json({ error: 'TikTok service unavailable' }));
    proxy.write(body);
    proxy.end();
});

app.get('/proxy', (req, res) => {
    const qs = new URLSearchParams(req.query).toString();
    const opts = { hostname: '127.0.0.1', port: FLASK_PORT, path: `/proxy?${qs}`, method: 'GET' };
    const proxy = http.request(opts, (r) => {
        res.writeHead(r.statusCode, r.headers);
        r.pipe(res);
    });
    proxy.on('error', () => res.status(503).send('TikTok service unavailable'));
    proxy.end();
});

// ─── Social Python proxy (Facebook/Snapchat) ─────────────────────────────────
const SOCIAL_PORT = 5001;

app.post('/social/download', (req, res) => {
    const body = JSON.stringify(req.body);
    const opts = {
        hostname: '127.0.0.1', port: SOCIAL_PORT, path: '/social/download', method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    };
    const proxy = http.request(opts, (r) => { res.writeHead(r.statusCode, r.headers); r.pipe(res); });
    proxy.on('error', () => res.status(503).json({ error: 'Social downloader unavailable' }));
    proxy.write(body); proxy.end();
});

app.get('/social/proxy', (req, res) => {
    const qs = new URLSearchParams(req.query).toString();
    const proxy = http.request(
        { hostname: '127.0.0.1', port: SOCIAL_PORT, path: `/social/proxy?${qs}`, method: 'GET' },
        (r) => { res.writeHead(r.statusCode, r.headers); r.pipe(res); }
    );
    proxy.on('error', () => res.status(503).send('Social downloader unavailable'));
    proxy.end();
});

app.listen(PORT, () => {
    console.log(`🚀 Doomsdaysnap running at http://localhost:${PORT}`);
});
