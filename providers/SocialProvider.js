const BaseProvider = require('./BaseProvider');

class SocialProvider extends BaseProvider {
    async getInfo(url) {
        const isInstagram = url.includes('instagram.com');
        const isTwitter   = url.includes('x.com') || url.includes('twitter.com');

        const extraArgs = {};

        if (isInstagram) {
            extraArgs.addHeader = [
                'referer:https://www.instagram.com/',
                'origin:https://www.instagram.com',
            ];
        } else if (isTwitter) {
            // Twitter/X requires auth for most content.
            // Try syndication API as best-effort fallback.
            extraArgs.extractorArgs = 'twitter:api=syndication';
            extraArgs.addHeader = [
                'referer:https://x.com/',
                'origin:https://x.com',
            ];
        }

        const output = await this.executeYtdlp(url, extraArgs);

        const formats = output.formats || [];

        // Prefer H.264 (avc/h264) for maximum compatibility
        const seenHeights = new Set();
        const uniqueFormats = [];

        const sorted = formats
            .filter(f => f.vcodec && f.vcodec !== 'none')
            .sort((a, b) => {
                const aH264 = /^(avc|h264)/i.test(a.vcodec || '') ? 1 : 0;
                const bH264 = /^(avc|h264)/i.test(b.vcodec || '') ? 1 : 0;
                if (bH264 !== aH264) return bH264 - aH264;
                return (b.height || 0) - (a.height || 0);
            });

        sorted.forEach(f => {
            const h = f.height || 'HD';
            if (!seenHeights.has(h) && uniqueFormats.length < 4) {
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

        const provider = isInstagram ? 'instagram' : isTwitter ? 'twitter' : 'generic';

        return {
            title:     output.title     || 'Video',
            thumbnail: output.thumbnail || '',
            duration:  output.duration_string || '0:00',
            formats:   uniqueFormats,
            provider,
        };
    }
}

module.exports = SocialProvider;
