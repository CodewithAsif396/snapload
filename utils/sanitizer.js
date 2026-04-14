/**
 * Utility to sanitize and prepare URLs for the download engines.
 */
function sanitizeUrl(url) {
    if (!url) return '';
    try {
        const parsed = new URL(url);
        
        // YouTube: Keep only the video ID
        if (parsed.hostname.includes('youtube.com') || parsed.hostname.includes('youtu.be')) {
            let videoId = parsed.searchParams.get('v');
            if (videoId) return `https://www.youtube.com/watch?v=${videoId}`;
            
            if (parsed.hostname.includes('youtu.be')) {
                const pathId = parsed.pathname.slice(1);
                if (pathId) return `https://www.youtube.com/watch?v=${pathId}`;
            }
        }
        
        // TikTok: Clean trailing garbage
        if (parsed.hostname.includes('tiktok.com')) {
            return `${parsed.protocol}//${parsed.hostname}${parsed.pathname}`;
        }

        // Generic cleanup
        return url.split('?')[0].split('&')[0];
    } catch (e) {
        return url.split('?')[0].split('&')[0];
    }
}

module.exports = { sanitizeUrl };
