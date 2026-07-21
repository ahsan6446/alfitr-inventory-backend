const express = require('express');
const path = require('path');
const fs = require('fs');
const PDFDocument = require('pdfkit');
const db = require('../lib/db');
const { requireAuth } = require('../lib/auth');
const { groupLinesByCategory, quotationTotals, lineTotal } = require('../lib/calc');

const router = express.Router();
router.use(requireAuth);

const TEAL = '#00627B';
const NAVY = '#0B2B36';
const ORANGE = '#F9893D';
const GRAY = '#5B6B70';
const LIGHT_GRAY = '#F3F5F6';

function logoAbsPath(state) {
  if (!state.company.logoPath) return null;
  const p = path.join(db.UPLOADS_DIR, path.basename(state.company.logoPath));
  return fs.existsSync(p) ? p : null;
}

const QUOTE_TYPE_LABEL = { PR: 'Project', SUP: 'Supply Only', AMC: 'AMC Contract', FO: 'Fit-Out' };
const HEADER_HEIGHT = 110;   // reserved space at the top of every page
const FOOTER_HEIGHT = 40;    // reserved space at the bottom of every page
const MARGIN_X = 40;

function fmtMoney(n) {
  return Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function fmtDate(d) {
  if (!d) return '—';
  const dt = new Date(d);
  if (isNaN(dt)) return String(d);
  return dt.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}

// Draws the full company header (logo, name, address) plus the quotation title block —
// called once per page, including every automatically-added page, so it genuinely
// repeats rather than only appearing once like the old browser-print approach did.
function drawHeader(doc, co, quote) {
  const pageWidth = doc.page.width;
  const top = 28;
  let textX = MARGIN_X;

  const logoPath = logoAbsPath({ company: co });
  if (logoPath) {
    try { doc.image(logoPath, MARGIN_X, top, { fit: [55, 45] }); textX = MARGIN_X + 65; } catch (e) { /* non-fatal */ }
  }
  doc.fontSize(13).fillColor(TEAL).font('Helvetica-Bold').text(co.name || '', textX, top, { width: 280 });
  doc.fontSize(8).fillColor(GRAY).font('Helvetica')
    .text([co.address, co.phone, co.email].filter(Boolean).join('  ·  '), textX, top + 17, { width: 280 });

  doc.fontSize(15).fillColor(NAVY).font('Helvetica-Bold').text('QUOTATION', pageWidth - MARGIN_X - 220, top, { width: 220, align: 'right' });
  doc.fontSize(9).fillColor(ORANGE).font('Helvetica-Bold')
    .text(quote.quotationNumber || '(not yet sent)', pageWidth - MARGIN_X - 220, top + 19, { width: 220, align: 'right' });
  doc.fontSize(8).fillColor(GRAY).font('Helvetica')
    .text(quote.status === 'PendingApproval' ? 'PENDING APPROVAL' : String(quote.status || '').toUpperCase(),
      pageWidth - MARGIN_X - 220, top + 31, { width: 220, align: 'right' });

  doc.moveTo(MARGIN_X, HEADER_HEIGHT - 10).lineTo(pageWidth - MARGIN_X, HEADER_HEIGHT - 10)
    .strokeColor(TEAL).lineWidth(2).stroke();

  doc.x = MARGIN_X;
  doc.y = HEADER_HEIGHT;
}

// Draws "Page X of Y" (and a light company credit) on every buffered page, run once
// after all content is drawn — the same reliable technique already used for Inventory PDFs.
function drawFooters(doc, co) {
  const range = doc.bufferedPageRange();
  const savedBottom = doc.page.margins.bottom;
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    doc.page.margins.bottom = 0;
    const y = doc.page.height - 30;
    doc.fontSize(7.5).fillColor(GRAY).font('Helvetica')
      .text(co.name || '', MARGIN_X, y, { width: 300, lineBreak: false })
      .text(`Page ${i - range.start + 1} of ${range.count}`, doc.page.width - MARGIN_X - 150, y, { width: 150, align: 'right', lineBreak: false });
    doc.page.margins.bottom = savedBottom;
  }
}

function makeEnsureSpace(doc, co, quote) {
  const usableBottom = doc.page.height - FOOTER_HEIGHT;
  return function ensureSpace(neededHeight) {
    if (doc.y + neededHeight > usableBottom) {
      doc.addPage();
      drawHeader(doc, co, quote);
    }
  };
}

