/**
 * Pure Node.js Facebook video extractor — no Python required.
 * Tries multiple third-party download services in sequence.
 */
const https = require('https');
const http  = require('http');
const querystring = require('querystring');

function fixUrl(u) {
    return u.replace(/\\u0026/g, '&').replace(/\\\//g, '/').replace(/\\\\/g, '\\');
}

function request(opts, postBody = null) {
    return new Promise((resolve) => {
        const lib = (opts.protocol === 'http:' || opts.port === 80) ? http : https;
        const req = lib.request(opts, (res) => {
            // follow redirects
            if ([301, 302, 307, 308].includes(res.statusCode) && res.headers.location) {
                res.resume();
                try {
                    const loc = res.headers.location;
                    const next = new URL(loc.startsWith('http') ? loc : `https://${opts.hostname}${loc}`);
                    request({
                        hostname: next.hostname,
                        path: next.pathname + next.search,
                        method: 'GET',
                        headers: opts.headers,
                    }).then(resolve);
                } catch { resolve(null); }
                return;
            }
            let data = '';
            res.on('data', d => data += d.toString());
            res.on('end', () => resolve(data));
        });
        req.setTimeout(20000, () => { req.destroy(); resolve(null); });
        req.on('error', () => resolve(null));
        if (postBody) req.write(postBody);
        req.end();
    });
}

const BROWSER_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
};

// Method 1: snapsave.app
async function trySnapsave(url) {
    try {
        const body = querystring.stringify({ url });
        const html = await request({
            hostname: 'snapsave.app',
            path: '/action.php',
            method: 'POST',
            headers: {
                ...BROWSER_HEADERS,
                'Content-Type': 'application/x-www-form-urlencoded',
                'Content-Length': Buffer.byteLength(body),
                'Referer': 'https://snapsave.app/',
                'Origin': 'https://snapsave.app',
            },
        }, body);
        if (!html) return null;
        const links = (html.match(/href="(https:\/\/[^"]+\.mp4[^"]*)"/gi) || [])
            .concat(html.match(/href="(https:\/\/[^"]+fbcdn[^"]*)"/gi) || [])
            .map(m => m.match(/href="([^"]+)"/)?.[1])
            .filter(Boolean);
        if (links.length > 0) {
            console.log('[FB-Direct] snapsave.app success');
            return fixUrl(links[0]);
        }
    } catch (e) {
        console.log('[FB-Direct] snapsave error:', e.message);
    }
    return null;
}

// Method 2: fdownloader.net
async function tryFdownloader(url) {
    try {
        const body = querystring.stringify({ q: url, lang: 'en', v: 'a2' });
        const raw = await request({
            hostname: 'fdownloader.net',
            path: '/api/ajaxSearch',
            method: 'POST',
            headers: {
                ...BROWSER_HEADERS,
                'Content-Type': 'application/x-www-form-urlencoded',
                'Content-Length': Buffer.byteLength(body),
                'Referer': 'https://fdownloader.net/',
                'Origin': 'https://fdownloader.net',
                'X-Requested-With': 'XMLHttpRequest',
            },
        }, body);
        if (!raw) return null;
        const data = JSON.parse(raw);
        const html = data?.data || '';
        const links = (html.match(/href="(https:\/\/[^"]+\.mp4[^"]*)"/gi) || [])
            .concat(html.match(/href="(https:\/\/[^"]+fbcdn[^"]*)"/gi) || [])
            .map(m => m.match(/href="([^"]+)"/)?.[1])
            .filter(Boolean);
        if (links.length > 0) {
            console.log('[FB-Direct] fdownloader.net success');
            return fixUrl(links[0]);
        }
    } catch (e) {
        console.log('[FB-Direct] fdownloader error:', e.message);
    }
    return null;
}

// Method 3: getfvid.com
async function tryGetFvid(url) {
    try {
        const body = querystring.stringify({ url });
        const html = await request({
            hostname: 'www.getfvid.com',
            path: '/downloader',
            method: 'POST',
            headers: {
                ...BROWSER_HEADERS,
                'Content-Type': 'application/x-www-form-urlencoded',
                'Content-Length': Buffer.byteLength(body),
                'Referer': 'https://www.getfvid.com/',
                'Origin': 'https://www.getfvid.com',
            },
        }, body);
        if (!html) return null;
        const m = html.match(/href="(https:\/\/[^"]+\.mp4[^"]*)"/i);
        if (m) {
            console.log('[FB-Direct] getfvid.com success');
            return fixUrl(m[1]);
        }
    } catch (e) {
        console.log('[FB-Direct] getfvid error:', e.message);
    }
    return null;
}

// Method 4: savefrom.net worker
async function trySavefrom(url) {
    try {
        const encoded = encodeURIComponent(url);
        const html = await request({
            hostname: 'worker.sf-tools.com',
            path: `/savefrom.php?sf_url=${encoded}&new=1`,
            method: 'GET',
            headers: {
                ...BROWSER_HEADERS,
                'Referer': 'https://en.savefrom.net/',
            },
        });
        if (!html) return null;
        const data = JSON.parse(html);
        const links = data?.url || [];
        if (links.length > 0) {
            const best = [...links].sort((a, b) => parseInt(b.id || 0) - parseInt(a.id || 0));
            const videoUrl = best[0]?.url;
            if (videoUrl) {
                console.log('[FB-Direct] savefrom.net success');
                return videoUrl;
            }
        }
    } catch (e) {
        console.log('[FB-Direct] savefrom error:', e.message);
    }
    return null;
}

// Method 5: fdown.net
async function tryFdown(url) {
    try {
        const body = querystring.stringify({ URLz: url });
        const html = await request({
            hostname: 'fdown.net',
            path: '/download.php',
            method: 'POST',
            headers: {
                ...BROWSER_HEADERS,
                'Content-Type': 'application/x-www-form-urlencoded',
                'Content-Length': Buffer.byteLength(body),
                'Referer': 'https://fdown.net/',
            },
        }, body);
        if (!html) return null;
        const hd = html.match(/href="(https:\/\/[^"]+\.mp4[^"]*)"[^>]*>\s*HD/i);
        const sd = html.match(/href="(https:\/\/[^"]+\.mp4[^"]*)"[^>]*>\s*SD/i);
        const m = hd || sd;
        if (m) {
            console.log('[FB-Direct] fdown.net success');
            return m[1];
        }
    } catch (e) {
        console.log('[FB-Direct] fdown error:', e.message);
    }
    return null;
}

/**
 * Try all methods in parallel (fastest wins).
 * Returns the first video URL found, or null if all fail.
 */
async function facebookDirectExtract(url) {
    // Run all methods in parallel — return first that succeeds
    return new Promise((resolve) => {
        let resolved = false;
        let pending = 5;

        function done(result) {
            pending--;
            if (!resolved && result) {
                resolved = true;
                resolve(result);
            } else if (pending === 0 && !resolved) {
                resolve(null);
            }
        }

        trySnapsave(url).then(done);
        tryFdownloader(url).then(done);
        tryGetFvid(url).then(done);
        trySavefrom(url).then(done);
        tryFdown(url).then(done);
    });
}

module.exports = { facebookDirectExtract };
