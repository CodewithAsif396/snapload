/**
 * TikTok Browser — real Chromium session with stealth.
 * Opens the TikTok video page, triggers playback, then grabs
 * the CDN URL + cookies directly from intercepted network requests.
 */
const puppeteer = require('puppeteer-extra');
const stealth   = require('puppeteer-extra-plugin-stealth');
puppeteer.use(stealth());

function findChromium() {
    const fs = require('fs');
    for (const p of [
        process.env.CHROMIUM_PATH,
        '/usr/bin/chromium-browser',
        '/usr/bin/chromium',
        '/usr/bin/google-chrome-stable',
        '/usr/bin/google-chrome',
    ]) {
        if (p && fs.existsSync(p)) return p;
    }
    return undefined;
}

const CHROMIUM = findChromium();
console.log('[TikTokBrowser] Chromium:', CHROMIUM || 'bundled');

let _browser = null;

async function getBrowser() {
    if (_browser && _browser.isConnected()) return _browser;
    _browser = await puppeteer.launch({
        headless: 'new',
        executablePath: CHROMIUM,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-gpu',
            '--no-first-run',
            '--no-zygote',
            '--autoplay-policy=no-user-gesture-required',
            '--disable-features=PreloadMediaEngagementData,MediaEngagementBypassAutoplayPolicies',
        ],
    });
    _browser.on('disconnected', () => { _browser = null; });
    console.log('[TikTokBrowser] Browser launched');
    return _browser;
}

/**
 * Returns { url, headers } with the video CDN URL and browser cookies.
 * Returns null if not found.
 */
