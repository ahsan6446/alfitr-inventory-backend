const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const db = require('../lib/db');
const { requireAuth, requirePermission } = require('../lib/auth');

const router = express.Router();
router.use(requireAuth);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (!/^image\/(png|jpe?g|webp|svg\+xml)$/.test(file.mimetype)) {
      return cb(new Error('Please upload a PNG, JPG, WEBP or SVG image.'));
    }
    cb(null, true);
  },
});

router.get('/', (req, res) => {
  const { company, dnCounter } = db.get();
  res.json({ company, nextDnPreview: (company.dnPrefix || 'DN-') + String(dnCounter + 1).padStart(company.dnPadding || 6, '0') });
});

router.put('/', requirePermission('manageInventory'), async (req, res) => {
  const state = db.get();
  const fields = ['name','address','phone','email','website','vatNumber','currency','dnPrefix','reportFooter','paperSize','logoSize'];
  for (const f of fields) if (req.body && f in req.body) state.company[f] = req.body[f];
  await db.persist();
  res.json({ company: state.company });
});

// Logo upload — stored as a static file (not base64-in-JSON) and served at /uploads/<name>.
// Resizing to a sane max footprint happens client-side before upload for quality; here we
// simply cap file size and type. (No external image-processing lib needed — this keeps the
// backend dependency-free and easy to deploy anywhere.)
router.post('/logo', requirePermission('manageInventory'), upload.single('logo'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });
  const state = db.get();
  const ext = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/svg+xml': 'svg' }[req.file.mimetype] || 'png';
  const filename = `logo-${Date.now()}.${ext}`;
  fs.writeFileSync(path.join(db.UPLOADS_DIR, filename), req.file.buffer);

  // clean up old logo file if present
  if (state.company.logoPath) {
    const oldPath = path.join(db.UPLOADS_DIR, path.basename(state.company.logoPath));
    if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
  }
  state.company.logoPath = `/uploads/${filename}`;
  await db.persist();
  res.json({ company: state.company });
});

router.delete('/logo', requirePermission('manageInventory'), async (req, res) => {
  const state = db.get();
  if (state.company.logoPath) {
    const oldPath = path.join(db.UPLOADS_DIR, path.basename(state.company.logoPath));
    if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
  }
  state.company.logoPath = null;
  await db.persist();
  res.json({ company: state.company });
});

module.exports = router;
