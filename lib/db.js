const fs = require('fs');
const path = require('path');
const { v4: uuid } = require('uuid');
const bcrypt = require('bcryptjs');
const { DEFAULT_PERMS } = require('./permissions');

// On most hosts, the app's code directory is rebuilt fresh on every deploy — so data must
// live on a separate, persistent volume. Set DATA_DIR in your environment to point at that
// volume's mount path (e.g. Render persistent disks: DATA_DIR=/var/data). If unset, defaults
// to a local "data" folder next to this file, which is correct for local/dev use.
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

const SEED_ITEMS = [
  ['Bosch','FAP-425-O','Addressable Smoke Detectors','D. Office','Pcs',20,85,125,95],
  ['Bosch','FAH-425-T','Addressable Heat Detectors','D. Office','Pcs',10,85,125,2],
  ['Bosch','FAH-425-OT','Addressable Multisensor Detectors','D. Office','Pcs',2,85,125,2],
  ['Bosch','FMC-420-RW-GSRRD','Manual Call Point','D. Office','Pcs',5,125,250,6],
  ['Bosch','FLM-420-I2-W','Input Interface Module Wall Mount','D. Office','Pcs',10,100,220,19],
  ['Bosch','FLM-420-RLV-8S','Octo Relay Interface Module Low Voltage','D. Office','Pcs',5,100,250,4],
  ['Bosch','FLM-420-NAC-S','Interface Module Notific App Surface','D. Office','Pcs',10,100,350,5],
  ['Bosch','FLM-420-RLV1-E','Relay Interface Module Low Voltage in-Built','D. Office','Pcs',10,120,365,0],
  ['Bosch','FLM-420-I8R1-S','Octo Relay Interface Module with Relay','D. Office','Pcs',5,100,250,3],
  ['Bosch','FNM-420-A-RD','Indoor Sounder','D. Office','Pcs',5,125,220,0],
  ['Bosch','FNM-420-B-RD','Outdoor Sounder','D. Office','Pcs',5,125,280,3],
  ['Bosch','FNS-420-R','Flasher','D. Office','Pcs',5,134,180,13],
  ['Bosch','FNM-420-A-BS-WH','Sounder Base','D. Office','Pcs',10,130,380,4],
  ['Bosch','FNM-420-A-BS-RD','Sounder Base','D. Office','Pcs',10,130,180,1],
  ['Bosch','ASWP-2475W-FR','HRN/STRB','D. Office','Pcs',5,180,250,3],
  ['Bosch','LSN-0300','Loop Card','D. Office','Pcs',3,350,750,3],
  ['Eaton','WPBB-R','Back Box','D. Office','Pcs',4,160,195,3],
  ['GST','DI-9102E','Addressable Smoke Detectors','D. Office','Pcs',100,51,70,50],
  ['GST','DI-9103E','Addressable Heat Detectors','D. Office','Pcs',0,51,70,28],
  ['GST','DB-01','Base','D. Office','Pcs',20,0,0,78],
  ['Shield','A-4011E + SA50001','Addressable Smoke Detectors with Base','D. Office','Pcs',10,130,200,20],
  ['Shield','S-A5042','Dual Switch Monitor Module','D. Office','Pcs',10,275,320,6],
  ['Mircom','MIX-2351AP','Addressable Smoke Detector with Base','D. Office','Pcs',10,91,205,30],
  ['Mircom','MIX-5251RB','Addressable Heat Detector with Base','D. Office','Pcs',10,91,205,10],
  ['Mircom','MIX-M 500M','Addressable Monitor Module','D. Office','Pcs',5,135,350,2],
  ['Mircom','MIX-M 500S','Addressable Control Module','D. Office','Pcs',5,142,350,2],
  ['Esser','802371','Addressable Smoke Detector with Base','D. Office','Pcs',2,101,145,15],
  ['Esser','802271','Addressable Heat Detector with Base','D. Office','Pcs',5,101,145,5],
  ['Esser','808623','Transponder','D. Office','Pcs',10,313,370,15],
  ['Apollo Discovery','58000-600','Addressable Smoke Detectors','D. Office','Pcs',5,63,100,10],
  ['Apollo Discovery','58000-700','Addressable Heat Detectors with Base','D. Office','Pcs',2,63,100,5],
  ['Ravel','','Addressable Smoke Detectors with Base','D. Office','Pcs',5,48,100,10],
  ['Simplex','4098-9792 + 4098-9714','Addressable Smoke Detectors with Base','D. Office','Pcs',5,82,130,15],
];

const DEFAULT_EXCLUSIONS = [
  'All kind of Panel Programming, Testing, Commissioning & any kind of field rectification.',
  'Our scope of work is limited as per the quoted items only, any additional work will be considered as variation and separate quote will be submitted.',
  'All the material will be supplied by the client.',
  'All kind of containment/conduit work.',
  'All kind of height arrangements, scaffolding, manlift, boom lift will be provided by the client.',
  'All kind of civil & electrical works.',
  'The client will be responsible to arrange the site access and gate pass for our team, if required.',
  'Normal working hours will be considered at site as per the UAE Labor law.',
  'Supply of any kind of material.',
  'Power supply for the machineries used for installation.',
  'Our scope is limited to the installation only, all kind of material & consumable will be provided by the client.',
  'Any kind of drawing preparation and authority charges.',
  'Any kind of re-work/change in the pipe routes or change in design & any additional work apart from the above scope of work will be considered as variation.',
  'Supply, warranty & installation certificate is not in our scope of work.',
];

