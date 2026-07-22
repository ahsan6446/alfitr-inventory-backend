const path = require('path');
const fs = require('fs');
const PDFDocument = require('pdfkit');
const db = require('../lib/db');
const { lineTotal, groupLinesByCategory, quotationTotals } = require('../lib/calc');

const TEAL = '#00627B';
const NAVY = '#0B2B36';
const GRAY = '#5B6B70';
const LIGHT = '#F5F5F5';
const BORDER = '#E1E6E8';

const MARGIN = 40;
const HEADER_H = 66;
const FOOTER_H = 40;

function logoAbsPath(company) {
  if (!company.logoPath) return null;
  const p = path.join(db.UPLOADS_DIR, path.basename(company.logoPath));
  return fs.existsSync(p) ? p : null;
}
function fmtMoney(n) { return Number(n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
function fmtDate(d) {
  if (!d) return '—';
  const dt = new Date(d);
  if (isNaN(dt)) return d;
  return dt.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}

const TYPE_LABEL = { PR: 'Project', SUP: 'Supply Only', AMC: 'AMC Contract', FO: 'Fit-Out' };

// Draws the letterhead — identical on every page, per Ahsan's request.
// Address/phone/email live in the footer only now (avoids showing the same
// contact details twice on one document).
function drawHeader(doc, co, q) {
  const pageWidth = doc.page.width;
  const logoPath = logoAbsPath(co);
  const logoScale = { small: 0.7, medium: 1, large: 1.3 }[co.logoSize] || 1;
  let textX = MARGIN;
  if (logoPath) {
    try {
      const h = 34 * logoScale;
      const props = doc.openImage(logoPath);
      const w = (props.width / props.height) * h;
      doc.image(logoPath, MARGIN, MARGIN, { height: h });
      textX = MARGIN + w + 12;
    } catch (e) { console.warn('PDF logo embed failed', e.message); }
  }
  const titleBlockW = 150;
  const nameWidth = pageWidth - textX - MARGIN - titleBlockW;
  doc.fontSize(13).fillColor(TEAL).font('Helvetica-Bold').text(co.name || '', textX, MARGIN + 10, { width: nameWidth });

  doc.fontSize(15).fillColor(NAVY).font('Helvetica-Bold').text('QUOTATION', pageWidth - MARGIN - titleBlockW, MARGIN, { width: titleBlockW, align: 'right' });
  doc.fontSize(9).fillColor('#D96F24').font('Helvetica-Bold')
    .text(q.quotationNumber || '(not yet sent)', pageWidth - MARGIN - titleBlockW, MARGIN + 19, { width: titleBlockW, align: 'right' });
  doc.fontSize(8).fillColor(GRAY).font('Helvetica')
    .text((q.status === 'PendingApproval' ? 'PENDING APPROVAL' : q.status || '').toUpperCase() + (q.revisionOf ? ` · REV ${q.revisionNumber}` : ''), pageWidth - MARGIN - titleBlockW, MARGIN + 32, { width: titleBlockW, align: 'right' });

  const dividerY = MARGIN + HEADER_H - 12;
  doc.moveTo(MARGIN, dividerY).lineTo(pageWidth - MARGIN, dividerY).lineWidth(2).strokeColor(TEAL).stroke();
}

function drawFooter(doc, co, pageNum, totalPages) {
  const pageWidth = doc.page.width, pageHeight = doc.page.height;
  const y = pageHeight - MARGIN - FOOTER_H + 8;
  doc.moveTo(MARGIN, y).lineTo(pageWidth - MARGIN, y).lineWidth(0.5).strokeColor(BORDER).stroke();
  const contactLine = [co.name, co.address, co.phone, co.email].filter(Boolean).join('  ·  ');
  doc.fontSize(7).fillColor(GRAY).font('Helvetica')
    .text(contactLine, MARGIN, y + 6, { width: pageWidth - MARGIN * 2 - 100 });
  doc.fontSize(7).fillColor(GRAY).font('Helvetica')
    .text(`Page ${pageNum} of ${totalPages}`, pageWidth - MARGIN - 90, y + 6, { width: 90, align: 'right', lineBreak: false });
}

function contentTop() { return MARGIN + HEADER_H + 6; }
function contentBottom(doc) { return doc.page.height - MARGIN - FOOTER_H - 4; }

// Ensures there's room for the next block; adds a page (with header redrawn) if not.
function ensureSpace(doc, co, q, cursor, needed) {
  if (cursor.y + needed > contentBottom(doc)) {
    doc.addPage();
    cursor.page += 1;
    drawHeader(doc, co, q);
    cursor.y = contentTop();
  }
}

function drawMetaGrid(doc, co, q, cursor) {
  ensureSpace(doc, co, q, cursor, 90);
  const contentWidth = doc.page.width - MARGIN * 2;
  const gap = 30;                                  // clean visual gap between the two columns
  const col1Width = (contentWidth - gap) / 2;       // left column takes roughly half the page
  const col2X = MARGIN + col1Width + gap;           // right column starts after the gap...
  const col2Width = (doc.page.width - MARGIN) - col2X; // ...and extends to the true right margin, so both columns are symmetric

  const rows = [
    ['REF NO', q.quotationNumber || '—', 'DATE', fmtDate(q.date)],
    ['CLIENT', q.clientCompany || '—', 'ATTN', q.clientAttn || '—'],
    ['CONTACT', q.clientContact || '—', 'EMAIL', q.clientEmail || '—'],
  ];
  let y = cursor.y;
  for (const [k1, v1, k2, v2] of rows) {
    const h1 = doc.heightOfString(v1, { width: col1Width, fontSize: 9.5 });
    const h2 = doc.heightOfString(v2, { width: col2Width - 10, fontSize: 9.5 });
    const rowHeight = Math.max(28, Math.max(h1, h2) + 13);
    doc.fontSize(7.5).fillColor(GRAY).font('Helvetica-Bold').text(k1, MARGIN, y);
    doc.fontSize(7.5).fillColor(GRAY).font('Helvetica-Bold').text(k2, col2X, y);
    doc.fontSize(9.5).fillColor(NAVY).font('Helvetica').text(v1, MARGIN, y + 11, { width: col1Width });
    doc.fontSize(9.5).fillColor(NAVY).font('Helvetica').text(v2, col2X, y + 11, { width: col2Width - 10 });
    y += rowHeight;
  }
  cursor.y = y + 4;
}

function drawSubjectSite(doc, co, q, cursor) {
  ensureSpace(doc, co, q, cursor, 60);
  let y = cursor.y;
  if (q.subject) {
    doc.fontSize(9.5).fillColor(NAVY).font('Helvetica-Bold').text('Subject: ', MARGIN, y, { continued: true }).font('Helvetica').text(q.subject);
    y = doc.y + 4;
  }
  if (q.siteDetail) {
    doc.fontSize(9.5).fillColor(NAVY).font('Helvetica-Bold').text('Site Detail: ', MARGIN, y, { continued: true }).font('Helvetica').text(q.siteDetail);
    y = doc.y + 8;
  }
  doc.fontSize(9.5).fillColor(NAVY).font('Helvetica').text('Dear Sir,', MARGIN, y);
  y = doc.y + 4;
  doc.text('We thank you for your enquiry. We have pleasure to submit our quotation as follows.', MARGIN, y);
  cursor.y = doc.y + 10;
}

function drawSitesCovered(doc, co, q, cursor) {
  if (!q.sitesCovered || !q.sitesCovered.length) return;
  ensureSpace(doc, co, q, cursor, 30 + q.sitesCovered.length * 16);
  doc.fontSize(9.5).fillColor(NAVY).font('Helvetica-Bold').text('Sites Covered:', MARGIN, cursor.y);
  cursor.y = doc.y + 4;
  const cols = [
    { key: 'i', label: '#', width: 24 }, { key: 'name', label: 'Site', width: 220 },
    { key: 'reference', label: 'Reference', width: 100 }, { key: 'notes', label: 'Notes', width: doc.page.width - MARGIN * 2 - 344 },
  ];
  cursor.y = drawTableHeader(doc, cols, cursor.y);
  q.sitesCovered.forEach((s, i) => {
    ensureSpace(doc, co, q, cursor, 16);
    if (cursor.y === contentTop()) cursor.y = drawTableHeader(doc, cols, cursor.y);
    drawTableRow(doc, cols, { i: String(i + 1), name: s.name, reference: s.reference || '—', notes: s.notes || '—' }, cursor.y, i % 2 === 1);
    cursor.y += 16;
  });
  cursor.y += 8;
}

function drawTableHeader(doc, cols, y) {
  const totalW = cols.reduce((s, c) => s + c.width, 0);
  doc.rect(MARGIN, y, totalW, 18).fill(TEAL);
  let x = MARGIN;
  doc.fontSize(7.5).fillColor('#FFFFFF').font('Helvetica-Bold');
  for (const c of cols) { doc.text(c.label, x + 4, y + 5, { width: c.width - 8, align: c.align || 'left' }); x += c.width; }
  return y + 18;
}
function drawTableRow(doc, cols, data, y, shaded) {
  const totalW = cols.reduce((s, c) => s + c.width, 0);
  if (shaded) doc.rect(MARGIN, y, totalW, 16).fill(LIGHT);
  let x = MARGIN;
  doc.fontSize(8).fillColor(NAVY).font('Helvetica');
  for (const c of cols) { doc.text(String(data[c.key] ?? ''), x + 4, y + 4, { width: c.width - 8, align: c.align || 'left' }); x += c.width; }
}

function itemTableCols(pageWidth) {
  const w = pageWidth - MARGIN * 2;
  return [
    { key: 'description', label: 'Description', width: w * 0.36 },
    { key: 'brand', label: 'Brand', width: w * 0.14 },
    { key: 'unit', label: 'Unit', width: w * 0.09 },
    { key: 'qty', label: 'Qty', width: w * 0.1, align: 'right' },
    { key: 'unitPrice', label: 'Unit Price', width: w * 0.15, align: 'right' },
    { key: 'total', label: 'Total', width: w * 0.16, align: 'right' },
  ];
}

function drawLineItems(doc, co, q, cursor, lines, groupLabel) {
  const cols = itemTableCols(doc.page.width);
  if (groupLabel) {
    ensureSpace(doc, co, q, cursor, 22);
    doc.rect(MARGIN, cursor.y, cols.reduce((s, c) => s + c.width, 0), 18).fill('#F3F5F6');
    doc.fontSize(8.5).fillColor(NAVY).font('Helvetica-Bold').text(groupLabel, MARGIN + 6, cursor.y + 5);
    cursor.y += 22;
  }
  ensureSpace(doc, co, q, cursor, 18);
  cursor.y = drawTableHeader(doc, cols, cursor.y);
  lines.forEach((l, idx) => {
    ensureSpace(doc, co, q, cursor, 16);
    // if a page break just happened, re-draw the column header before continuing
    if (cursor.y === contentTop()) cursor.y = drawTableHeader(doc, cols, cursor.y);
    drawTableRow(doc, cols, {
      description: l.description, brand: l.brand || '—', unit: l.unit,
      qty: String(l.qty), unitPrice: fmtMoney(l.unitPrice), total: fmtMoney(lineTotal(l)),
    }, cursor.y, idx % 2 === 1);
    cursor.y += 16;
  });
  cursor.y += 6;
}

function drawTotals(doc, co, q, cursor, totals) {
  ensureSpace(doc, co, q, cursor, 90);
  const boxW = 220, x = doc.page.width - MARGIN - boxW;
  let y = cursor.y + 4;
  const line = (label, value, bold) => {
    doc.fontSize(9).fillColor(bold ? NAVY : GRAY).font(bold ? 'Helvetica-Bold' : 'Helvetica')
      .text(label, x, y, { width: boxW - 90 })
      .text(`${co.currency} ${value}`, x + boxW - 90, y, { width: 90, align: 'right' });
    y += 15;
  };
  line('Subtotal', fmtMoney(totals.subtotal));
  if (totals.discount > 0) line('Discount', '-' + fmtMoney(totals.discount));
  line('VAT (5%)', fmtMoney(totals.vat));
  doc.moveTo(x, y).lineTo(x + boxW, y).lineWidth(0.5).strokeColor(BORDER).stroke();
  y += 4;
  line('Total', fmtMoney(totals.total), true);
  cursor.y = y + 10;
}

function drawTermsAndExclusions(doc, co, q, cursor) {
  ensureSpace(doc, co, q, cursor, 40);
  doc.fontSize(9.5).fillColor(NAVY).font('Helvetica-Bold').text('Payment Terms: ', MARGIN, cursor.y, { continued: true })
    .font('Helvetica').text(q.paymentTerms || 'TBD');
  cursor.y = doc.y + 4;
  doc.fontSize(9.5).fillColor(NAVY).font('Helvetica-Bold').text('Validity: ', MARGIN, cursor.y, { continued: true })
    .font('Helvetica').text(`${q.validityDays || 15} Days`);
  cursor.y = doc.y + 10;

  if (q.exclusions && q.exclusions.length) {
    ensureSpace(doc, co, q, cursor, 20 + q.exclusions.length * 14);
    doc.fontSize(9.5).fillColor(NAVY).font('Helvetica-Bold').text('Exclusions:', MARGIN, cursor.y);
    cursor.y = doc.y + 4;
    for (const excl of q.exclusions) {
      ensureSpace(doc, co, q, cursor, 14);
      doc.fontSize(8.5).fillColor(NAVY).font('Helvetica').text('•  ' + excl, MARGIN + 4, cursor.y, { width: doc.page.width - MARGIN * 2 - 8 });
      cursor.y = doc.y + 3;
    }
    cursor.y += 6;
  }
  if (q.notes) {
    ensureSpace(doc, co, q, cursor, 30);
    doc.fontSize(9.5).fillColor(NAVY).font('Helvetica-Bold').text('Notes: ', MARGIN, cursor.y, { continued: true })
      .font('Helvetica').text(q.notes, { width: doc.page.width - MARGIN * 2 - 40 });
    cursor.y = doc.y + 10;
  }
}

function drawSignature(doc, co, q, cursor) {
  ensureSpace(doc, co, q, cursor, 90);
  cursor.y += 16;
  doc.fontSize(9.5).fillColor(NAVY).font('Helvetica').text('Regards,', MARGIN, cursor.y);
  cursor.y = doc.y + 40;
  const colW = (doc.page.width - MARGIN * 2 - 40) / 2;
  doc.moveTo(MARGIN, cursor.y).lineTo(MARGIN + colW, cursor.y).lineWidth(0.5).strokeColor(NAVY).stroke();
  doc.moveTo(MARGIN + colW + 40, cursor.y).lineTo(MARGIN + colW * 2 + 40, cursor.y).lineWidth(0.5).strokeColor(NAVY).stroke();
  cursor.y += 5;
  doc.fontSize(9).fillColor(NAVY).font('Helvetica-Bold')
    .text(q.preparedByName || '—', MARGIN, cursor.y, { width: colW })
    .text(q.approvedByName || 'Pending', MARGIN + colW + 40, cursor.y, { width: colW });
  const nameLineY = cursor.y;
  doc.fontSize(8).fillColor(GRAY).font('Helvetica')
    .text(q.preparedByDesignation || 'Prepared By', MARGIN, nameLineY + 13, { width: colW })
    .text(q.approvedByDesignation || (q.approvedByName ? 'Approved By' : 'Approval Pending'), MARGIN + colW + 40, nameLineY + 13, { width: colW });
  cursor.y = nameLineY + 13 + 22;
  doc.fontSize(7.5).fillColor(GRAY).font('Helvetica')
    .text('This is a system-generated quotation. Signature is not required unless specifically requested by the client.', MARGIN, cursor.y, { width: doc.page.width - MARGIN * 2 });
  cursor.y = doc.y + 6;
}

// ---- AMC-specific blocks ----
function drawAmcBody(doc, co, q, cursor) {
  const amc = q.amc || {};
  if (amc.scopeOfAgreement) {
    ensureSpace(doc, co, q, cursor, 30);
    doc.fontSize(9.5).fillColor(NAVY).font('Helvetica-Bold').text('Scope of Agreement: ', MARGIN, cursor.y, { continued: true })
      .font('Helvetica').text(amc.scopeOfAgreement, { width: doc.page.width - MARGIN * 2 - 130 });
    cursor.y = doc.y + 10;
  }
  ensureSpace(doc, co, q, cursor, 20);
  doc.fontSize(9).fillColor(NAVY).font('Helvetica-Bold')
    .text(`Contract Period: ${fmtDate(amc.contractStart)} to ${fmtDate(amc.contractEnd)}`, MARGIN, cursor.y, { continued: true })
    .font('Helvetica').text(`    Maintenance Visits: ${amc.maintenanceSchedule || 'Quarterly'}`);
  cursor.y = doc.y + 12;

  const svcCols = [
    { key: 'description', label: 'Description', width: (doc.page.width - MARGIN * 2) * 0.55 },
    { key: 'qty', label: 'Qty', width: (doc.page.width - MARGIN * 2) * 0.13, align: 'right' },
    { key: 'unitPrice', label: 'Unit Price', width: (doc.page.width - MARGIN * 2) * 0.16, align: 'right' },
    { key: 'total', label: 'Total', width: (doc.page.width - MARGIN * 2) * 0.16, align: 'right' },
  ];
  ensureSpace(doc, co, q, cursor, 18);
  cursor.y = drawTableHeader(doc, svcCols, cursor.y);
  (amc.services || []).forEach((s, idx) => {
    ensureSpace(doc, co, q, cursor, 16);
    if (cursor.y === contentTop()) cursor.y = drawTableHeader(doc, svcCols, cursor.y);
    drawTableRow(doc, svcCols, { description: s.description, qty: String(s.qty), unitPrice: fmtMoney(s.unitPrice), total: fmtMoney(lineTotal(s)) }, cursor.y, idx % 2 === 1);
    cursor.y += 16;
  });
  cursor.y += 10;

  if (amc.manpower && amc.manpower.length) {
    ensureSpace(doc, co, q, cursor, 20 + amc.manpower.length * 16);
    doc.fontSize(9.5).fillColor(NAVY).font('Helvetica-Bold').text('Manpower Details:', MARGIN, cursor.y);
    cursor.y = doc.y + 4;
    const mpCols = [{ key: 'role', label: 'Role', width: 300 }, { key: 'qty', label: 'Qty', width: 100, align: 'right' }];
    cursor.y = drawTableHeader(doc, mpCols, cursor.y);
    amc.manpower.forEach((m, idx) => {
      ensureSpace(doc, co, q, cursor, 16);
      drawTableRow(doc, mpCols, { role: m.role, qty: String(m.qty) }, cursor.y, idx % 2 === 1);
      cursor.y += 16;
    });
    cursor.y += 10;
  }
}

async function generateQuotationPdf(q, res) {
  const state = db.get();
  const co = state.company;
  const pageSize = (co.paperSize || 'A4').toUpperCase() === 'LETTER' ? 'LETTER' : 'A4';
  const doc = new PDFDocument({ size: pageSize, layout: 'portrait', margin: MARGIN, bufferPages: true });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${(q.quotationNumber || 'Quotation').replace(/\//g, '-')}.pdf"`);
  doc.pipe(res);

  drawHeader(doc, co, q);
  const cursor = { y: contentTop(), page: 1 };

  drawMetaGrid(doc, co, q, cursor);
  drawSubjectSite(doc, co, q, cursor);
  drawSitesCovered(doc, co, q, cursor);

  if (q.type === 'AMC') {
    drawAmcBody(doc, co, q, cursor);
    const totals = quotationTotals(q);
    drawTotals(doc, co, q, cursor, totals);
  } else {
    const groups = groupLinesByCategory(q.lineItems);
    const showGrouped = (q.type === 'PR' || q.type === 'FO') && groups.length > 1;
    if (showGrouped) {
      ensureSpace(doc, co, q, cursor, 24);
      doc.fontSize(10).fillColor(NAVY).font('Helvetica-Bold').text('ARTICLE 1: SUMMARY', MARGIN, cursor.y, { width: doc.page.width - MARGIN * 2, align: 'center' });
      cursor.y = doc.y + 8;
      const sumCols = [
        { key: 'category', label: 'Description', width: (doc.page.width - MARGIN * 2) * 0.75 },
        { key: 'total', label: `Total (${co.currency})`, width: (doc.page.width - MARGIN * 2) * 0.25, align: 'right' },
      ];
      cursor.y = drawTableHeader(doc, sumCols, cursor.y);
      groups.forEach((g, idx) => {
        ensureSpace(doc, co, q, cursor, 16);
        drawTableRow(doc, sumCols, { category: g.category, total: fmtMoney(g.subtotal) }, cursor.y, idx % 2 === 1);
        cursor.y += 16;
      });
      cursor.y += 14;
      ensureSpace(doc, co, q, cursor, 24);
      doc.fontSize(10).fillColor(NAVY).font('Helvetica-Bold').text('ARTICLE 2: BILL OF QUANTITY', MARGIN, cursor.y, { width: doc.page.width - MARGIN * 2, align: 'center' });
      cursor.y = doc.y + 8;
    }
    for (const g of groups) {
      drawLineItems(doc, co, q, cursor, g.lines, showGrouped ? g.category : null);
    }
    const totals = quotationTotals(q);
    drawTotals(doc, co, q, cursor, totals);
  }

  drawTermsAndExclusions(doc, co, q, cursor);
  drawSignature(doc, co, q, cursor);

  const range = doc.bufferedPageRange();
  const totalPages = range.count;
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    drawFooter(doc, co, i - range.start + 1, totalPages);
  }

  doc.end();
}

module.exports = { generateQuotationPdf };
