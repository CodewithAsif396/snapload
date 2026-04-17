/**
 * TwitterProvider
 * ───────────────
 * Handles Twitter/X video downloads via yt-dlp.
 *
 * Notes:
 *   - Most tweets now require login; syndication API is used as a
 *     best-effort fallback for public tweets.
 *   - GIFs and video tweets both work on public accounts.
 *   - Private/login-gated content will return an error.
 */

const BaseProvider = require('./BaseProvider');

class TwitterProvider extends BaseProvider {
    async getInfo(url) {
        // syndication API lets yt-dlp access some public tweets without login
        const output = await this.executeYtdlp(url, {
            extractorArgs: 'twitter:api=syndication',
            addHeader: [
                'referer:https://x.com/',
                'origin:https://x.com',
            ],
        });

        return {
            title:     output.title           || 'X / Twitter Video',
            thumbnail: output.thumbnail       || '',
            duration:  output.duration_string || '0:00',
            formats:   this.parseFormats(output.formats),
            provider:  'twitter',
        };
    }
}

module.exports = TwitterProvider;
