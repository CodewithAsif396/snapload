const BaseProvider   = require('./BaseProvider');

class SocialProvider extends BaseProvider {
    async getInfo(url) {
        const isSnapchat = url.includes('snapchat.com') || url.includes('t.snapchat.com');

        // ── Snapchat ──────────────────────────────────────────────────────────
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
