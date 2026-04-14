const BaseProvider = require('./BaseProvider');

class YouTubeProvider extends BaseProvider {
    async getInfo(url) {
        const output = await this.executeYtdlp(url, {
            // Stable client bypass for 403s and Bot Detection
            extractorArgs: 'youtube:player_client=tv_embedded,ios,mweb',
        });

        const formats = output.formats || [];

        // Best audio stream size (added to each video format for accurate total size)
        const audioFormats = formats.filter(f =>
            f.acodec !== 'none' && f.vcodec === 'none' && f.ext === 'm4a'
        );
        const bestAudio    = audioFormats.sort((a, b) => (b.abr || 0) - (a.abr || 0))[0];
        const audioSize    = bestAudio
            ? (bestAudio.filesize || bestAudio.filesize_approx || 0)
            : 0;

        // Deduplicate by height, prefer H.264 (avc) + mp4
        const heightMap = new Map();
        formats
            .filter(f => f.vcodec !== 'none' && f.height && f.height > 0)
            .forEach(f => {
                const existing     = heightMap.get(f.height);
                const isAvc        = /^avc/i.test(f.vcodec || '');
                const existingIsAvc = existing ? /^avc/i.test(existing.vcodec || '') : false;
                const curSize      = f.filesize || f.filesize_approx || 0;
                const exSize       = existing ? (existing.filesize || existing.filesize_approx || 0) : 0;

                if (
                    !existing ||
                    (isAvc && !existingIsAvc) ||
                    (isAvc === existingIsAvc && f.ext === 'mp4' && existing.ext !== 'mp4') ||
                    (isAvc === existingIsAvc && f.ext === existing.ext && curSize > exSize)
                ) {
                    heightMap.set(f.height, f);
                }
            });

        const uniqueFormats = Array.from(heightMap.values())
            .sort((a, b) => b.height - a.height)
            .map(f => {
                const videoSize = f.filesize || f.filesize_approx || null;
                // Show combined video+audio size so the UI matches what actually downloads
                const totalSize = videoSize ? videoSize + audioSize : null;
                return {
                    height: f.height,
                    ext:    'mp4',
                    size:   totalSize,
                };
            });

        return {
            title:     output.title     || 'YouTube Video',
            thumbnail: output.thumbnail || '',
            duration:  output.duration_string || '0:00',
            formats:   uniqueFormats,
            provider:  'youtube',
        };
    }
}

module.exports = YouTubeProvider;
