const express = require('express');
const path    = require('path');
const fs      = require('fs');
const { requireAuth, requirePermission } = require('../lib/auth');

const router = express.Router();
router.use(requireAuth);

// ─────────────────────────────────────────────────────────────────────
// Ref-number generator  →  AF/SDR/0047/001/26
// ─────────────────────────────────────────────────────────────────────
function nextSdrNumber(state, joNumber) {
  if (!state.delayReportCounters) state.delayReportCounters = {};
  state.delayReportCounters[joNumber] =
    (state.delayReportCounters[joNumber] || 0) + 1;
  const seq   = String(state.delayReportCounters[joNumber]).padStart(3, '0');
  const yy    = new Date().getFullYear().toString().slice(-2);
  const joSeq = String(joNumber).replace(/\D/g, '').slice(-4).padStart(4, '0');
  return `AF/SDR/${joSeq}/${seq}/${yy}`;
}

// ─────────────────────────────────────────────────────────────────────
// Multer — photo uploads (site photo + drawing photo per row)
// ─────────────────────────────────────────────────────────────────────
const db = require('../lib/db');

let photoUpload;
try {
  const multer    = require('multer');
  const uploadDir = path.join(db.UPLOADS_DIR, 'delay-reports');
  if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

  const storage = multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, uploadDir),
    filename:    (_req, file,  cb) => {
      const uid = Date.now() + '-' + Math.round(Math.random() * 1e6);
      cb(null, uid + path.extname(file.originalname).toLowerCase());
    },
  });

  const upload = multer({
    storage,
    limits:     { fileSize: 10 * 1024 * 1024 },
    fileFilter: (_req, file, cb) =>
      cb(null, /\.(jpe?g|png|webp)$/i.test(file.originalname)),
  });

  photoUpload = upload.fields([
    { name: 'sitePhotos',    maxCount: 20 },
    { name: 'drawingPhotos', maxCount: 20 },
  ]);
} catch {
  photoUpload = (_req, _res, next) => next();
}

// ─────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────
const isTrue    = v  => v === true || v === 'true';
const parseBody = b  => (typeof b === 'string' ? JSON.parse(b) : b) || {};

// ─────────────────────────────────────────────────────────────────────
// GET /api/delay-reports
// ─────────────────────────────────────────────────────────────────────
router.get('/', (req, res) => {
  const { delayReports = [] } = db.get();
  res.json({
    delayReports: [...delayReports].sort((a, b) => b.createdAt - a.createdAt),
  });
});

// ─────────────────────────────────────────────────────────────────────
// GET /api/delay-reports/:id
// ─────────────────────────────────────────────────────────────────────
router.get('/:id', (req, res) => {
  const { delayReports = [] } = db.get();
  const report = delayReports.find(r => r.id === req.params.id);
  if (!report) return res.status(404).json({ error: 'Delay report not found.' });
  res.json({ delayReport: report });
});

