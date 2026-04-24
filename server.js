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
function getPythonCommand() {
    if (process.platform === 'win32') return 'python';
    try {
        const { execSync } = require('child_process');
        execSync('python3 --version', { stdio: 'ignore' });
        return 'python3';
    } catch {
        return 'python';
    }
}
const YTDLP = getPythonCommand(); // Auto-detect python vs python3
const YTDLP_IS_MODULE = true; 


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

        // ── FAQPage + WebSite schema for home ──
        const homeFaqSchema = {
            "@context": "https://schema.org",
            "@type": "FAQPage",
            "mainEntity": [
                { "@type": "Question", "name": "What is Doomsdaysnap?", "acceptedAnswer": { "@type": "Answer", "text": "Doomsdaysnap is a free online video downloader that supports YouTube, TikTok, Instagram, Twitter/X, Facebook, and Snapchat. No sign-up required." } },
                { "@type": "Question", "name": "Is Doomsdaysnap free to use?", "acceptedAnswer": { "@type": "Answer", "text": "Yes, Doomsdaysnap is 100% free with no usage limits, no registration, and no hidden fees." } },
                { "@type": "Question", "name": "Can I download TikTok videos without watermark?", "acceptedAnswer": { "@type": "Answer", "text": "Yes. Doomsdaysnap fetches the original source file before TikTok applies its watermark overlay, so downloads are completely watermark-free." } },
                { "@type": "Question", "name": "Does Doomsdaysnap support 4K video downloads?", "acceptedAnswer": { "@type": "Answer", "text": "Yes, Doomsdaysnap supports 4K and 1080p HD downloads from YouTube and other platforms when the original content is available in those resolutions." } },
                { "@type": "Question", "name": "Do I need to install any software?", "acceptedAnswer": { "@type": "Answer", "text": "No installation needed. Doomsdaysnap is a browser-based tool that works on all devices including Android, iPhone, Windows, and Mac." } },
                { "@type": "Question", "name": "Can I convert YouTube videos to MP3?", "acceptedAnswer": { "@type": "Answer", "text": "Yes. After pasting a YouTube link, select the Audio/MP3 option to extract the audio track in high quality." } },
                { "@type": "Question", "name": "Which platforms does Doomsdaysnap support?", "acceptedAnswer": { "@type": "Answer", "text": "Doomsdaysnap supports YouTube, TikTok, Instagram Reels, Twitter/X, Facebook, and Snapchat Spotlights." } },
                { "@type": "Question", "name": "Is it safe to use Doomsdaysnap?", "acceptedAnswer": { "@type": "Answer", "text": "Yes. Doomsdaysnap never stores your downloads, does not serve malware, and never asks for your social media credentials." } }
            ]
        };
        const websiteSchema = {
            "@context": "https://schema.org",
            "@type": "WebSite",
            "name": "Doomsdaysnap",
            "url": "https://doomsdaysnap.online",
            "potentialAction": {
                "@type": "SearchAction",
                "target": { "@type": "EntryPoint", "urlTemplate": "https://doomsdaysnap.online/?url={search_term_string}" },
                "query-input": "required name=search_term_string"
            }
        };
        const schemaInject = `\n<script type="application/ld+json">${JSON.stringify(homeFaqSchema)}</script>\n<script type="application/ld+json">${JSON.stringify(websiteSchema)}</script>`;

        // ── Platform grid HTML for HOME_PLATFORM_GRID ──
        const platformGridHtml = `
            <div class="mt-16 sm:mt-20">
                <div class="text-center mb-10">
                    <h2 class="text-3xl font-bold mb-3">All Downloader Tools</h2>
                    <p class="text-gray-400 max-w-xl mx-auto text-sm">One platform for all your video saving needs. Choose your source below.</p>
                </div>
                <div class="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-4 stagger-reveal">
                    <a href="/youtube-downloader" class="glass-card rounded-2xl p-5 flex flex-col items-center text-center hover-lift border-t-2 border-t-red-500/40" style="text-decoration:none">
                        <div class="w-12 h-12 rounded-full bg-red-500/10 flex items-center justify-center mb-3"><i class="fa-brands fa-youtube text-2xl text-red-500"></i></div>
                        <span class="text-white font-bold text-sm mb-1">YouTube</span>
                        <span class="text-gray-500 text-xs">4K · MP4 · MP3</span>
                    </a>
                    <a href="/tiktok-downloader" class="glass-card rounded-2xl p-5 flex flex-col items-center text-center hover-lift border-t-2 border-t-[#25F4EE]/40" style="text-decoration:none">
                        <div class="w-12 h-12 rounded-full bg-[#25F4EE]/10 flex items-center justify-center mb-3"><i class="fa-brands fa-tiktok text-2xl text-white"></i></div>
                        <span class="text-white font-bold text-sm mb-1">TikTok</span>
                        <span class="text-gray-500 text-xs">No Watermark · HD</span>
                    </a>
                    <a href="/instagram-downloader" class="glass-card rounded-2xl p-5 flex flex-col items-center text-center hover-lift border-t-2 border-t-pink-500/40" style="text-decoration:none">
                        <div class="w-12 h-12 rounded-full bg-pink-500/10 flex items-center justify-center mb-3"><i class="fa-brands fa-instagram text-2xl text-pink-500"></i></div>
                        <span class="text-white font-bold text-sm mb-1">Instagram</span>
                        <span class="text-gray-500 text-xs">Reels · IGTV · Posts</span>
                    </a>
                    <a href="/twitter-downloader" class="glass-card rounded-2xl p-5 flex flex-col items-center text-center hover-lift border-t-2 border-t-gray-500/40" style="text-decoration:none">
                        <div class="w-12 h-12 rounded-full bg-gray-500/10 flex items-center justify-center mb-3"><i class="fa-brands fa-x-twitter text-2xl text-white"></i></div>
                        <span class="text-white font-bold text-sm mb-1">Twitter / X</span>
                        <span class="text-gray-500 text-xs">HD · GIFs · Clips</span>
                    </a>
                    <a href="/facebook-downloader" class="glass-card rounded-2xl p-5 flex flex-col items-center text-center hover-lift border-t-2 border-t-blue-500/40" style="text-decoration:none">
                        <div class="w-12 h-12 rounded-full bg-blue-500/10 flex items-center justify-center mb-3"><i class="fa-brands fa-facebook text-2xl text-blue-500"></i></div>
                        <span class="text-white font-bold text-sm mb-1">Facebook</span>
                        <span class="text-gray-500 text-xs">Public · Reels · Watch</span>
                    </a>
                    <a href="/snapchat-downloader" class="glass-card rounded-2xl p-5 flex flex-col items-center text-center hover-lift border-t-2 border-t-yellow-400/40" style="text-decoration:none">
                        <div class="w-12 h-12 rounded-full bg-yellow-400/10 flex items-center justify-center mb-3"><i class="fa-brands fa-snapchat text-2xl text-yellow-400"></i></div>
                        <span class="text-white font-bold text-sm mb-1">Snapchat</span>
                        <span class="text-gray-500 text-xs">Spotlight · Stories</span>
                    </a>
                </div>
                <div class="grid grid-cols-1 sm:grid-cols-3 gap-4 mt-6">
                    <a href="/youtube-to-mp3" class="glass-card rounded-2xl p-5 flex items-center gap-4 hover-lift" style="text-decoration:none">
                        <div class="w-10 h-10 rounded-xl bg-red-500/10 flex items-center justify-center flex-shrink-0"><i class="fa-solid fa-music text-red-400"></i></div>
                        <div><span class="text-white font-bold text-sm block">YouTube to MP3</span><span class="text-gray-500 text-xs">Extract audio free</span></div>
                    </a>
                    <a href="/shorts-downloader" class="glass-card rounded-2xl p-5 flex items-center gap-4 hover-lift" style="text-decoration:none">
                        <div class="w-10 h-10 rounded-xl bg-red-500/10 flex items-center justify-center flex-shrink-0"><i class="fa-brands fa-youtube text-red-400"></i></div>
                        <div><span class="text-white font-bold text-sm block">Shorts Downloader</span><span class="text-gray-500 text-xs">Save YouTube Shorts HD</span></div>
                    </a>
                    <a href="/reels-downloader" class="glass-card rounded-2xl p-5 flex items-center gap-4 hover-lift" style="text-decoration:none">
                        <div class="w-10 h-10 rounded-xl bg-pink-500/10 flex items-center justify-center flex-shrink-0"><i class="fa-brands fa-instagram text-pink-400"></i></div>
                        <div><span class="text-white font-bold text-sm block">Reels Downloader</span><span class="text-gray-500 text-xs">Instagram Reels in HD</span></div>
                    </a>
                </div>
            </div>
        `;

        // ── Home FAQ section HTML ──
        const homeFaqHtml = `
            <section class="max-w-3xl mx-auto px-4 sm:px-6 py-10">
                <div class="text-center mb-8">
                    <h2 class="text-3xl font-bold mb-3">Frequently Asked Questions</h2>
                    <p class="text-gray-400 text-sm">Everything you need to know about Doomsdaysnap.</p>
                </div>
                <div class="space-y-3">
                    <div class="glass-card rounded-xl overflow-hidden hover-lift stagger-item"><button class="faq-btn w-full px-6 py-4 text-left flex justify-between items-center focus:outline-none"><span class="font-semibold text-gray-200">Is Doomsdaysnap completely free?</span><i class="fa-solid fa-chevron-down text-gray-500 transition-transform duration-300 flex-shrink-0 ml-4"></i></button><div class="faq-content hidden px-6 pb-5 text-gray-400 text-sm leading-relaxed border-t border-white/5 pt-4">Yes, 100% free with no usage limits, no registration, and no hidden fees. Download as many videos as you need.</div></div>
                    <div class="glass-card rounded-xl overflow-hidden hover-lift stagger-item"><button class="faq-btn w-full px-6 py-4 text-left flex justify-between items-center focus:outline-none"><span class="font-semibold text-gray-200">Can I download TikTok videos without watermark?</span><i class="fa-solid fa-chevron-down text-gray-500 transition-transform duration-300 flex-shrink-0 ml-4"></i></button><div class="faq-content hidden px-6 pb-5 text-gray-400 text-sm leading-relaxed border-t border-white/5 pt-4">Yes. Our engine fetches the original video file before TikTok overlays its watermark, giving you a completely clean download.</div></div>
                    <div class="glass-card rounded-xl overflow-hidden hover-lift stagger-item"><button class="faq-btn w-full px-6 py-4 text-left flex justify-between items-center focus:outline-none"><span class="font-semibold text-gray-200">Does it support 4K YouTube downloads?</span><i class="fa-solid fa-chevron-down text-gray-500 transition-transform duration-300 flex-shrink-0 ml-4"></i></button><div class="faq-content hidden px-6 pb-5 text-gray-400 text-sm leading-relaxed border-t border-white/5 pt-4">Yes. We fetch the highest quality stream available — including 4K/2160p and 1080p Full HD when the original video supports it.</div></div>
                    <div class="glass-card rounded-xl overflow-hidden hover-lift stagger-item"><button class="faq-btn w-full px-6 py-4 text-left flex justify-between items-center focus:outline-none"><span class="font-semibold text-gray-200">Do I need to install any software?</span><i class="fa-solid fa-chevron-down text-gray-500 transition-transform duration-300 flex-shrink-0 ml-4"></i></button><div class="faq-content hidden px-6 pb-5 text-gray-400 text-sm leading-relaxed border-t border-white/5 pt-4">No installation required. Doomsdaysnap works entirely in your browser on all devices — Android, iPhone, Windows, Mac, and Linux.</div></div>
                    <div class="glass-card rounded-xl overflow-hidden hover-lift stagger-item"><button class="faq-btn w-full px-6 py-4 text-left flex justify-between items-center focus:outline-none"><span class="font-semibold text-gray-200">Can I convert YouTube videos to MP3?</span><i class="fa-solid fa-chevron-down text-gray-500 transition-transform duration-300 flex-shrink-0 ml-4"></i></button><div class="faq-content hidden px-6 pb-5 text-gray-400 text-sm leading-relaxed border-t border-white/5 pt-4">Absolutely. Paste a YouTube link and choose the Audio/MP3 option. You'll get the highest-quality audio stream available.</div></div>
                    <div class="glass-card rounded-xl overflow-hidden hover-lift stagger-item"><button class="faq-btn w-full px-6 py-4 text-left flex justify-between items-center focus:outline-none"><span class="font-semibold text-gray-200">Which platforms are supported?</span><i class="fa-solid fa-chevron-down text-gray-500 transition-transform duration-300 flex-shrink-0 ml-4"></i></button><div class="faq-content hidden px-6 pb-5 text-gray-400 text-sm leading-relaxed border-t border-white/5 pt-4">YouTube, TikTok, Instagram Reels, Twitter/X, Facebook, and Snapchat Spotlights are all fully supported.</div></div>
                    <div class="glass-card rounded-xl overflow-hidden hover-lift stagger-item"><button class="faq-btn w-full px-6 py-4 text-left flex justify-between items-center focus:outline-none"><span class="font-semibold text-gray-200">Is it safe and private?</span><i class="fa-solid fa-chevron-down text-gray-500 transition-transform duration-300 flex-shrink-0 ml-4"></i></button><div class="faq-content hidden px-6 pb-5 text-gray-400 text-sm leading-relaxed border-t border-white/5 pt-4">Yes. We never store your downloads, never log your activity, and never ask for social media credentials. Your privacy is our priority.</div></div>
                </div>
            </section>
        `;

        // ── Blog preview section ──
        const blogPreviewHtml = `
            <section class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-10 border-t border-white/5">
                <div class="text-center mb-8">
                    <h2 class="text-3xl font-bold mb-3 reveal">Latest Guides & Tips</h2>
                    <p class="text-gray-400 max-w-xl mx-auto reveal delay-100 text-sm">Learn how to download videos from every platform.</p>
                </div>
                <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-5 stagger-reveal">
                    ${BLOG_POSTS.slice(0, 4).map(p => `
                    <a href="/blog/${p.slug}" class="glass-card rounded-2xl p-5 hover-lift stagger-item flex flex-col" style="text-decoration:none">
                        <span class="text-xs text-purple-400 font-semibold uppercase mb-2">${p.category}</span>
                        <h3 class="text-white font-bold text-sm leading-snug mb-2 flex-1">${p.title}</h3>
                        <span class="text-gray-600 text-xs mt-auto">${p.readTime}</span>
                    </a>`).join('')}
                </div>
                <div class="text-center mt-8">
                    <a href="/blog" class="inline-flex items-center gap-2 text-purple-400 hover:text-purple-300 font-semibold text-sm transition-colors" style="text-decoration:none">
                        View All Guides <i class="fa-solid fa-arrow-right text-xs"></i>
                    </a>
                </div>
            </section>
        `;

        // Hide small tab row for home page but KEEP the main search interaction
        let modified = data.replace('id="platform-tabs-row"', 'id="platform-tabs-row" style="display:none !important"');

        // Inject FAQ + WebSite schema into <head>
        modified = modified.replace('</head>', `${schemaInject}\n</head>`);

        // Restore essential sections for Home Page functionality
        modified = modified.replace('id="downloader-input-section" style="display:none !important"', 'id="downloader-input-section"');
        modified = modified.replace('id="mobile-paste-sample-row" style="display:none !important"', 'id="mobile-paste-sample-row"');

        // Inject platform grid into home-platform-grid div
        modified = modified.replace('<!-- HOME_PLATFORM_GRID -->', platformGridHtml);

        // Inject FAQ section replacing TOOL_FAQ placeholder
        modified = modified.replace('<!-- TOOL_FAQ -->', homeFaqHtml);

        // Inject blog preview replacing TOOL_RICH_CONTENT
        modified = modified.replace('<!-- TOOL_RICH_CONTENT -->', blogPreviewHtml);

        // Clear unused placeholders
        modified = modified.replace('<!-- TOOL_STEPS -->', '');
        modified = modified.replace('<!-- TOOL_GRID_ITEMS -->', '');
        modified = modified.replace('<!-- LEGAL_CONTENT -->', '');
        // Clear remaining HOME_PLATFORM_GRID comments (non-div ones)
        modified = modified.replace(/<!-- HOME_PLATFORM_GRID -->/g, '');

        res.send(modified);
    });
});

