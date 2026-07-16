require('dotenv').config({ quiet: true });
const express = require('express');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const path = require('path');
const db = require('./lib/db');

const app = express();
const PORT = process.env.PORT || 4000;

app.use(cors({ origin: process.env.CORS_ORIGIN || true, credentials: true }));
app.use(express.json({ limit: '2mb' }));
app.use(cookieParser());

// Static file uploads (logos)
app.use('/uploads', express.static(db.UPLOADS_DIR));

// API routes
app.use('/api/auth', require('./routes/auth'));
app.use('/api/items', require('./routes/items'));
app.use('/api/movements', require('./routes/movements'));
app.use('/api/clients', require('./routes/clients'));
app.use('/api/dns', require('./routes/dns'));
app.use('/api/users', require('./routes/users'));
app.use('/api/company', require('./routes/company'));
app.use('/api/meta', require('./routes/meta'));
app.use('/api/export', require('./routes/export'));

app.get('/api/health', (req, res) => res.json({ ok: true, time: new Date().toISOString() }));

// Serve the frontend (single-page app)
const PUBLIC_DIR = path.join(__dirname, 'public');
app.use(express.static(PUBLIC_DIR));

// SPA fallback — anything not matched above and not /api or /uploads returns index.html.
// Implemented as a plain middleware (no path pattern) so it works regardless of the
// Express version's route-matching syntax.
app.use((req, res, next) => {
  if (req.method !== 'GET') return next();
  if (req.path.startsWith('/api') || req.path.startsWith('/uploads')) return next();
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

// Error handler (e.g. multer file-type/size errors)
app.use((err, req, res, next) => {
  console.error(err);
  res.status(err.status || 500).json({ error: err.message || 'Something went wrong on the server.' });
});

app.listen(PORT, () => {
  console.log(`\n✅ Al Fitr Inventory backend running at http://localhost:${PORT}`);
  console.log(`   Default login — username: admin / password: admin123 (you'll be asked to change it)\n`);
});
