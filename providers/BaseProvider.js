const youtubedl = require('youtube-dl-exec');
const ffmpegPath = require('ffmpeg-static');
const { quoteArg } = require('../utils/shell');

class BaseProvider {
    constructor() {
        this.userAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
    }

    async getInfo(url) {
        throw new Error('getInfo must be implemented by subclass');
    }

    async executeYtdlp(url, extraArgs = {}) {
        const defaultArgs = {
            dumpSingleJson:     true,
            noWarnings:         true,
            noCheckCertificate: true,
            noPlaylist:         true,
            // ffmpegPath and userAgent contain spaces — must be quoted.
            // All other args (extractorArgs, addHeader) must NOT be quoted,
            // as youtube-dl-exec passes them directly and extra quotes break them.
            ffmpegLocation:     quoteArg(ffmpegPath),
            userAgent:          quoteArg(this.userAgent),
        };

        return await youtubedl(url, { ...defaultArgs, ...extraArgs }, { timeout: 45000 });
    }
}

module.exports = BaseProvider;
