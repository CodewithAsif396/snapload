const express = require('express');
const multer  = require('multer');
const path    = require('path');
const fs      = require('fs');
const { execSync } = require('child_process');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

// Path to the Python downloader project
const COOKIE_PATH = path.resolve(__dirname, '../../cookies.txt');

const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 5 * 1024 * 1024 }, // 5MB max
});

// GET /admin/cookies — status
router.get('/status', requireAuth, (_req, res) => {
    try {
        if (!fs.existsSync(COOKIE_PATH)) {
            return res.json({ exists: false, age_days: null, size: 0 });
        }
        const stat = fs.statSync(COOKIE_PATH);
        const age_days = (Date.now() - stat.mtimeMs) / 86400000;
        res.json({ exists: true, age_days: parseFloat(age_days.toFixed(1)), size: stat.size });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// POST /admin/cookies/upload — upload new cookies.txt
router.post('/upload', requireAuth, upload.single('cookies'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    if (req.file.size < 500) return res.status(400).json({ error: 'File too small — not a valid cookies.txt' });

    // Backup old cookies
    if (fs.existsSync(COOKIE_PATH)) {
        fs.copyFileSync(COOKIE_PATH, COOKIE_PATH + '.bak');
    }

    fs.writeFileSync(COOKIE_PATH, req.file.buffer);

    // Quick validate via python
    let valid = false;
    let reason = 'Not checked';
    try {
        const pythonDir = path.resolve(__dirname, '../..');
        const result = execSync(
            `python cookie_manager.py --check`,
            { cwd: pythonDir, timeout: 30000, encoding: 'utf8' }
        );
        valid = result.includes('True');
        reason = result.trim().split('\n').pop();
    } catch (e) {
        reason = e.stdout || e.message;
    }

    res.json({ success: true, valid, reason, size: req.file.size });
});

module.exports = router;
