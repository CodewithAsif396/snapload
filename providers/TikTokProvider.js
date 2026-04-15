const BaseProvider = require('./BaseProvider');
const https        = require('https');

// Base headers for all TikTok API and CDN requests
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

// Extract TikTok video ID from URL
function extractVideoId(url) {
    const m = url.match(/video\/(\d+)/);
    return m ? m[1] : null;
}

// Method 0: TikTok's own aweme API — returns highest-quality, no-watermark URLs
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

// Pick highest-quality entry from the bit_rate array using resolution in gear_name
// e.g. "adapt_lowest_1080_1" → 1080, "normal_720_0" → 720
function pickBestBitRate(bitRates) {
    if (!Array.isArray(bitRates) || bitRates.length === 0) return null;
    const gearRes = (name = '') => { const m = name.match(/(\d{3,4})/); return m ? parseInt(m[1]) : 0; };
    return [...bitRates].sort((a, b) => {
        const d = gearRes(b.gear_name) - gearRes(a.gear_name);
        return d !== 0 ? d : (b.bit_rate || 0) - (a.bit_rate || 0);
    })[0];
}

// Method 1: tikwm.com API
async function tikwmFetch(url) {
    const json = await fetchJson(`https://www.tikwm.com/api/?url=${encodeURIComponent(url)}&hd=1`);
    if (json?.code === 0 && json.data) return json.data;
    return null;
}

// Method 2: tikwm.com API with extended params
async function snaptikFetch(url) {
    const json = await fetchJson(
        `https://www.tikwm.com/api/?url=${encodeURIComponent(url)}&count=12&cursor=0&web=1&hd=1`,
        { 'Referer': 'https://www.tikwm.com/' }
    );
    if (json?.code === 0 && json.data) return json.data;
    return null;
}

class TikTokProvider extends BaseProvider {
    async getInfo(url) {
        const videoId = extractVideoId(url);

        // Try TikTok's internal API first — gives bit_rate array with gear_name quality tiers
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
                    formats.push({
                        height: h,
                        ext:    'mp4',
                        size:   (video.download_addr || video.play_addr)?.data_size || null,
                        label:  `HD · ${res}`,
                    });
                }

                if (formats.length > 0) {
                    // Internal API returns duration in milliseconds
                    const durSec = Math.round((video.duration || 0) / 1000);
                    const mm = String(Math.floor(durSec / 60));
                    const ss = String(durSec % 60).padStart(2, '0');

                    return {
                        title:     aweme.desc                  || 'TikTok Video',
                        thumbnail: video.cover?.url_list?.[0]  || '',
                        duration:  `${mm}:${ss}`,
                        formats,
                        provider:  'tiktok',
                    };
                }
            }
        }

        // Fallback: tikwm.com API
        const data = await tikwmFetch(url) || await snaptikFetch(url);

        if (data) {
            const w = data.width  || 1080;
            const h = data.height || 1920;
            const res = `${w}×${h}`;

            const formats = [];

            // HD no-watermark (original quality)
            if (data.hdplay) {
                formats.push({
                    height: h,
                    ext:    'mp4',
                    size:   data.hd_size || null,
                    label:  `Original HD · ${res}`,
                });
            }

            // SD no-watermark
            if (data.play) {
                formats.push({
                    height: Math.round(h * 0.75),
                    ext:    'mp4',
                    size:   data.size || null,
                    label:  `Standard · ${res}`,
                });
            }

            if (formats.length === 0) formats.push({ height: 'HD', ext: 'mp4', size: null });

            const dur = data.duration || 0;
            const mm  = String(Math.floor(dur / 60));
            const ss  = String(dur % 60).padStart(2, '0');

            return {
                title:     data.title    || 'TikTok Video',
                thumbnail: data.cover    || '',
                duration:  `${mm}:${ss}`,
                formats,
                provider:  'tiktok',
            };
        }

        // Final fallback: yt-dlp
        console.log('[TikTok] API failed, trying yt-dlp');
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