// ─── Legal Pages ─────────────────────────────────────────────────────────────
// ─── Legal Pages ─────────────────────────────────────────────────────────────
const LEGAL_DATA = {
    'privacy': {
        title: 'Privacy Policy | Doomsdaysnap',
        desc: 'Learn about how Doomsdaysnap handles privacy and data protection.',
        h1: 'Privacy Policy',
        content: `
            <div class="space-y-2">
                <section class="m-0 p-0">
                    <h2 class="text-base font-bold text-white m-0 p-0 mb-0.5">1. Data Collection</h2>
                    <p class="text-gray-400 text-xs leading-normal m-0 p-0">Doomsdaysnap is a privacy-first platform. We do NOT store personal data, IP addresses, or video download history on our servers. All video processing is performed in temporary memory and never persisted.</p>
                </section>
                <section class="m-0 p-0 mt-2">
                    <h2 class="text-base font-bold text-white m-0 p-0 mb-0.5">2. Cookies & Analytics</h2>
                    <p class="text-gray-400 text-xs leading-normal m-0 p-0">We use standard Google Analytics to understand platform performance. No personally identifiable information is shared with third parties. You can opt-out by disabling cookies in your browser.</p>
                </section>
                <section class="m-0 p-0 mt-2">
                    <h2 class="text-base font-bold text-white m-0 p-0 mb-0.5">3. External Links</h2>
                    <p class="text-gray-400 text-xs leading-normal m-0 p-0">Our service allows you to download content from third-party platforms like YouTube and TikTok. We are not responsible for the privacy practices of those external sites.</p>
                </section>
            </div>
        `
    },
    'tos': {
        title: 'Terms of Service | Doomsdaysnap',
        desc: 'Read the terms and conditions for using Doomsdaysnap services.',
        h1: 'Terms of Service',
        content: `
            <div class="space-y-2">
                <section class="m-0 p-0">
                    <h2 class="text-base font-bold text-white m-0 p-0 mb-0.5">1. Service Usage</h2>
                    <p class="text-gray-400 text-xs leading-normal m-0 p-0">Doomsdaysnap provides a tool to download publicly available media. By using this service, you agree to comply with all applicable copyright laws and regulations.</p>
                </section>
                <section class="m-0 p-0 mt-2">
                    <h2 class="text-base font-bold text-white m-0 p-0 mb-0.5">2. Personal Use</h2>
                    <p class="text-gray-400 text-xs leading-normal m-0 p-0">Our service is intended for personal, non-commercial use only. You may not use this platform to bypass encryption or access private content.</p>
                </section>
                <section class="m-0 p-0 mt-2">
                    <h2 class="text-base font-bold text-white m-0 p-0 mb-0.5">3. Disclaimer</h2>
                    <p class="text-gray-400 text-xs leading-normal m-0 p-0">The service is provided "as is" without warranty of any kind. Doomsdaysnap is not affiliated with YouTube, TikTok, Facebook, or any other social media platform.</p>
                </section>
            </div>
        `
    }
};

