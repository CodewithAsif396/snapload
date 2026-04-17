/**
 * InstagramProvider
 * ─────────────────
 * Handles Instagram Reels, Stories, and IGTV videos via yt-dlp.
 *
 * Requirements:
 *   - Public content only (private/login-gated posts will fail).
 *   - Instagram CDN requires its own referer + origin headers to avoid 403s.
 *
 * Format selection is handled by BaseProvider.parseFormats() which:
 *   - Prefers H.264 for maximum device compatibility
 *   - Deduplicates by resolution height
 *   - Caps at 4 quality options
 */

const BaseProvider = require('./BaseProvider');

class InstagramProvider extends BaseProvider {
    async getInfo(url) {
        const output = await this.executeYtdlp(url, {
            addHeader: [
                'referer:https://www.instagram.com/',
                'origin:https://www.instagram.com',
            ],
        });

        return {
            title:     output.title           || 'Instagram Video',
            thumbnail: output.thumbnail       || '',
            duration:  output.duration_string || '0:00',
            formats:   this.parseFormats(output.formats),
            provider:  'instagram',
        };
    }
}

module.exports = InstagramProvider;
