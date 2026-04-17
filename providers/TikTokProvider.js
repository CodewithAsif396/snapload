const BaseProvider = require('./BaseProvider');
const https        = require('https');
const zlib         = require('zlib');

function extractVideoId(url) {
    const m = url.match(/video\/(\d+)/);
    return m ? m[1] : null;
}

// Resolve vt.tiktok.com / vm.tiktok.com short URLs → full URL containing video ID
function resolveTikTokUrl(url) {
    if (!url.includes('vt.tiktok.com') && !url.includes('vm.tiktok.com')) return Promise.resolve(url);
    return new Promise((resolve) => {
        const req = https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
            res.resume();
            if ([301, 302, 307, 308].includes(res.statusCode) && res.headers.location) {
                const loc = res.headers.location;
                resolve(loc.startsWith('http') ? loc : `https://www.tiktok.com${loc}`);
            } else {
                resolve(url);
            }
        });
        req.on('error', () => resolve(url));
        setTimeout(() => { req.destroy(); resolve(url); }, 6000);
    });
}

// ─── Method A: TikTok web item-detail API + tt_chain_token ───────────────────
// /api/item/detail/ returns bitrateInfo with genuine HD URLs AND sets
// tt_chain_token in Set-Cookie — that token is the CDN pass for original quality.
// Without tt_chain_token the CDN silently serves the compressed stream.
function tiktokItemDetailFetch(videoId) {
    return new Promise((resolve) => {
        const qs = [
            `itemId=${videoId}`, 'aid=1988', 'app_language=en', 'app_name=tiktok_web',
            'browser_language=en-US', 'browser_name=Mozilla', 'browser_platform=Win32',
            'browser_version=5.0', 'channel=tiktok_web', 'device_platform=web_pc',
            'focus_state=true', 'from_page=video', 'history_len=2',
            'is_fullscreen=false', 'is_page_visible=true',
            'language=en', 'os=windows', 'region=US',
            'screen_height=1080', 'screen_width=1920', 'tz_name=America%2FNew_York',
        ].join('&');

        const headers = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
            'Accept': 'application/json, text/plain, */*',
            'Accept-Language': 'en-US,en;q=0.9',
            'Referer': 'https://www.tiktok.com/',
            'Sec-Fetch-Dest': 'empty',
            'Sec-Fetch-Mode': 'cors',
            'Sec-Fetch-Site': 'same-origin',
            'sec-ch-ua': '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
            'sec-ch-ua-mobile': '?0',
            'sec-ch-ua-platform': '"Windows"',
        };
        if (process.env.TIKTOK_COOKIE) headers['Cookie'] = process.env.TIKTOK_COOKIE;

        const req = https.get(`https://www.tiktok.com/api/item/detail/?${qs}`, { headers }, (res) => {
            // Capture tt_chain_token — this is the CDN access key for HD quality
            let ttToken = null;
            for (const c of (res.headers['set-cookie'] || [])) {
                const m = c.match(/tt_chain_token=([^;]+)/);
                if (m) { ttToken = m[1]; break; }
            }

            let d = '';
            res.on('data', c => d += c);
            res.on('end', () => {
                try {
                    const json = JSON.parse(d);
                    resolve({ item: json?.itemInfo?.itemStruct || null, ttToken });
                } catch { resolve({ item: null, ttToken }); }
            });
        });
        req.on('error', () => resolve({ item: null, ttToken: null }));
        setTimeout(() => { req.destroy(); resolve({ item: null, ttToken: null }); }, 12000);
    });
}

// Pick highest-quality entry from bitrateInfo (web API — PascalCase keys)
// Sort by resolution number in GearName, tiebreak by actual Bitrate value
function pickBestBitrateInfo(bitrateInfo) {
    if (!Array.isArray(bitrateInfo) || bitrateInfo.length === 0) return null;
    const gearRes = (name = '') => { const m = name.match(/(\d{3,4})/); return m ? parseInt(m[1]) : 0; };
    return [...bitrateInfo].sort((a, b) => {
        const d = gearRes(b.GearName) - gearRes(a.GearName);
        return d !== 0 ? d : (b.Bitrate || 0) - (a.Bitrate || 0);
    })[0];
}

// ─── Method B: TikTok internal aweme API ─────────────────────────────────────
function tiktokApiFetch(videoId) {
    return new Promise((resolve) => {
        const url = `https://api22-normal-c-useast2a.tiktokv.com/aweme/v1/feed/?aweme_id=${videoId}&aid=1233&app_name=musical_ly&version_code=26.1.3&device_type=Pixel+4&os=android`;
        const headers = {
            'User-Agent': 'Mozilla/5.0',
            'Referer':    'https://www.tiktok.com/',
        };
        if (process.env.TIKTOK_COOKIE) headers['Cookie'] = process.env.TIKTOK_COOKIE;
        https.get(url, { headers }, (res) => {
            let d = '';
            res.on('data', c => d += c);
            res.on('end', () => {
                try {
                    const json = JSON.parse(d);
                    resolve(json?.status_code === 0 ? (json.aweme_list?.[0] || null) : null);
                } catch { resolve(null); }
            });
        }).on('error', () => resolve(null));
    });
}

