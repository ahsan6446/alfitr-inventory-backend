const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const db = require('../lib/db');
const { requireAuth, requirePermission } = require('../lib/auth');

const router = express.Router();
router.use(requireAuth);

// Ref number generator: AF/SDR/0047/001/26 — sequence resets per Job Order, so each
// job's delay reports number 001, 002, 003... regardless of what other jobs are doing.
function nextSdrNumber(state, jobOrderNumber) {
  if (!state.delayReportCounters) state.delayReportCounters = {};
  state.delayReportCounters[jobOrderNumber] = (state.delayReportCounters[jobOrderNumber] || 0) + 1;
  const seq = String(state.delayReportCounters[jobOrderNumber]).padStart(3, '0');
  const yy = new Date().getFullYear().toString().slice(-2);
  const joSeq = jobOrderNumber.replace(/\D/g, '').slice(-4);
  return `AF/SDR/${joSeq}/${seq}/${yy}`;
}

const uploadDir = path.join(db.UPLOADS_DIR, 'delay-reports');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => {
    const unique = Date.now() + '-' + Math.round(Math.random() * 1e6);
    cb(null, unique + path.extname(file.originalname));
  },
});
const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB per photo
  fileFilter: (req, file, cb) => {
    const ok = /\.(jpe?g|png|webp)$/i.test(file.originalname);
    cb(ok ? null : new Error('Only JPG, PNG, or WEBP photos are allowed.'), ok);
  },
});
// Each delay-item row's photos are named "sitePhoto_<rowIndex>" / "drawingPhoto_<rowIndex>"
// by the frontend, and matched back to the right row by that index — not by array
// position. Positional matching breaks the moment a row in the middle has no photo,
// since a missing file just shrinks the array instead of leaving an empty slot.
const photoUpload = upload.any();
function photosByRowIndex(files) {
  const site = {}, drawing = {};
  for (const f of files || []) {
    const m = f.fieldname.match(/^(sitePhoto|drawingPhoto)_(\d+)$/);
    if (!m) continue;
    const idx = Number(m[2]);
    if (m[1] === 'sitePhoto') site[idx] = f; else drawing[idx] = f;
  }
  return { site, drawing };
}

const isTrue = v => v === 'true' || v === true;

router.get('/', (req, res) => {
  const { delayReports } = db.get();
  res.json({ delayReports: [...delayReports].sort((a, b) => b.createdAt - a.createdAt) });
});

router.get('/:id', (req, res) => {
  const { delayReports } = db.get();
  const report = delayReports.find(r => r.id === req.params.id);
  if (!report) return res.status(404).json({ error: 'Delay report not found.' });
  res.json({ delayReport: report });
});

