const BaseProvider = require('./BaseProvider');
const https        = require('https');

// Fetch TikTok video info via tikwm.com API (works on datacenter IPs)
function tikwmFetch(url) {
    return new Promise((resolve) => {
        const apiUrl = `https://www.tikwm.com/api/?url=${encodeURIComponent(url)}&hd=1`;
        https.get(apiUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
            let d = '';
            res.on('data', c => d += c);
            res.on('end', () => {
                try {
                    const json = JSON.parse(d);
                    resolve(json?.code === 0 ? json.data : null);
                } catch { resolve(null); }
            });
        }).on('error', () => resolve(null));
    });
}

class TikTokProvider extends BaseProvider {
    async getInfo(url) {
        // Try tikwm.com first — works on VPS without IP restrictions
        const data = await tikwmFetch(url);

        if (data) {
            const formats = [];
            if (data.hdplay) formats.push({ height: 'HD', ext: 'mp4', size: data.hd_size || null });
            if (data.play)   formats.push({ height: 'SD', ext: 'mp4', size: data.size   || null });
            if (formats.length === 0) formats.push({ height: 'HD', ext: 'mp4', size: null });

            return {
                title:     data.title    || 'TikTok Video',
                thumbnail: data.cover    || '',
                duration:  data.duration ? String(Math.floor(data.duration / 60)).padStart(1,'0') + ':' + String(data.duration % 60).padStart(2,'0') : '0:00',
                formats,
                provider:  'tiktok',
            };
        }

        // Fallback to yt-dlp
        console.log('[TikTok] tikwm failed, trying yt-dlp fallback');
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
            .slice(0, 3)
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