function pickBestBitRate(bitRates) {
    if (!Array.isArray(bitRates) || bitRates.length === 0) return null;
    const gearRes = (name = '') => { const m = name.match(/(\d{3,4})/); return m ? parseInt(m[1]) : 0; };
    return [...bitRates].sort((a, b) => {
        const d = gearRes(b.gear_name) - gearRes(a.gear_name);
        return d !== 0 ? d : (b.bit_rate || 0) - (a.bit_rate || 0);
    })[0];
}

// ─── Method C: tikwm.com ──────────────────────────────────────────────────────
function fetchJson(url, headers = {}) {
    return new Promise((resolve) => {
        https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://www.tiktok.com/', ...headers } }, (res) => {
            let d = '';
            res.on('data', c => d += c);
            res.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve(null); } });
        }).on('error', () => resolve(null));
    });
}

async function tikwmFetch(url) {
    const json = await fetchJson(`https://www.tikwm.com/api/?url=${encodeURIComponent(url)}&hd=1`);
    if (json?.code === 0 && json.data) return json.data;
    return null;
}

async function snaptikFetch(url) {
    const json = await fetchJson(
        `https://www.tikwm.com/api/?url=${encodeURIComponent(url)}&count=12&cursor=0&web=1&hd=1`,
        { 'Referer': 'https://www.tikwm.com/' }
    );
    if (json?.code === 0 && json.data) return json.data;
    return null;
}

