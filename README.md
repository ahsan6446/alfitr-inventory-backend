# Al Fitr Inventory & Delivery — Backend (Real Server, Real Security)

This is the **real backend version** of the Al Fitr Inventory & Delivery system. Unlike the
earlier browser-only version, permissions, pricing visibility, and stock rules are enforced
**on the server** — a Storekeeper account genuinely never receives pricing data over the
network, even if they open browser dev tools, inspect API responses, or download an export.
That claim was verified with an automated test that inspects the raw bytes of exported files
(see "Testing" below).

## What's inside

```
backend/
  server.js          entry point
  lib/                shared logic (auth, permissions, calculations, data store)
  routes/              one file per API resource
  public/              the frontend (plain HTML/CSS/JS, no build step)
  data/                JSON database + uploaded logos (created on first run)
  .env.example         copy to .env and fill in
```

## Quick start (local)

```bash
cd backend
npm install
cp .env.example .env
# open .env and set JWT_SECRET to a long random value, e.g.:
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
npm start
```

Open **http://localhost:4000**. First login:

- **Username:** `admin`
- **Password:** `admin123`

You'll be forced to set a new password immediately on first login — this is intentional.

## How data is stored

All data (items, movements, delivery notes, clients, users, roles, company settings) lives in
a single file: `data/db.json`. Uploaded logos are saved as real image files in
`data/uploads/`. This is deliberately dependency-free (no database server to install or
maintain) and is a good fit for a single company / a handful of branches. **Back up
`data/db.json` and `data/uploads/` regularly** — e.g. a nightly copy to cloud storage. If you
outgrow this (very high transaction volume, need for concurrent multi-region writes), the data
layer is isolated in `lib/db.js`, so swapping it for Postgres/MySQL later is a contained
change, not a rewrite.

## Security model — what's actually enforced

- **Real authentication.** Username + password (bcrypt-hashed, never stored in plain text),
  JSON Web Tokens for sessions, 12-hour expiry.
- **Server-side permission checks.** Every API route that changes data checks the caller's
  role against the live permissions table before doing anything — not just the UI.
- **Pricing is stripped at the source.** For roles without `viewPricing`, the `cost`, `price`,
  `stockValue`, and `margin` fields are deleted from the object *before* it's ever serialized
  to JSON, written into an Excel file, or drawn into a PDF. There's no hidden column, no
  client-side filter to bypass — the bytes simply don't contain the data.
- **Negative-stock protection.** Roles without `allowNegativeStock` (Storekeeper, Engineer,
  Viewer by default) are blocked server-side from creating a movement or issuing a Delivery
  Note that would take an item below zero.
- **Super Admin cannot be locked out.** The last active Super Admin can't be deleted,
  deactivated, or demoted by mistake.

### What this does *not* include (be aware)

- **Rate limiting / brute-force login protection** — add a reverse-proxy rule or a package
  like `express-rate-limit` before exposing this to the public internet.
