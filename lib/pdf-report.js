'use strict';

const PDFDocument = require('pdfkit');
const { Readable } = require('stream');

// ── Design tokens ─────────────────────────────────────────────────────────────
const C = {
  bg:        '#FAFAF8',
  accent:    '#C41E3A',  // brand red
  accentMid: '#E05070',
  ink:       '#1A1A1A',
  inkMid:    '#555555',
  inkLight:  '#8A8A8A',
  rule:      '#E0DED8',
  kpiBg:     '#F3F2EF',
  kpiOk:     '#1B7A3C',
  kpiBad:    '#C41E3A',
  kpiFlat:   '#6B6B6B',
  rowAlt:    '#F7F6F4',
  rowHdr:    '#2A2A2A',
  chartBars: ['#C41E3A', '#D94060', '#E06080', '#3A6EA8', '#5A8EC8', '#8AB4E8', '#A0A090', '#C0C0B0'],
};

const PAGE = { width: 595.28, height: 841.89, margin: 44 };
const CONTENT_W = PAGE.width - PAGE.margin * 2;

// ── Utils ─────────────────────────────────────────────────────────────────────

function hex(h) {
  const r = parseInt(h.slice(1, 3), 16);
  const g = parseInt(h.slice(3, 5), 16);
  const b = parseInt(h.slice(5, 7), 16);
  return [r / 255, g / 255, b / 255];
}

function rgb(doc, h) { doc.fillColor(h); }
function stroke(doc, h) { doc.strokeColor(h); }

function hRule(doc, y, color, lw) {
  doc.save()
    .strokeColor(color || C.rule)
    .lineWidth(lw || 0.5)
    .moveTo(PAGE.margin, y)
    .lineTo(PAGE.width - PAGE.margin, y)
    .stroke()
    .restore();
}

// ── Header ────────────────────────────────────────────────────────────────────

function drawHeader(doc, data, brandName) {
  const { margin } = PAGE;
  const y0 = margin;

  // Red accent bar
  doc.rect(0, 0, PAGE.width, 6).fill(C.accent);

  // Brand name (top-left)
  doc.fillColor(C.ink)
     .font('Helvetica-Bold')
     .fontSize(11)
     .text((brandName || 'Brand').toUpperCase(), margin, y0 + 14, { lineBreak: false });

  // Report title (larger)
  doc.fillColor(C.ink)
     .font('Helvetica-Bold')
     .fontSize(18)
     .text(data.title, margin, y0 + 36);

  const titleBottom = doc.y;

  // Period pill (top-right)
  const dateStr = fmtPeriodShort(data.startDate, data.endDate);
  const pillW = doc.widthOfString(dateStr, { font: 'Helvetica', size: 9 }) + 20;
  const pillX = PAGE.width - margin - pillW;
  const pillY = y0 + 30;
  doc.roundedRect(pillX, pillY, pillW, 20, 4).fill(C.kpiBg);
  doc.fillColor(C.inkMid).font('Helvetica').fontSize(9)
     .text(dateStr, pillX, pillY + 5, { width: pillW, align: 'center', lineBreak: false });

  const headerBottom = Math.max(titleBottom, pillY + 22);
  hRule(doc, headerBottom + 8, C.accent, 1.5);
  return headerBottom + 20;
}

function fmtPeriodShort(start, end) {
  const fmt = d => {
    const dt = new Date(d + 'T12:00:00Z');
    return dt.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
  };
  return start === end ? fmt(start) : fmt(start) + ' – ' + fmt(end);
}

// ── KPI strip ─────────────────────────────────────────────────────────────────

function drawKPIs(doc, kpis, startY) {
  const { margin } = PAGE;
  const cols = Math.min(kpis.length, 3);
  const gutter = 8;
  const boxW = (CONTENT_W - gutter * (cols - 1)) / cols;
  const boxH = 64;
  let y = startY;

  for (let row = 0; row < Math.ceil(kpis.length / cols); row++) {
    for (let col = 0; col < cols; col++) {
      const i = row * cols + col;
      if (i >= kpis.length) break;
      const kpi = kpis[i];
      const x = margin + col * (boxW + gutter);

      doc.roundedRect(x, y, boxW, boxH, 5).fill(C.kpiBg);

      // Label
      doc.fillColor(C.inkLight).font('Helvetica').fontSize(7.5)
         .text(kpi.label.toUpperCase(), x + 10, y + 10, { width: boxW - 20, lineBreak: false });

      // Value
      const valSize = kpi.value.length > 14 ? 13 : kpi.value.length > 10 ? 14 : 16;
      doc.fillColor(C.ink).font('Helvetica-Bold').fontSize(valSize)
         .text(kpi.value, x + 10, y + 22, { width: boxW - 20, lineBreak: false });

      // Sub (trend)
      if (kpi.sub) {
        const subColor = kpi.subOk === true ? C.kpiOk : kpi.subOk === false ? C.kpiBad : C.inkMid;
        doc.fillColor(subColor).font('Helvetica').fontSize(7.5)
           .text(kpi.sub, x + 10, y + 44, { width: boxW - 20, lineBreak: false });
      }
    }
    y += boxH + gutter;
  }
  return y;
}

