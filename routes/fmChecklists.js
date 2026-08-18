const express = require('express');
const db      = require('../lib/db');
const { requireAuth, requirePermission } = require('../lib/auth');

const router = express.Router();
router.use(requireAuth);

// ── Built-in checklist templates (from Al Fitr FM documents) ─────
const BUILT_IN_TEMPLATES = [
  {
    id: 'tpl-fire-fight',
    name: 'Fire Fight System Check List',
    category: 'Fire & Safety',
    items: [
      { id: 1, description: 'Fire Alarm Panel – Check and Report any faults', frequency: 'Daily' },
      { id: 2, description: 'Fire Alarm Repeater – Check and Report any faults', frequency: 'Daily' },
      { id: 3, description: 'Voice Evacuation Panel – Check and Report any faults', frequency: 'Daily' },
      { id: 4, description: 'Emergency Light Control Panel – Check and report any faults', frequency: 'Daily' },
      { id: 5, description: 'FM 200 Panel – Check and report any faults', frequency: 'Daily' },
      { id: 6, description: 'FF – Check all control panels are in AUTO mode', frequency: 'Daily' },
      { id: 7, description: 'FF – Check the status of Battery', frequency: 'Daily' },
      { id: 8, description: 'FF – Check Water Tank level', frequency: 'Daily' },
      { id: 9, description: 'FF – Check Fuel level', frequency: 'Daily' },
      { id: 10, description: 'FF – Check for any leaks', frequency: 'Daily' },
      { id: 11, description: 'FF – Check room is Neat & Tidy', frequency: 'Daily' },
    ],
  },
  {
    id: 'tpl-generator',
    name: 'Generator Room Check List',
    category: 'Mechanical',
    items: [
      { id: 1, description: 'Maintain the generator set daily', frequency: 'Daily' },
      { id: 2, description: 'Lubrication system: check oil leakage and oil level', frequency: 'Daily' },
      { id: 3, description: 'Check coolant leakage for cooling system', frequency: 'Daily' },
      { id: 4, description: 'Check fuel level', frequency: 'Daily' },
      { id: 5, description: 'Report any defects found and record the details in the logbook', frequency: 'Daily' },
    ],
  },
  {
    id: 'tpl-electrical',
    name: 'Electrical Room Check List',
    category: 'Electrical',
    items: [
      { id: 1, description: 'Checking and record the actual room temperature', frequency: 'Daily' },
      { id: 2, description: 'Check for the lights in the room and replace fused one if necessary', frequency: 'Daily' },
      { id: 3, description: 'Check if any water leakage from ceiling or anywhere else in the room', frequency: 'Daily' },
      { id: 4, description: 'Check if there any trip in the DB/SMDB/MDB/CONTROL PANEL/capacitor bank (Burning Smell)', frequency: 'Daily' },
      { id: 5, description: 'Checking the LV PANEL P-N and P-P readings', frequency: 'Daily' },
      { id: 6, description: 'Check the capacitor bank reading', frequency: 'Daily' },
      { id: 7, description: 'Check for the abnormal noise from the equipment', frequency: 'Daily' },
      { id: 8, description: 'Water Meter Reading', frequency: 'Daily' },
      { id: 9, description: 'Electrical Meter Reading', frequency: 'Daily' },
    ],
  },
  {
    id: 'tpl-pump-room',
    name: 'Pump Room Check List',
    category: 'Mechanical',
    items: [
      { id: 1, description: 'Check for the abnormal noise from the equipment', frequency: 'Daily' },
      { id: 2, description: 'Check any water leakage in the room', frequency: 'Daily' },
      { id: 3, description: 'Check the pump control panel selector switch for AUTO/Manual/OFF', frequency: 'Daily' },
      { id: 4, description: 'Check the sequence of pump operation', frequency: 'Daily' },
      { id: 5, description: 'Check the pressure gauge and reading', frequency: 'Daily' },
      { id: 6, description: 'Check pump for water leaks', frequency: 'Daily' },
      { id: 7, description: 'Check water tank level', frequency: 'Daily' },
    ],
  },
  {
    id: 'tpl-chill-water',
    name: 'Chill Water Pump Room Check List',
    category: 'HVAC',
    items: [
      { id: 1, description: 'Check all AC control panel/VFD for any abnormality', frequency: 'Daily' },
      { id: 2, description: 'Check for the abnormal noise from the equipments', frequency: 'Daily' },
      { id: 3, description: 'Check for the lights and replace fused lamp', frequency: 'Daily' },
      { id: 4, description: 'Check for all pipe insulation and cladding are intact', frequency: 'Daily' },
      { id: 5, description: 'Check for water leakage', frequency: 'Daily' },
      { id: 7, description: 'Check Dosing pump operation status', frequency: 'Daily' },
      { id: 8, description: 'Check Chemical level in Tanks', frequency: 'Daily' },
      { id: 9, description: 'Check Make up pump operation Auto/manual/OFF', frequency: 'Daily' },
      { id: 10, description: 'Check room is Neat & Tidy', frequency: 'Daily' },
    ],
  },
  {
    id: 'tpl-chiller',
    name: 'Daily Chiller Checklist',
    category: 'HVAC',
    items: [
      { id: 1, description: 'General check for abnormality, noise & vibration (Chiller No. 1)', frequency: 'Daily' },
      { id: 2, description: 'Leaving water temperature set point °C (Chiller No. 1)', frequency: 'Daily' },
      { id: 3, description: 'Entering Chilled Water Temperature °C (Chiller No. 1)', frequency: 'Daily' },
      { id: 4, description: 'Leaving Chilled Water Temperature °C (Chiller No. 1)', frequency: 'Daily' },
      { id: 5, description: 'Compressor running hours (Chiller No. 1)', frequency: 'Daily' },
      { id: 6, description: 'Check condenser condition & dust (Chiller No. 1)', frequency: 'Daily' },
      { id: 7, description: 'Check the oil leak (Chiller No. 1)', frequency: 'Daily' },
    ],
  },
  {
    id: 'tpl-idf-mdf',
    name: 'IDF/MDF & IT Room Check List',
    category: 'IT/ELV',
    items: [
      { id: 1, description: 'Check and log the room temperature reading (°C)', frequency: 'Daily' },
      { id: 2, description: 'Check for the lights in the room and replace fused one if necessary', frequency: 'Daily' },
      { id: 3, description: 'Check the UPS operation', frequency: 'Daily' },
      { id: 4, description: 'Check if any water leakage from ceiling or anywhere else in the room', frequency: 'Daily' },
      { id: 5, description: 'Check for the abnormal noise from the equipment', frequency: 'Daily' },
      { id: 6, description: 'Check and ensure that server room is clean from all kind of debris', frequency: 'Daily' },
      { id: 7, description: 'Check the CCU system operation (if applicable)', frequency: 'Daily' },
    ],
  },
  {
    id: 'tpl-swimming-pool',
    name: 'Swimming Pool Check List',
    category: 'Civil/Other',
    items: [
      { id: 1, description: 'Visually examine equipment for correct operation', frequency: 'Daily' },
      { id: 2, description: 'Visually check all pipework connections (if leaks found)', frequency: 'Daily' },
      { id: 3, description: 'Visually check for light in operation', frequency: 'Daily' },
      { id: 4, description: 'Visually check for Neat & Tidy', frequency: 'Daily' },
    ],
  },
  {
    id: 'tpl-control-room',
    name: 'Control Room Check List',
    category: 'Fire & Safety',
    items: [
      { id: 1, description: 'Check integrity of data communications between central operator station and all networked outstations', frequency: 'Daily' },
      { id: 2, description: 'Perform testing to ensure the remote connection is still valid', frequency: 'Daily' },
      { id: 4, description: 'Check that any alarms received are being routed correctly', frequency: 'Daily' },
      { id: 5, description: 'Check spurious alarms', frequency: 'Daily' },
      { id: 6, description: 'Maintain access of monitoring platform of the solar system', frequency: 'Daily' },
    ],
  },
  {
    id: 'tpl-classroom',
    name: 'Class Rooms/Office/Corridor/Kitchen TFM Check List',
    category: 'Civil/Other',
    items: [
      { id: 1, description: 'Lights – Check and report any faults', frequency: 'Daily' },
      { id: 2, description: 'FAS Panel – Check and report any faults', frequency: 'Daily' },
      { id: 3, description: 'AC – Check and report any faults', frequency: 'Daily' },
      { id: 4, description: 'Remarks for any Other issues', frequency: 'Daily' },
    ],
  },
];

