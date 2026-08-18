const express = require('express');
const path    = require('path');
const fs      = require('fs');
const db      = require('../lib/db');
const { requireAuth, requirePermission } = require('../lib/auth');

const router = express.Router();
router.use(requireAuth);

const WORK_TYPES = [
  'Painting / Touch Up', 'Plumbing', 'Electrical', 'HVAC / AC',
  'Civil / Carpentry', 'Fire Alarm / FF', 'ELV / IT', 'Cleaning',
  'General Maintenance', 'Other',
];

// ── Multer setup ──────────────────────────────────────────────────
let upload;
try {
  const multer    = require('multer');
  const uploadDir = path.join(db.UPLOADS_DIR, 'work-reports');
  if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
  const storage = multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, uploadDir),
    filename:    (_req, file, cb) => {
      const uid = Date.now() + '-' + Math.round(Math.random() * 1e6);
      cb(null, uid + path.extname(file.originalname).toLowerCase());
    },
  });
  upload = multer({
    storage,
    limits: { fileSize: 15 * 1024 * 1024 },
    fileFilter: (_req, file, cb) => cb(null, /\.(jpg|jpeg|png|webp)$/i.test(file.originalname)),
  }).fields([
    ...Array.from({length:10}, (_,i) => ({ name: `beforePhoto_${i}`, maxCount: 1 })),
    ...Array.from({length:10}, (_,i) => ({ name: `afterPhoto_${i}`,  maxCount: 1 })),
    { name: 'servicePhoto', maxCount: 1 },
  ]);
} catch { upload = (_req, _res, next) => next(); }

function nextWcrNumber(state) {
  if (!state.wcrCounter) state.wcrCounter = 0;
  state.wcrCounter++;
  return `AF/WCR/${String(state.wcrCounter).padStart(4,'0')}/${new Date().getFullYear().toString().slice(-2)}`;
}
function nextSnrNumber(state) {
  if (!state.snrCounter) state.snrCounter = 0;
  state.snrCounter++;
  return `AF/SNR/${String(state.snrCounter).padStart(4,'0')}/${new Date().getFullYear().toString().slice(-2)}`;
}

// ── GET all work reports ───────────────────────────────────────────
router.get('/', (req, res) => {
  const state = db.get();
  const wcrs  = (state.workReports || []).sort((a,b) => b.createdAt - a.createdAt);
  res.json({ workReports: wcrs });
});

// ── GET one ───────────────────────────────────────────────────────
router.get('/:id', (req, res) => {
  const state = db.get();
  const wr    = (state.workReports || []).find(r => r.id === req.params.id);
  if (!wr) return res.status(404).json({ error: 'Report not found.' });
  res.json({ workReport: wr });
});

// ── POST Work Completion Report ────────────────────────────────────
router.post('/wcr', requirePermission('manageReports'), upload, async (req, res) => {
  const state = db.get();
  const body  = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
  const jo    = (state.jobOrders || []).find(j => j.id === body.jobOrderId);
  if (!jo) return res.status(400).json({ error: 'Select a valid Job Order.' });

  // Parse tasks
  let tasks = [];
  try { tasks = JSON.parse(body.tasks || '[]'); } catch { tasks = []; }

  // Attach uploaded photos to tasks
  tasks = tasks.map((task, i) => {
    const bf = req.files?.[`beforePhoto_${i}`]?.[0];
    const af = req.files?.[`afterPhoto_${i}`]?.[0];
    return {
      ...task,
      beforePhotoUrl: bf ? `/uploads/work-reports/${bf.filename}` : (task.beforePhotoUrl || null),
      afterPhotoUrl:  af ? `/uploads/work-reports/${af.filename}` : (task.afterPhotoUrl  || null),
    };
  });

  if (!state.workReports) state.workReports = [];
  const wr = {
    id:             db.uuid(),
    type:           'WCR',
    refNumber:      nextWcrNumber(state),
    jobOrderId:     jo.id,
    jobOrderNumber: jo.jobOrderNumber,
    clientCompany:  jo.clientCompany,
    projectName:    jo.subject || '',
    location:       body.location || jo.location || '',
    date:           body.date || new Date().toISOString().slice(0,10),
    technicianName: body.technicianName || req.user.name,
    supervisorName: body.supervisorName || '',
    receivedBy:     body.receivedBy || '',
    tasks,
    notes:          body.notes || '',
    status:         body.status || 'Completed',
    forClient:      body.forClient === 'true' || body.forClient === true,
    createdById:    req.user.id,
    createdByName:  req.user.name,
    createdAt:      Date.now(),
    updatedAt:      Date.now(),
  };
  state.workReports.push(wr);
  await db.persist();
  res.status(201).json({ workReport: wr });
});

// ── POST Service Notification Report ──────────────────────────────
router.post('/snr', requirePermission('manageReports'), upload, async (req, res) => {
  const state = db.get();
  const body  = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
  const jo    = (state.jobOrders || []).find(j => j.id === body.jobOrderId);
  if (!jo) return res.status(400).json({ error: 'Select a valid Job Order.' });

  const photo = req.files?.servicePhoto?.[0];
  if (!state.workReports) state.workReports = [];
  const snr = {
    id:             db.uuid(),
    type:           'SNR',
    refNumber:      nextSnrNumber(state),
    jobOrderId:     jo.id,
    jobOrderNumber: jo.jobOrderNumber,
    clientCompany:  jo.clientCompany,
    projectName:    jo.subject || '',
    location:       body.location || jo.location || '',
    date:           body.date || new Date().toISOString().slice(0,10),
    time:           body.time || new Date().toTimeString().slice(0,5),
    technicianName: body.technicianName || req.user.name,
    supervisorName: body.supervisorName || '',
    subject:        body.subject || '',
    description:    body.description || '',
    workType:       body.workType || '',
    photoUrl:       photo ? `/uploads/work-reports/${photo.filename}` : null,
    status:         body.status || 'Completed',
    forClient:      body.forClient === 'true' || body.forClient === true,
    createdById:    req.user.id,
    createdByName:  req.user.name,
    createdAt:      Date.now(),
    updatedAt:      Date.now(),
  };
  state.workReports.push(snr);
  await db.persist();
  res.status(201).json({ workReport: snr });
});

// ── DELETE ─────────────────────────────────────────────────────────
router.delete('/:id', requirePermission('manageReports'), async (req, res) => {
  const state = db.get();
  if (!state.workReports) return res.status(404).json({ error: 'Not found.' });
  const before = state.workReports.length;
  state.workReports = state.workReports.filter(r => r.id !== req.params.id);
  if (state.workReports.length === before) return res.status(404).json({ error: 'Not found.' });
  await db.persist();
  res.json({ ok: true });
});

module.exports = { router, WORK_TYPES };