function drawMetaBlock(doc, ensureSpace, quote) {
  ensureSpace(100);
  const colW = (doc.page.width - MARGIN_X * 2) / 2;
  const rows = [
    ['REF NO', quote.quotationNumber || '—', 'DATE', fmtDate(quote.date)],
    ['CLIENT', quote.clientCompany || '—', 'ATTN', quote.clientAttn || '—'],
    ['CONTACT', quote.clientContact || '—', 'EMAIL', quote.clientEmail || '—'],
  ];
  for (const [k1, v1, k2, v2] of rows) {
    ensureSpace(30);
    const rowY = doc.y;
    doc.fontSize(7.5).fillColor(GRAY).font('Helvetica').text(k1, MARGIN_X, rowY, { width: colW - 10 });
    doc.fontSize(7.5).fillColor(GRAY).text(k2, MARGIN_X + colW, rowY, { width: colW - 10 });
    doc.fontSize(10).fillColor(NAVY).font('Helvetica-Bold').text(v1, MARGIN_X, rowY + 11, { width: colW - 10 });
    doc.fontSize(10).fillColor(NAVY).text(v2, MARGIN_X + colW, rowY + 11, { width: colW - 10 });
    doc.y = rowY + 28;
  }
  doc.moveDown(0.3);
  if (quote.subject) {
    ensureSpace(20);
    doc.fontSize(10).fillColor(NAVY).font('Helvetica-Bold').text('Subject: ', MARGIN_X, doc.y, { continued: true }).font('Helvetica').text(quote.subject);
  }
  if (quote.siteDetail) {
    ensureSpace(20);
    doc.fontSize(10).fillColor(NAVY).font('Helvetica-Bold').text('Site Detail: ', MARGIN_X, doc.y, { continued: true }).font('Helvetica').text(quote.siteDetail);
  }
  if (quote.sitesCovered && quote.sitesCovered.length) {
    ensureSpace(20 + quote.sitesCovered.length * 16);
    doc.moveDown(0.3);
    doc.fontSize(10).fillColor(NAVY).font('Helvetica-Bold').text('Sites Covered:', MARGIN_X, doc.y);
    doc.moveDown(0.2);
    drawTable(doc, ensureSpace,
      [{ label: '#', width: 30 }, { label: 'Site', width: 220 }, { label: 'Reference', width: 120 }, { label: 'Notes', width: 145 }],
      quote.sitesCovered.map((s, i) => [String(i + 1), s.name || '', s.reference || '—', s.notes || '—'])
    );
  }
  doc.moveDown(0.5);
  ensureSpace(40);
  doc.fontSize(10).fillColor(NAVY).font('Helvetica').text('Dear Sir,', MARGIN_X, doc.y);
  doc.moveDown(0.3);
  doc.text('We thank you for your enquiry. We have pleasure to submit our quotation as follows.', MARGIN_X, doc.y, { width: doc.page.width - MARGIN_X * 2 });
  doc.moveDown(0.5);
}

// Generic table drawer used for sites-covered, item tables, services, manpower —
// wraps text within each column and computes row height dynamically so nothing overlaps.
function drawTable(doc, ensureSpace, cols, rows, opts = {}) {
  const totalWidth = cols.reduce((s, c) => s + c.width, 0);
  const rowPad = 6;

  function drawHeaderRow() {
    ensureSpace(22);
    const y = doc.y;
    doc.rect(MARGIN_X, y, totalWidth, 20).fill(TEAL);
    let x = MARGIN_X;
    doc.fontSize(7.5).fillColor('#FFFFFF').font('Helvetica-Bold');
    for (const c of cols) {
      doc.text(c.label, x + 4, y + 6, { width: c.width - 8, align: c.align || 'left' });
      x += c.width;
    }
    doc.y = y + 20;
  }

  drawHeaderRow();
  rows.forEach((row, idx) => {
    const heights = row.map((cell, ci) => doc.heightOfString(String(cell ?? ''), { width: cols[ci].width - 8, fontSize: 8.5 }));
    const rowHeight = Math.max(18, Math.max(...heights) + rowPad * 2 - 6);
    if (doc.y + rowHeight > doc.page.height - FOOTER_HEIGHT) {
      doc.addPage();
      drawHeader(doc, opts.co, opts.quote);
      drawHeaderRow();
    }
    const y = doc.y;
    if (idx % 2 === 1) doc.rect(MARGIN_X, y, totalWidth, rowHeight).fill(LIGHT_GRAY);
    let x = MARGIN_X;
    doc.fontSize(8.5).fillColor('#1B2A2F').font('Helvetica');
    row.forEach((cell, ci) => {
      doc.text(String(cell ?? ''), x + 4, y + rowPad - 2, { width: cols[ci].width - 8, align: cols[ci].align || 'left' });
      x += cols[ci].width;
    });
    doc.y = y + rowHeight;
  });
  doc.moveDown(0.4);
}