function seedDb() {
  const now = Date.now();
  const items = SEED_ITEMS.map(([brand,partNo,description,location,unit,minLevel,cost,price,openingQty]) => ({
    id: uuid(), brand, partNo, description, location, unit,
    minLevel: Number(minLevel), cost: Number(cost), price: Number(price), openingQty: Number(openingQty),
    createdAt: now,
  }));

  const superAdminId = uuid();
  const defaultPasswordHash = bcrypt.hashSync('admin123', 10);

  return {
    meta: { schemaVersion: 4 },
    company: {
      name: 'AL FITR ELECTROMECHANICAL WORKS LLC', address: 'Sharjah, UAE', phone: '', email: '',
      website: '', vatNumber: '', logoPath: null, currency: 'AED', dnPrefix: 'DN-', dnPadding: 6,
      reportFooter: '', paperSize: 'A4', logoSize: 'medium',
      quotationApprovers: [], // user IDs allowed to approve quotations before send
    },
    branches: ['D. Office', 'Store A', 'Store B', 'Store C', 'Site'],
    brands: ['Bosch','Eaton','GST','Shield','Mircom','Esser','Apollo Discovery','Ravel','Simplex','Other'],
    units: ['Pcs','Nos','Set','Box','Roll','Mtr','Ltr','Kg','Other'],
    quotationCategories: ['Fire Alarm System', 'PAVA System', 'Emergency Lighting System (CBS)', 'Fire Fighting System', 'Sprinkler System', 'MEP Services', 'General'],
    roles: JSON.parse(JSON.stringify(DEFAULT_PERMS)),
    users: [
      { id: superAdminId, name: 'Super Admin', username: 'admin', passwordHash: defaultPasswordHash, role: 'Super Admin', designation: 'General Manager', active: true, mustChangePassword: true, createdAt: now },
    ],
    items,
    movements: [],
    clients: [
      { id: uuid(), companyName: 'Edge Technical Solutions LLC', contactPerson: '', phone: '', email: '', address: '', createdAt: now },
      { id: uuid(), companyName: 'Binghatti West / Highrise OAM', contactPerson: '', phone: '', email: '', address: '', createdAt: now },
      { id: uuid(), companyName: 'AZZURRO FM', contactPerson: '', phone: '', email: '', address: '', createdAt: now },
    ],
    dns: [],
    dnCounter: 0,
    quotations: [],
    quotationCounter: 20410, // continues Al Fitr's real existing reference sequence — adjust in Settings if needed
    jobOrders: [],
    jobOrderCounter: 0,
    exclusions: DEFAULT_EXCLUSIONS.map(text => ({ id: uuid(), text, category: 'General', createdAt: now })),
  };
}

// Backfills fields added after a database was first created, without ever touching
// existing real data. Every new field here must be additive and safe to run repeatedly.
function migrate(state) {
  let changed = false;
  const ensure = (obj, key, value) => { if (!(key in obj) || obj[key] === undefined) { obj[key] = value; changed = true; } };

  ensure(state, 'quotations', []);
  ensure(state, 'quotationCounter', 20410);
  ensure(state, 'jobOrders', []);
  ensure(state, 'jobOrderCounter', 0);
  ensure(state, 'quotationCategories', ['Fire Alarm System', 'PAVA System', 'Emergency Lighting System (CBS)', 'Fire Fighting System', 'Sprinkler System', 'MEP Services', 'General']);
  ensure(state, 'exclusions', DEFAULT_EXCLUSIONS.map(text => ({ id: uuid(), text, category: 'General', createdAt: Date.now() })));
  if (state.company) ensure(state.company, 'quotationApprovers', []);
  if (Array.isArray(state.users)) {
    for (const u of state.users) {
      if (!('designation' in u)) { u.designation = ''; changed = true; }
    }
  }
  if (state.roles) {
    for (const role of Object.keys(state.roles)) {
      if (!('manageQuotations' in state.roles[role])) {
        state.roles[role].manageQuotations = (role === 'Super Admin' || role === 'Admin');
        changed = true;
      }
      if (!('manageMovements' in state.roles[role])) {
        state.roles[role].manageMovements = (role === 'Super Admin');
        changed = true;
      }
    }
  }
  if (!state.meta) { state.meta = { schemaVersion: 2 }; changed = true; }
  else if (state.meta.schemaVersion < 4) { state.meta.schemaVersion = 4; changed = true; }

  return changed;
}

let dbCache = null;
let writeQueue = Promise.resolve();

function load() {
  if (dbCache) return dbCache;
  if (!fs.existsSync(DB_FILE)) {
    dbCache = seedDb();
    fs.writeFileSync(DB_FILE, JSON.stringify(dbCache, null, 2));
  } else {
    dbCache = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    if (migrate(dbCache)) {
      fs.writeFileSync(DB_FILE, JSON.stringify(dbCache, null, 2));
    }
  }
  return dbCache;
}

// Serializes all writes so concurrent requests never corrupt the file.
function persist() {
  writeQueue = writeQueue.then(() => new Promise((resolve, reject) => {
    const tmp = DB_FILE + '.tmp';
    fs.writeFile(tmp, JSON.stringify(dbCache, null, 2), (err) => {
      if (err) return reject(err);
      fs.rename(tmp, DB_FILE, (err2) => err2 ? reject(err2) : resolve());
    });
  }));
  return writeQueue;
}

function get() {
  return load();
}

module.exports = { get, persist, uuid, DATA_DIR, UPLOADS_DIR };
