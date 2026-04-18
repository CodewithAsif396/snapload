const express = require('express');
const bcrypt  = require('bcryptjs');
const jwt     = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const fs      = require('fs');
const path    = require('path');

const { requireAuth, JWT_SECRET } = require('../middleware/auth');
const { ads } = require('../storage');

// maintenance.json sits one level up (in the main doomsdaysnap folder)
const MAINTENANCE_FILE = path.join(__dirname, '..', '..', 'maintenance.json');

function loadMnt() {
    try { return JSON.parse(fs.readFileSync(MAINTENANCE_FILE, 'utf8')); }
    catch { return { global: false, pages: {}, message: '', estimatedTime: '' }; }
}
function saveMnt(data) {
    fs.writeFileSync(MAINTENANCE_FILE, JSON.stringify(data, null, 2));
}

const router = express.Router();
let ADMIN_HASH = null;
function setAdminHash(hash) { ADMIN_HASH = hash; }

const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';
const VALID_TYPES      = ['banner', 'sidebar', 'popup', 'video', 'html'];
const VALID_PLACEMENTS = ['header', 'footer', 'sidebar-left', 'sidebar-right', 'in-content', 'overlay'];
const VALID_DEVICES    = ['all', 'desktop', 'mobile'];

// ─── Login ────────────────────────────────────────────────────────────────────
router.post('/login', async (req, res) => {
    const { username, password } = req.body || {};
    if (!username || !password)
        return res.status(400).json({ error: 'username and password are required.' });
    if (username !== ADMIN_USERNAME)
        return res.status(401).json({ error: 'Invalid credentials.' });
    const ok = await bcrypt.compare(password, ADMIN_HASH);
    if (!ok) return res.status(401).json({ error: 'Invalid credentials.' });
    const token = jwt.sign({ role: 'admin' }, JWT_SECRET, { expiresIn: '8h' });
    res.json({ token, expiresIn: '8h' });
});

// ─── Protected ───────────────────────────────────────────────────────────────
router.get('/ads',     requireAuth, (_req, res) => res.json(ads.getAll()));
router.get('/ads/:id', requireAuth, (req, res) => {
    const ad = ads.getById(req.params.id);
    if (!ad) return res.status(404).json({ error: 'Ad not found.' });
    res.json(ad);
});

router.post('/ads', requireAuth, (req, res) => {
    const { title, type, placement, imageUrl, linkUrl, html,
            active, priority, deviceTarget, startDate, endDate } = req.body || {};

    if (!title || !type || !placement)
        return res.status(400).json({ error: 'title, type, and placement are required.' });
    if (!VALID_TYPES.includes(type))
        return res.status(400).json({ error: `type must be one of: ${VALID_TYPES.join(', ')}` });
    if (!VALID_PLACEMENTS.includes(placement))
        return res.status(400).json({ error: `placement must be one of: ${VALID_PLACEMENTS.join(', ')}` });

    const ad = {
        id:           uuidv4(),
        title,
        type,
        placement,
        imageUrl:     imageUrl     || null,
        linkUrl:      linkUrl      || null,
        html:         html         || null,
        active:       active !== false,
        priority:     Math.min(10, Math.max(1, parseInt(priority) || 5)),
        deviceTarget: VALID_DEVICES.includes(deviceTarget) ? deviceTarget : 'all',
        startDate:    startDate    || null,
        endDate:      endDate      || null,
        impressions:  0,
        clicks:       0,
        createdAt:    new Date().toISOString(),
        updatedAt:    new Date().toISOString(),
    };
    res.status(201).json(ads.create(ad));
});

router.put('/ads/:id', requireAuth, (req, res) => {
    if (!ads.getById(req.params.id))
        return res.status(404).json({ error: 'Ad not found.' });

    const allowed = ['title', 'type', 'placement', 'imageUrl', 'linkUrl', 'html',
                     'active', 'priority', 'deviceTarget', 'startDate', 'endDate'];
    const updates = {};
    for (const key of allowed) {
        if (key in req.body) updates[key] = req.body[key];
    }
    updates.updatedAt = new Date().toISOString();
    res.json(ads.update(req.params.id, updates));
});

router.delete('/ads/:id', requireAuth, (req, res) => {
    if (!ads.getById(req.params.id))
        return res.status(404).json({ error: 'Ad not found.' });
    ads.remove(req.params.id);
    res.json({ message: 'Ad deleted.' });
});

router.patch('/ads/:id/toggle', requireAuth, (req, res) => {
    const ad = ads.getById(req.params.id);
    if (!ad) return res.status(404).json({ error: 'Ad not found.' });
    res.json(ads.update(req.params.id, { active: !ad.active, updatedAt: new Date().toISOString() }));
});

router.get('/stats', requireAuth, (_req, res) => {
    const all = ads.getAll();
    const totals = all.reduce((a, ad) => {
        a.impressions += ad.impressions;
        a.clicks      += ad.clicks;
        return a;
    }, { impressions: 0, clicks: 0 });
    res.json({ 
        totalAds:    all.length, 
        activeAds:   all.filter(a => a.active).length, 
        ...totals,
        history:     stats.getHistory()
    });
});

// ─── Maintenance ─────────────────────────────────────────────────────────────
router.get('/maintenance', requireAuth, (_req, res) => {
    res.json(loadMnt());
});

router.post('/maintenance', requireAuth, (req, res) => {
    const { page, enabled, global: globalMode, message, estimatedTime } = req.body || {};
    const data = loadMnt();
    if (typeof globalMode === 'boolean') data.global = globalMode;
    if (page) data.pages[page] = enabled === true;
    if (message  !== undefined) data.message       = message;
    if (estimatedTime !== undefined) data.estimatedTime = estimatedTime;
    saveMnt(data);
    console.log('[Maintenance] Updated:', JSON.stringify(data));
    res.json(data);
});

module.exports = { router, setAdminHash };
