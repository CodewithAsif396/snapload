const express = require('express');
const cors = require('cors');
const path = require('path');
const youtubedl = require('youtube-dl-exec');
const ffmpegPath = require('ffmpeg-static');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// Serve static files (like index.html)
app.use(express.static(path.join(__dirname)));

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// Helper to sanitize URLs for Windows CMD to prevent & breaking the command
// It's safer to just split by & and take the first part for most video urls,
// but for flexibility, we will wrap in quotes.
function sanitizeUrl(url) {
    if (process.platform === 'win32') {
        return `"${url}"`;
    }
    return url;
}

app.post('/api/info', async (req, res) => {
    try {
        const { url } = req.body;
        if (!url) {
            return res.status(400).json({ error: 'URL is required' });
        }

        console.log(`Processing URL for info: ${url}`);
        const safeUrl = sanitizeUrl(url);
        
        // Execute yt-dlp to get a single JSON output
        const output = await youtubedl(safeUrl, {
            dumpSingleJson: true,
            noWarnings: true,
            noCheckCertificate: true,
            preferFreeFormats: true,
            noPlaylist: true,
            ffmpegLocation: ffmpegPath
        });

        // Parse relevant info
        const title = output.title || 'Unknown Title';
        const thumbnail = output.thumbnail || 'https://via.placeholder.com/600x400?text=No+Thumbnail';
        const duration = output.duration_string || output.duration ? new Date(output.duration * 1000).toISOString().substr(14, 5) : '00:00';

        // Extract available resolutions dynamically
        const formats = output.formats || [];
        let availableHeights = [...new Set(
            formats.filter(f => f.vcodec !== 'none' && f.height).map(f => f.height)
        )].sort((a, b) => b - a);

        // Fallback default heights if the platform doesn't report height cleanly
        if (availableHeights.length === 0) {
            availableHeights = [1080, 720, 360];
        }

        // We return the raw URL back so the frontend can send it to our /api/download endpoint
        return res.json({
            title,
            thumbnail,
            duration,
            availableHeights,
            originalUrl: url
        });

    } catch (error) {
        console.error('Error fetching info:', error.message);
        return res.status(500).json({ error: 'Failed to extract video information. The video might be private or link is invalid.' });
    }
});

// Endpoint to securely proxy the download to the user
app.get('/api/download', (req, res) => {
    const { url, type } = req.query;
    if (!url) return res.status(400).send('URL is required');

    console.log(`Starting Download Proxy (${type}): ${url}`);
    
    // Set yt-dlp string formats based on quality
    let format = 'best[ext=mp4]/best'; 
    let ext = 'mp4';
    let mime = 'video/mp4';

    if (type === 'audio') {
        // Audio only extraction
        format = 'bestaudio/best';
        ext = 'mp3';
        mime = 'audio/mpeg';
    } else {
        // Handle specific heights
        const height = parseInt(type) || 720;
        format = `bestvideo[height<=${height}][ext=mp4]+bestaudio[ext=m4a]/best[height<=${height}][ext=mp4]/best`;
    }

    // Set headers to trigger a file download in the browser
    // Encode filename securely
    res.header('Content-Disposition', `attachment; filename="snapload_video_${Date.now()}.${ext}"`);
    res.header('Content-Type', mime);

    const safeUrl = sanitizeUrl(url);

    // Run youtube-dl-exec and pipe its standard output (the media file) directly to the response object
    const subprocess = youtubedl.exec(safeUrl, {
        f: format,
        noWarnings: true,
        noCheckCertificate: true,
        noPlaylist: true,
        ffmpegLocation: ffmpegPath,
        extractAudio: type === 'audio',
        audioFormat: type === 'audio' ? 'mp3' : undefined,
        o: '-' // '-' tells yt-dlp to output binary data directly to stdout instead of saving a file!
    });

    subprocess.stdout.pipe(res);

    subprocess.catch((err) => {
        console.error('Download stream error:', err.message);
        if (!res.headersSent) {
            res.status(500).send('Direct Download failed.');
        }
    });

    // Handle client disconnects to prevent memory leaks / dangling yt-dlp processes
    req.on('close', () => {
        if (!subprocess.killed) {
            console.log('Client aborted download. Killing yt-dlp subprocess.');
            subprocess.kill('SIGKILL');
        }
    });
});

app.listen(PORT, () => {
    console.log(`🚀 SnapLoad Proxy Server running at http://localhost:${PORT}`);
});
