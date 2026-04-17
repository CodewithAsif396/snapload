/**
 * cobalt.tools API wrapper
 * GitHub: https://github.com/imputnet/cobalt
 * Free, open-source, no API key needed.
 * Supports: Pinterest, Twitter, Instagram, Reddit, YouTube, TikTok, etc.
 */
const https = require('https');

async function cobaltExtract(url, opts = {}) {
    return new Promise((resolve) => {
        const body = JSON.stringify({
            url,
            videoQuality: opts.quality || '1080',
            filenameStyle: 'basic',
        });

        const req = https.request({
            hostname: 'api.cobalt.tools',
            path: '/',
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Accept': 'application/json',
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            },
            timeout: 15000,
        }, (res) => {
            let data = '';
            res.on('data', d => data += d);
            res.on('end', () => {
                try {
                    const json = JSON.parse(data);
                    if (json.status === 'stream' || json.status === 'tunnel') {
                        resolve({ url: json.url, type: 'single' });
                    } else if (json.status === 'picker' && json.picker?.length > 0) {
                        // Multiple streams — pick the first (usually best quality)
                        resolve({ url: json.picker[0].url, type: 'picker' });
                    } else {
                        console.log('[Cobalt] Unexpected response:', json.status, json.error?.code);
                        resolve(null);
                    }
                } catch (e) {
                    console.log('[Cobalt] Parse error:', e.message);
                    resolve(null);
                }
            });
        });

        req.on('error', (e) => {
            console.log('[Cobalt] Request error:', e.message);
            resolve(null);
        });

        req.on('timeout', () => {
            req.destroy();
            resolve(null);
        });

        req.write(body);
        req.end();
    });
}

module.exports = { cobaltExtract };