// ── GET templates list ─────────────────────────────────────────────
router.get('/templates', (req, res) => {
  const state     = db.get();
  const custom    = state.fmChecklistTemplates || [];
  const all       = [
    ...BUILT_IN_TEMPLATES.map(t => ({ ...t, builtIn: true })),
    ...custom.map(t => ({ ...t, builtIn: false })),
  ];
  res.json({ templates: all });
});

// ── POST custom template ───────────────────────────────────────────
router.post('/templates', requirePermission('manageReports'), async (req, res) => {
  const state = db.get();
  if (!state.fmChecklistTemplates) state.fmChecklistTemplates = [];
  const body = req.body || {};
  if (!body.name || !body.name.trim()) return res.status(400).json({ error: 'Template name is required.' });
  const tpl = {
    id:       'tpl-' + db.uuid().slice(0, 8),
    name:     body.name.trim(),
    category: body.category || 'Other',
    items:    (body.items || []).map((it, i) => ({ id: i + 1, description: it.description || '', frequency: it.frequency || 'Daily' })),
    builtIn:  false,
    createdAt: Date.now(),
  };
  state.fmChecklistTemplates.push(tpl);
  await db.persist();
  res.status(201).json({ template: tpl });
});

// ── GET all checklists ─────────────────────────────────────────────
router.get('/', (req, res) => {
  const { fmChecklists = [] } = db.get();
  res.json({ checklists: [...fmChecklists].sort((a, b) => b.createdAt - a.createdAt) });
});

