const puppeteer = require('puppeteer-extra');
const stealth   = require('puppeteer-extra-plugin-stealth');
const fs        = require('fs');
const path      = require('path');

puppeteer.use(stealth());

// ── Load cookies from Netscape cookies.txt ────────────────────────────────────
function loadCookiesFile() {
    const names = ['cookies.txt', 'cookies (1).txt', 'cookie.txt'];
    for (const name of names) {
        const p = path.join(__dirname, '..', name);
        if (fs.existsSync(p)) {
            try {
                const lines = fs.readFileSync(p, 'utf8').split('\n');
                const cookies = [];
                for (const line of lines) {
                    if (!line || line.startsWith('#')) continue;
                    const parts = line.split('\t');
                    if (parts.length < 7) continue;
                    const [domain, , cookiePath, secure, expires, name2, value] = parts;
                    // Keep original domain — don't add leading dot to www. domains
                    // Puppeteer needs exact domain or .domain for subdomain matching
                    const cleanDomain = domain.trim();
                    cookies.push({
                        domain:   cleanDomain,
                        path:     cookiePath || '/',
                        secure:   secure === 'TRUE',
                        expires:  parseInt(expires) || undefined,
                        name:     name2.trim(),
                        value:    value.trim(),
                        httpOnly: false,
                        sameSite: 'None',
                    });
                }
                console.log(`[BrowserScraper] Loaded ${cookies.length} cookies from ${name}`);
                return cookies;
            } catch (e) {
                console.error('[BrowserScraper] Cookie parse error:', e.message);
            }
        }
    }
    return [];
}

const ALL_COOKIES = loadCookiesFile();

// Filter cookies for a specific domain
// Matches both exact (www.x.com) and wildcard (.x.com) forms
function cookiesFor(domains) {
    return ALL_COOKIES.filter(c => {
        const cd = c.domain.replace(/^\./, ''); // strip leading dot for comparison
        return domains.some(d => {
            const dd = d.replace(/^\./, '');
            return cd === dd || cd.endsWith('.' + dd) || dd.endsWith('.' + cd);
        });
    });
}

function findChromium() {
    const isWin = process.platform === 'win32';
    const paths = isWin ? [
        process.env.CHROMIUM_PATH,
        'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
        `${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe`,
    ] : [
        process.env.CHROMIUM_PATH,
        '/usr/bin/chromium-browser',
        '/usr/bin/chromium',
        '/usr/bin/google-chrome-stable',
        '/usr/bin/google-chrome',
    ];
    for (const p of paths) {
        if (p && fs.existsSync(p)) return p;
    }
    return undefined;
}

const CHROMIUM = findChromium();
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
        ],
    });
    _browser.on('disconnected', () => { _browser = null; });
    return _browser;
}

// ── Network-intercept helper ──────────────────────────────────────────────────
// Opens a page, intercepts all network responses, and collects URLs whose
// content-type looks like video, or whose URL matches known video CDN patterns.
// Returns the best URL found (prefer HD / longest URL for CDN quality signals).
async function interceptVideoUrl(targetUrl, cdnPatterns, cookieDomains = [], timeout = 25000) {
    let page;
    const found = [];

    try {
        const browser = await getBrowser();
        page = await browser.newPage();

        await page.setViewport({ width: 1280, height: 800 });
        await page.setUserAgent(
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
            '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
        );

        // Inject platform cookies so we appear as a logged-in user
        if (cookieDomains.length > 0) {
            const toInject = cookiesFor(cookieDomains);
            if (toInject.length > 0) {
                await page.setCookie(...toInject);
                console.log(`[BrowserScraper] Injected ${toInject.length} cookies for ${cookieDomains}`);
            }
        }

        // Collect video CDN URLs from network traffic
        page.on('response', async (response) => {
            try {
                const url = response.url();
                const ct  = (response.headers()['content-type'] || '').toLowerCase();
                const isVideo = ct.includes('video') || ct.includes('octet-stream');
                const matchesCdn = cdnPatterns.some(p => url.match(p));

                if ((isVideo || matchesCdn) && url.startsWith('http')) {
                    const status = response.status();
                    if (status === 200 || status === 206) {
                        found.push(url);
                    }
                }
            } catch (_) {}
        });

        // Also intercept XHR/fetch for JSON data containing video URLs
        await page.setRequestInterception(true);
        page.on('request', (req) => {
            // Block images and fonts to speed up loading
            const rt = req.resourceType();
            if (['image', 'font', 'stylesheet'].includes(rt)) {
                req.abort();
            } else {
                req.continue();
            }
        });

        await page.goto(targetUrl, { waitUntil: 'networkidle2', timeout });
        // Give extra time for lazy-loaded video elements to start fetching
        await new Promise(r => setTimeout(r, 3000));

        return found;
    } catch (err) {
        console.error('[BrowserScraper] interceptVideoUrl error:', err.message);
        return found;
    } finally {
        if (page) await page.close().catch(() => {});
    }
}

