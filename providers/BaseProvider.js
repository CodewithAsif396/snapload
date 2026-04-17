const { spawn }  = require('child_process');
const ffmpegPath = require('ffmpeg-static');
const fs         = require('fs');
const path       = require('path');

const isWin = process.platform === 'win32';

// Robust yt-dlp detection (align with server.js)
function getYTdlpPath() {
    // Check root directory
    const rootPath = path.join(__dirname, '..', isWin ? 'yt-dlp.exe' : 'yt-dlp');
    if (fs.existsSync(rootPath)) return rootPath;

    // System common paths
    const systemPaths = isWin 
        ? ['C:\\Program Files\\yt-dlp\\yt-dlp.exe', 'C:\\yt-dlp.exe']
        : ['/usr/local/bin/yt-dlp', '/usr/bin/yt-dlp'];
    
    for (const p of systemPaths) {
        if (fs.existsSync(p)) return p;
    }

    // Fallback to node_modules
    return isWin
        ? path.join(__dirname, '..', 'node_modules', 'youtube-dl-exec', 'bin', 'yt-dlp.exe')
        : path.join(__dirname, '..', 'node_modules', 'youtube-dl-exec', 'bin', 'yt-dlp');
}

const YTDLP_BIN = getYTdlpPath();

// Cookies file detection — check multiple possible names (browser export adds " (1)" suffix)
function findCookiesFile() {
    const names = ['cookies.txt', 'cookies (1).txt', 'cookie.txt'];
    for (const name of names) {
        const p = path.join(__dirname, '..', name);
        if (fs.existsSync(p)) return p;
    }
    return null;
}
const COOKIES_ARG = findCookiesFile();

console.log('[BaseProvider] Using YTDLP:', YTDLP_BIN);
if (COOKIES_ARG) console.log('[BaseProvider] Using COOKIES_FILE:', COOKIES_ARG);
else            console.log('[BaseProvider] No cookies file found');


// Convert options object → CLI args array
function toArgs(opts) {
    const args = [];
    for (const [key, val] of Object.entries(opts)) {
        if (val === false || val == null) continue;
        const flag = '--' + key.replace(/([A-Z])/g, '-$1').toLowerCase();
        if (val === true) {
            args.push(flag);
        } else if (Array.isArray(val)) {
            for (const v of val) args.push(flag, v);
        } else {
            args.push(flag, String(val));
        }
    }
    return args;
}

class BaseProvider {
    constructor() {}

    async getInfo(url) {
        throw new Error('getInfo must be implemented by subclass');
    }

    /**
     * Shared format parser used by all social providers.
     * - Filters out audio-only streams
     * - Prefers H.264 (avc/h264) for maximum device compatibility
     * - Deduplicates by resolution height
     * - Caps at maxCount options (default 4)
     * - Always returns at least one fallback entry
     *
     * @param {Array}  formats   raw formats array from yt-dlp JSON
     * @param {number} maxCount  max number of quality options to return
     * @returns {Array}  [{height, ext, size}, ...]
     */
    parseFormats(formats = [], maxCount = 4) {
        const seenHeights   = new Set();
        const uniqueFormats = [];

        const sorted = formats
            .filter(f => f.vcodec && f.vcodec !== 'none')
            .sort((a, b) => {
                // H.264 formats first (widest compatibility), then high-to-low resolution
                const aH264 = /^(avc|h264)/i.test(a.vcodec || '') ? 1 : 0;
                const bH264 = /^(avc|h264)/i.test(b.vcodec || '') ? 1 : 0;
                if (bH264 !== aH264) return bH264 - aH264;
                return (b.height || 0) - (a.height || 0);
            });

        for (const f of sorted) {
            const h = f.height || 'HD';
            if (!seenHeights.has(h) && uniqueFormats.length < maxCount) {
                seenHeights.add(h);
                uniqueFormats.push({
                    height: h,
                    ext:    'mp4',
                    size:   f.filesize || f.filesize_approx || null,
                    // Store the exact yt-dlp format ID so the download route
                    // can request this precise stream instead of guessing by height.
                    fid:    f.format_id || null,
                });
            }
        }

        // Always return at least one download option
        if (uniqueFormats.length === 0) {
            uniqueFormats.push({ height: 'HD', ext: 'mp4', size: null });
        }

        return uniqueFormats;
    }

    async executeYtdlp(url, extraOpts = {}) {
        const { userAgent, referer, ...otherOpts } = extraOpts;

        return new Promise((resolve, reject) => {
            const args = [
                url,
                '--dump-single-json',
                '--no-warnings',
                '--no-check-certificate',
                '--no-playlist',
                '--force-ipv4',
                '--geo-bypass',
                '--ffmpeg-location', ffmpegPath,
            ];

            // Add standard Cookies if available
            if (COOKIES_ARG) args.push('--cookies', COOKIES_ARG);

            // Add explicit UA/Referer flags (most effective against bots)
            if (userAgent) args.push('--user-agent', userAgent);
            if (referer)   args.push('--referer', referer);

            // Append other extra options converted to CLI flags
            args.push(...toArgs(otherOpts));

            const proc = spawn(YTDLP_BIN, args, { stdio: ['ignore', 'pipe', 'pipe'] });
            let out = '';
            let err = '';

            proc.stdout.on('data', d => out += d.toString());
            proc.stderr.on('data', d => {
                const line = d.toString();
                // Filter out progress lines to keep error log clean
                if (!line.includes('[download]') && !line.includes('ETA')) err += line;
            });

            const timer = setTimeout(() => {
                proc.kill('SIGKILL');
                reject(new Error('yt-dlp timed out (extraction took too long)'));
            }, 60000); // 60s timeout for heavy extractions

            proc.on('close', code => {
                clearTimeout(timer);
                if (code === 0 && out.trim()) {
                    try { resolve(JSON.parse(out)); }
                    catch (e) { reject(new Error('Failed to parse yt-dlp JSON results')); }
                } else {
                    const errorMsg = err.trim() || `yt-dlp exited with code ${code}`;
                    
                    // Specific bot detection discovery
                    if (errorMsg.includes('Sign in to confirm you’re not a bot') || errorMsg.includes('403') || errorMsg.includes('Forbidden')) {
                        reject(new Error(`BOT_DETECTED: ${errorMsg}`));
                    } else {
                        reject(new Error(errorMsg));
                    }
                }
            });

            proc.on('error', e => { clearTimeout(timer); reject(e); });
        });
    }
}

module.exports = BaseProvider;
