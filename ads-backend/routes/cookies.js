const express = require('express');
const multer  = require('multer');
const path    = require('path');
const fs      = require('fs');
const { execSync } = require('child_process');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

// Store cookies in the ads-backend/data folder which is definitely writable
const ABS_ROOT = path.resolve(__dirname, '..', 'data');
if (!fs.existsSync(ABS_ROOT)) fs.mkdirSync(ABS_ROOT, { recursive: true });

// Also need the main root for cookie_manager.py execution
const MAIN_ROOT = path.resolve(__dirname, '..', '..');

function getPythonCommand() {
    if (process.platform === 'win32') return 'python';
    try {
        const { execSync } = require('child_process');
        execSync('python3 --version', { stdio: 'ignore' });
        return 'python3';
    } catch {
        return 'python';
    }
}
const PYTHON = getPythonCommand();

const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 5 * 1024 * 1024 }, // 5MB max
});

// GET /admin/cookies/status — status of all platforms or a specific one
router.get('/status', requireAuth, (req, res) => {
    try {
        const platform = req.query.platform;
        const result = execSync(
            `${PYTHON} cookie_manager.py --json`,
            { cwd: MAIN_ROOT, timeout: 30000, encoding: 'utf8' }
        );
        const data = JSON.parse(result);
        
        if (platform && data[platform]) {
            return res.json(data[platform]);
        }
        res.json(data);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// POST /admin/cookies/upload — upload new cookies for a platform
router.post('/upload', requireAuth, upload.single('cookies'), (req, res) => {
    const platform = req.body.platform;
    if (!platform) return res.status(400).json({ error: 'Platform is required' });
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    if (req.file.size < 500) return res.status(400).json({ error: 'File too small — not a valid cookies file' });

    const filename = `cookies_${platform}.txt`;
    const cookiePath = path.join(ABS_ROOT, filename);

    // Backup old cookies
    if (fs.existsSync(cookiePath)) {
        fs.copyFileSync(cookiePath, cookiePath + '.bak');
    }

    fs.writeFileSync(cookiePath, req.file.buffer);

    // Quick validate via python for all platforms to refresh dashboard
    let allStatus = {};
    try {
        const result = execSync(
            `${PYTHON} cookie_manager.py --json`,
            { cwd: MAIN_ROOT, timeout: 30000, encoding: 'utf8' }
        );
        allStatus = JSON.parse(result);
    } catch (e) {
        console.error('[Cookies] Validation error:', e.message);
    }

    res.json({ 
        success: true, 
        message: 'Cookies uploaded successfully',
        platform,
        status: allStatus[platform] || { valid: false, reason: 'Check failed' },
        allStatus
    });
});

module.exports = router;
