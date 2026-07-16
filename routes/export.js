const express = require('express');
const path = require('path');
const fs = require('fs');
const ExcelJS = require('exceljs');
const PDFDocument = require('pdfkit');
const db = require('../lib/db');
const { requireAuth } = require('../lib/auth');
const { can } = require('../lib/permissions');
const { enrichItem } = require('../lib/calc');

const router = express.Router();
router.use(requireAuth);

function filteredItems(req, state) {
  let list = state.items.map(it => enrichItem(it, state.movements));
  const { branch, status, search } = req.query;
  if (branch && branch !== 'All') list = list.filter(i => i.location === branch);
  if (status && status !== 'All') list = list.filter(i => i.status === status);
  if (search && search.trim()) {
    const q = search.trim().toLowerCase();
    list = list.filter(i => (i.brand + ' ' + i.partNo + ' ' + i.description).toLowerCase().includes(q));
  }
  return list;
}

function filterSummary(req) {
  const { branch, status, search } = req.query;
  const parts = [];
  parts.push('Branch: ' + (!branch || branch === 'All' ? 'All Branches' : branch));
  parts.push('Status: ' + (!status || status === 'All' ? 'All' : status));
  if (search && search.trim()) parts.push(`Search: "${search.trim()}"`);
  return parts.join('  ·  ');
}

function logoAbsPath(state) {
  if (!state.company.logoPath) return null;
  const p = path.join(db.UPLOADS_DIR, path.basename(state.company.logoPath));
  return fs.existsSync(p) ? p : null;
}

