const BaseProvider = require('./BaseProvider');
const { getRandomUA } = require('../utils/userAgent');

class FacebookProvider extends BaseProvider {
    async getInfo(url) {
        const uaData = getRandomUA();
        
        // Facebook CDN requires a real browser UA + referer to serve video metadata
        const output = await this.executeYtdlp(url, {
            userAgent: uaData.ua,
            referer: 'https://www.facebook.com/',
            addHeader: [
                `sec-ch-ua: ${uaData.clientHints}`,
                `sec-ch-ua-mobile: ${uaData.mobile || '?0'}`,
                `sec-ch-ua-platform: ${uaData.platform}`,
                'sec-fetch-dest: empty',
                'sec-fetch-mode: cors',
                'sec-fetch-site: same-origin',
                'origin:https://www.facebook.com',
                'accept: */*',
                'accept-language: en-US,en;q=0.9',
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
