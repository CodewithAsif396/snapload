const BaseProvider = require('./BaseProvider');
const https        = require('https');

// Base headers for TikTok API/CDN requests
const TIKTOK_HEADERS = {
    'User-Agent': 'Mozilla/5.0',
    'Referer':    'https://www.tiktok.com/',
};

function fetchJson(url, headers = {}) {
    return new Promise((resolve) => {
        https.get(url, { headers: { ...TIKTOK_HEADERS, ...headers } }, (res) => {
            let d = '';
            res.on('data', c => d += c);
            res.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve(null); } });
        }).on('error', () => resolve(null));
    });
}

function extractVideoId(url) {
    const m = url.match(/video\/(\d+)/);
    return m ? m[1] : null;
}

// ─── Method A: TikTok webpage scrape ─────────────────────────────────────────
// TikTok server-renders full video data in __UNIVERSAL_DATA_FOR_REHYDRATION__
// including bitrateInfo with genuine HD CDN URLs — no auth required for public videos
function tiktokWebScrape(url, redirects = 5) {
    return new Promise((resolve) => {
        const headers = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Language': 'en-US,en;q=0.9',
            'Accept-Encoding': 'identity',
            'Referer': 'https://www.tiktok.com/',
            'Upgrade-Insecure-Requests': '1',
            'Cache-Control': 'max-age=0',
        };
        if (process.env.TIKTOK_COOKIE) headers['Cookie'] = process.env.TIKTOK_COOKIE;

        const req = https.get(url, { headers }, (res) => {
            // Follow redirects (short URLs like vm.tiktok.com)
            if ([301, 302, 307, 308].includes(res.statusCode) && res.headers.location && redirects > 0) {
                res.resume();
                const next = res.headers.location.startsWith('http')
                    ? res.headers.location
                    : `https://www.tiktok.com${res.headers.location}`;
                return tiktokWebScrape(next, redirects - 1).then(resolve);
            }

            const chunks = [];
            res.on('data', c => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
            res.on('end', () => {
                try {
                    const html = Buffer.concat(chunks).toString('utf8');

                    // Primary: __UNIVERSAL_DATA_FOR_REHYDRATION__ (current TikTok web)
                    const marker = '<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__"';
                    const si = html.indexOf(marker);
                    if (si !== -1) {
                        const ci = html.indexOf('>', si) + 1;
                        const ce = html.indexOf('</script>', ci);
                        if (ce !== -1) {
                            const data = JSON.parse(html.slice(ci, ce));
                            const item = data?.__DEFAULT_SCOPE__?.['webapp.video-detail']?.itemInfo?.itemStruct;
                            if (item?.video) return resolve(item);
                        }
                    }

                    // Fallback: SIGI_STATE (older TikTok web versions)
                    const sigiMarker = '<script id="SIGI_STATE"';
                    const ssi = html.indexOf(sigiMarker);
                    if (ssi !== -1) {
                        const sci = html.indexOf('>', ssi) + 1;
                        const sce = html.indexOf('</script>', sci);
                        if (sce !== -1) {
                            const data = JSON.parse(html.slice(sci, sce));
                            const items = data?.ItemModule;
                            if (items) {
                                const first = Object.values(items)[0];
                                if (first?.video) return resolve(first);
                            }
                        }
                    }

                    resolve(null);
                } catch { resolve(null); }
            });
        });
        req.on('error', () => resolve(null));
        setTimeout(() => { req.destroy(); resolve(null); }, 12000);
    });
}

// Pick best quality from bitrateInfo (web page — PascalCase keys)
// Sort by resolution in GearName, then by actual Bitrate value
function pickBestBitrateInfo(bitrateInfo) {
    if (!Array.isArray(bitrateInfo) || bitrateInfo.length === 0) return null;
    const gearRes = (name = '') => { const m = name.match(/(\d{3,4})/); return m ? parseInt(m[1]) : 0; };
    return [...bitrateInfo].sort((a, b) => {
        const d = gearRes(b.GearName) - gearRes(a.GearName);
        return d !== 0 ? d : (b.Bitrate || 0) - (a.Bitrate || 0);
    })[0];
}