// ── Executive summary ─────────────────────────────────────────────────────────

function drawSummary(doc, text, startY) {
  if (!text) return startY;
  const { margin } = PAGE;
  const boxPad = 12;

  // Measure text height
  const opts = { width: CONTENT_W - boxPad * 2, lineBreak: true, font: 'Helvetica', fontSize: 9.5 };
  doc.font('Helvetica').fontSize(9.5);
  const textH = doc.heightOfString(text, opts);
  const boxH = textH + boxPad * 2 + 20;

  // Border-left accent box
  doc.rect(margin, startY, 3, boxH).fill(C.accent);
  doc.rect(margin + 3, startY, CONTENT_W - 3, boxH).fill(C.kpiBg);

  doc.fillColor(C.inkMid).font('Helvetica-Bold').fontSize(7.5)
     .text('EXECUTIVE SUMMARY', margin + 14, startY + boxPad, { lineBreak: false });

  doc.fillColor(C.ink).font('Helvetica').fontSize(9.5)
     .text(text, margin + 14, startY + boxPad + 14, { width: CONTENT_W - 26, lineBreak: true });

  return startY + boxH + 12;
}

// ── Bar chart ─────────────────────────────────────────────────────────────────

function drawBarChart(doc, chartData, startY, title) {
  if (!chartData || !chartData.length) return startY;
  const { margin } = PAGE;

  const chartH   = 100;
  const labelPad = 30;
  const barArea  = CONTENT_W - labelPad;
  const maxVal   = Math.max(...chartData.map(d => d.value), 1);
  const barW     = Math.max(8, Math.floor((barArea / chartData.length) * 0.65));
  const gap      = Math.floor(barArea / chartData.length);

  // Section title
  if (title) {
    doc.fillColor(C.inkMid).font('Helvetica-Bold').fontSize(8)
       .text(title.toUpperCase(), margin, startY, { lineBreak: false });
    startY += 14;
  }

  // Grid lines + y-axis labels
  const gridLines = 4;
  for (let i = 0; i <= gridLines; i++) {
    const gy = startY + chartH - (i / gridLines) * chartH;
    hRule(doc, gy, C.rule, 0.3);
    if (i > 0) {
      const v = Math.round((maxVal * i / gridLines) / 1000);
      doc.fillColor(C.inkLight).font('Helvetica').fontSize(6)
         .text(v + 'k', margin, gy - 4, { lineBreak: false });
    }
  }

  chartData.forEach((d, idx) => {
    const barH  = Math.max(2, Math.round((d.value / maxVal) * chartH));
    const barX  = margin + labelPad + idx * gap + (gap - barW) / 2;
    const barY  = startY + chartH - barH;
    const color = C.chartBars[idx % C.chartBars.length];

    doc.rect(barX, barY, barW, barH).fill(color);

    // Label under bar
    const label = d.label.length > 8 ? d.label.slice(0, 7) + '…' : d.label;
    doc.fillColor(C.inkLight).font('Helvetica').fontSize(6)
       .text(label, barX - 4, startY + chartH + 3, { width: barW + 8, align: 'center', lineBreak: false });
  });

  return startY + chartH + 18;
}

// ── Data table ────────────────────────────────────────────────────────────────

