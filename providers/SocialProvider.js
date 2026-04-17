/**
 * SocialProvider
 * ──────────────
 * Handles Snapchat, Pinterest, and any other platform not covered by a
 * dedicated provider. Uses yt-dlp with platform-specific headers.
 *
 * Supported platforms:
 *   - Snapchat  : public Spotlight videos and public Story links
 *                 (snapchat.com, t.snapchat.com)
 *   - Pinterest : video pins from pinterest.com or pin.it short links
 *   - Generic   : any other URL — tried with default yt-dlp settings
 *
 * Format selection is handled by BaseProvider.parseFormats().
 */

const BaseProvider = require('./BaseProvider');

class SocialProvider extends BaseProvider {
    async getInfo(url) {
        const isSnapchat  = url.includes('snapchat.com') || url.includes('t.snapchat.com');
        const isPinterest = url.includes('pinterest.com') || url.includes('pin.it');

        let extraArgs = {};

        if (isSnapchat) {
            // Snapchat CDN needs referer + browser UA to allow video access
            extraArgs = {
                addHeader: [
                    'referer:https://www.snapchat.com/',
                    'origin:https://www.snapchat.com',
                    'user-agent:Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
                ],
            };
        } else if (isPinterest) {
            // Pinterest requires referer + browser UA for video pin metadata
            extraArgs = {
                addHeader: [
                    'referer:https://www.pinterest.com/',
                    'origin:https://www.pinterest.com',
                    'user-agent:Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
                ],
            };
        }
        // Generic: no extra args — yt-dlp will try with its own defaults

        const output = await this.executeYtdlp(url, extraArgs);

        // Determine provider label for the frontend badge
        const provider = isSnapchat  ? 'snapchat'
                       : isPinterest ? 'pinterest'
                       : 'generic';

        return {
            title:     output.title           || 'Video',
            thumbnail: output.thumbnail       || '',
            duration:  output.duration_string || '0:00',
            formats:   this.parseFormats(output.formats),
            provider,
        };
    }
}

module.exports = SocialProvider;
