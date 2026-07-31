const express = require('express');
const path    = require('path');
const fs      = require('fs');
const db      = require('../lib/db');
const { requireAuth, requirePermission } = require('../lib/auth');

const router = express.Router();
router.use(requireAuth);

// ── Multer for LPO + Quote document uploads ───────────────────────
let docUpload;
try {
  const multer    = require('multer');
  const uploadDir = path.join(db.UPLOADS_DIR, 'job-orders');
  if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

  const storage = multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, uploadDir),
    filename:    (_req, file,  cb) => {
      const uid = Date.now() + '-' + Math.round(Math.random() * 1e6);
      cb(null, uid + path.extname(file.originalname).toLowerCase());
    },
  });

  docUpload = multer({
    storage,
    limits:     { fileSize: 20 * 1024 * 1024 }, // 20 MB per file
    fileFilter: (_req, file, cb) => {
      const ok = /\.(pdf|jpg|jpeg|png|doc|docx|xls|xlsx)$/i.test(file.originalname);
      cb(null, ok);
    },
  }).fields([
    { name: 'lpoFile',   maxCount: 1 },
    { name: 'quoteFile', maxCount: 1 },
  ]);
} catch {
  docUpload = (_req, _res, next) => next();
}

function nextJobOrderNumber(state) {
  state.jobOrderCounter += 1;
  const yy = new Date().getFullYear();
  return `JO-${yy}-${String(state.jobOrderCounter).padStart(4, '0')}`;
}

// ── GET all ───────────────────────────────────────────────────────
router.get('/', (req, res) => {
  const { jobOrders } = db.get();
  res.json({ jobOrders: [...jobOrders].sort((a, b) => b.createdAt - a.createdAt) });
});

// ── GET one ───────────────────────────────────────────────────────
router.get('/:id', (req, res) => {
  const { jobOrders } = db.get();
  const jo = jobOrders.find(j => j.id === req.params.id);
  if (!jo) return res.status(404).json({ error: 'Job Order not found.' });
  res.json({ jobOrder: jo });
});

// ── POST create ───────────────────────────────────────────────────
router.post('/', requirePermission('manageReports'), docUpload, async (req, res) => {
  const state = db.get();
  const body  = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});

  if (!body.clientCompany || !body.clientCompany.trim()) {
    return res.status(400).json({ error: 'Client company name is required.' });
  }
  const customNumber = (body.jobOrderNumber || '').trim();
  if (customNumber && state.jobOrders.some(j => j.jobOrderNumber === customNumber)) {
    return res.status(400).json({ error: `Job Order number "${customNumber}" is already in use.` });
  }

  // Link to quotation if selected
  let linkedQuotation = null;
  if (body.quotationId) {
    linkedQuotation = (state.quotations || []).find(q => q.id === body.quotationId);
  }

  const lpoFile   = req.files?.lpoFile?.[0];
  const quoteFile = req.files?.quoteFile?.[0];

  const jo = {
    id:             db.uuid(),
    jobOrderNumber: customNumber || nextJobOrderNumber(state),
    // Quotation link
    quotationId:     linkedQuotation ? linkedQuotation.id : null,
    quotationNumber: linkedQuotation ? linkedQuotation.quotationNumber : (body.quotationNumber || null),
    type:            body.type || 'SUP',
    clientId:        body.clientId      || (linkedQuotation?.clientId)      || null,
    clientCompany:   body.clientCompany.trim(),
    subject:         body.subject       || (linkedQuotation?.subject)       || '',
    siteDetail:      body.siteDetail    || (linkedQuotation?.siteDetail)    || '',
    location:        body.location      || '',
    sitesCovered:    [],
    // Site team — set separately via /site-team
    siteEngineer:     body.siteEngineer     || '',
    projectManager:   body.projectManager   || '',
    siteSupervisor:   body.siteSupervisor   || '',
    projectsIncharge: body.projectsIncharge || '',
    preparedBy:       body.preparedBy       || '',
    value:  Number(body.value || linkedQuotation?.totals?.total || 0),
    status: body.status || 'Open',
    // Document uploads
    lpoFileUrl:   lpoFile   ? `/uploads/job-orders/${lpoFile.filename}`   : null,
    lpoFileName:  lpoFile   ? lpoFile.originalname                        : null,
    quoteFileUrl: quoteFile ? `/uploads/job-orders/${quoteFile.filename}` : null,
    quoteFileName: quoteFile ? quoteFile.originalname                     : null,
    createdById:  req.user.id,
    createdByName: req.user.name,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };

  // Mark quotation as linked if one was selected manually
  if (linkedQuotation && !linkedQuotation.jobOrderId) {
    linkedQuotation.jobOrderId = jo.id;
  }

  state.jobOrders.push(jo);
  await db.persist();
  res.status(201).json({ jobOrder: jo });
});

// ── PUT update core fields ────────────────────────────────────────
router.put('/:id', requirePermission('manageReports'), docUpload, async (req, res) => {
  const state = db.get();
  const jo    = state.jobOrders.find(j => j.id === req.params.id);
  if (!jo) return res.status(404).json({ error: 'Job Order not found.' });

  const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});

  if ('clientCompany' in body && !body.clientCompany.trim()) {
    return res.status(400).json({ error: 'Client company name is required.' });
  }
  if ('jobOrderNumber' in body) {
    const newNum = body.jobOrderNumber.trim();
    if (newNum && newNum !== jo.jobOrderNumber && state.jobOrders.some(j => j.jobOrderNumber === newNum)) {
      return res.status(400).json({ error: `Job Order number "${newNum}" is already in use.` });
    }
    if (newNum) jo.jobOrderNumber = newNum;
  }

  for (const f of ['clientId','clientCompany','subject','siteDetail','location','type','status','quotationNumber']) {
    if (f in body) jo[f] = body[f];
  }
  if ('value' in body) jo.value = Number(body.value || 0);

  // Handle document uploads (replace if new file provided)
  const lpoFile   = req.files?.lpoFile?.[0];
  const quoteFile = req.files?.quoteFile?.[0];
  if (lpoFile)   { jo.lpoFileUrl   = `/uploads/job-orders/${lpoFile.filename}`;   jo.lpoFileName   = lpoFile.originalname; }
  if (quoteFile) { jo.quoteFileUrl = `/uploads/job-orders/${quoteFile.filename}`; jo.quoteFileName = quoteFile.originalname; }

  jo.updatedAt = Date.now();
  await db.persist();
  res.json({ jobOrder: jo });
});

// ── PUT site team ─────────────────────────────────────────────────
router.put('/:id/site-team', requirePermission('manageReports'), async (req, res) => {
  const state = db.get();
  const jo    = state.jobOrders.find(j => j.id === req.params.id);
  if (!jo) return res.status(404).json({ error: 'Job Order not found.' });
  const body = req.body || {};
  for (const f of ['siteEngineer','projectManager','siteSupervisor','projectsIncharge','preparedBy']) {
    if (f in body) jo[f] = String(body[f] || '').trim();
  }
  jo.updatedAt = Date.now();
  await db.persist();
  res.json({ jobOrder: jo });
});

module.exports = router;