const browserScraper = {

    // ── Facebook ─────────────────────────────────────────────────────────────
    async extractFacebook(videoUrl) {
        try {
            console.log('[BrowserScraper] FB → network intercept:', videoUrl);

            // Facebook CDN patterns
            const cdnPatterns = [
                /video\.xx\.fbcdn\.net/,
                /video\.fbcdn\.net/,
                /fbcdn\.net.*\.mp4/,
                /\.fbcdn\.net.*type=video/,
                /facebook\.com.*video_redirect/,
            ];

            // Try mobile URL first (less bot detection) + inject FB cookies
            const mobileUrl = videoUrl.replace('www.facebook.com', 'm.facebook.com');
            const fbCookieDomains = ['facebook.com', '.facebook.com'];
            let urls = await interceptVideoUrl(mobileUrl, cdnPatterns, fbCookieDomains);

            // Fallback: try desktop URL with cookies
            if (urls.length === 0) {
                urls = await interceptVideoUrl(videoUrl, cdnPatterns, fbCookieDomains);
            }

            // Fallback: scrape script tags for playable_url
            if (urls.length === 0) {
                urls = await this._fbScriptScrape(mobileUrl);
            }

            if (urls.length === 0) return null;

            // Prefer HD (longer URLs tend to be higher quality on fbcdn)
            urls.sort((a, b) => b.length - a.length);
            const best = urls[0];

            return {
                title: 'Facebook Video',
                thumbnail: '',
                formats: [{ height: 'HD', url: best, ext: 'mp4' }],
                provider: 'facebook',
            };
        } catch (err) {
            console.error('[BrowserScraper] FB Error:', err.message);
            return null;
        }
    },

    // Script-tag fallback for Facebook
    async _fbScriptScrape(targetUrl) {
        let page;
        try {
            const browser = await getBrowser();
            page = await browser.newPage();
            await page.setViewport({ width: 1280, height: 800 });
            await page.setUserAgent(
                'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
                '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
            );
            const fbCookies = cookiesFor(['facebook.com', '.facebook.com']);
            if (fbCookies.length > 0) await page.setCookie(...fbCookies);
            await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 25000 });
            await new Promise(r => setTimeout(r, 3000));

            const urls = await page.evaluate(() => {
                const results = [];
                const scripts = Array.from(document.querySelectorAll('script'));
                for (const s of scripts) {
                    const c = s.textContent;
                    if (!c.includes('playable_url')) continue;

                    // Multiple regex patterns for different FB page formats
                    const patterns = [
                        /"browser_native_hd_url":"([^"]+)"/g,
                        /"browser_native_sd_url":"([^"]+)"/g,
                        /"playable_url":"([^"]+)"/g,
                        /"playable_url_quality_hd":"([^"]+)"/g,
                        /playable_url\\?":\\?"([^"\\]+)/g,
                    ];
                    for (const re of patterns) {
                        let m;
                        while ((m = re.exec(c)) !== null) {
                            const url = m[1].replace(/\\/g, '');
                            if (url.startsWith('http')) results.push(url);
                        }
                    }
                }
                return [...new Set(results)];
            });

            return urls;
        } catch (err) {
            console.error('[BrowserScraper] FB script scrape error:', err.message);
            return [];
        } finally {
            if (page) await page.close().catch(() => {});
        }
    },

    // ── Snapchat ──────────────────────────────────────────────────────────────
    async extractSnapchat(videoUrl) {
        try {
            console.log('[BrowserScraper] Snapchat → network intercept:', videoUrl);

            const cdnPatterns = [
                /cf-st\.sc-cdn\.net/,
                /sc-cdn\.net.*\.mp4/,
                /snapchat-video/,
                /snap\.com.*video/,
                /storage\.googleapis\.com.*snap/,
                /snapkit\.com.*video/,
                /\.snap\.com.*media/,
            ];

            const snapCookieDomains = ['snapchat.com', '.snapchat.com', 'accounts.snapchat.com'];
            let urls = await interceptVideoUrl(videoUrl, cdnPatterns, snapCookieDomains, 30000);

            // Fallback: check video tag after full load
            if (urls.length === 0) {
                urls = await this._snapVideoTag(videoUrl);
            }

            if (urls.length === 0) return null;

            return {
                title: 'Snapchat Video',
                thumbnail: '',
                formats: [{ height: 'HD', url: urls[0], ext: 'mp4' }],
                provider: 'snapchat',
            };
        } catch (err) {
            console.error('[BrowserScraper] Snapchat Error:', err.message);
            return null;
        }
    },

    async _snapVideoTag(videoUrl) {
        let page;
        try {
            const browser = await getBrowser();
            page = await browser.newPage();
            await page.setViewport({ width: 390, height: 844 }); // mobile viewport
            await page.setUserAgent(
                'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) ' +
                'AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1'
            );
            await page.goto(videoUrl, { waitUntil: 'networkidle2', timeout: 30000 });
            await new Promise(r => setTimeout(r, 5000));

            const urls = await page.evaluate(() => {
                const results = [];
                // Check all video elements
                document.querySelectorAll('video').forEach(v => {
                    if (v.src && v.src.startsWith('http')) results.push(v.src);
                    if (v.currentSrc && v.currentSrc.startsWith('http')) results.push(v.currentSrc);
                    v.querySelectorAll('source').forEach(s => {
                        if (s.src && s.src.startsWith('http')) results.push(s.src);
                    });
                });
                // Check page source for CDN URLs
                const html = document.documentElement.innerHTML;
                const matches = html.match(/https?:\/\/[^"'\s]+\.mp4[^"'\s]*/g);
                if (matches) results.push(...matches.filter(u => !u.includes('logo') && !u.includes('icon')));

                return [...new Set(results)];
            });

            return urls;
        } catch (err) {
            console.error('[BrowserScraper] Snap video tag error:', err.message);
            return [];
        } finally {
            if (page) await page.close().catch(() => {});
        }
    },
};

module.exports = browserScraper;
