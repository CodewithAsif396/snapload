const BaseProvider = require('./BaseProvider');

class TikTokProvider extends BaseProvider {
    async getInfo(url) {
        const output = await this.executeYtdlp(url, {
            addHeader: [
                'referer:https://www.tiktok.com/',
                'origin:https://www.tiktok.com',
                'user-agent:Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
            ],
            extractorArgs: 'tiktok:api_hostname=api22-normal-c-useast2a.tiktokv.com',
            noCheckFormats: true,
        });

        const formats = output.formats || [];

        // Prefer H.264 (h264) over H.265 for compatibility.
        // TikTok serves combined video+audio streams (no separate streams).
        const seenHeights = new Set();
        const uniqueFormats = [];

        // Sort: h264 first (preference), then by height desc
        const sorted = formats
            .filter(f => f.vcodec && f.vcodec !== 'none')
            .sort((a, b) => {
                const aIsH264 = (a.vcodec || '').startsWith('h264') ? 1 : 0;
                const bIsH264 = (b.vcodec || '').startsWith('h264') ? 1 : 0;
                if (bIsH264 !== aIsH264) return bIsH264 - aIsH264;
                return (b.height || 0) - (a.height || 0);
            });

        sorted.forEach(f => {
            const h = f.height || 'HD';
            if (!seenHeights.has(h)) {
                seenHeights.add(h);
                uniqueFormats.push({
                    height: h,
                    ext:    'mp4',
                    size:   f.filesize || f.filesize_approx || null,
                });
            }
        });

        if (uniqueFormats.length === 0) {
            uniqueFormats.push({ height: 'HD', ext: 'mp4', size: null });
        }

        return {
            title:     output.title     || 'TikTok Video',
            thumbnail: output.thumbnail || '',
            duration:  output.duration_string || '0:00',
            formats:   uniqueFormats,
            provider:  'tiktok',
        };
    }
}

module.exports = TikTokProvider;
