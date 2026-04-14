const youtubedl = require('youtube-dl-exec');
const ffmpegPath = require('ffmpeg-static');
const { quoteArg } = require('../utils/shell');

class BaseProvider {
    constructor() {
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
            ffmpegLocation:     ffmpegPath,
        };

        return await youtubedl(url, { ...defaultArgs, ...extraArgs }, { timeout: 45000 });
    }
}

module.exports = BaseProvider;