// ─── Method D: Direct page scraping (__UNIVERSAL_DATA_FOR_REHYDRATION__) ─────
// Inspired by Tikorgzo's direct extractor: fetches the TikTok video page HTML,
// parses the embedded SSR JSON to extract original-quality download URLs without
// relying on any third-party API.
function tiktokDirectPageFetch(videoId) {
    return new Promise((resolve) => {
        const url = `https://www.tiktok.com/video/${videoId}`;
        const headers = {
            'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
            'Accept':          'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Language': 'en-US,en;q=0.9',
            'Accept-Encoding': 'gzip, deflate, br',
            'Referer':         'https://www.tiktok.com/',
            'Sec-Fetch-Dest':  'document',
            'Sec-Fetch-Mode':  'navigate',
            'Sec-Fetch-Site':  'none',
        };
        if (process.env.TIKTOK_COOKIE) headers['Cookie'] = process.env.TIKTOK_COOKIE;

        const req = https.get(url, { headers }, (res) => {
            // Decompress response (TikTok almost always sends gzip/br)
            let stream = res;
            const enc = res.headers['content-encoding'];
            if (enc === 'gzip')    stream = res.pipe(zlib.createGunzip());
            else if (enc === 'br') stream = res.pipe(zlib.createBrotliDecompress());
            else if (enc === 'deflate') stream = res.pipe(zlib.createInflate());

            const chunks = [];
            stream.on('data', c => chunks.push(c));
            stream.on('end', () => {
                const html = Buffer.concat(chunks).toString('utf8');
                // Locate the SSR hydration data script tag
                const m = html.match(/<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__"[^>]*>([\s\S]*?)<\/script>/);
                if (!m) return resolve(null);
                try {
                    const data     = JSON.parse(m[1]);
                    const item     = data?.['__DEFAULT_SCOPE__']?.['webapp.video-detail']?.itemInfo?.itemStruct;
                    resolve(item || null);
                } catch { resolve(null); }
            });
            stream.on('error', () => resolve(null));
        });
        req.on('error', () => resolve(null));
        setTimeout(() => { req.destroy(); resolve(null); }, 15000);
    });
}

// ─── Provider ─────────────────────────────────────────────────────────────────
class TikTokProvider extends BaseProvider {
    async getInfo(url) {
        // Resolve short URLs (vt.tiktok.com, vm.tiktok.com) before extracting video ID
        const resolvedUrl = await resolveTikTokUrl(url);
        const videoId = extractVideoId(resolvedUrl);

        // A: item/detail API — bitrateInfo with HD URLs
        if (videoId) {
            const { item } = await tiktokItemDetailFetch(videoId);
            if (item?.video) {
                const video = item.video;
                const w = video.width  || 576;
                const h = video.height || 1024;
                const res = `${w}×${h}`;
                const formats = [];

                const best = pickBestBitrateInfo(video.bitrateInfo);
                if (best) {
                    const bh = parseInt(best.GearName?.match(/(\d{3,4})/)?.[1]) || h;
                    formats.push({
                        height: bh,
                        ext:    'mp4',
                        size:   best.PlayAddr?.DataSize || null,
                        label:  `${best.GearName} · ${res}`,
                    });
                } else if (video.downloadAddr || video.playAddr) {
                    formats.push({ height: h, ext: 'mp4', size: null, label: `HD · ${res}` });
                }

                if (formats.length > 0) {
                    const dur = video.duration || 0; // seconds in web API
                    const mm  = String(Math.floor(dur / 60));
                    const ss  = String(dur % 60).padStart(2, '0');
                    return {
                        title:     item.desc  || 'TikTok Video',
                        thumbnail: video.cover || '',
                        duration:  `${mm}:${ss}`,
                        formats,
                        provider:  'tiktok',
                    };
                }
            }
        }

        // B: aweme internal API — bit_rate array
        if (videoId) {
            const aweme = await tiktokApiFetch(videoId);
            if (aweme?.video) {
                const video = aweme.video;
                const w = video.width  || 576;
                const h = video.height || 1024;
                const formats = [];

                const best = pickBestBitRate(video.bit_rate);
                if (best) {
                    const bh = parseInt(best.gear_name?.match(/(\d{3,4})/)?.[1]) || h;
                    formats.push({
                        height: bh,
                        ext:    'mp4',
                        size:   best.play_addr?.data_size || null,
                        label:  `${best.gear_name} · ${w}×${h}`,
                    });
                } else if (video.download_addr || video.play_addr) {
                    formats.push({ height: h, ext: 'mp4', size: null, label: `HD · ${w}×${h}` });
                }

                if (formats.length > 0) {
                    const durSec = Math.round((video.duration || 0) / 1000);
                    const mm = String(Math.floor(durSec / 60));
                    const ss = String(durSec % 60).padStart(2, '0');
                    return {
                        title:     aweme.desc                 || 'TikTok Video',
                        thumbnail: video.cover?.url_list?.[0] || '',
                        duration:  `${mm}:${ss}`,
                        formats,
                        provider:  'tiktok',
                    };
                }
            }
        }

        // C: Direct TikTok page scraping (__UNIVERSAL_DATA_FOR_REHYDRATION__)
        // Tikorgzo-style: parses the SSR JSON embedded in the TikTok video page
        // to get original downloadAddr/playAddr without any external API dependency.
        if (videoId) {
            const item = await tiktokDirectPageFetch(videoId);
            if (item?.video) {
                const video = item.video;
                const w = video.width  || 576;
                const h = video.height || 1024;
                const res = `${w}×${h}`;
                const formats = [];

                const best = pickBestBitrateInfo(video.bitrateInfo);
                if (best) {
                    const bh = parseInt(best.GearName?.match(/(\d{3,4})/)?.[1]) || h;
                    formats.push({ height: bh, ext: 'mp4', size: best.PlayAddr?.DataSize || null, label: `${best.GearName} · ${res}` });
                } else if (video.downloadAddr || video.playAddr) {
                    formats.push({ height: h, ext: 'mp4', size: null, label: `Original · ${res}` });
                }

                if (formats.length > 0) {
                    const dur = video.duration || 0;
                    return {
                        title:     item.desc  || 'TikTok Video',
                        thumbnail: video.cover || '',
                        duration:  `${String(Math.floor(dur / 60))}:${String(dur % 60).padStart(2, '0')}`,
                        formats,
                        provider:  'tiktok',
                    };
                }
            }
        }

        // D: tikwm.com API
        const data = await tikwmFetch(url) || await snaptikFetch(url);
        if (data) {
            const w = data.width  || 1080;
            const h = data.height || 1920;
            const formats = [];
            if (data.hdplay) formats.push({ height: h, ext: 'mp4', size: data.hd_size || null, label: `Original HD · ${w}×${h}` });
            if (data.play)   formats.push({ height: Math.round(h * 0.75), ext: 'mp4', size: data.size || null, label: `Standard · ${w}×${h}` });
            if (!formats.length) formats.push({ height: 'HD', ext: 'mp4', size: null });

            const dur = data.duration || 0;
            return {
                title:     data.title || 'TikTok Video',
                thumbnail: data.cover || '',
                duration:  `${String(Math.floor(dur / 60))}:${String(dur % 60).padStart(2, '0')}`,
                formats,
                provider:  'tiktok',
            };
        }

        // E: yt-dlp final fallback
        console.log('[TikTok] All APIs failed, trying yt-dlp');
        const output = await this.executeYtdlp(url, {
            addHeader: [
                'referer:https://www.tiktok.com/',
                'user-agent:Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
            ],
            noCheckFormats: true,
        });

        const formats = (output.formats || [])
            .filter(f => f.vcodec && f.vcodec !== 'none')
            .sort((a, b) => (b.height || 0) - (a.height || 0))
            .slice(0, 2)
            .map(f => ({ height: f.height || 'HD', ext: 'mp4', size: f.filesize || null }));

        return {
            title:     output.title     || 'TikTok Video',
            thumbnail: output.thumbnail || '',
            duration:  output.duration_string || '0:00',
            formats:   formats.length ? formats : [{ height: 'HD', ext: 'mp4', size: null }],
            provider:  'tiktok',
        };
    }
}

module.exports = TikTokProvider;
