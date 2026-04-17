const BaseProvider = require('./BaseProvider');

class FacebookProvider extends BaseProvider {
    async getInfo(url) {
        console.log('[Facebook] yt-dlp with cookies...');

        // Normalize URL — prefer www over m. for better yt-dlp compat
        const cleanUrl = url.replace('m.facebook.com', 'www.facebook.com');

        try {
            const output = await this.executeYtdlp(cleanUrl, {
                referer: 'https://www.facebook.com/',
            });

            return {
                title:     output.title           || 'Facebook Video',
                thumbnail: output.thumbnail       || '',
                duration:  output.duration_string || '0:00',
                formats:   this.parseFormats(output.formats),
                provider:  'facebook',
            };
        } catch (err) {
            throw new Error('Facebook video could not be fetched. Only public videos are supported. ' + err.message);
        }
    }
}

module.exports = FacebookProvider;
