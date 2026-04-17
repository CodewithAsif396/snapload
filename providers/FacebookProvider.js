/**
 * FacebookProvider
 * ────────────────
 * Handles Facebook video and Reel downloads via yt-dlp.
 *
 * Notes:
 *   - Only public videos are supported (no login cookies provided).
 *   - A realistic browser User-Agent is required — Facebook blocks
 *     bot-like requests without it.
 *   - fb.watch short links are also supported.
 */

const BaseProvider = require('./BaseProvider');

class FacebookProvider extends BaseProvider {
    async getInfo(url) {
        // Facebook CDN requires a real browser UA + referer to serve video metadata
        const output = await this.executeYtdlp(url, {
            addHeader: [
                'referer:https://www.facebook.com/',
                'origin:https://www.facebook.com',
                'user-agent:Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
            ],
        });

        return {
            title:     output.title           || 'Facebook Video',
            thumbnail: output.thumbnail       || '',
            duration:  output.duration_string || '0:00',
            formats:   this.parseFormats(output.formats),
            provider:  'facebook',
        };
    }
}

module.exports = FacebookProvider;