// ─── Method B: TikTok internal aweme API ─────────────────────────────────────
async function tiktokApiFetch(videoId) {
    const apiUrl = `https://api22-normal-c-useast2a.tiktokv.com/aweme/v1/feed/?aweme_id=${videoId}&aid=1233&app_name=musical_ly&version_code=26.1.3&device_type=Pixel+4&os=android`;
    const headers = { ...TIKTOK_HEADERS };
    if (process.env.TIKTOK_COOKIE) headers['Cookie'] = process.env.TIKTOK_COOKIE;
    return new Promise((resolve) => {
        https.get(apiUrl, { headers }, (res) => {
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

// Pick best quality from bit_rate (API — snake_case keys)
function pickBestBitRate(bitRates) {
    if (!Array.isArray(bitRates) || bitRates.length === 0) return null;
    const gearRes = (name = '') => { const m = name.match(/(\d{3,4})/); return m ? parseInt(m[1]) : 0; };
    return [...bitRates].sort((a, b) => {
        const d = gearRes(b.gear_name) - gearRes(a.gear_name);
        return d !== 0 ? d : (b.bit_rate || 0) - (a.bit_rate || 0);
    })[0];
}

// ─── Method C: tikwm.com API ──────────────────────────────────────────────────
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

// ─── Provider ─────────────────────────────────────────────────────────────────
class TikTokProvider extends BaseProvider {
    async getInfo(url) {
        // A: Web page scrape — bitrateInfo has genuine HD URLs, no auth needed
        const webItem = await tiktokWebScrape(url);
        if (webItem?.video) {
            const video = webItem.video;
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
            } else if (video.playAddr || video.downloadAddr) {
                formats.push({ height: h, ext: 'mp4', size: null, label: `HD · ${res}` });
            }

            if (formats.length > 0) {
                const dur = video.duration || 0;
                const mm  = String(Math.floor(dur / 60));
                const ss  = String(dur % 60).padStart(2, '0');
                return {
                    title:     webItem.desc                  || 'TikTok Video',
                    thumbnail: video.cover                   || '',
                    duration:  `${mm}:${ss}`,
                    formats,
                    provider:  'tiktok',
                };
            }
        }

        // B: Internal aweme API
        const videoId = extractVideoId(url);
        if (videoId) {
            const aweme = await tiktokApiFetch(videoId);
            if (aweme?.video) {
                const video = aweme.video;
                const w = video.width  || 576;
                const h = video.height || 1024;
                const res = `${w}×${h}`;
                const formats = [];

                const best = pickBestBitRate(video.bit_rate);
                if (best) {
                    const bh = parseInt(best.gear_name?.match(/(\d{3,4})/)?.[1]) || h;
                    formats.push({
                        height: bh,
                        ext:    'mp4',
                        size:   best.play_addr?.data_size || null,
                        label:  `${best.gear_name} · ${res}`,
                    });
                } else if (video.download_addr || video.play_addr) {
                    formats.push({ height: h, ext: 'mp4', size: null, label: `HD · ${res}` });
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

        // C: tikwm.com API
        const data = await tikwmFetch(url) || await snaptikFetch(url);
        if (data) {
            const w = data.width  || 1080;
            const h = data.height || 1920;
            const res = `${w}×${h}`;
            const formats = [];

            if (data.hdplay) {
                formats.push({ height: h, ext: 'mp4', size: data.hd_size || null, label: `Original HD · ${res}` });
            }
            if (data.play) {
                formats.push({ height: Math.round(h * 0.75), ext: 'mp4', size: data.size || null, label: `Standard · ${res}` });
            }
            if (formats.length === 0) formats.push({ height: 'HD', ext: 'mp4', size: null });

            const dur = data.duration || 0;
            const mm  = String(Math.floor(dur / 60));
            const ss  = String(dur % 60).padStart(2, '0');
            return {
                title:     data.title || 'TikTok Video',
                thumbnail: data.cover || '',
                duration:  `${mm}:${ss}`,
                formats,
                provider:  'tiktok',
            };
        }

        // D: yt-dlp final fallback
        console.log('[TikTok] All APIs failed, trying yt-dlp');
        const output = await this.executeYtdlp(url, {
            addHeader: [
                'referer:https://www.tiktok.com/',
                'user-agent:Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
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