router.post('/', requirePermission('manageReports'), (req, res) => {
  photoUpload(req, res, async (uploadErr) => {
    if (uploadErr) return res.status(400).json({ error: uploadErr.message || 'Photo upload failed.' });
    try {
      const state = db.get();
      const body = req.body || {};

      const jo = state.jobOrders.find(j => j.id === body.jobOrderId);
      if (!jo) return res.status(400).json({ error: 'Select a valid Job Order.' });

      let delayItems;
      try {
        delayItems = typeof body.delayItems === 'string' ? JSON.parse(body.delayItems) : (body.delayItems || []);
      } catch {
        return res.status(400).json({ error: 'Invalid delay items data.' });
      }
      if (!delayItems.length) return res.status(400).json({ error: 'Add at least one delay item.' });

      const { site: sitePhotos, drawing: drawingPhotos } = photosByRowIndex(req.files);

      const items = delayItems.map((item, i) => ({
        id: db.uuid(),
        srNo: i + 1,
        floor: item.floor || '',
        areaZone: item.areaZone || '',
        description: item.description || '',
        reasonOfDelay: item.reasonOfDelay || '',
        actionBy: item.actionBy || '',
        actionNote: item.actionNote || '',
        status: item.status || 'Open',
        remarks: item.remarks || '',
        targetDate: item.targetDate || '',
        sitePhotoUrl: sitePhotos[i] ? `/uploads/delay-reports/${sitePhotos[i].filename}` : null,
        drawingPhotoUrl: drawingPhotos[i] ? `/uploads/delay-reports/${drawingPhotos[i].filename}` : null,
      }));

      // Signatures pull directly from the Job Order's site team — never hardcoded,
      // so a job with no site team set yet just shows blank rather than someone else's name.
      const signatures = {
        afSide: [
          ...(isTrue(body.includeReportedBySignature) ? [{ name: body.reportedBy || req.user.name, role: 'Reported By' }] : []),
          ...(isTrue(body.includeProjectsInchargeSignature) ? [{ name: jo.projectsIncharge || '', role: 'Projects Incharge' }] : []),
        ],
        clientSide: [
          ...(isTrue(body.includeSiteEngineerSignature) ? [{ name: jo.siteEngineer || '', role: 'Site Engineer' }] : []),
          ...(isTrue(body.includeProjectManagerSignature) ? [{ name: jo.projectManager || '', role: 'Project Manager' }] : []),
        ],
      };

      const report = {
        id: db.uuid(),
        refNumber: nextSdrNumber(state, jo.jobOrderNumber),
        jobOrderId: jo.id, jobOrderNumber: jo.jobOrderNumber,
        projectName: jo.subject || '', location: jo.siteDetail || '', clientCompany: jo.clientCompany || '',
        projectManager: jo.projectManager || '', siteEngineer: jo.siteEngineer || '',
        siteSupervisor: jo.siteSupervisor || '', projectsIncharge: jo.projectsIncharge || '',
        date: body.date || new Date().toISOString().slice(0, 10),
        reportedBy: body.reportedBy || req.user.name, reportedById: req.user.id,
        delayItems: items,
        signatures,
        status: 'Submitted',
        createdAt: Date.now(), updatedAt: Date.now(),
      };

      state.delayReports.push(report);
      await db.persist();
      res.status(201).json({ delayReport: report });
    } catch (err) {
      console.error('POST /delay-reports error:', err);
      res.status(500).json({ error: 'Could not save delay report.' });
    }
  });
});

router.put('/:id', requirePermission('manageReports'), (req, res) => {
  photoUpload(req, res, async (uploadErr) => {
    if (uploadErr) return res.status(400).json({ error: uploadErr.message || 'Photo upload failed.' });
    try {
      const state = db.get();
      const report = state.delayReports.find(r => r.id === req.params.id);
      if (!report) return res.status(404).json({ error: 'Delay report not found.' });

      const body = req.body || {};
      let delayItems;
      try {
        delayItems = typeof body.delayItems === 'string' ? JSON.parse(body.delayItems) : (body.delayItems || report.delayItems);
      } catch {
        delayItems = report.delayItems;
      }

      const { site: sitePhotos, drawing: drawingPhotos } = photosByRowIndex(req.files);

      report.date = body.date || report.date;
      report.reportedBy = body.reportedBy || report.reportedBy;
      report.delayItems = delayItems.map((item, i) => ({
        ...item,
        id: item.id || db.uuid(),
        srNo: i + 1,
        sitePhotoUrl: sitePhotos[i] ? `/uploads/delay-reports/${sitePhotos[i].filename}` : (item.sitePhotoUrl || null),
        drawingPhotoUrl: drawingPhotos[i] ? `/uploads/delay-reports/${drawingPhotos[i].filename}` : (item.drawingPhotoUrl || null),
      }));
      report.updatedAt = Date.now();

      await db.persist();
      res.json({ delayReport: report });
    } catch (err) {
      console.error('PUT /delay-reports/:id error:', err);
      res.status(500).json({ error: 'Could not update delay report.' });
    }
  });
});

router.delete('/:id', requirePermission('manageReports'), async (req, res) => {
  const state = db.get();
  const before = state.delayReports.length;
  state.delayReports = state.delayReports.filter(r => r.id !== req.params.id);
  if (state.delayReports.length === before) return res.status(404).json({ error: 'Delay report not found.' });
  await db.persist();
  res.json({ ok: true });
});

module.exports = router;