async function getTikTokCdnUrl(videoUrl) {
    let page;
    try {
        const browser = await getBrowser();
        page = await browser.newPage();

        // Desktop UA — TikTok desktop serves h264 mp4 which is universally compatible
        await page.setViewport({ width: 1280, height: 800 });
        await page.setUserAgent(
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ' +
            'AppleWebKit/537.36 (KHTML, like Gecko) ' +
            'Chrome/124.0.0.0 Safari/537.36'
        );

        // Set extra headers to look like a real browser
        await page.setExtraHTTPHeaders({
            'Accept-Language': 'en-US,en;q=0.9',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
            'sec-ch-ua': '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
            'sec-ch-ua-mobile': '?0',
            'sec-ch-ua-platform': '"Windows"',
        });

        let captured = null;

        // ── Intercept actual network requests to CDN ──────────────────────────
        await page.setRequestInterception(true);
        page.on('request', (req) => {
            try {
                const u = req.url();
                if (!captured) {
                    const isCdn = u.includes('tiktokcdn.com')
                               || u.includes('tokcdn.com')
                               || u.includes('tiktokv.com')
                               || u.includes('tiktokcdn-us.com')
                               || u.includes('tiktokcdn-eu.com');
                    const isVid = u.includes('/video/tos/')
                               || u.includes('mime_type=video_mp4')
                               || u.includes('mime_type=mp4')
                               || u.includes('filetype=mp4')
                               || (u.includes('.mp4') && !u.includes('cover')
                                   && !u.includes('thumb') && !u.includes('image'));
                    if (isCdn && isVid) {
                        captured = { url: u, headers: req.headers() };
                        console.log('[TikTokBrowser] Captured CDN req:', u.slice(0, 120));
                    }
                }
            } catch { /* ignore */ }
            req.continue().catch(() => {});
        });

        // Use www.tiktok.com (desktop) — more reliable CDN interception
        const targetUrl = videoUrl
            .replace('m.tiktok.com', 'www.tiktok.com')
            .replace('vt.tiktok.com', 'www.tiktok.com')
            .replace('vm.tiktok.com', 'www.tiktok.com');

        console.log('[TikTokBrowser] Navigating to:', targetUrl.slice(0, 100));
        await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });

        // Wait a moment for page to settle
        await new Promise(r => setTimeout(r, 2000));

        // Try to trigger video playback via multiple methods
        if (!captured) {
            try {
                // Click the video element
                await page.evaluate(() => {
                    const v = document.querySelector('video');
                    if (v) { v.muted = true; v.play().catch(() => {}); }
                });
            } catch { /* ignore */ }
        }

        if (!captured) {
            try {
                // Click any play button overlays
                await page.evaluate(() => {
                    const selectors = [
                        '[data-e2e="video-play"]',
                        '.tiktok-video-player',
                        '[class*="DivPlayerContainer"]',
                        '[class*="play-btn"]',
                        '[class*="PlayButton"]',
                        'button[aria-label*="play"]',
                        'button[aria-label*="Play"]',
                    ];
                    for (const sel of selectors) {
                        const el = document.querySelector(sel);
                        if (el) { el.click(); break; }
                    }
                });
            } catch { /* ignore */ }
        }

        // Wait up to 15s for CDN request
        for (let i = 0; i < 15; i++) {
            await new Promise(r => setTimeout(r, 1000));
            if (captured) break;

            // Every 3 seconds try to re-trigger playback
            if (i % 3 === 2 && !captured) {
                try {
                    await page.evaluate(() => {
                        const v = document.querySelector('video');
                        if (v && v.paused) { v.muted = true; v.play().catch(() => {}); }
                    });
                } catch { /* ignore */ }
            }
        }

        if (captured) {
            // Add standard headers if missing
            if (!captured.headers['referer']) captured.headers['referer'] = 'https://www.tiktok.com/';
            // Grab page cookies and merge into captured headers
            try {
                const cookies   = await page.cookies();
                const cookieStr = cookies.map(c => `${c.name}=${c.value}`).join('; ');
                if (cookieStr) captured.headers['cookie'] = cookieStr;
            } catch { /* ignore */ }
            console.log('[TikTokBrowser] Using intercepted CDN URL with browser headers');
            return captured;
        }

        // ── Fallback: read video.src / video.currentSrc from DOM ─────────────
        const domUrl = await page.evaluate(() => {
            const v = document.querySelector('video');
            return v?.src || v?.currentSrc || null;
        }).catch(() => null);

        if (domUrl && domUrl.startsWith('http')) {
            console.log('[TikTokBrowser] DOM video.src fallback:', domUrl.slice(0, 80));
            const cookies    = await page.cookies().catch(() => []);
            const cookieStr  = cookies.map(c => `${c.name}=${c.value}`).join('; ');
            return {
                url: domUrl,
                headers: {
                    'user-agent':  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
                    'referer':     'https://www.tiktok.com/',
                    'cookie':      cookieStr,
                },
            };
        }

        // ── Last resort: try TikTok's internal API for the video URL ──────────
        const apiUrl = await page.evaluate(() => {
            // Check __NEXT_DATA__ / SIGI_STATE for video URL
            try {
                const nextData = JSON.parse(document.getElementById('__NEXT_DATA__')?.textContent || '{}');
                const itemList = nextData?.props?.pageProps?.itemInfo?.itemStruct;
                if (itemList?.video?.playAddr) return itemList.video.playAddr;
                if (itemList?.video?.downloadAddr) return itemList.video.downloadAddr;
            } catch { /* */ }
            try {
                const sigiState = JSON.parse(document.getElementById('SIGI_STATE')?.textContent || '{}');
                const items = sigiState?.ItemModule || {};
                for (const key of Object.keys(items)) {
                    const v = items[key]?.video;
                    if (v?.playAddr) return v.playAddr;
                }
            } catch { /* */ }
            return null;
        }).catch(() => null);

        if (apiUrl && apiUrl.startsWith('http')) {
            console.log('[TikTokBrowser] NEXT_DATA/SIGI_STATE URL:', apiUrl.slice(0, 80));
            const cookies   = await page.cookies().catch(() => []);
            const cookieStr = cookies.map(c => `${c.name}=${c.value}`).join('; ');
            return {
                url: apiUrl,
                headers: {
                    'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
                    'referer':    'https://www.tiktok.com/',
                    'cookie':     cookieStr,
                },
            };
        }

        console.log('[TikTokBrowser] No video URL found');
        return null;

    } catch (err) {
        console.error('[TikTokBrowser] Error:', err.message);
        return null;
    } finally {
        if (page) {
            await page.setRequestInterception(false).catch(() => {});
            await page.close().catch(() => {});
        }
    }
}

// Warm up browser at startup
getBrowser().catch(err => console.error('[TikTokBrowser] Warmup failed:', err.message));

module.exports = { getTikTokCdnUrl };