function drawTable(doc, data, startY) {
  const { margin } = PAGE;
  if (!data.tableRows || !data.tableRows.length) {
    doc.fillColor(C.inkLight).font('Helvetica-Oblique').fontSize(9)
       .text('No records found for this period.', margin, startY);
    return startY + 24;
  }

  const rowH  = 16;
  const hdrH  = 18;
  const colW  = data.tableColWidths;
  const align = data.tableAlign || data.tableHeaders.map(() => 'left');

  // Section header
  doc.fillColor(C.inkMid).font('Helvetica-Bold').fontSize(8)
     .text('TRANSACTION DATA', margin, startY, { lineBreak: false });
  startY += 14;

  // Header row
  doc.rect(margin, startY, CONTENT_W, hdrH).fill(C.rowHdr);
  let cx = margin;
  data.tableHeaders.forEach((h, i) => {
    doc.fillColor('#FFFFFF').font('Helvetica-Bold').fontSize(7)
       .text(h, cx + 4, startY + 5, { width: colW[i] - 6, lineBreak: false, align: align[i] || 'left' });
    cx += colW[i];
  });
  startY += hdrH;

  // Check if we need to paginate
  const usableH = PAGE.height - PAGE.margin - 60; // leave room for footer

  data.tableRows.forEach((row, ri) => {
    // Page break?
    if (startY + rowH > usableH) {
      doc.addPage();
      drawPageFooter(doc, data);
      startY = PAGE.margin;

      // Repeat column headers
      doc.rect(margin, startY, CONTENT_W, hdrH).fill(C.rowHdr);
      let cx2 = margin;
      data.tableHeaders.forEach((h, i) => {
        doc.fillColor('#FFFFFF').font('Helvetica-Bold').fontSize(7)
           .text(h, cx2 + 4, startY + 5, { width: colW[i] - 6, lineBreak: false, align: align[i] || 'left' });
        cx2 += colW[i];
      });
      startY += hdrH;
    }

    if (ri % 2 === 1) {
      doc.rect(margin, startY, CONTENT_W, rowH).fill(C.rowAlt);
    }

    cx = margin;
    row.forEach((cell, ci) => {
      const al = align[ci] || 'left';
      const isAccent = cell && (cell.toString().includes('Shortage') || cell.toString().includes('shortage'));
      const isOk     = cell && (cell.toString() === 'Matched' || cell.toString() === 'Balanced');
      const cellColor = isAccent ? C.kpiBad : isOk ? C.kpiOk : C.ink;
      doc.fillColor(cellColor).font('Helvetica').fontSize(7.5)
         .text(String(cell ?? ''), cx + 4, startY + 4, { width: colW[ci] - 6, lineBreak: false, align: al });
      cx += colW[ci];
    });
    startY += rowH;
  });

  // Totals row
  if (data.tableTotals) {
    doc.rect(margin, startY, CONTENT_W, hdrH).fill(C.accent);
    cx = margin;
    data.tableTotals.forEach((cell, ci) => {
      doc.fillColor('#FFFFFF').font('Helvetica-Bold').fontSize(7)
         .text(String(cell ?? ''), cx + 4, startY + 5, { width: colW[ci] - 6, lineBreak: false, align: align[ci] || 'left' });
      cx += colW[ci];
    });
    startY += hdrH;
  }

  // Table note
  if (data.tableNote) {
    startY += 4;
    doc.fillColor(C.inkLight).font('Helvetica-Oblique').fontSize(7.5)
       .text('* ' + data.tableNote, margin, startY, { width: CONTENT_W, lineBreak: true });
    startY = doc.y + 4;
  }

  return startY;
}

// ── Footer ────────────────────────────────────────────────────────────────────

function drawPageFooter(doc, data) {
  const y = PAGE.height - PAGE.margin + 8;
  hRule(doc, y - 4, C.rule);
  doc.fillColor(C.inkLight).font('Helvetica').fontSize(7)
     .text('Generated ' + new Date().toLocaleString('en-GB', { dateStyle: 'long', timeStyle: 'short' }) + ' · Confidential', PAGE.margin, y, { lineBreak: false })
     .text(data.title, PAGE.margin, y, { width: CONTENT_W, align: 'right', lineBreak: false });
}

// ── Main generate function ────────────────────────────────────────────────────

function generate(data, brandName) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'A4',
      margin: 0,
      info: {
        Title:   data.title,
        Author:  brandName || 'Optimize',
        Subject: 'Business Report',
        Creator: 'Optimize Dashboard',
      },
      compress: true,
    });

    const chunks = [];
    doc.on('data', c => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    // Page background
    doc.rect(0, 0, PAGE.width, PAGE.height).fill(C.bg);

    let y = drawHeader(doc, data, brandName);

    y = drawKPIs(doc, data.kpis, y);
    y += 12;

    y = drawSummary(doc, data.summary, y);

    // Chart (if present)
    if (data.chartData && data.chartData.length) {
      // Section header
      y += 4;
      y = drawBarChart(doc, data.chartData, y, data.chartTitle || null);
      y += 8;
    }

    hRule(doc, y, C.rule);
    y += 12;

    // Table
    drawTable(doc, data, y);

    // Footer on last page (all pages via page loop, but doc.on('pageAdded') is fine)
    const totalPages = doc.bufferedPageRange ? doc.bufferedPageRange() : null;

    drawPageFooter(doc, data);

    doc.end();
  });
}

module.exports = { generate };
