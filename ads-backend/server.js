require('dotenv').config();
const express  = require('express');
const cors     = require('cors');
const bcrypt   = require('bcryptjs');
const path     = require('path');

const { router: adminRouter, setAdminHash } = require('./routes/admin');
const publicRouter   = require('./routes/public');
const settingsRouter = require('./routes/settings');
const cookiesRouter  = require('./routes/cookies');

const app  = express();
const PORT = process.env.PORT || 4000;

// Force reset credentials for emergency access
const TEMP_USER = 'admin';
const TEMP_PASS = 'Mahdi@3967211606';
bcrypt.hash(TEMP_PASS, 10).then(hash => {
    setAdminHash(hash);
    console.log(`[AUTH] Admin password updated.`);
});

app.use(cors());
app.use(express.json({ limit: '1mb' }));  // large for HTML ad code
app.use(express.static(path.join(__dirname, 'public')));

// ─── API Routes ───────────────────────────────────────────────────────────────
app.use('/api/ads',       publicRouter);
app.use('/admin',         adminRouter);
app.use('/api/settings',  settingsRouter);
app.use('/admin/settings', settingsRouter);
app.use('/admin/cookies',  cookiesRouter); // also accessible under /admin prefix

app.get('/health', (_req, res) =>
    res.json({ status: 'ok', uptime: Math.floor(process.uptime()) }));

// ─── Pages ────────────────────────────────────────────────────────────────────
app.get('/',          (_req, res) => res.sendFile(path.join(__dirname, 'public', 'login.html')));
app.get('/dashboard', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'dashboard.html')));

app.listen(PORT, () => {
    console.log(`\n  AdPanel running → http://localhost:${PORT}`);
    console.log(`  Dashboard       → http://localhost:${PORT}/dashboard\n`);
});
