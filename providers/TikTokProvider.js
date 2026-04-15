const BaseProvider = require('./BaseProvider');
const https        = require('https');

function fetchJson(url, headers = {}) {
    return new Promise((resolve) => {
        https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0', ...headers } }, (res) => {
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

// Method 1: tikwm.com API
async function tikwmFetch(url) {
    const json = await fetchJson(`https://www.tikwm.com/api/?url=${encodeURIComponent(url)}&hd=1`);
    if (json?.code === 0 && json.data) return json.data;
    return null;
}

// Method 2: ssstik.io scraping approach via snaptik API
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

        // Fallback: yt-dlp
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