router.get('/excel', async (req, res) => {
  const state = db.get();
  const showPricing = can(state.roles, req.user.role, 'viewPricing') && can(state.roles, req.user.role, 'exportPricing') && req.query.pricing !== '0';
  const items = filteredItems(req, state);
  const co = state.company;

  const wb = new ExcelJS.Workbook();
  wb.creator = co.name; wb.created = new Date();
  const ws = wb.addWorksheet('Inventory');

  const cols = [
    { header: 'Description', width: 34 }, { header: 'Brand', width: 16 }, { header: 'Part No.', width: 20 },
    { header: 'Branch', width: 14 }, { header: 'Unit', width: 8 }, { header: 'Qty On Hand', width: 12 }, { header: 'Min Level', width: 10 },
  ];
  if (showPricing) {
    cols.push({ header: `Cost (${co.currency})`, width: 14 });
    cols.push({ header: `Price (${co.currency})`, width: 14 });
    cols.push({ header: `Stock Value (${co.currency})`, width: 16 });
  }
  cols.push({ header: 'Status', width: 14 });
  const totalCols = cols.length;
  cols.forEach((c, i) => { ws.getColumn(i + 1).width = c.width; });

  ws.mergeCells(1, 1, 1, totalCols);
  ws.getCell(1, 1).value = co.name;
  ws.getCell(1, 1).font = { size: 16, bold: true, color: { argb: 'FF00627B' } };
  ws.getRow(1).height = 26;

  ws.mergeCells(2, 1, 2, totalCols);
  ws.getCell(2, 1).value = 'Inventory Report — Exported ' + new Date().toLocaleString('en-GB');
  ws.getCell(2, 1).font = { size: 10, italic: true, color: { argb: 'FF5B6B70' } };

  ws.mergeCells(3, 1, 3, totalCols);
  ws.getCell(3, 1).value = 'Filters applied: ' + filterSummary(req) + `  ·  ${items.length} item(s)  ·  Exported by ${req.user.name} (${req.user.role})`;
  ws.getCell(3, 1).font = { size: 10, color: { argb: 'FF5B6B70' } };

  const headerRowIdx = 5;
  cols.forEach((c, i) => {
    const cell = ws.getCell(headerRowIdx, i + 1);
    cell.value = c.header;
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF00627B' } };
    cell.alignment = { vertical: 'middle', horizontal: 'center' };
  });
  ws.getRow(headerRowIdx).height = 20;

  items.forEach((it, idx) => {
    const r = headerRowIdx + 1 + idx;
    const rowVals = [it.description, it.brand, it.partNo || '—', it.location, it.unit, it.qty, it.minLevel];
    if (showPricing) rowVals.push(Number(it.cost || 0), Number(it.price || 0), Number(it.stockValue || 0));
    rowVals.push(it.status);
    rowVals.forEach((v, ci) => { ws.getCell(r, ci + 1).value = v; });
    if (idx % 2 === 1) { for (let ci = 1; ci <= totalCols; ci++) ws.getCell(r, ci).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF5F5F5' } }; }
    if (showPricing) {
      ws.getCell(r, 8).numFmt = '#,##0.00'; ws.getCell(r, 9).numFmt = '#,##0.00'; ws.getCell(r, 10).numFmt = '#,##0.00';
    }
  });

  const lastDataRow = headerRowIdx + items.length;
  ws.autoFilter = { from: { row: headerRowIdx, column: 1 }, to: { row: Math.max(lastDataRow, headerRowIdx), column: totalCols } };
  ws.views = [{ state: 'frozen', ySplit: headerRowIdx }];

  const logoPath = logoAbsPath(state);
  if (logoPath) {
    try {
      const ext = path.extname(logoPath).slice(1).toLowerCase();
      const imgId = wb.addImage({ filename: logoPath, extension: ext === 'jpg' ? 'jpeg' : ext });
      ws.addImage(imgId, { tl: { col: totalCols - 1.5, row: 0.05 }, ext: { width: 100, height: 40 } });
    } catch (e) { console.warn('Excel logo embed failed', e.message); }
  }

  if (co.reportFooter) {
    const footerRow = lastDataRow + 2;
    ws.mergeCells(footerRow, 1, footerRow, totalCols);
    ws.getCell(footerRow, 1).value = co.reportFooter;
    ws.getCell(footerRow, 1).font = { italic: true, size: 9, color: { argb: 'FF5B6B70' } };
  }

  const buf = await wb.xlsx.writeBuffer();
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="Inventory-Report-${Date.now()}.xlsx"`);
  res.send(Buffer.from(buf));
});

router.get('/pdf', async (req, res) => {
  const state = db.get();
  const showPricing = can(state.roles, req.user.role, 'viewPricing') && can(state.roles, req.user.role, 'exportPricing') && req.query.pricing !== '0';
  const items = filteredItems(req, state);
  const co = state.company;

  const pageSize = (co.paperSize || 'A4').toUpperCase() === 'LETTER' ? 'LETTER' : 'A4';
  const doc = new PDFDocument({ size: pageSize, layout: 'landscape', margin: 30 });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="Inventory-Report-${Date.now()}.pdf"`);
  doc.pipe(res);

  const pageWidth = doc.page.width;
  let textX = 30;
  const logoPath = logoAbsPath(state);
  if (logoPath) {
    try { doc.image(logoPath, 30, 20, { fit: [70, 30] }); textX = 110; } catch (e) { console.warn('PDF logo embed failed', e.message); }
  }
  doc.fontSize(15).fillColor('#0B2B36').text(co.name, textX, 22);
  doc.fontSize(9).fillColor('#5B6B70').text('Inventory Report', textX, 40);
  doc.fontSize(8).fillColor('#5B6B70')
    .text(`Exported: ${new Date().toLocaleString('en-GB')}`, pageWidth - 260, 22, { width: 230, align: 'right' })
    .text(`Filters: ${filterSummary(req)}`, pageWidth - 260, 33, { width: 230, align: 'right' })
    .text(`By: ${req.user.name} (${req.user.role})`, pageWidth - 260, 44, { width: 230, align: 'right' });

  const cols = [
    { key: 'description', label: 'Description', width: showPricing ? 150 : 220 },
    { key: 'brand', label: 'Brand', width: 70 },
    { key: 'partNo', label: 'Part No.', width: 90 },
    { key: 'location', label: 'Branch', width: 60 },
    { key: 'unit', label: 'Unit', width: 40 },
    { key: 'qty', label: 'Qty', width: 40 },
    { key: 'minLevel', label: 'Min', width: 40 },
  ];
  if (showPricing) {
    cols.push({ key: 'cost', label: `Cost`, width: 55 });
    cols.push({ key: 'price', label: `Price`, width: 55 });
    cols.push({ key: 'stockValue', label: `Value`, width: 65 });
  }
  cols.push({ key: 'status', label: 'Status', width: 70 });

  const tableLeft = 30;
  const tableTop = 70;
  const rowHeight = 18;
  const usableHeight = doc.page.height - 60;

  function drawHeader(y) {
    doc.fontSize(8).fillColor('#FFFFFF');
    let x = tableLeft;
    doc.rect(tableLeft, y, cols.reduce((s, c) => s + c.width, 0), rowHeight).fill('#00627B');
    doc.fillColor('#FFFFFF');
    for (const c of cols) {
      doc.text(c.label, x + 4, y + 5, { width: c.width - 8 });
      x += c.width;
    }
    return y + rowHeight;
  }

  let y = drawHeader(tableTop);
  let pageNum = 1;
  const pageNumsY = [];

  items.forEach((it, idx) => {
    if (y + rowHeight > usableHeight) {
      pageNumsY.push({ page: pageNum });
      doc.addPage();
      pageNum++;
      y = drawHeader(tableTop);
    }
    if (idx % 2 === 1) doc.rect(tableLeft, y, cols.reduce((s, c) => s + c.width, 0), rowHeight).fill('#F5F5F5');
    doc.fillColor('#1B2A2F').fontSize(8);
    let x = tableLeft;
    const rowData = {
      description: it.description, brand: it.brand, partNo: it.partNo || '—', location: it.location,
      unit: it.unit, qty: String(it.qty), minLevel: String(it.minLevel), status: it.status,
      cost: showPricing ? Number(it.cost || 0).toFixed(2) : '', price: showPricing ? Number(it.price || 0).toFixed(2) : '',
      stockValue: showPricing ? Number(it.stockValue || 0).toFixed(2) : '',
    };
    for (const c of cols) {
      doc.text(String(rowData[c.key] ?? ''), x + 4, y + 5, { width: c.width - 8 });
      x += c.width;
    }
    y += rowHeight;
  });
  pageNumsY.push({ page: pageNum });

  const totalPages = pageNum;
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    doc.fontSize(8).fillColor('#787878')
      .text(`Page ${i - range.start + 1} of ${range.count}`, doc.page.width - 150, doc.page.height - 30, { width: 120, align: 'right' });
    if (co.reportFooter) doc.text(co.reportFooter, 30, doc.page.height - 30, { width: 300 });
  }

  doc.end();
});

module.exports = router;