function drawTotalsBox(doc, ensureSpace, totals, co) {
  ensureSpace(90);
  const boxW = 220;
  const x = doc.page.width - MARGIN_X - boxW;
  const rows = [['Subtotal', totals.subtotal]];
  if (totals.discount > 0) rows.push(['Discount', -totals.discount]);
  rows.push(['VAT (5%)', totals.vat]);
  let y = doc.y;
  doc.fontSize(9).font('Helvetica');
  for (const [label, val] of rows) {
    doc.fillColor(GRAY).text(label, x, y, { width: 100 });
    doc.fillColor(NAVY).text(`${co.currency} ${fmtMoney(val)}`, x + 100, y, { width: 120, align: 'right' });
    y += 16;
  }
  doc.moveTo(x, y).lineTo(x + boxW, y).strokeColor('#ddd').lineWidth(1).stroke();
  y += 6;
  doc.fontSize(11).font('Helvetica-Bold').fillColor(NAVY).text('Total', x, y, { width: 100 });
  doc.text(`${co.currency} ${fmtMoney(totals.total)}`, x + 100, y, { width: 120, align: 'right' });
  doc.y = y + 24;
  doc.x = MARGIN_X;
}

function drawClosing(doc, ensureSpace, quote) {
  ensureSpace(40);
  doc.fontSize(9).font('Helvetica-Bold').fillColor(NAVY).text('Payment Terms: ', MARGIN_X, doc.y, { continued: true, width: doc.page.width - MARGIN_X * 2 })
    .font('Helvetica').text(quote.paymentTerms || 'TBD');
  ensureSpace(20);
  doc.font('Helvetica-Bold').text('Validity: ', MARGIN_X, doc.y, { continued: true }).font('Helvetica').text(`${quote.validityDays || 15} Days`);
  doc.moveDown(0.4);

  if (quote.exclusions && quote.exclusions.length) {
    ensureSpace(20);
    doc.font('Helvetica-Bold').fillColor(NAVY).text('Exclusions:', MARGIN_X, doc.y);
    doc.font('Helvetica').fillColor('#1B2A2F');
    for (const ex of quote.exclusions) {
      const h = doc.heightOfString('•  ' + ex, { width: doc.page.width - MARGIN_X * 2 - 10, fontSize: 8.5 });
      ensureSpace(h + 4);
      doc.fontSize(8.5).text('•  ' + ex, MARGIN_X + 6, doc.y, { width: doc.page.width - MARGIN_X * 2 - 10 });
      doc.moveDown(0.15);
    }
    doc.moveDown(0.3);
  }
  if (quote.notes) {
    ensureSpace(20);
    doc.fontSize(9).font('Helvetica-Bold').fillColor(NAVY).text('Notes: ', MARGIN_X, doc.y, { continued: true, width: doc.page.width - MARGIN_X * 2 })
      .font('Helvetica').text(quote.notes);
    doc.moveDown(0.3);
  }

  ensureSpace(90);
  doc.moveDown(0.6);
  doc.fontSize(9).font('Helvetica').fillColor('#1B2A2F').text('Regards,', MARGIN_X, doc.y);
  doc.moveDown(2.2);
  const colW = (doc.page.width - MARGIN_X * 2 - 30) / 2;
  const signY = doc.y;
  doc.moveTo(MARGIN_X, signY).lineTo(MARGIN_X + colW, signY).strokeColor('#999').lineWidth(0.5).stroke();
  doc.moveTo(MARGIN_X + colW + 30, signY).lineTo(MARGIN_X + colW * 2 + 30, signY).strokeColor('#999').lineWidth(0.5).stroke();
  doc.fontSize(8.5).fillColor(GRAY)
    .text(`Prepared By${quote.preparedByName ? ' — ' + quote.preparedByName : ''}`, MARGIN_X, signY + 4, { width: colW })
    .text(`Approved By${quote.approvedByName ? ' — ' + quote.approvedByName : ' — pending'}`, MARGIN_X + colW + 30, signY + 4, { width: colW });
  doc.y = signY + 26;
  ensureSpace(20);
  doc.fontSize(7.5).fillColor('#999').font('Helvetica-Oblique')
    .text('This is a system-generated quotation. Signature is not required unless specifically requested by the client.', MARGIN_X, doc.y, { width: doc.page.width - MARGIN_X * 2 });
}

