const BaseProvider = require('./BaseProvider');
const { getRandomUA } = require('../utils/userAgent');

class SocialProvider extends BaseProvider {
    async getInfo(url) {
        const isSnapchat  = url.includes('snapchat.com') || url.includes('t.snapchat.com');
        const isPinterest = url.includes('pinterest.com') || url.includes('pin.it');

        const uaData = getRandomUA();
        let extraArgs = {
            userAgent: uaData.ua,
            addHeader: [
                `sec-ch-ua: ${uaData.clientHints}`,
                `sec-ch-ua-mobile: ${uaData.mobile || '?0'}`,
                `sec-ch-ua-platform: ${uaData.platform}`,
                'sec-fetch-dest: empty',
                'sec-fetch-mode: cors',
                'sec-fetch-site: same-origin',
                'accept: */*',
                'accept-language: en-US,en;q=0.9',
            ]
        };

        if (isSnapchat) {
            extraArgs.referer = 'https://www.snapchat.com/';
        } else if (isPinterest) {
            extraArgs.referer = 'https://www.pinterest.com/';
        }

        const output = await this.executeYtdlp(url, extraArgs);

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
