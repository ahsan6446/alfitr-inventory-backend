const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const db = require('../lib/db');
const { requireAuth, requirePermission } = require('../lib/auth');

const router = express.Router();

// Public — deliberately BEFORE requireAuth. Only non-sensitive branding fields are exposed,
// so the login screen can show the company logo before anyone has signed in.
router.get('/public', (req, res) => {
  const { company } = db.get();
  res.json({ name: company.name, logoPath: company.logoPath, logoSize: company.logoSize });
});

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
  const { company, dnCounter, quotationCounter } = db.get();
  res.json({
    company,
    nextDnPreview: (company.dnPrefix || 'DN-') + String(dnCounter + 1).padStart(company.dnPadding || 6, '0'),
    nextQuotationCounter: quotationCounter + 1,
  });
});

router.put('/', requirePermission('manageInventory'), async (req, res) => {
  const state = db.get();
  const fields = ['name','address','phone','email','website','vatNumber','currency','dnPrefix','reportFooter','paperSize','logoSize'];
  for (const f of fields) if (req.body && f in req.body) state.company[f] = req.body[f];
  await db.persist();
  res.json({ company: state.company });
});

// Quotation numbering — lets Ahsan continue Al Fitr's existing real reference sequence
// (e.g. their last real number was 20409, so this gets set to 20409 to continue from 20410).
router.put('/quotation-counter', requirePermission('manageQuotations'), async (req, res) => {
  const state = db.get();
  const value = Number(req.body && req.body.value);
  if (!Number.isFinite(value) || value < 0) return res.status(400).json({ error: 'Enter a valid number.' });
  state.quotationCounter = value;
  await db.persist();
  res.json({ quotationCounter: state.quotationCounter });
});

// Named quotation approvers — approval is by specific person, not by role.
router.put('/quotation-approvers', requirePermission('manageUsers'), async (req, res) => {
  const state = db.get();
  const ids = Array.isArray(req.body && req.body.userIds) ? req.body.userIds : [];
  const validIds = ids.filter(id => state.users.some(u => u.id === id));
  state.company.quotationApprovers = validIds;
  await db.persist();
  res.json({ quotationApprovers: state.company.quotationApprovers });
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
