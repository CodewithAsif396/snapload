const fs   = require('fs');
const path = require('path');

const ADS_FILE      = path.join(__dirname, 'data', 'ads.json');
const SETTINGS_FILE = path.join(__dirname, 'data', 'settings.json');
const STATS_FILE    = path.join(__dirname, 'data', 'stats.json');

const DEFAULT_SETTINGS = {
    general:      { siteName: 'Doomsdaysnap', tagline: 'Fast video downloader', logoUrl: '', faviconUrl: '' },
    seo:          { metaDescription: '', metaKeywords: '', ogImageUrl: '' },
    analytics:    { googleAnalyticsId: '', facebookPixelId: '', customHeadHtml: '', customBodyHtml: '' },
    social:       { twitter: '', instagram: '', youtube: '', discord: '', tiktok: '' },
    features:     { maintenanceMode: false, showAds: true, downloadLimit: 40 },
    announcement: { enabled: false, text: '', linkUrl: '', linkText: 'Learn more', style: 'info' },
    hero:         { headline: 'Download Any Video', accent: 'Without Limits.', sub: 'The fastest way to save high-quality media from YouTube, TikTok, Instagram, and Twitter. Zero watermarks, 4K support, completely secure.', ctaText: 'Start Downloading Now', badge: '100% Free & Fast Proxy Extraction' },
};

function readJSON(file, fallback) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch { return fallback; }
}
function writeJSON(file, data) {
    fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
}

// ─── Ads ─────────────────────────────────────────────────────────────────────
const ads = {
    getAll()    { return readJSON(ADS_FILE, []); },
    getById(id) { return ads.getAll().find(a => a.id === id) || null; },
    create(ad)  { const list = ads.getAll(); list.push(ad); writeJSON(ADS_FILE, list); return ad; },
    update(id, updates) {
        const list = ads.getAll();
        const idx  = list.findIndex(a => a.id === id);
        if (idx === -1) return null;
        list[idx] = { ...list[idx], ...updates };
        writeJSON(ADS_FILE, list);
        return list[idx];
    },
    remove(id) { writeJSON(ADS_FILE, ads.getAll().filter(a => a.id !== id)); },
};

// ─── Settings ─────────────────────────────────────────────────────────────────
const settings = {
    get() {
        const stored = readJSON(SETTINGS_FILE, {});
        // Deep merge with defaults so new keys always exist
        const merged = {};
        for (const [section, defaults] of Object.entries(DEFAULT_SETTINGS)) {
            merged[section] = { ...defaults, ...(stored[section] || {}) };
        }
        return merged;
    },
    update(patch) {
        const current = settings.get();
        for (const [section, values] of Object.entries(patch)) {
            if (current[section]) current[section] = { ...current[section], ...values };
        }
        writeJSON(SETTINGS_FILE, current);
        return current;
    },
};

// ─── Stats & Analytics ────────────────────────────────────────────────────────
const stats = {
    getHistory() {
        const data = readJSON(STATS_FILE, { history: [] });
        // Clean up older than 3 days
        const now = new Date();
        const threeDaysAgo = new Date(now.setDate(now.getDate() - 3)).toISOString().split('T')[0];
        const filtered = (data.history || []).filter(h => h.date >= threeDaysAgo);
        if (filtered.length !== (data.history || []).length) writeJSON(STATS_FILE, { history: filtered });
        return filtered;
    },
    log(type, platform = '', country = 'Unknown') {
        const data = readJSON(STATS_FILE, { history: [] });
        const today = new Date().toISOString().split('T')[0];
        let day = data.history.find(h => h.date === today);

        if (!day) {
            day = { date: today, impressions: 0, clicks: 0, downloads: 0, locations: {}, platforms: {} };
            data.history.push(day);
        }

        if (type === 'impression') day.impressions++;
        if (type === 'click')      day.clicks++;
        if (type === 'download')   day.downloads++;

        if (country)   day.locations[country] = (day.locations[country] || 0) + 1;
        if (platform)  day.platforms[platform] = (day.platforms[platform] || 0) + 1;

        writeJSON(STATS_FILE, data);
    }
};

module.exports = { ads, settings, stats };