- **HTTPS** — this app itself speaks plain HTTP. Put it behind a reverse proxy (nginx, Caddy,
  or your hosting platform's built-in TLS) so passwords and tokens aren't sent in the clear.
- **Automated backups** — see "How data is stored" above.
- **Multi-region / high-availability** — the JSON file store assumes a single running server
  process. Fine for one company's internal tool; not meant for massive concurrent scale.

## Deploying

Any Node.js host works. Three common options:

### Option A — Render / Railway (simplest)
1. Push this `backend/` folder to a GitHub repo.
2. Create a new Web Service, point it at the repo.
3. Build command: `npm install`. Start command: `npm start`.
4. Set the `JWT_SECRET` and `CORS_ORIGIN` environment variables in the host's dashboard.
5. **Important:** on most of these platforms the filesystem is *not* persistent across
   deploys/restarts by default — add a persistent disk/volume and point it at `data/`, or
   your inventory will reset. Both Render and Railway support this ("persistent disks" /
   "volumes") for a small monthly fee.

### Option B — Your own VPS (DigitalOcean, AWS Lightsail, etc.)
```bash
git clone <your-repo> && cd backend
npm install --production
cp .env.example .env   # fill in JWT_SECRET
npm install -g pm2
pm2 start server.js --name alfitr-inventory
pm2 save && pm2 startup   # keeps it running after reboot
```
Put nginx or Caddy in front for HTTPS and your domain name.

### Option C — Docker (if you prefer containers)
A minimal Dockerfile:
```dockerfile
FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install --production
COPY . .
VOLUME ["/app/data"]
EXPOSE 4000
CMD ["node", "server.js"]
```
Mount a volume at `/app/data` so your inventory survives container restarts.

## API overview

All endpoints are under `/api` and (except `/api/auth/login`) require
`Authorization: Bearer <token>`.

| Area | Endpoints |
|---|---|
| Auth | `POST /api/auth/login`, `GET /api/auth/me`, `POST /api/auth/change-password` |
| Inventory | `GET/POST /api/items`, `PUT/DELETE /api/items/:id` |
| Stock movements | `GET/POST /api/movements` |
| Delivery notes | `GET/POST /api/dns`, `PUT /api/dns/:id`, `POST /api/dns/:id/issue` |
| Clients | `GET/POST /api/clients`, `PUT/DELETE /api/clients/:id` |
| Users & roles | `GET/POST /api/users`, `PUT/DELETE /api/users/:id`, `GET /api/users/roles/all`, `PUT /api/users/roles/:role` |
| Company / branding | `GET/PUT /api/company`, `POST/DELETE /api/company/logo` |
| Reference lists | `GET/POST/DELETE /api/meta/branches` (same pattern for `/brands`, `/units`) |
| Exports | `GET /api/export/excel`, `GET /api/export/pdf` (both accept `?branch=&status=&search=&pricing=0|1`) |

## Default roles & permissions

| Role | Pricing | Manage Stock | Create DN | Manage Items | Manage Users | Negative Stock |
|---|---|---|---|---|---|---|
| Super Admin | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Admin | ✅ | ✅ | ✅ | ✅ | ❌ | ✅ |
| Storekeeper | ❌ | ✅ | ✅ | ❌ | ❌ | ❌ |
| Engineer | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| Viewer | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |

Super Admin can adjust every permission for every other role from **Settings → Role
Permissions**, except Super Admin itself (always full access, by design, so no one can
accidentally lock everyone out).

## Testing performed

Before delivery this was tested end-to-end with an automated browser (Playwright) against the
actual running server:

- Login, forced password change on first login, logout.
- Company details, logo upload (appears on header, login area, Delivery Notes, and both
  export formats), Delivery Note prefix / currency / paper size / footer settings.
- Creating a Storekeeper user and confirming, **directly from the JSON response and from the
  raw bytes of downloaded Excel/PDF files**, that `cost`/`price`/`stockValue` are completely
  absent — not hidden, absent.
- Negative-stock blocking for restricted roles, and the override working for Admin/Super
  Admin.
- Delivery Note creation with LPO #, Invoice #, client details (from a saved client record),
  issuing it, and confirming stock deducted by the correct amount.
- Filtered Excel/PDF exports (search + status filter) containing exactly the filtered rows.
- Role-permission checkboxes taking effect immediately for other logged-in users.

## Known limitations / honest notes

- This is a from-scratch build, not a migration of a pre-existing "software" (there wasn't
  one to migrate from) — so "preserve existing database" doesn't apply, but your real
  inventory data from the spreadsheet/browser-tool versions was carried over as the seed data
  here, unchanged.
- Very large catalogs (tens of thousands of SKUs) or very high concurrent write volume would
  benefit from swapping the JSON file store for a real database — the code is structured so
  that's a contained change (see `lib/db.js`), not a rewrite.
- No built-in email/SMS notifications, barcode scanning, or multi-currency conversion — none
  of these were requested, but flagging them as not-included in case they matter later.
- `npm audit` currently reports a moderate advisory in a transitive dependency of `exceljs`
  (the `uuid` package it bundles). It's low-risk for how this app uses it, but re-run
  `npm audit` occasionally and update dependencies as fixes become available.
