const express = require('express');
const { ads, settings } = require('../storage');

const router = express.Router();

// GET /api/ads — active ads, optionally filtered by placement or device
router.get('/', (req, res) => {
    const cfg = settings.get();
    if (!cfg.features.showAds) return res.json([]);

    const now = new Date();
    let list  = ads.getAll().filter(ad => {
        if (!ad.active)                                   return false;
        if (ad.startDate && new Date(ad.startDate) > now) return false;
        if (ad.endDate   && new Date(ad.endDate)   < now) return false;
        return true;
    });

    if (req.query.placement) list = list.filter(a => a.placement === req.query.placement);
    if (req.query.device)    list = list.filter(a => a.deviceTarget === 'all' || a.deviceTarget === req.query.device);

    // Sort by priority descending
    list.sort((a, b) => (b.priority || 5) - (a.priority || 5));

    // Strip internal stats from public response
    const safe = list.map(({ impressions: _i, clicks: _c, ...ad }) => ad);
    res.json(safe);
});

// Redirect to ad link and track click
router.get('/click/:id', (req, res) => {
    const ad = storage.ads.getById(req.params.id);
    if (!ad) return res.redirect('/');
    storage.stats.log('click', ad.type);
    res.redirect(ad.linkUrl);
});

// Serve ad with impression tracking
router.get('/view/:id', (req, res) => {
    const ad = storage.ads.getById(req.params.id);
    if (!ad) return res.status(404).send('Ad not found');
    storage.stats.log('impression', ad.type);
    res.send(ad.html || `<a href="/api/ads/click/${ad.id}"><img src="${ad.imageUrl}" style="max-width:100%"></a>`);
});

// Generic tracking endpoint
router.post('/track', (req, res) => {
    const { type, platform } = req.body;
    const country = req.headers['cf-ipcountry'] || 'Unknown';
    storage.stats.log(type, platform, country);
    res.status(204).end();
});

module.exports = router;