// ─────────────────────────────────────────────────────────────────────
// POST /api/delay-reports  — create
// ─────────────────────────────────────────────────────────────────────
router.post('/', requirePermission('manageReports'), photoUpload, async (req, res) => {
  try {
    const state = db.get();
    const body  = parseBody(req.body);

    const jo = (state.jobOrders || []).find(j => j.id === body.jobOrderId);
    if (!jo) return res.status(400).json({ error: 'Select a valid Job Order.' });

    let delayItems;
    try {
      delayItems = typeof body.delayItems === 'string'
        ? JSON.parse(body.delayItems)
        : (body.delayItems || []);
    } catch {
      return res.status(400).json({ error: 'Invalid delay items data.' });
    }
    if (!Array.isArray(delayItems) || delayItems.length === 0) {
      return res.status(400).json({ error: 'Add at least one delay item.' });
    }

    const sitePhotos    = req.files?.sitePhotos    || [];
    const drawingPhotos = req.files?.drawingPhotos  || [];

    const items = delayItems.map((item, i) => ({
      id:             db.uuid(),
      srNo:           i + 1,
      floor:          item.floor         || '',
      areaZone:       item.areaZone      || '',
      description:    item.description   || '',
      reasonOfDelay:  item.reasonOfDelay || '',
      actionBy:       item.actionBy      || '',
      actionNote:     item.actionNote    || '',
      status:         item.status        || 'Open',
      remarks:        item.remarks       || '',
      targetDate:     item.targetDate    || '',
      sitePhotoUrl:    sitePhotos[i]    ? `/uploads/delay-reports/${sitePhotos[i].filename}`    : null,
      drawingPhotoUrl: drawingPhotos[i] ? `/uploads/delay-reports/${drawingPhotos[i].filename}` : null,
    }));

    const signatures = {
      afSide: [
        ...(isTrue(body.sigRamadasu) ? [{ name: body.reportedBy || jo.preparedBy || 'Ramadasu',   role: 'Prepared By'       }] : []),
        ...(isTrue(body.sigNazir)    ? [{ name: jo.projectsIncharge || 'Projects Incharge',        role: 'Project In-Charge' }] : []),
      ],
      clientSide: [
        ...(isTrue(body.sigIbrahim) ? [{ name: jo.siteEngineer   || 'Client Engineer',  role: 'Client Engineer'  }] : []),
        ...(isTrue(body.sigHussein) ? [{ name: jo.projectManager || 'Project Manager',  role: 'Project Manager'  }] : []),
      ],
    };

    const report = {
      id:               db.uuid(),
      refNumber:        nextSdrNumber(state, jo.jobOrderNumber || jo.id),
      jobOrderId:       jo.id,
      jobOrderNumber:   jo.jobOrderNumber || jo.id,
      projectName:      jo.projectName    || jo.name || '',
      location:         jo.location       || '',
      clientCompany:    jo.clientCompany  || '',
      projectManager:   jo.projectManager || '',
      siteEngineer:     jo.siteEngineer   || '',
      siteSupervisor:   jo.siteSupervisor || '',
      projectsIncharge: 'Engr. Nazir Hussain',
      date:             body.date || new Date().toISOString().slice(0, 10),
      reportedBy:       body.reportedBy || req.user.name,
      reportedById:     req.user.id,
      delayItems:       items,
      signatures,
      status:           'Submitted',
      createdAt:        Date.now(),
      updatedAt:        Date.now(),
    };

    if (!state.delayReports) state.delayReports = [];
    state.delayReports.push(report);
    await db.persist();

    res.status(201).json({ delayReport: report });
  } catch (err) {
    console.error('POST /api/delay-reports:', err);
    res.status(500).json({ error: 'Could not save delay report.' });
  }
});

// ─────────────────────────────────────────────────────────────────────
// PUT /api/delay-reports/:id  — update
// ─────────────────────────────────────────────────────────────────────
router.put('/:id', requirePermission('manageReports'), photoUpload, async (req, res) => {
  try {
    const state   = db.get();
    const reports = state.delayReports || [];
    const idx     = reports.findIndex(r => r.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'Delay report not found.' });

    const body = parseBody(req.body);
    let delayItems;
    try {
      delayItems = typeof body.delayItems === 'string'
        ? JSON.parse(body.delayItems)
        : (body.delayItems || reports[idx].delayItems);
    } catch { delayItems = reports[idx].delayItems; }

    const sitePhotos    = req.files?.sitePhotos    || [];
    const drawingPhotos = req.files?.drawingPhotos  || [];

    reports[idx] = {
      ...reports[idx],
      date:       body.date       || reports[idx].date,
      reportedBy: body.reportedBy || reports[idx].reportedBy,
      delayItems: delayItems.map((item, i) => ({
        ...item,
        id:   item.id || db.uuid(),
        srNo: i + 1,
        sitePhotoUrl:    sitePhotos[i]    ? `/uploads/delay-reports/${sitePhotos[i].filename}`    : (item.sitePhotoUrl    || null),
        drawingPhotoUrl: drawingPhotos[i] ? `/uploads/delay-reports/${drawingPhotos[i].filename}` : (item.drawingPhotoUrl || null),
      })),
      updatedAt: Date.now(),
    };

    await db.persist();
    res.json({ delayReport: reports[idx] });
  } catch (err) {
    console.error('PUT /api/delay-reports/:id:', err);
    res.status(500).json({ error: 'Could not update delay report.' });
  }
});

// ─────────────────────────────────────────────────────────────────────
// DELETE /api/delay-reports/:id
// ─────────────────────────────────────────────────────────────────────
router.delete('/:id', requirePermission('manageReports'), async (req, res) => {
  const state  = db.get();
  const before = (state.delayReports || []).length;
  state.delayReports = (state.delayReports || []).filter(r => r.id !== req.params.id);
  if (state.delayReports.length === before) {
    return res.status(404).json({ error: 'Delay report not found.' });
  }
  await db.persist();
  res.json({ ok: true });
});

module.exports = router;
