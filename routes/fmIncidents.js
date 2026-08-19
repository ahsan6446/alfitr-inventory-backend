const express = require('express');
const path    = require('path');
const fs      = require('fs');
const db      = require('../lib/db');
const { requireAuth, requirePermission } = require('../lib/auth');

const router  = express.Router();
router.use(requireAuth);

const INCIDENT_TYPES = [
  'Health & Safety', 'Fire', 'Electrical', 'Plumbing',
  'HVAC / AC', 'Fire Alarm', 'Fire Fighting',
  'Civil / Structural', 'Environmental', 'Other',
];
const SEVERITY_LEVELS = ['Near Miss', 'Minor', 'Major', 'Critical', 'Fatal'];

// ── Multer ────────────────────────────────────────────────────────
let upload;
try {
  const multer    = require('multer');
  const uploadDir = path.join(db.UPLOADS_DIR, 'incidents');
  if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
  const storage = multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, uploadDir),
    filename:    (_req, file, cb) => cb(null, Date.now() + '-' + Math.round(Math.random()*1e6) + path.extname(file.originalname).toLowerCase()),
  });
  upload = multer({ storage, limits: { fileSize: 15*1024*1024 },
    fileFilter: (_req, file, cb) => cb(null, /\.(jpg|jpeg|png|webp)$/i.test(file.originalname)),
  }).fields([...Array.from({length:5}, (_,i) => ({ name:`photo_${i}`, maxCount:1 }))]);
} catch { upload = (_req, _res, next) => next(); }

function nextIrNumber(state) {
  if (!state.irCounter) state.irCounter = 0;
  state.irCounter++;
  return `AF/IR/${String(state.irCounter).padStart(4,'0')}/${new Date().getFullYear().toString().slice(-2)}`;
}

// GET all
router.get('/', (req, res) => {
  const { fmIncidents = [] } = db.get();
  res.json({ incidents: [...fmIncidents].sort((a,b) => b.createdAt - a.createdAt) });
});

// GET one
router.get('/:id', (req, res) => {
  const { fmIncidents = [] } = db.get();
  const ir = fmIncidents.find(r => r.id === req.params.id);
  if (!ir) return res.status(404).json({ error: 'Not found.' });
  res.json({ incident: ir });
});

// POST create
router.post('/', requirePermission('manageReports'), upload, async (req, res) => {
  const state = db.get();
  const body  = req.body || {};
  const jo    = (state.jobOrders||[]).find(j => j.id === body.jobOrderId);
  if (!jo) return res.status(400).json({ error: 'Select a valid Job Order.' });

  // Collect uploaded photos
  const photos = [];
  for (let i = 0; i < 5; i++) {
    const f = req.files?.[`photo_${i}`]?.[0];
    if (f) photos.push(`/uploads/incidents/${f.filename}`);
  }

  // Parse risk controls
  let riskControls = [];
  try { riskControls = JSON.parse(body.riskControls || '[]'); } catch {}

  if (!state.fmIncidents) state.fmIncidents = [];
  const ir = {
    id:                 db.uuid(),
    refNumber:          nextIrNumber(state),
    jobOrderId:         jo.id,
    jobOrderNumber:     jo.jobOrderNumber,
    clientCompany:      jo.clientCompany,
    projectName:        jo.subject || '',
    location:           body.location || '',
    date:               body.date || new Date().toISOString().slice(0,10),
    time:               body.time || '',
    incidentType:       body.incidentType || 'Other',
    severity:           body.severity || 'Minor',
    classification:     body.classification || '',
    // H&S specific
    affectedPerson:     body.affectedPerson || '',
    affectedDesignation:body.affectedDesignation || '',
    injuryType:         body.injuryType || '',
    // Type-specific details
    typeDetails:        body.typeDetails || '',
    material:           body.material || '',
    extinguishingMedia: body.extinguishingMedia || '',
    civilDefenseInformed: body.civilDefenseInformed === 'true',
    estimatedCost:      body.estimatedCost || '',
    // Core fields
    description:        body.description || '',
    immediateAction:    body.immediateAction || '',
    correctiveAction:   body.correctiveAction || '',
    // Cause analysis
    immediateCause:     body.immediateCause || '',
    underlyingCause:    body.underlyingCause || '',
    rootCause:          body.rootCause || '',
    // Risk controls
    riskControls,
    // Photos
    photos,
    // People
    supervisorName:     body.supervisorName || '',
    preparedByName:     body.preparedByName || req.user.name,
    preparedByDesig:    body.preparedByDesig || '',
    approvedByName:     body.approvedByName || '',
    approvedByDesig:    body.approvedByDesig || '',
    status:             'Open',
    createdById:        req.user.id,
    createdByName:      req.user.name,
    createdAt:          Date.now(),
    updatedAt:          Date.now(),
  };
  state.fmIncidents.push(ir);
  await db.persist();
  res.status(201).json({ incident: ir });
});

// DELETE
router.delete('/:id', requirePermission('manageReports'), async (req, res) => {
  const state = db.get();
  if (!state.fmIncidents) return res.status(404).json({ error: 'Not found.' });
  const before = state.fmIncidents.length;
  state.fmIncidents = state.fmIncidents.filter(r => r.id !== req.params.id);
  if (state.fmIncidents.length === before) return res.status(404).json({ error: 'Not found.' });
  await db.persist();
  res.json({ ok: true });
});

module.exports = { router, INCIDENT_TYPES, SEVERITY_LEVELS };
