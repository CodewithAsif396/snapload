const BaseProvider   = require('./BaseProvider');
const { cobaltExtract } = require('../utils/cobalt');

class SocialProvider extends BaseProvider {
    async getInfo(url) {
        const isSnapchat  = url.includes('snapchat.com') || url.includes('t.snapchat.com');
        const isPinterest = url.includes('pinterest.com') || url.includes('pin.it');

        // ── Pinterest: cobalt.tools API (most reliable, free, no key needed) ──
        if (isPinterest) {
            console.log('[Social] Pinterest → cobalt.tools API');
            try {
                const result = await cobaltExtract(url);
                if (result?.url) {
                    console.log('[Social] Pinterest cobalt success:', result.url.slice(0, 80));
                    return {
                        title:     'Pinterest Video',
                        thumbnail: '',
                        duration:  '0:00',
                        formats:   [{ height: 'HD', ext: 'mp4', url: result.url, size: null }],
                        provider:  'pinterest',
                    };
                }
            } catch (e) {
                console.log('[Social] Cobalt error:', e.message);
            }

            // Fallback: yt-dlp with cookies
            console.log('[Social] Pinterest → yt-dlp fallback');
            try {
                const output = await this.executeYtdlp(url);
                return {
                    title:     output.title           || 'Pinterest Video',
                    thumbnail: output.thumbnail       || '',
                    duration:  output.duration_string || '0:00',
                    formats:   this.parseFormats(output.formats),
                    provider:  'pinterest',
                };
            } catch (e) {
                throw new Error('Pinterest video could not be fetched. Make sure the pin is public and contains a video.');
            }
        }

        // ── Snapchat: yt-dlp with cookies (browser scraper gets watermarked CDN URLs) ──
        if (isSnapchat) {
            console.log('[Social] Snapchat → yt-dlp with cookies');
            try {
                const output = await this.executeYtdlp(url, {
                    referer: 'https://www.snapchat.com/',
                });
                return {
                    title:     output.title           || 'Snapchat Video',
                    thumbnail: output.thumbnail       || '',
                    duration:  output.duration_string || '0:00',
                    formats:   this.parseFormats(output.formats),
                    provider:  'snapchat',
                };
            } catch (e) {
                throw new Error('Snapchat video could not be fetched. Only public Spotlight/Story links are supported.');
            }
        }

        // ── Generic fallback ──────────────────────────────────────────────────
        console.log('[Social] Generic → yt-dlp');
        const output = await this.executeYtdlp(url);
        return {
            title:     output.title           || 'Video',
            thumbnail: output.thumbnail       || '',
            duration:  output.duration_string || '0:00',
            formats:   this.parseFormats(output.formats),
            provider:  'generic',
        };
    }
}

module.exports = SocialProvider;