router.get('/:id/pdf', async (req, res) => {
  const state = db.get();
  const quote = state.quotations.find(q => q.id === req.params.id);
  if (!quote) return res.status(404).json({ error: 'Quotation not found.' });
  const co = state.company;

  const doc = new PDFDocument({ size: 'A4', margin: MARGIN_X, bufferPages: true });
  const safeName = (quote.quotationNumber || 'Quotation-Draft').replace(/[\/\\]/g, '-');
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${safeName}.pdf"`);
  doc.pipe(res);

  drawHeader(doc, co, quote);
  const ensureSpace = makeEnsureSpace(doc, co, quote);
  drawMetaBlock(doc, ensureSpace, quote);

  if (quote.type === 'AMC') {
    const amc = quote.amc || {};
    if (amc.scopeOfAgreement) {
      ensureSpace(30);
      doc.fontSize(9).font('Helvetica-Bold').fillColor(NAVY).text('Scope of Agreement: ', MARGIN_X, doc.y, { continued: true, width: doc.page.width - MARGIN_X * 2 })
        .font('Helvetica').text(amc.scopeOfAgreement);
      doc.moveDown(0.4);
    }
    ensureSpace(20);
    doc.fontSize(9).font('Helvetica-Bold').fillColor(NAVY)
      .text(`Contract Period: ${fmtDate(amc.contractStart)} to ${fmtDate(amc.contractEnd)}   |   Maintenance Visits: ${amc.maintenanceSchedule || 'Quarterly'}`, MARGIN_X, doc.y);
    doc.moveDown(0.4);

    drawTable(doc, ensureSpace,
      [{ label: 'Description', width: 265 }, { label: 'Qty', width: 60, align: 'right' }, { label: 'Unit Price', width: 90, align: 'right' }, { label: 'Total', width: 100, align: 'right' }],
      (amc.services || []).map(s => [s.description, String(s.qty ?? ''), fmtMoney(s.unitPrice), fmtMoney(lineTotal(s))]),
      { co, quote }
    );

    if (amc.manpower && amc.manpower.length) {
      ensureSpace(20);
      doc.fontSize(9).font('Helvetica-Bold').fillColor(NAVY).text('Manpower Details:', MARGIN_X, doc.y);
      doc.moveDown(0.2);
      drawTable(doc, ensureSpace,
        [{ label: 'Role', width: 415 }, { label: 'Qty', width: 100, align: 'right' }],
        amc.manpower.map(m => [m.role, String(m.qty ?? '')]),
        { co, quote }
      );
    }
    drawTotalsBox(doc, ensureSpace, quotationTotals(quote), co);
  } else {
    const showGrouped = (quote.type === 'PR' || quote.type === 'FO');
    const groups = groupLinesByCategory(quote.lineItems);
    const cols = [
      { label: 'Description', width: 175 }, { label: 'Brand', width: 65 }, { label: 'Unit', width: 45 },
      { label: 'Qty', width: 45, align: 'right' }, { label: 'Unit Price', width: 70, align: 'right' }, { label: 'Total', width: 75, align: 'right' },
    ];
    if (showGrouped && groups.length > 1) {
      ensureSpace(20);
      doc.fontSize(9).font('Helvetica-Bold').fillColor(NAVY).text('ARTICLE 1: SUMMARY', MARGIN_X, doc.y, { width: doc.page.width - MARGIN_X * 2, align: 'center' });
      doc.moveDown(0.3);
      drawTable(doc, ensureSpace,
        [{ label: 'Description', width: 355 }, { label: 'Total', width: 160, align: 'right' }],
        groups.map(g => [g.category, fmtMoney(g.subtotal)]),
        { co, quote }
      );
      ensureSpace(20);
      doc.fontSize(9).font('Helvetica-Bold').fillColor(NAVY).text('ARTICLE 2: BILL OF QUANTITY', MARGIN_X, doc.y, { width: doc.page.width - MARGIN_X * 2, align: 'center' });
      doc.moveDown(0.3);
    }
    for (const g of groups) {
      if (showGrouped && groups.length > 1) {
        ensureSpace(20);
        doc.rect(MARGIN_X, doc.y, doc.page.width - MARGIN_X * 2, 16).fill(LIGHT_GRAY);
        doc.fontSize(8.5).font('Helvetica-Bold').fillColor(NAVY).text(g.category, MARGIN_X + 4, doc.y + 4);
        doc.y += 16;
      }
      drawTable(doc, ensureSpace, cols, g.lines.map(l => [l.description, l.brand || '—', l.unit, String(l.qty), fmtMoney(l.unitPrice), fmtMoney(lineTotal(l))]), { co, quote });
    }
    drawTotalsBox(doc, ensureSpace, quotationTotals(quote), co);
  }

  drawClosing(doc, ensureSpace, quote);
  drawFooters(doc, co);
  doc.end();
});

module.exports = router;