['privacy', 'tos'].forEach(slug => {
    app.get(`/${slug}`, (_req, res) => {
        const legal = LEGAL_DATA[slug];
        if (!legal) return res.status(404).send('Not Found');

        fs.readFile(path.join(__dirname, 'app.html'), 'utf8', (err, data) => {
            if (err) return res.status(500).send('Error');
            
            let modified = data
                .replace(/<title>.*?<\/title>/, `<title>${legal.title}</title>`)
                .replace(/<meta name="description" content=".*?">/, `<meta name="description" content="${legal.desc}">`)
                .replace('id="downloader-input-section"', 'id="downloader-input-section" style="display:none !important"')
                .replace('id="hero-header"', 'id="hero-header" style="display:none !important"')
                .replace('id="mobile-paste-sample-row"', 'id="mobile-paste-sample-row" style="display:none !important"')
                .replace(/<!-- HOME_PLATFORM_GRID -->/g, '') // Hide Why Choose etc.
                .replace('<!-- TOOL_STEPS -->', '')
                .replace('<!-- TOOL_FAQ -->', '')
                .replace('<!-- TOOL_GRID_ITEMS -->', '')
                .replace('<!-- TOOL_RICH_CONTENT -->', `
                    <div class="max-w-4xl mx-auto py-3 px-6 bg-white/5 rounded-2xl border border-white/10 backdrop-blur-xl m-0">
                        <h1 class="text-2xl font-black text-white m-0 p-0 gradient-text text-center pb-2">${legal.h1}</h1>
                        <hr class="border-white/10 mb-3">
                        ${legal.content}
                        <div class="mt-4 pt-2 border-t border-white/10 text-center">
                            <a href="/" class="text-[10px] text-gray-500 hover:text-white transition-all uppercase tracking-widest leading-none">← Back</a>
                        </div>
                    </div>
                `);
            
            res.send(modified);
        });
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

// ─── Blog / Article SEO Data ──────────────────────────────────────────────────
const BLOG_POSTS = [
    {
        slug: 'how-to-download-youtube-videos-4k',
        title: 'How to Download YouTube Videos in 4K for Free (2026 Guide)',
        desc: 'Learn the easiest way to download YouTube videos in 4K Ultra HD quality for free. Step-by-step guide using Doomsdaysnap — no software needed.',
        date: '2026-04-10',
        readTime: '6 min read',
        category: 'YouTube',
        keywords: 'download youtube videos 4k, youtube 4k downloader free, save youtube 4k video, how to download youtube in 4k',
        content: `
            <p class="text-lg text-gray-300 leading-relaxed mb-6">Downloading YouTube videos in 4K Ultra HD used to require expensive software. In 2026, the fastest and easiest method is to use a free online tool like <strong class="text-white">Doomsdaysnap</strong> — no installation required, no watermarks, and no registration.</p>
            <h2 class="text-2xl font-bold text-white mb-4 mt-10">Why Download YouTube Videos in 4K?</h2>
            <p class="text-gray-400 leading-relaxed mb-6">Whether you are a content creator who needs reference footage, a student archiving educational content, or simply someone who wants to watch videos offline during a flight — 4K downloads ensure the sharpest image quality on any screen. A 4K YouTube video at 3840×2160 resolution offers four times the pixel density of Full HD, meaning every detail is crystal clear on a 4K monitor or modern TV.</p>
            <h2 class="text-2xl font-bold text-white mb-4 mt-10">Step-by-Step: Download YouTube 4K Video with Doomsdaysnap</h2>
            <ol class="list-decimal list-inside text-gray-400 space-y-4 mb-6 ml-2">
                <li><strong class="text-white">Open YouTube</strong> and navigate to the 4K video you want to download. Look for videos tagged with "4K" or "2160p".</li>
                <li><strong class="text-white">Copy the URL</strong> from your browser address bar (e.g., <code class="text-purple-400 bg-white/5 px-1 rounded">https://www.youtube.com/watch?v=XXXXX</code>).</li>
                <li><strong class="text-white">Visit Doomsdaysnap</strong> at <a href="https://doomsdaysnap.online" class="text-purple-400 underline">doomsdaysnap.online</a> and paste your link in the search box.</li>
                <li><strong class="text-white">Select 4K (2160p)</strong> from the list of available quality options.</li>
                <li><strong class="text-white">Click Download</strong> and the file will start saving directly to your device.</li>
            </ol>
            <h2 class="text-2xl font-bold text-white mb-4 mt-10">What Formats Are Available?</h2>
            <p class="text-gray-400 leading-relaxed mb-4">Doomsdaysnap provides multiple formats for every video:</p>
            <ul class="list-disc list-inside text-gray-400 space-y-2 mb-6 ml-2">
                <li><strong class="text-white">4K MP4 (2160p)</strong> — Best quality for modern TVs and monitors</li>
                <li><strong class="text-white">1080p Full HD MP4</strong> — Perfect balance of quality and file size</li>
                <li><strong class="text-white">720p HD MP4</strong> — Great for mobile devices and data saving</li>
                <li><strong class="text-white">MP3 Audio</strong> — Extract just the audio from any YouTube video</li>
                <li><strong class="text-white">WEBM</strong> — Open-source format with excellent compression</li>
            </ul>
            <h2 class="text-2xl font-bold text-white mb-4 mt-10">Does Doomsdaysnap Support YouTube Shorts in 4K?</h2>
            <p class="text-gray-400 leading-relaxed mb-6">Yes! YouTube Shorts are supported too. Simply paste the Shorts URL (which looks like <code class="text-purple-400 bg-white/5 px-1 rounded">https://www.youtube.com/shorts/XXXXX</code>) and choose your preferred quality. Most Shorts are uploaded in 1080p vertical format, so that will typically be the highest option available.</p>
            <h2 class="text-2xl font-bold text-white mb-4 mt-10">Tips for the Best 4K Download Experience</h2>
            <ul class="list-disc list-inside text-gray-400 space-y-2 mb-6 ml-2">
                <li>Make sure you have a stable internet connection — 4K files can be 1GB or more.</li>
                <li>Use a desktop browser for the fastest download speeds.</li>
                <li>If 4K is not listed, the original uploader may not have uploaded in 4K.</li>
                <li>Doomsdaysnap always fetches the highest available stream directly from YouTube servers.</li>
            </ul>
            <h2 class="text-2xl font-bold text-white mb-4 mt-10">Frequently Asked Questions</h2>
            <div class="space-y-4 mb-6">
                <div class="bg-white/5 rounded-xl p-5"><p class="font-semibold text-white mb-1">Is it free to download YouTube 4K videos?</p><p class="text-gray-400 text-sm">Yes, Doomsdaysnap is completely free with no usage limits or hidden fees.</p></div>
                <div class="bg-white/5 rounded-xl p-5"><p class="font-semibold text-white mb-1">Do I need to install any software?</p><p class="text-gray-400 text-sm">No. Doomsdaysnap works entirely in your browser — no downloads or extensions required.</p></div>
                <div class="bg-white/5 rounded-xl p-5"><p class="font-semibold text-white mb-1">How long does the download take?</p><p class="text-gray-400 text-sm">Processing takes 2–10 seconds. The actual file transfer depends on your internet speed and the video length.</p></div>
            </div>
        `
    },
    {
        slug: 'tiktok-video-download-without-watermark',
        title: 'How to Download TikTok Videos Without Watermark (2026)',
        desc: 'Remove the TikTok watermark and download any TikTok video in HD quality for free. The complete guide using Doomsdaysnap.',
        date: '2026-04-08',
        readTime: '5 min read',
        category: 'TikTok',
        keywords: 'tiktok downloader without watermark, download tiktok no watermark, remove tiktok watermark, save tiktok video hd',
        content: `
            <p class="text-lg text-gray-300 leading-relaxed mb-6">TikTok is one of the world's most-watched platforms, but it stamps a watermark on every video you try to save. This guide shows you how to download any TikTok video completely <strong class="text-white">watermark-free in HD quality</strong> — in seconds, using only your browser.</p>
            <h2 class="text-2xl font-bold text-white mb-4 mt-10">Why TikTok Adds a Watermark</h2>
            <p class="text-gray-400 leading-relaxed mb-6">TikTok's built-in "Save Video" feature places a large logo and the creator's username across the video. This is by design — they want content to be traced back to their platform. But for content creators who want to repurpose clips, video editors, or anyone who simply values a clean video, the watermark is a significant inconvenience.</p>
            <h2 class="text-2xl font-bold text-white mb-4 mt-10">How to Download TikTok Without Watermark Using Doomsdaysnap</h2>
            <ol class="list-decimal list-inside text-gray-400 space-y-4 mb-6 ml-2">
                <li><strong class="text-white">Open TikTok</strong> on your phone or PC and find the video you want to save.</li>
                <li><strong class="text-white">Tap Share → Copy Link</strong> (on mobile) or copy the URL from the browser address bar.</li>
                <li><strong class="text-white">Open Doomsdaysnap</strong> at <a href="https://doomsdaysnap.online/tiktok-downloader" class="text-purple-400 underline">doomsdaysnap.online/tiktok-downloader</a>.</li>
                <li><strong class="text-white">Paste the TikTok link</strong> into the input box and press Enter or click Download.</li>
                <li><strong class="text-white">Download the clean HD video</strong> — no watermark, no TikTok branding.</li>
            </ol>
            <h2 class="text-2xl font-bold text-white mb-4 mt-10">How Doomsdaysnap Removes the Watermark</h2>
            <p class="text-gray-400 leading-relaxed mb-6">Our extraction engine accesses TikTok's original CDN (Content Delivery Network) URL — the raw video file that exists <em>before</em> TikTok overlays its watermark during playback. This means you get the purest version of the video: full resolution, original audio, zero overlays. This is fundamentally different from screen-recording or using editing software to crop the logo.</p>
            <h2 class="text-2xl font-bold text-white mb-4 mt-10">Supported TikTok URL Formats</h2>
            <ul class="list-disc list-inside text-gray-400 space-y-2 mb-6 ml-2">
                <li>Standard TikTok video: <code class="text-purple-400 bg-white/5 px-1 rounded">tiktok.com/@username/video/123456</code></li>
                <li>Short share link: <code class="text-purple-400 bg-white/5 px-1 rounded">vm.tiktok.com/XXXXXXX/</code></li>
                <li>Mobile share URL: <code class="text-purple-400 bg-white/5 px-1 rounded">m.tiktok.com/v/XXXXXXX.html</code></li>
            </ul>
            <h2 class="text-2xl font-bold text-white mb-4 mt-10">Can I Download TikTok Slideshows?</h2>
            <p class="text-gray-400 leading-relaxed mb-6">TikTok Slideshows (photo posts with music) are also supported. Doomsdaysnap will extract the video version of the slideshow as a full MP4 with the original audio track included.</p>
            <h2 class="text-2xl font-bold text-white mb-4 mt-10">FAQs</h2>
            <div class="space-y-4 mb-6">
                <div class="bg-white/5 rounded-xl p-5"><p class="font-semibold text-white mb-1">Is downloading TikTok videos legal?</p><p class="text-gray-400 text-sm">Downloading publicly available TikTok videos for personal use is generally acceptable. Do not redistribute downloaded content without the creator's permission.</p></div>
                <div class="bg-white/5 rounded-xl p-5"><p class="font-semibold text-white mb-1">Does the creator get notified?</p><p class="text-gray-400 text-sm">No. Doomsdaysnap accesses the public video URL — no notification is sent to the creator.</p></div>
                <div class="bg-white/5 rounded-xl p-5"><p class="font-semibold text-white mb-1">What quality are the downloads?</p><p class="text-gray-400 text-sm">We always serve the highest available quality, typically 1080p HD with the original audio bitrate.</p></div>
            </div>
        `
    },
    {
        slug: 'youtube-to-mp3-converter-guide',
        title: 'Best Free YouTube to MP3 Converter in 2026 (No Install)',
        desc: 'Convert any YouTube video to MP3 audio instantly for free. No software installation needed — works on mobile and PC.',
        date: '2026-04-05',
        readTime: '5 min read',
        category: 'YouTube',
        keywords: 'youtube to mp3, youtube mp3 converter, convert youtube to mp3 free, youtube mp3 downloader 2026',
        content: `
            <p class="text-lg text-gray-300 leading-relaxed mb-6">Converting YouTube videos to MP3 is one of the most searched topics on the internet. Whether you want to save a podcast, a music video soundtrack, or a lecture for offline listening, the fastest method in 2026 is using <strong class="text-white">Doomsdaysnap's free online converter</strong> — no app installation, no account, no cost.</p>
            <h2 class="text-2xl font-bold text-white mb-4 mt-10">How to Convert YouTube to MP3 in 3 Steps</h2>
            <ol class="list-decimal list-inside text-gray-400 space-y-4 mb-6 ml-2">
                <li><strong class="text-white">Copy the YouTube URL</strong> — from your browser or the YouTube Share menu.</li>
                <li><strong class="text-white">Paste it on Doomsdaysnap</strong> — go to <a href="https://doomsdaysnap.online" class="text-purple-400 underline">doomsdaysnap.online</a> and paste the link.</li>
                <li><strong class="text-white">Select MP3 Audio</strong> — from the format list and click Download. Your MP3 will be ready in seconds.</li>
            </ol>
            <h2 class="text-2xl font-bold text-white mb-4 mt-10">What Bitrate is the MP3?</h2>
            <p class="text-gray-400 leading-relaxed mb-6">Doomsdaysnap extracts audio at the highest bitrate available from the YouTube source — typically <strong class="text-white">128kbps to 320kbps</strong> depending on what the uploader provided. This ensures the best possible audio quality without any re-encoding artifacts. For music and podcasts, the quality difference between a compressed MP3 and the original is virtually undetectable to the human ear.</p>
            <h2 class="text-2xl font-bold text-white mb-4 mt-10">Use Cases for YouTube MP3 Downloads</h2>
            <ul class="list-disc list-inside text-gray-400 space-y-2 mb-6 ml-2">
                <li><strong class="text-white">Music & Playlists</strong> — Save your favorite songs and listen without a data connection.</li>
                <li><strong class="text-white">Podcasts & Lectures</strong> — Educational content to listen during commutes.</li>
                <li><strong class="text-white">Sound Effects</strong> — For video creators and musicians who need audio samples.</li>
                <li><strong class="text-white">Language Learning</strong> — Save conversations and lessons for repeated listening.</li>
                <li><strong class="text-white">Meditation & ASMR</strong> — Save relaxation audio to listen without internet.</li>
            </ul>
            <h2 class="text-2xl font-bold text-white mb-4 mt-10">Does It Work on iPhone and Android?</h2>
            <p class="text-gray-400 leading-relaxed mb-6">Yes — Doomsdaysnap is fully mobile-optimized. On iPhone (iOS 13+), the file downloads to your Files app. On Android, it saves to your Downloads folder. From there, you can add it to any music player app, transfer to AirPods, or upload to a cloud service.</p>
            <h2 class="text-2xl font-bold text-white mb-4 mt-10">Is There a Video Length Limit?</h2>
            <p class="text-gray-400 leading-relaxed mb-6">Doomsdaysnap supports videos of any length — from 30-second Shorts to 4-hour livestream recordings. However, very long videos may take slightly more processing time to extract the audio stream.</p>
            <div class="space-y-4 mb-6">
                <div class="bg-white/5 rounded-xl p-5"><p class="font-semibold text-white mb-1">Is YouTube to MP3 free?</p><p class="text-gray-400 text-sm">Yes. Doomsdaysnap is 100% free with unlimited conversions and no sign-up required.</p></div>
                <div class="bg-white/5 rounded-xl p-5"><p class="font-semibold text-white mb-1">Can I convert YouTube playlists to MP3?</p><p class="text-gray-400 text-sm">Currently, you can convert individual videos. Paste each video URL separately to extract the audio.</p></div>
            </div>
        `
    },
    {
        slug: 'download-instagram-reels-hd',
        title: 'How to Download Instagram Reels in HD Quality (2026)',
        desc: 'Save any Instagram Reel to your phone or PC in full HD quality. Free, fast, and no Instagram login needed.',
        date: '2026-04-02',
        readTime: '4 min read',
        category: 'Instagram',
        keywords: 'instagram reels downloader, download instagram reels hd, save instagram reels, instagram reel download free',
        content: `
            <p class="text-lg text-gray-300 leading-relaxed mb-6">Instagram Reels are short, engaging videos — and sometimes you find one worth keeping. Doomsdaysnap lets you <strong class="text-white">download any public Instagram Reel in HD quality</strong> without needing an Instagram account or any app installation.</p>
            <h2 class="text-2xl font-bold text-white mb-4 mt-10">Step-by-Step: Download Instagram Reels</h2>
            <ol class="list-decimal list-inside text-gray-400 space-y-4 mb-6 ml-2">
                <li><strong class="text-white">Find the Reel</strong> on Instagram and tap the three-dot (⋯) menu.</li>
                <li><strong class="text-white">Tap "Copy Link"</strong> to copy the Reel's URL to your clipboard.</li>
                <li><strong class="text-white">Open Doomsdaysnap</strong> at <a href="https://doomsdaysnap.online/instagram-downloader" class="text-purple-400 underline">doomsdaysnap.online/instagram-downloader</a>.</li>
                <li><strong class="text-white">Paste the link</strong> and click Download. The Reel will be saved in full HD.</li>
            </ol>
            <h2 class="text-2xl font-bold text-white mb-4 mt-10">What Types of Instagram Content Can I Download?</h2>
            <ul class="list-disc list-inside text-gray-400 space-y-2 mb-6 ml-2">
                <li><strong class="text-white">Reels</strong> — Short vertical videos up to 90 seconds</li>
                <li><strong class="text-white">IGTV Videos</strong> — Long-form video content</li>
                <li><strong class="text-white">Public Posts</strong> — Video posts from public profiles</li>
                <li><strong class="text-white">Stories</strong> — Publicly accessible story videos</li>
            </ul>
            <h2 class="text-2xl font-bold text-white mb-4 mt-10">Why Can't I Download Private Instagram Reels?</h2>
            <p class="text-gray-400 leading-relaxed mb-6">Doomsdaysnap only supports public content. Private accounts require Instagram login credentials to access, which we do not support for privacy and security reasons. If a Reel is from a private account, set your account to public temporarily or ask the creator to share it directly with you.</p>
            <h2 class="text-2xl font-bold text-white mb-4 mt-10">Download Instagram Reels on iPhone</h2>
            <p class="text-gray-400 leading-relaxed mb-6">On iOS, after tapping Download, the file saves to your Safari Downloads (accessible via the Files app). To add it to Photos, open the file in Files and tap Share → Save Video. This works on iOS 13 and later with Safari browser.</p>
        `
    },
    {
        slug: 'save-facebook-videos-to-phone',
        title: 'How to Download Facebook Videos to Your Phone (2026 Guide)',
        desc: 'Download any Facebook video to your phone or computer in HD quality for free. Works on Android and iPhone without any app.',
        date: '2026-03-28',
        readTime: '4 min read',
        category: 'Facebook',
        keywords: 'download facebook videos, save facebook video to phone, facebook video downloader, facebook downloader free',
        content: `
            <p class="text-lg text-gray-300 leading-relaxed mb-6">Facebook makes it surprisingly difficult to save videos directly from its platform. With Doomsdaysnap, you can <strong class="text-white">download any public Facebook video in HD</strong> directly to your phone or computer — no app, no account, and completely free.</p>
            <h2 class="text-2xl font-bold text-white mb-4 mt-10">How to Download Facebook Videos (Step by Step)</h2>
            <ol class="list-decimal list-inside text-gray-400 space-y-4 mb-6 ml-2">
                <li><strong class="text-white">Find the Facebook video</strong> you want to save. Click on it to open the full video view.</li>
                <li><strong class="text-white">Copy the URL</strong> from your browser's address bar, or right-click the video and choose "Copy video URL".</li>
                <li><strong class="text-white">Go to Doomsdaysnap</strong> at <a href="https://doomsdaysnap.online/facebook-downloader" class="text-purple-400 underline">doomsdaysnap.online/facebook-downloader</a>.</li>
                <li><strong class="text-white">Paste the URL</strong> and press Enter. Select HD or SD quality and download.</li>
            </ol>
            <h2 class="text-2xl font-bold text-white mb-4 mt-10">What Facebook Videos Are Supported?</h2>
            <ul class="list-disc list-inside text-gray-400 space-y-2 mb-6 ml-2">
                <li>Public Facebook post videos</li>
                <li>Facebook Watch videos</li>
                <li>Shared video posts from public pages</li>
                <li>Facebook Reels (public)</li>
            </ul>
            <h2 class="text-2xl font-bold text-white mb-4 mt-10">Downloading Facebook Videos on Android</h2>
            <p class="text-gray-400 leading-relaxed mb-6">Android is the simplest experience — open Doomsdaysnap in Chrome, paste the Facebook URL, select your quality, and tap Download. The video will appear in your Downloads folder and can be opened in any video player or moved to your Gallery.</p>
            <h2 class="text-2xl font-bold text-white mb-4 mt-10">Why Is My Facebook Video Not Downloading?</h2>
            <p class="text-gray-400 leading-relaxed mb-6">The most common reasons a Facebook video might not download are: (1) the video is from a private group or profile, (2) the content has been restricted by the original poster, or (3) the URL was copied incorrectly. Make sure you are copying the full URL from the Facebook video page, not just the share dialog link.</p>
        `
    },
    {
        slug: 'download-twitter-x-videos-free',
        title: 'How to Download Twitter (X) Videos for Free in 2026',
        desc: 'Save any Twitter or X video to your device in high quality. Free online tool — no app needed, works on all devices.',
        date: '2026-03-25',
        readTime: '4 min read',
        category: 'Twitter/X',
        keywords: 'twitter video downloader, x video download, save tweet video, download twitter videos free, x downloader',
        content: `
            <p class="text-lg text-gray-300 leading-relaxed mb-6">X (formerly Twitter) hosts millions of videos daily — breaking news clips, sports highlights, funny moments, and exclusive content. Doomsdaysnap makes it simple to <strong class="text-white">download any public Twitter/X video in HD quality</strong> instantly and for free.</p>
            <h2 class="text-2xl font-bold text-white mb-4 mt-10">How to Download Twitter/X Videos</h2>
            <ol class="list-decimal list-inside text-gray-400 space-y-4 mb-6 ml-2">
                <li><strong class="text-white">Find the tweet</strong> containing the video you want to save on X.com or Twitter.com.</li>
                <li><strong class="text-white">Copy the tweet URL</strong> from your browser address bar (e.g., <code class="text-purple-400 bg-white/5 px-1 rounded">x.com/username/status/1234567890</code>).</li>
                <li><strong class="text-white">Open Doomsdaysnap</strong> at <a href="https://doomsdaysnap.online/twitter-downloader" class="text-purple-400 underline">doomsdaysnap.online/twitter-downloader</a>.</li>
                <li><strong class="text-white">Paste the URL</strong> and click Download to save the video.</li>
            </ol>
            <h2 class="text-2xl font-bold text-white mb-4 mt-10">What Quality Formats Are Available for Twitter Videos?</h2>
            <p class="text-gray-400 leading-relaxed mb-6">Twitter/X videos are available in multiple resolutions. Doomsdaysnap presents all available options, which typically include <strong class="text-white">1280×720 (HD)</strong>, <strong class="text-white">854×480 (SD)</strong>, and sometimes 1920×1080 (Full HD) for high-quality uploads. We recommend HD for the best experience.</p>
            <h2 class="text-2xl font-bold text-white mb-4 mt-10">Can I Download Twitter GIFs?</h2>
            <p class="text-gray-400 leading-relaxed mb-6">Yes! Twitter GIFs are actually stored as MP4 files on Twitter's servers. Doomsdaysnap will download them as MP4 videos, which you can then convert to GIF format using any free converter if needed. The downloaded MP4 will loop seamlessly just like the original GIF.</p>
            <h2 class="text-2xl font-bold text-white mb-4 mt-10">Twitter Video Not Downloading?</h2>
            <p class="text-gray-400 leading-relaxed mb-6">Make sure the tweet is from a public account. Protected (private) accounts restrict video access. Also ensure you are copying the URL of the specific tweet, not just the user's profile page.</p>
        `
    },
    {
        slug: 'how-to-download-youtube-shorts',
        title: 'How to Download YouTube Shorts in High Quality (2026)',
        desc: 'Save YouTube Shorts to your phone or PC in HD quality. Free, instant, no app needed — complete guide for Android and iPhone.',
        date: '2026-03-20',
        readTime: '4 min read',
        category: 'YouTube',
        keywords: 'youtube shorts download, save youtube shorts, download youtube shorts hd, youtube shorts downloader free',
        content: `
            <p class="text-lg text-gray-300 leading-relaxed mb-6">YouTube Shorts are 60-second vertical videos that have taken over the platform. If you find a Short you want to keep — a tutorial, a funny moment, a recipe — Doomsdaysnap lets you <strong class="text-white">download it in HD for free</strong> in seconds.</p>
            <h2 class="text-2xl font-bold text-white mb-4 mt-10">How to Download YouTube Shorts (Step by Step)</h2>
            <ol class="list-decimal list-inside text-gray-400 space-y-4 mb-6 ml-2">
                <li><strong class="text-white">Open the YouTube Short</strong> you want to download on your phone or PC.</li>
                <li><strong class="text-white">Copy the URL</strong> — it will look like <code class="text-purple-400 bg-white/5 px-1 rounded">youtube.com/shorts/XXXXXXXXXXX</code>.</li>
                <li><strong class="text-white">Visit Doomsdaysnap</strong> at <a href="https://doomsdaysnap.online/youtube-downloader" class="text-purple-400 underline">doomsdaysnap.online/youtube-downloader</a>.</li>
                <li><strong class="text-white">Paste the link</strong> and click Extract. Then choose your preferred resolution and download.</li>
            </ol>
            <h2 class="text-2xl font-bold text-white mb-4 mt-10">Are YouTube Shorts in HD?</h2>
            <p class="text-gray-400 leading-relaxed mb-6">Most YouTube Shorts are uploaded in 1080×1920 (Full HD vertical) resolution. Doomsdaysnap always fetches the highest available quality, so you will typically get a crisp 1080p HD download that looks perfect on any phone screen.</p>
            <h2 class="text-2xl font-bold text-white mb-4 mt-10">Can I Download YouTube Shorts as MP3?</h2>
            <p class="text-gray-400 leading-relaxed mb-6">Absolutely. If you only need the audio from a YouTube Short — for example, a music Short or a quick speech — simply choose the MP3 audio option from the format list. The audio quality matches the source at the highest available bitrate.</p>
            <h2 class="text-2xl font-bold text-white mb-4 mt-10">Why Is YouTube Short URL Different?</h2>
            <p class="text-gray-400 leading-relaxed mb-6">YouTube Shorts use the <code class="text-purple-400 bg-white/5 px-1 rounded">/shorts/</code> URL format, which is technically just a regular YouTube video displayed in vertical mode. Doomsdaysnap recognizes both Shorts URLs and regular YouTube URLs seamlessly.</p>
        `
    },
    {
        slug: 'is-it-legal-to-download-youtube-videos',
        title: 'Is It Legal to Download YouTube Videos? (Complete 2026 Guide)',
        desc: 'Understand the legality of downloading YouTube videos. Learn what is allowed, what to avoid, and how to stay safe.',
        date: '2026-03-15',
        readTime: '7 min read',
        category: 'Guide',
        keywords: 'is it legal to download youtube videos, youtube download legal, can you download youtube videos, youtube terms of service download',
        content: `
            <p class="text-lg text-gray-300 leading-relaxed mb-6">One of the most common questions about video downloading is: <strong class="text-white">Is it legal to download YouTube videos?</strong> The answer depends on several factors — including the purpose of the download, whether the content is copyrighted, and your country's laws. This comprehensive guide breaks it all down.</p>
            <h2 class="text-2xl font-bold text-white mb-4 mt-10">YouTube's Terms of Service</h2>
            <p class="text-gray-400 leading-relaxed mb-6">YouTube's Terms of Service (Section 5) state that users may not download content unless a download button or link is explicitly provided by YouTube. This means that technically, downloading videos via third-party tools may violate YouTube's ToS. <em>However, violating a platform's Terms of Service is not the same as breaking the law.</em> YouTube can only terminate your account or restrict your access — they cannot pursue criminal or civil action against you simply for downloading a video for personal use.</p>
            <h2 class="text-2xl font-bold text-white mb-4 mt-10">Copyright Law and Fair Use</h2>
            <p class="text-gray-400 leading-relaxed mb-6">The more important legal consideration is <strong class="text-white">copyright law</strong>. Most YouTube videos are copyrighted by their creators. Downloading them for personal viewing (not redistribution, not monetization) generally falls under <strong class="text-white">"fair use"</strong> in the United States and similar doctrines in other countries. This means:</p>
            <ul class="list-disc list-inside text-gray-400 space-y-2 mb-6 ml-2">
                <li><strong class="text-white text-green-400">Generally OK:</strong> Downloading for personal offline viewing</li>
                <li><strong class="text-white text-green-400">Generally OK:</strong> Downloading your own uploaded videos</li>
                <li><strong class="text-white text-green-400">Generally OK:</strong> Downloading Creative Commons or public domain content</li>
                <li><strong class="text-white text-red-400">Not OK:</strong> Redistributing downloaded videos on other platforms</li>
                <li><strong class="text-white text-red-400">Not OK:</strong> Monetizing someone else's downloaded content</li>
                <li><strong class="text-white text-red-400">Not OK:</strong> Using clips commercially without a license</li>
            </ul>
            <h2 class="text-2xl font-bold text-white mb-4 mt-10">What About YouTube Premium's Offline Feature?</h2>
            <p class="text-gray-400 leading-relaxed mb-6">YouTube Premium ($13.99/month) includes an official offline download feature. However, these downloads are locked within the YouTube app and expire after 30 days. They cannot be exported to other apps or devices. For content you own the rights to, or creative commons video, a direct download is far more practical.</p>
            <h2 class="text-2xl font-bold text-white mb-4 mt-10">Legal Use Cases for Downloading Videos</h2>
            <ul class="list-disc list-inside text-gray-400 space-y-2 mb-6 ml-2">
                <li>Educational institutions archiving lecture videos</li>
                <li>Researchers documenting online content for academic study</li>
                <li>Journalists preserving evidence from public posts</li>
                <li>Content creators backing up their own uploaded videos</li>
                <li>Personal offline access in areas with poor internet connectivity</li>
            </ul>
            <h2 class="text-2xl font-bold text-white mb-4 mt-10">Our Recommendation</h2>
            <p class="text-gray-400 leading-relaxed mb-6">Always respect creators' work. If you are downloading content for personal, non-commercial use, you are very unlikely to face any legal issues. If you plan to use downloaded content in any project or publication, verify the license first. Look for Creative Commons licensed videos, which explicitly allow reuse.</p>
            <div class="bg-purple-500/10 border border-purple-500/30 rounded-xl p-6 mt-8">
                <p class="text-purple-300 font-semibold mb-2">Important Disclaimer</p>
                <p class="text-gray-400 text-sm">This article is for informational purposes only and does not constitute legal advice. Laws vary by country and jurisdiction. Consult a qualified attorney for legal guidance specific to your situation.</p>
            </div>
        `
    }
];

// ─── Additional SEO Landing Pages ─────────────────────────────────────────────
const ADDITIONAL_SEO_DATA = {
    'youtube-to-mp3': {
        title: 'YouTube to MP3 Converter — Free, Fast & HD Audio | Doomsdaysnap',
        desc: 'Convert any YouTube video to MP3 audio for free in seconds. No software, no sign-up — the best YouTube to MP3 converter online.',
        h1: 'YouTube to MP3 Converter',
        canonical: 'https://doomsdaysnap.online/youtube-to-mp3',
        keywords: 'youtube to mp3, youtube mp3 converter free, convert youtube to mp3, youtube audio download',
        icon: 'fa-youtube', color: 'text-red-500', border: 'border-t-red-500/40', bg: 'bg-red-500/10',
        intro: 'Extract high-quality MP3 audio from any YouTube video — free, instant, no registration required.',
        features: [
            { icon: 'fa-music', title: 'High-Quality MP3', desc: 'Get audio at up to 320kbps — the highest quality available from the YouTube source stream.' },
            { icon: 'fa-bolt', title: 'Instant Conversion', desc: 'No waiting in queues. Your YouTube MP3 is ready within seconds of pasting the link.' },
            { icon: 'fa-infinity', title: 'Unlimited & Free', desc: 'No daily download limits, no subscriptions, no credit card. Completely free forever.' },
            { icon: 'fa-mobile', title: 'Works on All Devices', desc: 'Converts on Android, iPhone, Windows, Mac and Linux — any browser, any platform.' }
        ],
        faqs: [
            { q: "What bitrate is the MP3?", a: "We extract audio at the highest bitrate available from YouTube, typically 128–320kbps depending on the source." },
            { q: "Can I convert YouTube Shorts to MP3?", a: "Yes, just paste the Shorts URL and select the Audio/MP3 option." },
            { q: "Is there a video length limit?", a: "No limit — Doomsdaysnap handles videos of any length from Shorts to full-length concerts." },
            { q: "Does it work on iPhone?", a: "Yes, Safari on iOS supports direct MP3 downloads which save to your Files app." },
            { q: "Can I convert playlists?", a: "Currently individual videos are supported. Paste each URL separately." },
            { q: "Is it completely free?", a: "100% free, no registration, no watermarks, no hidden fees." }
        ]
    },
    'shorts-downloader': {
        title: 'YouTube Shorts Downloader — Save Shorts in HD Free | Doomsdaysnap',
        desc: 'Download YouTube Shorts in HD quality for free. Save any Short to your phone or PC instantly without any app.',
        h1: 'YouTube Shorts Downloader',
        canonical: 'https://doomsdaysnap.online/shorts-downloader',
        keywords: 'youtube shorts downloader, save youtube shorts, download shorts hd, shorts download free 2026',
        icon: 'fa-youtube', color: 'text-red-500', border: 'border-t-red-500/40', bg: 'bg-red-500/10',
        intro: 'Download any YouTube Short in full HD quality instantly — free, no watermark, no app required.',
        features: [
            { icon: 'fa-mobile-screen', title: 'Vertical HD Quality', desc: 'Download Shorts in their native 1080×1920 vertical format — exactly as they appear on YouTube.' },
            { icon: 'fa-bolt', title: 'Instant Processing', desc: 'Our engine processes YouTube Shorts URLs in under 3 seconds on average.' },
            { icon: 'fa-music', title: 'Audio Extraction', desc: 'Choose to download the Short as MP3 audio if you only need the soundtrack.' },
            { icon: 'fa-check-circle', title: 'No Watermark', desc: 'Clean, watermark-free download — the original video file from YouTube servers.' }
        ],
        faqs: [
            { q: "How do I get a YouTube Short URL?", a: "Open the Short on YouTube and copy the URL from your browser — it looks like youtube.com/shorts/XXXXXXXX." },
            { q: "What resolution are YouTube Shorts downloads?", a: "Most Shorts are available in 1080p (Full HD) vertical format." },
            { q: "Can I save YouTube Shorts on iPhone?", a: "Yes! Paste the Shorts URL in Safari on Doomsdaysnap and download directly to your Files app." },
            { q: "Is downloading Shorts free?", a: "Yes, completely free with no limits on how many Shorts you download." },
            { q: "Can I get a Shorts MP3?", a: "Yes, select the Audio option from the format list to extract just the audio." },
            { q: "Do I need an account?", a: "No account or sign-up required. Just paste and download." }
        ]
    },
    'reels-downloader': {
        title: 'Instagram Reels Downloader — Save Reels in HD Free | Doomsdaysnap',
        desc: 'Download Instagram Reels in HD quality for free. No Instagram account needed — works on Android, iPhone and PC.',
        h1: 'Instagram Reels Downloader',
        canonical: 'https://doomsdaysnap.online/reels-downloader',
        keywords: 'instagram reels downloader, save instagram reels, download reels hd free, instagram reel saver 2026',
        icon: 'fa-instagram', color: 'text-pink-500', border: 'border-t-pink-500/40', bg: 'bg-pink-500/10',
        intro: 'Save any public Instagram Reel to your device in full HD — completely free, no login, no watermark.',
        features: [
            { icon: 'fa-film', title: 'Full HD Quality', desc: 'Download Reels in their original 1080p HD quality — exactly as uploaded by the creator.' },
            { icon: 'fa-lock-open', title: 'No Login Needed', desc: 'No Instagram account required. Simply paste the Reel link and download.' },
            { icon: 'fa-droplet-slash', title: 'No Watermark', desc: 'Clean video with no Instagram branding or watermarks overlaid.' },
            { icon: 'fa-globe', title: 'Cross-Platform', desc: 'Works seamlessly on Android, iPhone, Mac, Windows and Linux browsers.' }
        ],
        faqs: [
            { q: "How do I copy an Instagram Reel link?", a: "Tap the three-dot menu (⋯) on the Reel and select 'Copy Link'." },
            { q: "Can I download private Reels?", a: "No, only publicly accessible Reels can be downloaded." },
            { q: "Does it work on Android?", a: "Yes, open Doomsdaysnap in Chrome on Android, paste the link and tap Download." },
            { q: "What about IGTV and Stories?", a: "Yes, IGTV and public Stories are also supported through Doomsdaysnap." },
            { q: "Is it safe to use?", a: "Yes — we access only the public URL and never ask for your Instagram credentials." },
            { q: "Is it free?", a: "Completely free. No subscription, no sign-up, no limits." }
        ]
    }
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
            
            // Replace Title / Meta / SEO
            modifiedContent = modifiedContent
                .replace(/<title>.*?<\/title>/, `<title>${seo.title}</title>`)
                .replace(/<meta name="description" content=".*?">/, `<meta name="description" content="${seo.desc}">`)
                .replace(/<meta property="og:title" content=".*?">/, `<meta property="og:title" content="${seo.title}">`)
                .replace(/<meta property="og:description" content=".*?">/, `<meta property="og:description" content="${seo.desc}">`)
                .replace(/<meta name="twitter:title" content=".*?">/, `<meta name="twitter:title" content="${seo.title}">`)
                .replace(/<meta name="twitter:description" content=".*?">/, `<meta name="twitter:description" content="${seo.desc}">`)
                .replace(/<link rel="canonical" href=".*?">/, `<link rel="canonical" href="https://doomsdaysnap.online${route}">`);

            // Inject Page-Specific Schema (SoftwareApplication + BreadcrumbList)
            const breadcrumbSchema = {
              "@context": "https://schema.org",
              "@type": "BreadcrumbList",
              "itemListElement": [
                {
                  "@type": "ListItem",
                  "position": 1,
                  "name": "Home",
                  "item": "https://doomsdaysnap.online/"
                },
                {
                  "@type": "ListItem",
                  "position": 2,
                  "name": seo.h1,
                  "item": `https://doomsdaysnap.online${route}`
                }
              ]
            };

            const softwareSchema = {
              "@context": "https://schema.org",
              "@type": "SoftwareApplication",
              "name": seo.h1,
              "operatingSystem": "All",
              "applicationCategory": "MultimediaApplication",
              "offers": { "@type": "Offer", "price": "0", "priceCurrency": "USD" },
              "aggregateRating": { "@type": "AggregateRating", "ratingValue": "4.9", "reviewCount": "1280" }
            };

            const schemaHtml = `
            <script type="application/ld+json">${JSON.stringify(breadcrumbSchema)}</script>
            <script type="application/ld+json">${JSON.stringify(softwareSchema)}</script>`;
            
            modifiedContent = modifiedContent.replace('</head>', `${schemaHtml}\n</head>`);

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

// ─── Blog Routes ─────────────────────────────────────────────────────────────
function buildBlogLayout(title, desc, canonical, bodyHtml) {
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${title}</title>
<meta name="description" content="${desc}">
<link rel="canonical" href="${canonical}">
<meta property="og:title" content="${title}">
<meta property="og:description" content="${desc}">
<meta property="og:url" content="${canonical}">
<meta property="og:type" content="article">
<meta property="og:image" content="https://doomsdaysnap.online/og-image.png">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${title}">
<meta name="twitter:description" content="${desc}">
<link rel="icon" type="image/png" href="/favicon.png?v=4">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800&display=swap" rel="stylesheet">
<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.1/css/all.min.css">
<script src="https://cdn.tailwindcss.com"></script>
<script>tailwind.config={darkMode:'class',theme:{extend:{fontFamily:{sans:['Inter','sans-serif']}}}}</script>
<style>
  html,body{background:#0f0f0f;color:#fff;font-family:'Inter',sans-serif;overflow-x:hidden}
  .glass{background:rgba(255,255,255,0.04);backdrop-filter:blur(12px);border:1px solid rgba(255,255,255,0.08)}
  .gradient-text{background:linear-gradient(135deg,#a855f7,#ec4899);-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text}
  .nav-glass{background:rgba(10,10,15,0.8);backdrop-filter:blur(25px);border-bottom:1px solid rgba(255,255,255,0.06)}
  a.nav-link{color:#9ca3af;transition:color .2s}a.nav-link:hover{color:#fff}
  .tag{display:inline-block;padding:3px 10px;border-radius:20px;font-size:.7rem;font-weight:600;text-transform:uppercase;letter-spacing:.05em}
  code{background:rgba(168,85,247,.15);color:#c084fc;padding:2px 6px;border-radius:4px;font-size:.88em}
  a{color:#a855f7;text-decoration:none}a:hover{text-decoration:underline}
</style>
<!-- Google tag (gtag.js) -->
<script async src="https://www.googletagmanager.com/gtag/js?id=G-Z5XE5YM46M"></script>
<script>window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments);}gtag('js',new Date());gtag('config','G-Z5XE5YM46M');</script>
</head>
<body class="dark">
<nav class="nav-glass fixed top-0 left-0 right-0 z-50">
  <div class="max-w-6xl mx-auto px-4 sm:px-6 h-16 flex items-center justify-between">
    <a href="/" class="font-extrabold text-xl text-white tracking-tight">Doomsday<span class="gradient-text">snap</span></a>
    <div class="flex items-center gap-6 text-sm">
      <a href="/" class="nav-link">Home</a>
      <a href="/youtube-downloader" class="nav-link hidden sm:inline">YouTube</a>
      <a href="/tiktok-downloader" class="nav-link hidden sm:inline">TikTok</a>
      <a href="/blog" class="nav-link font-semibold text-purple-400">Blog</a>
    </div>
  </div>
</nav>
<main class="pt-24 pb-16 px-4">${bodyHtml}</main>
<footer class="border-t border-white/5 py-10 text-center">
  <div class="max-w-4xl mx-auto px-4">
    <a href="/" class="font-extrabold text-lg text-white">Doomsday<span class="gradient-text">snap</span></a>
    <p class="text-gray-600 text-sm mt-2">Free video downloader for YouTube, TikTok, Instagram, Facebook, Twitter &amp; Snapchat.</p>
    <div class="flex justify-center gap-6 mt-4 text-sm text-gray-600">
      <a href="/privacy" class="hover:text-gray-400 transition-colors">Privacy</a>
      <a href="/tos" class="hover:text-gray-400 transition-colors">Terms</a>
      <a href="/blog" class="hover:text-gray-400 transition-colors">Blog</a>
    </div>
  </div>
</footer>
</body></html>`;
}

app.get('/blog', (_req, res) => {
    const base = 'https://doomsdaysnap.online';
    const categoryColors = { YouTube: 'bg-red-500/20 text-red-400', TikTok: 'bg-[#25F4EE]/20 text-[#25F4EE]', Instagram: 'bg-pink-500/20 text-pink-400', Facebook: 'bg-blue-500/20 text-blue-400', 'Twitter/X': 'bg-gray-500/20 text-gray-300', Guide: 'bg-purple-500/20 text-purple-400' };

    const articleSchema = {
        "@context": "https://schema.org",
        "@type": "Blog",
        "name": "Doomsdaysnap Blog",
        "url": `${base}/blog`,
        "description": "Tips, guides and tutorials for downloading videos from YouTube, TikTok, Instagram and more.",
        "blogPost": BLOG_POSTS.map(p => ({
            "@type": "BlogPosting",
            "headline": p.title,
            "description": p.desc,
            "datePublished": p.date,
            "url": `${base}/blog/${p.slug}`
        }))
    };

    const cards = BLOG_POSTS.map(p => {
        const catColor = categoryColors[p.category] || 'bg-purple-500/20 text-purple-400';
        return `
        <article class="glass rounded-2xl overflow-hidden hover:border-purple-500/30 transition-all duration-300 flex flex-col">
            <div class="p-6 flex-1 flex flex-col">
                <div class="flex items-center gap-3 mb-3">
                    <span class="tag ${catColor}">${p.category}</span>
                    <span class="text-gray-600 text-xs">${p.readTime}</span>
                </div>
                <h2 class="text-lg font-bold text-white mb-3 leading-snug flex-1">
                    <a href="/blog/${p.slug}" class="hover:text-purple-400 transition-colors" style="color:inherit;text-decoration:none">${p.title}</a>
                </h2>
                <p class="text-gray-500 text-sm leading-relaxed mb-4">${p.desc}</p>
                <div class="flex items-center justify-between mt-auto pt-3 border-t border-white/5">
                    <span class="text-gray-600 text-xs">${new Date(p.date).toLocaleDateString('en-US', {year:'numeric',month:'long',day:'numeric'})}</span>
                    <a href="/blog/${p.slug}" class="text-purple-400 text-sm font-semibold hover:text-purple-300 transition-colors flex items-center gap-1.5" style="text-decoration:none">
                        Read <i class="fa-solid fa-arrow-right text-xs"></i>
                    </a>
                </div>
            </div>
        </article>`;
    }).join('');

    const body = `
    <script type="application/ld+json">${JSON.stringify(articleSchema)}</script>
    <div class="max-w-6xl mx-auto">
        <div class="text-center mb-12">
            <span class="inline-block px-4 py-1.5 rounded-full bg-purple-500/15 text-purple-400 text-sm font-semibold mb-4">Blog & Guides</span>
            <h1 class="text-4xl sm:text-5xl font-extrabold text-white mb-4">Video Download <span class="gradient-text">Guides</span></h1>
            <p class="text-gray-400 max-w-xl mx-auto">Expert tutorials on downloading videos from YouTube, TikTok, Instagram, Facebook, Twitter/X and Snapchat.</p>
        </div>
        <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6 mb-16">${cards}</div>
        <div class="glass rounded-2xl p-8 text-center">
            <h2 class="text-2xl font-bold text-white mb-3">Ready to Download?</h2>
            <p class="text-gray-400 mb-6 max-w-md mx-auto">Try Doomsdaysnap — the fastest free video downloader for 7 platforms.</p>
            <a href="/" class="inline-flex items-center gap-2 bg-gradient-to-r from-purple-600 to-pink-600 text-white font-bold px-8 py-3 rounded-xl hover:opacity-90 transition-opacity" style="text-decoration:none">
                <i class="fa-solid fa-download"></i> Download a Video Free
            </a>
        </div>
    </div>`;

    res.send(buildBlogLayout(
        'Video Download Guides & Tutorials | Doomsdaysnap Blog',
        'Expert guides on how to download videos from YouTube, TikTok, Instagram, Facebook, Twitter and Snapchat for free.',
        `${base}/blog`,
        body
    ));
});

app.get('/blog/:slug', (req, res) => {
    const base = 'https://doomsdaysnap.online';
    const post = BLOG_POSTS.find(p => p.slug === req.params.slug);
    if (!post) return res.status(404).redirect('/blog');

    const articleSchema = {
        "@context": "https://schema.org",
        "@type": "BlogPosting",
        "headline": post.title,
        "description": post.desc,
        "datePublished": post.date,
        "dateModified": post.date,
        "author": { "@type": "Organization", "name": "Doomsdaysnap", "url": base },
        "publisher": { "@type": "Organization", "name": "Doomsdaysnap", "url": base, "logo": { "@type": "ImageObject", "url": `${base}/og-image.png` } },
        "url": `${base}/blog/${post.slug}`,
        "mainEntityOfPage": { "@type": "WebPage", "@id": `${base}/blog/${post.slug}` },
        "image": `${base}/og-image.png`,
        "keywords": post.keywords
    };

    const breadcrumbSchema = {
        "@context": "https://schema.org",
        "@type": "BreadcrumbList",
        "itemListElement": [
            { "@type": "ListItem", "position": 1, "name": "Home", "item": `${base}/` },
            { "@type": "ListItem", "position": 2, "name": "Blog", "item": `${base}/blog` },
            { "@type": "ListItem", "position": 3, "name": post.title, "item": `${base}/blog/${post.slug}` }
        ]
    };

    const otherPosts = BLOG_POSTS.filter(p => p.slug !== post.slug).slice(0, 3).map(p => `
        <a href="/blog/${p.slug}" class="glass rounded-xl p-4 flex flex-col gap-2 hover:border-purple-500/30 transition-all" style="text-decoration:none">
            <span class="text-xs text-purple-400 font-semibold uppercase">${p.category}</span>
            <span class="text-sm font-semibold text-white leading-snug">${p.title}</span>
            <span class="text-xs text-gray-500">${p.readTime}</span>
        </a>`).join('');

    const body = `
    <script type="application/ld+json">${JSON.stringify(articleSchema)}</script>
    <script type="application/ld+json">${JSON.stringify(breadcrumbSchema)}</script>
    <div class="max-w-4xl mx-auto">
        <nav class="flex items-center gap-2 text-sm text-gray-600 mb-8">
            <a href="/" class="hover:text-gray-400 transition-colors" style="text-decoration:none">Home</a>
            <i class="fa-solid fa-chevron-right text-xs"></i>
            <a href="/blog" class="hover:text-gray-400 transition-colors" style="text-decoration:none">Blog</a>
            <i class="fa-solid fa-chevron-right text-xs"></i>
            <span class="text-gray-400 truncate max-w-xs">${post.title}</span>
        </nav>
        <header class="mb-10">
            <div class="flex items-center gap-3 mb-4">
                <span class="tag bg-purple-500/20 text-purple-400">${post.category}</span>
                <span class="text-gray-600 text-sm">${post.readTime}</span>
                <span class="text-gray-600 text-sm">${new Date(post.date).toLocaleDateString('en-US', {year:'numeric',month:'long',day:'numeric'})}</span>
            </div>
            <h1 class="text-3xl sm:text-4xl font-extrabold text-white leading-tight mb-4">${post.title}</h1>
            <p class="text-lg text-gray-400">${post.desc}</p>
        </header>
        <div class="glass rounded-2xl p-4 sm:p-6 mb-8">
            <div class="flex items-center gap-3 mb-3">
                <i class="fa-solid fa-download text-purple-400"></i>
                <span class="text-white font-semibold">Try Doomsdaysnap Now</span>
            </div>
            <p class="text-gray-400 text-sm mb-3">Download videos from YouTube, TikTok, Instagram and more — free, instant, no sign-up.</p>
            <a href="/" class="inline-flex items-center gap-2 bg-gradient-to-r from-purple-600 to-pink-600 text-white font-bold px-5 py-2.5 rounded-xl text-sm hover:opacity-90 transition-opacity" style="text-decoration:none">
                <i class="fa-solid fa-bolt"></i> Start Downloading Free
            </a>
        </div>
        <article class="prose max-w-none">${post.content}</article>
        <div class="mt-12 pt-8 border-t border-white/10">
            <h2 class="text-xl font-bold text-white mb-6">More Guides</h2>
            <div class="grid grid-cols-1 sm:grid-cols-3 gap-4">${otherPosts}</div>
        </div>
    </div>`;

    res.send(buildBlogLayout(post.title, post.desc, `${base}/blog/${post.slug}`, body));
});

// ─── Additional SEO Landing Pages ─────────────────────────────────────────────
Object.entries(ADDITIONAL_SEO_DATA).forEach(([slug, seo]) => {
    app.get(`/${slug}`, (_req, res) => {
        const base = 'https://doomsdaysnap.online';

        const faqSchema = {
            "@context": "https://schema.org",
            "@type": "FAQPage",
            "mainEntity": seo.faqs.map(f => ({
                "@type": "Question",
                "name": f.q,
                "acceptedAnswer": { "@type": "Answer", "text": f.a }
            }))
        };
        const softwareSchema = {
            "@context": "https://schema.org",
            "@type": "SoftwareApplication",
            "name": seo.h1,
            "operatingSystem": "All",
            "applicationCategory": "MultimediaApplication",
            "offers": { "@type": "Offer", "price": "0", "priceCurrency": "USD" },
            "aggregateRating": { "@type": "AggregateRating", "ratingValue": "4.9", "reviewCount": "2150" }
        };
        const breadcrumbSchema = {
            "@context": "https://schema.org",
            "@type": "BreadcrumbList",
            "itemListElement": [
                { "@type": "ListItem", "position": 1, "name": "Home", "item": `${base}/` },
                { "@type": "ListItem", "position": 2, "name": seo.h1, "item": seo.canonical }
            ]
        };

        const featuresHtml = seo.features.map(f => `
            <div class="glass rounded-2xl p-6 hover:border-purple-500/20 transition-all">
                <div class="w-11 h-11 rounded-xl bg-purple-500/10 flex items-center justify-center mb-4">
                    <i class="fa-solid ${f.icon} text-xl text-purple-400"></i>
                </div>
                <h3 class="text-white font-bold mb-2">${f.title}</h3>
                <p class="text-gray-500 text-sm leading-relaxed">${f.desc}</p>
            </div>`).join('');

        const faqHtml = seo.faqs.map(f => `
            <div class="glass rounded-xl overflow-hidden">
                <details class="group">
                    <summary class="px-6 py-4 font-semibold text-gray-200 cursor-pointer list-none flex justify-between items-center">
                        ${f.q}
                        <i class="fa-solid fa-chevron-down text-gray-500 text-sm flex-shrink-0 transition-transform group-open:rotate-180"></i>
                    </summary>
                    <div class="px-6 pb-5 text-gray-400 text-sm leading-relaxed border-t border-white/5 pt-4">${f.a}</div>
                </details>
            </div>`).join('');

        const relatedTools = Object.entries(PLATFORM_SEO_DATA).slice(0, 4).map(([key, p]) => `
            <a href="/${key}" class="glass rounded-xl p-4 hover:border-purple-500/20 transition-all block" style="text-decoration:none">
                <i class="fa-brands ${p.icon} text-lg ${p.color} mb-2 block"></i>
                <span class="text-sm font-semibold text-white">${key.split('-')[0].charAt(0).toUpperCase() + key.split('-')[0].slice(1)}</span>
                <span class="text-xs text-gray-500 block mt-1">Downloader</span>
            </a>`).join('');

        const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${seo.title}</title>
<meta name="description" content="${seo.desc}">
<meta name="keywords" content="${seo.keywords}">
<link rel="canonical" href="${seo.canonical}">
<link rel="icon" type="image/png" href="/favicon.png?v=4">
<meta property="og:title" content="${seo.title}">
<meta property="og:description" content="${seo.desc}">
<meta property="og:url" content="${seo.canonical}">
<meta property="og:type" content="website">
<meta property="og:image" content="${base}/og-image.png">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${seo.title}">
<meta name="twitter:description" content="${seo.desc}">
<script type="application/ld+json">${JSON.stringify(faqSchema)}</script>
<script type="application/ld+json">${JSON.stringify(softwareSchema)}</script>
<script type="application/ld+json">${JSON.stringify(breadcrumbSchema)}</script>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800&display=swap" rel="stylesheet">
<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.1/css/all.min.css">
<script src="https://cdn.tailwindcss.com"></script>
<script>tailwind.config={darkMode:'class',theme:{extend:{fontFamily:{sans:['Inter','sans-serif']}}}}</script>
<style>
  html,body{background:#0f0f0f;color:#fff;font-family:'Inter',sans-serif;overflow-x:hidden}
  .glass{background:rgba(255,255,255,0.04);backdrop-filter:blur(12px);border:1px solid rgba(255,255,255,0.08)}
  .gradient-text{background:linear-gradient(135deg,#a855f7,#ec4899);-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text}
  .gradient-bg{background:linear-gradient(135deg,#a855f7,#ec4899)}
  .nav-glass{background:rgba(10,10,15,0.8);backdrop-filter:blur(25px);border-bottom:1px solid rgba(255,255,255,0.06)}
</style>
<script async src="https://www.googletagmanager.com/gtag/js?id=G-Z5XE5YM46M"></script>
<script>window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments);}gtag('js',new Date());gtag('config','G-Z5XE5YM46M');</script>
</head>
<body class="dark">
<nav class="nav-glass fixed top-0 left-0 right-0 z-50">
  <div class="max-w-7xl mx-auto px-4 sm:px-6 h-16 flex items-center justify-between">
    <a href="/" class="font-extrabold text-xl text-white tracking-tight">Doomsday<span class="gradient-text">snap</span></a>
    <div class="flex items-center gap-5 text-sm">
      <a href="/" class="text-gray-400 hover:text-white transition-colors">Home</a>
      <a href="/blog" class="text-gray-400 hover:text-white transition-colors">Blog</a>
      <a href="/" class="gradient-bg text-white font-semibold px-4 py-2 rounded-xl text-sm hover:opacity-90 transition-opacity">Download Free</a>
    </div>
  </div>
</nav>
<main class="pt-24 pb-16">
    <section class="max-w-4xl mx-auto px-4 text-center pt-8 pb-12">
        <div class="inline-flex items-center gap-2 px-4 py-2 rounded-full glass text-xs text-gray-300 mb-6">
            <i class="fa-brands ${seo.icon} ${seo.color}"></i> Free · No Sign-Up · Unlimited
        </div>
        <h1 class="text-4xl sm:text-5xl md:text-6xl font-extrabold tracking-tight mb-4 leading-tight">${seo.h1}</h1>
        <p class="text-lg text-gray-400 mb-8 max-w-xl mx-auto">${seo.intro}</p>
        <div class="relative max-w-2xl mx-auto">
            <div class="glass rounded-2xl p-3 flex flex-col sm:flex-row gap-3 items-center">
                <input id="urlInput" type="text" placeholder="Paste YouTube link here…" class="flex-1 bg-transparent border-none outline-none px-4 py-3 text-white placeholder-gray-600 text-sm w-full" autocomplete="off">
                <a href="/" class="gradient-bg text-white font-bold px-6 py-3 rounded-xl text-sm whitespace-nowrap w-full sm:w-auto text-center hover:opacity-90 transition-opacity" style="text-decoration:none">Download Free</a>
            </div>
        </div>
    </section>

    <section class="max-w-6xl mx-auto px-4 py-12">
        <div class="text-center mb-10">
            <h2 class="text-3xl font-bold mb-3">Why Use Doomsdaysnap?</h2>
            <p class="text-gray-400">Built for speed, quality and simplicity.</p>
        </div>
        <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-5">${featuresHtml}</div>
    </section>

    <section class="max-w-4xl mx-auto px-4 py-12">
        <div class="text-center mb-10">
            <h2 class="text-3xl font-bold mb-3">How It Works</h2>
        </div>
        <div class="grid grid-cols-1 sm:grid-cols-3 gap-6 text-center">
            <div class="glass rounded-2xl p-6"><div class="text-3xl font-black text-purple-400 mb-3">1</div><h3 class="font-bold text-white mb-2">Copy the URL</h3><p class="text-gray-500 text-sm">Copy the video link from YouTube or any supported platform.</p></div>
            <div class="glass rounded-2xl p-6"><div class="text-3xl font-black text-purple-400 mb-3">2</div><h3 class="font-bold text-white mb-2">Paste on Doomsdaysnap</h3><p class="text-gray-500 text-sm">Go to doomsdaysnap.online and paste the URL in the input box.</p></div>
            <div class="glass rounded-2xl p-6"><div class="text-3xl font-black text-purple-400 mb-3">3</div><h3 class="font-bold text-white mb-2">Download</h3><p class="text-gray-500 text-sm">Select your preferred quality or format and click Download.</p></div>
        </div>
    </section>

    <section class="max-w-3xl mx-auto px-4 py-12">
        <div class="text-center mb-10">
            <h2 class="text-3xl font-bold mb-3">Frequently Asked Questions</h2>
        </div>
        <div class="space-y-3">${faqHtml}</div>
    </section>

    <section class="max-w-6xl mx-auto px-4 py-12 border-t border-white/5">
        <div class="text-center mb-8">
            <h2 class="text-2xl font-bold mb-2">More Downloader Tools</h2>
            <p class="text-gray-400 text-sm">Download from every major social media platform.</p>
        </div>
        <div class="grid grid-cols-2 sm:grid-cols-4 gap-4">${relatedTools}</div>
    </section>
</main>
<footer class="border-t border-white/5 py-10 text-center">
  <div class="max-w-4xl mx-auto px-4">
    <a href="/" class="font-extrabold text-lg text-white">Doomsday<span class="gradient-text">snap</span></a>
    <p class="text-gray-600 text-sm mt-2">Free video downloader for YouTube, TikTok, Instagram, Facebook, Twitter &amp; Snapchat.</p>
    <div class="flex justify-center gap-6 mt-4 text-sm text-gray-600">
      <a href="/privacy" class="hover:text-gray-400 transition-colors">Privacy</a>
      <a href="/tos" class="hover:text-gray-400 transition-colors">Terms</a>
      <a href="/blog" class="hover:text-gray-400 transition-colors">Blog</a>
    </div>
  </div>
</footer>
</body></html>`;
        res.send(html);
    });
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
        
        // ── YouTube Hybrid Pro Integration ──
        if (safeUrl.includes('youtube.com') || safeUrl.includes('youtu.be')) {
            console.log(`[INFO] YouTube Hybrid Pro → ${safeUrl}`);
            try {
                const response = await new Promise((resolve, reject) => {
                    const pyReq = http.get(`http://127.0.0.1:5002/info?url=${encodeURIComponent(safeUrl)}`, (res) => {
                        let data = '';
                        res.on('data', chunk => data += chunk);
                        res.on('end', () => resolve(JSON.parse(data)));
                    });
                    pyReq.on('error', reject);
                    pyReq.setTimeout(30000, () => { pyReq.destroy(); reject(new Error('YouTube Engine Timeout')); });
                });
                return res.json({ ...response, originalUrl: url });
            } catch (err) {
                console.error('[YouTube Engine Error]:', err.message);
                if (err.code === 'ECONNREFUSED') {
                    throw new Error('YouTube Hybrid Pro Engine (Port 5002) is currently offline. Please run start_all.bat to start it.');
                }
                throw err;
            }
        }

        const isTikTok = safeUrl.includes('tiktok.com');
        const provider = getProvider(safeUrl);
        console.log(`[INFO] ${provider.constructor.name} → ${safeUrl}`);
        const info = await provider.getInfo(safeUrl);

        info.audioFormats = info.audioFormats || [];

        // Fetch file sizes in parallel for all formats using the new getFileSize method
        if (info.formats && info.formats.length > 0) {
            await Promise.all(info.formats.map(async (fmt) => {
                // If yt-dlp already provided a size, keep it. Otherwise, fetch it.
                if (!fmt.size && fmt.url) {
                    fmt.size = await provider.getFileSize(fmt.url);
                }
            }));
        }

        // Pre-fetch CDN URL in background so /api/download is instant
        if (!isTikTok) setImmediate(() => preFetchCdnUrl(safeUrl, info).catch(() => {}));

        return res.json({ ...info, originalUrl: url });
    } catch (err) {
        console.error('[INFO Error]:', err.message);
        let msg = 'Could not extract video info. The link may be invalid or private.';
        const m = err.message || '';
        if (m.includes('BOT_DETECTION_TRIGGERED'))                msg = 'YouTube is blocking this request (Bot Detection). Try again later or update cookies.';
        else if (m.includes('Private video'))                     msg = 'This video is private.';
        else if (m.includes('age'))                               msg = 'Age-restricted content cannot be downloaded.';
        else if (m.includes('offline'))                           msg = m; // Pass through the "engine offline" message
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
    
    // ── YouTube Hybrid Pro Download ──
    if (isYouTube) {
        console.log(`[DOWNLOAD] YouTube Hybrid Pro Pipe → ${safeUrl.slice(0, 60)}`);
        const pyUrl = `http://127.0.0.1:5002/download?url=${encodeURIComponent(safeUrl)}${type ? `&height=${type}` : ''}${fid ? `&fid=${encodeURIComponent(fid)}` : ''}`;
        
        const pyReq = http.get(pyUrl, (pyRes) => {
            if (pyRes.statusCode !== 200) {
                console.error('[YouTube Engine] Download error:', pyRes.statusCode);
                return res.status(500).send('YouTube download failed.');
            }
            if (pyRes.headers['content-length']) res.setHeader('Content-Length', pyRes.headers['content-length']);
            if (pyRes.headers['content-type']) res.setHeader('Content-Type', pyRes.headers['content-type']);
            
            console.log(`[DOWNLOAD] Streaming from Python engine started: ${safeUrl.slice(0, 40)}...`);
            pyRes.pipe(res);
        });
        
        pyReq.on('error', (err) => {
            console.error('[YouTube Proxy Error]:', err.message);
            if (!res.headersSent) res.status(500).send('Connection to YouTube engine failed.');
        });
        
        req.on('close', () => pyReq.destroy());
        return;
    }

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
        if (isTikTok) {
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
                console.log('[DOWNLOAD] tikwm original URL — redirecting browser:', tikwmOriginal.slice(0, 100));
                if (!res.headersSent) return res.redirect(302, tikwmOriginal);
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

            console.log('[DOWNLOAD] Snapchat social_server failed → yt-dlp merge');
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

app.get('/tiktok-downloader', (_req, res) => {
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
        <div class="mt-5 space-y-3">
          <a href="\${data.video_url}"
             class="btn-dl w-full flex items-center justify-center gap-2 text-white font-bold py-4 rounded-xl text-base"
             target="_blank">
            <i class="fa-solid fa-download"></i> Download Direct (HD)
          </a>
          <a href="/proxy?url=\${encodeURIComponent(data.video_url)}"
             class="w-full flex items-center justify-center gap-2 text-gray-400 hover:text-white transition py-2 text-sm"
             target="_blank">
            <i class="fa-solid fa-server"></i> Server Proxy Fallback
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

// ─── Sitemap & SEO Infrastructure ──────────────────────────────────────────────
app.get('/sitemap.xml', (_req, res) => {
    const baseUrl = 'https://doomsdaysnap.online';
    const now = new Date().toISOString().split('T')[0];

    const staticPages = [
        { loc: '/',          priority: '1.0', changefreq: 'daily'   },
        { loc: '/blog',      priority: '0.9', changefreq: 'weekly'  },
        { loc: '/privacy',   priority: '0.3', changefreq: 'monthly' },
        { loc: '/tos',       priority: '0.3', changefreq: 'monthly' },
    ];

    const platformPages = Object.keys(PLATFORM_SEO_DATA).map(p => ({
        loc: `/${p}`, priority: '0.9', changefreq: 'weekly'
    }));

    const additionalPages = Object.keys(ADDITIONAL_SEO_DATA).map(p => ({
        loc: `/${p}`, priority: '0.8', changefreq: 'weekly'
    }));

    const blogPages = BLOG_POSTS.map(p => ({
        loc: `/blog/${p.slug}`, priority: '0.7', changefreq: 'monthly', lastmod: p.date
    }));

    const allPages = [...staticPages, ...platformPages, ...additionalPages, ...blogPages];

    const urlEntries = allPages.map(p => `
    <url>
        <loc>${baseUrl}${p.loc}</loc>
        <lastmod>${p.lastmod || now}</lastmod>
        <changefreq>${p.changefreq}</changefreq>
        <priority>${p.priority}</priority>
    </url>`).join('');

    const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urlEntries}\n</urlset>`;

    res.header('Content-Type', 'application/xml');
    res.send(xml);
});

app.listen(PORT, () => {
    console.log(`🚀 Doomsdaysnap running at http://localhost:${PORT}`);
});
