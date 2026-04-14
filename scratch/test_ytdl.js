const youtubedl = require('youtube-dl-exec');
const ffmpegPath = require('ffmpeg-static');

const test = async () => {
    try {
        console.log('FFMPEG Path:', ffmpegPath);
        const output = await youtubedl('https://www.youtube.com/watch?v=aqz-KE-bpKQ', {
            dumpSingleJson: true,
            ffmpegLocation: ffmpegPath,
            userAgent: 'Mozilla/5.0'
        });
        console.log('Success!');
    } catch (err) {
        console.error('Error:', err.message);
    }
};

test();