// ── GET single checklist ───────────────────────────────────────────
router.get('/:id', (req, res) => {
  const { fmChecklists = [] } = db.get();
  const cl = fmChecklists.find(c => c.id === req.params.id);
  if (!cl) return res.status(404).json({ error: 'Checklist not found.' });
  res.json({ checklist: cl });
});

// ── POST create checklist ──────────────────────────────────────────
router.post('/', requirePermission('manageReports'), async (req, res) => {
  const state = db.get();
  const body  = req.body || {};

  const jo = (state.jobOrders || []).find(j => j.id === body.jobOrderId);
  if (!jo) return res.status(400).json({ error: 'Select a valid Job Order.' });

  // Find template (built-in or custom)
  const allTpls = [
    ...BUILT_IN_TEMPLATES,
    ...(state.fmChecklistTemplates || []),
  ];
  const tpl = allTpls.find(t => t.id === body.templateId);
  if (!tpl) return res.status(400).json({ error: 'Select a valid checklist template.' });

  // Build item responses
  const items = (tpl.items || []).map(it => ({
    id:          it.id,
    description: it.description,
    frequency:   it.frequency || 'Daily',
    status:      null, // null = not yet filled | 'ok' | 'fail' | 'na'
    remarks:     '',
  }));

  // Auto ref number
  if (!state.fmChecklistCounter) state.fmChecklistCounter = 0;
  state.fmChecklistCounter += 1;
  const refNumber = `AF/FM/CL/${String(state.fmChecklistCounter).padStart(4, '0')}/${new Date().getFullYear().toString().slice(-2)}`;

  const cl = {
    id:               db.uuid(),
    refNumber,
    templateId:       tpl.id,
    templateName:     tpl.name,
    category:         tpl.category,
    jobOrderId:       jo.id,
    jobOrderNumber:   jo.jobOrderNumber,
    clientCompany:    jo.clientCompany,
    projectName:      jo.subject || jo.name || '',
    location:         body.location    || jo.location || '',
    building:         body.building    || '',
    floor:            body.floor       || '',
    month:            body.month       || new Date().toISOString().slice(0, 7),
    technicianName:   body.technicianName || req.user.name,
    supervisorName:   body.supervisorName || '',
    items,
    abnormalities:    [], // { date, abnormality, actionTaken, status, doneBy }
    status:           'Draft',
    submittedAt:      null,
    createdById:      req.user.id,
    createdByName:    req.user.name,
    createdAt:        Date.now(),
    updatedAt:        Date.now(),
  };

  if (!state.fmChecklists) state.fmChecklists = [];
  state.fmChecklists.push(cl);
  await db.persist();
  res.status(201).json({ checklist: cl });
});

// ── PUT update checklist (fill responses) ─────────────────────────
router.put('/:id', requirePermission('manageReports'), async (req, res) => {
  const state = db.get();
  const cl    = (state.fmChecklists || []).find(c => c.id === req.params.id);
  if (!cl) return res.status(404).json({ error: 'Checklist not found.' });

  const body = req.body || {};

  // Update item responses
  if (Array.isArray(body.items)) {
    body.items.forEach(upd => {
      const item = cl.items.find(i => i.id === upd.id);
      if (item) {
        if (upd.status  !== undefined) item.status  = upd.status;
        if (upd.remarks !== undefined) item.remarks = upd.remarks;
      }
    });
  }

  // Update abnormalities
  if (Array.isArray(body.abnormalities)) cl.abnormalities = body.abnormalities;

  // Update header fields
  for (const f of ['location','building','floor','technicianName','supervisorName']) {
    if (f in body) cl[f] = body[f];
  }

  // Submit
  if (body.submit === true) {
    cl.status      = 'Submitted';
    cl.submittedAt = Date.now();
  }

  cl.updatedAt = Date.now();
  await db.persist();
  res.json({ checklist: cl });
});

// ── DELETE ─────────────────────────────────────────────────────────
router.delete('/:id', requirePermission('manageReports'), async (req, res) => {
  const state  = db.get();
  const before = (state.fmChecklists || []).length;
  state.fmChecklists = (state.fmChecklists || []).filter(c => c.id !== req.params.id);
  if (state.fmChecklists.length === before) return res.status(404).json({ error: 'Checklist not found.' });
  await db.persist();
  res.json({ ok: true });
});

module.exports = router;
