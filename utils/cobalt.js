/**
 * cobalt.tools API wrapper — tries multiple public instances
 */
const https = require('https');

const COBALT_INSTANCES = [
    'api.cobalt.tools',
    'cobalt.privacydev.net',
    'cobalt.api.timelessnesses.me',
];

function cobaltRequest(hostname, url, opts = {}) {
    return new Promise((resolve) => {
        const body = JSON.stringify({
            url,
            videoQuality: opts.quality || '1080',
            filenameStyle: 'basic',
            downloadMode: opts.mode || 'auto',
        });

        const req = https.request({
            hostname,
            path: '/',
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Accept': 'application/json',
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
                'Content-Length': Buffer.byteLength(body),
            },
            timeout: 12000,
        }, (res) => {
            let data = '';
            res.on('data', d => data += d);
            res.on('end', () => {
                try {
                    const json = JSON.parse(data);
                    if (json.status === 'stream' || json.status === 'tunnel' || json.status === 'redirect') {
                        resolve({ url: json.url, type: 'single' });
                    } else if (json.status === 'picker' && json.picker?.length > 0) {
                        resolve({ url: json.picker[0].url, type: 'picker' });
                    } else {
                        resolve(null);
                    }
                } catch { resolve(null); }
            });
        });

        req.on('error', () => resolve(null));
        req.on('timeout', () => { req.destroy(); resolve(null); });
        req.write(body);
        req.end();
    });
}

async function cobaltExtract(url, opts = {}) {
    for (const host of COBALT_INSTANCES) {
        try {
            const result = await cobaltRequest(host, url, opts);
            if (result?.url) {
                console.log(`[Cobalt] Success via ${host}`);
                return result;
            }
        } catch { /* try next */ }
    }
    return null;
}

module.exports = { cobaltExtract };
