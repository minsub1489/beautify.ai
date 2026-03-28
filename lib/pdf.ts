import pdf from 'pdf-parse';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import type { VisualSpec } from './types';

export async function extractPdfText(bytes: Buffer) {
  const parsed = await pdf(bytes);
  return parsed.text || '';
}

export async function annotatePdfWithNotes(params: {
  originalPdf: Buffer;
  notesByPage: { page: number; notes: string }[];
  visuals: VisualSpec[];
}) {
  const doc = await PDFDocument.load(params.originalPdf);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const fontBold = await doc.embedFont(StandardFonts.HelveticaBold);

  for (const item of params.notesByPage) {
    const pages = doc.getPages();
    const pageIndex = Math.max(0, Math.min(item.page - 1, pages.length - 1));
    const page = pages[pageIndex];
    const { width, height } = page.getSize();
    const noteWidth = Math.min(248, Math.max(190, width * 0.28));
    const maxCardHeight = Math.min(height * 0.72, 420);
    const noteLines = wrapText(item.notes, 30);
    const important = extractImportantPoints(item.notes).slice(0, 3);

    const estimatedHeight = Math.min(
      maxCardHeight,
      64 + important.length * 44 + Math.max(48, noteLines.length * 11.2),
    );
    const placement = pickPlacement({
      pageIndex,
      width,
      height,
      noteWidth,
      noteHeight: estimatedHeight,
      text: item.notes,
    });
    const cardX = placement.x;
    const cardY = placement.y;

    page.drawRectangle({
      x: cardX,
      y: cardY,
      width: noteWidth,
      height: estimatedHeight,
      color: rgb(0.97, 0.98, 1),
      opacity: 0.97,
      borderColor: rgb(0.84, 0.89, 0.98),
      borderWidth: 1,
    });

    page.drawText('AI 필기', {
      x: cardX + 12,
      y: cardY + estimatedHeight - 20,
      size: 11,
      font: fontBold,
      color: rgb(0.16, 0.24, 0.55),
    });

    let y = cardY + estimatedHeight - 38;

    if (important.length) {
      page.drawText('형광펜 포인트', {
        x: cardX + 12,
        y,
        size: 8.5,
        font: fontBold,
        color: rgb(0.47, 0.39, 0.03),
      });
      y -= 12;
      for (const point of important) {
        const pointLines = wrapText(point, 24).slice(0, 2);
        const boxHeight = Math.max(18, pointLines.length * 10 + 6);
        page.drawRectangle({
          x: cardX + 10,
          y: y - boxHeight + 4,
          width: noteWidth - 20,
          height: boxHeight,
          color: rgb(1, 0.95, 0.55),
          opacity: 0.72,
        });
        let pointY = y - 4;
        for (const line of pointLines) {
          page.drawText(line, {
            x: cardX + 14,
            y: pointY,
            size: 8.2,
            font,
            color: rgb(0.24, 0.23, 0.16),
          });
          pointY -= 9.5;
        }
        y -= boxHeight + 6;
        if (y < 120) break;
      }

      // Tiny sticky memo block.
      page.drawRectangle({
        x: cardX + 10,
        y: y - 32,
        width: noteWidth - 20,
        height: 28,
        color: rgb(1, 0.98, 0.85),
        opacity: 0.92,
      });
      page.drawText('메모: 시험 전 이 포인트만 빠르게 복습', {
        x: cardX + 14,
        y: y - 20,
        size: 7.6,
        font,
        color: rgb(0.39, 0.3, 0.15),
      });
      y -= 40;
    }

    const lines = noteLines;
    let lineCursor = 0;
    for (const line of lines) {
      page.drawText(line, {
        x: cardX + 12,
        y,
        size: 8.5,
        font,
        color: rgb(0.12, 0.12, 0.15),
      });
      y -= 11.2;
      lineCursor += 1;
      if (y < cardY + 10) break;
    }

    const overflow = lines.slice(lineCursor);
    if (overflow.length) {
      insertContinuationNotePages({
        doc,
        sourcePage: item.page,
        lines: overflow,
        font,
        fontBold,
      });
    }
  }

  for (const visual of params.visuals.slice(0, 3)) {
    const page = doc.addPage([842, 595]);
    const { width, height } = page.getSize();
    page.drawText(visual.title, { x: 40, y: height - 40, size: 20, font: fontBold, color: rgb(0.1, 0.1, 0.15) });
    page.drawText(visual.caption, { x: 40, y: height - 64, size: 10, font, color: rgb(0.35, 0.36, 0.42), maxWidth: width - 80 });

    if (visual.kind === 'graph' && visual.graph) drawGraph(page, visual, font, fontBold);
    if (visual.kind === 'timeline' && visual.timeline) drawTimeline(page, visual, font, fontBold);
    if (visual.kind === 'table' && visual.table) drawTable(page, visual, font, fontBold);
    if (visual.kind === 'flowchart' && visual.flowchart) drawFlowchart(page, visual, font, fontBold);
  }

  return Buffer.from(await doc.save());
}

function pickPlacement(params: {
  pageIndex: number;
  width: number;
  height: number;
  noteWidth: number;
  noteHeight: number;
  text: string;
}) {
  const baseMargin = Math.max(14, params.width * 0.02);
  const side = params.pageIndex % 2 === 0 ? 'right' : 'left';

  let x = side === 'right'
    ? params.width - params.noteWidth - baseMargin
    : baseMargin;

  const normalized = params.text.replace(/\s+/g, ' ').trim();
  const hash = normalized.split('').reduce((acc, ch) => (acc + ch.charCodeAt(0)) % 97, 0);
  const bucket = hash % 3; // top / middle / lower
  const availableY = params.height - params.noteHeight - baseMargin;
  let y = baseMargin;

  if (bucket === 0) y = Math.max(baseMargin, availableY);
  if (bucket === 1) y = Math.max(baseMargin, availableY * 0.56);
  if (bucket === 2) y = Math.max(baseMargin, availableY * 0.18);

  if (params.noteWidth > params.width * 0.46) {
    x = Math.max(baseMargin, params.width - params.noteWidth - baseMargin);
  }

  return {
    x,
    y,
  };
}

function insertContinuationNotePages(params: {
  doc: PDFDocument;
  sourcePage: number;
  lines: string[];
  font: any;
  fontBold: any;
}) {
  let cursor = 0;
  let pageCount = 0;

  while (cursor < params.lines.length) {
    const page = params.doc.addPage([842, 595]);
    pageCount += 1;

    const { width, height } = page.getSize();
    page.drawRectangle({
      x: 24,
      y: 24,
      width: width - 48,
      height: height - 48,
      color: rgb(0.985, 0.992, 1),
      opacity: 0.98,
    });

    page.drawText(`추가 필기 · 원본 ${params.sourcePage}페이지`, {
      x: 42,
      y: height - 42,
      size: 14,
      font: params.fontBold,
      color: rgb(0.16, 0.24, 0.55),
    });

    page.drawText(`자동 확장 페이지 ${pageCount}`, {
      x: width - 190,
      y: height - 42,
      size: 10,
      font: params.font,
      color: rgb(0.4, 0.45, 0.55),
    });

    let y = height - 68;
    while (cursor < params.lines.length) {
      page.drawText(params.lines[cursor], {
        x: 42,
        y,
        size: 10.5,
        font: params.font,
        color: rgb(0.14, 0.14, 0.18),
        maxWidth: width - 84,
      });
      y -= 14;
      cursor += 1;
      if (y < 36) break;
    }
  }

  return pageCount;
}

function drawGraph(page: any, visual: VisualSpec, font: any, fontBold: any) {
  const box = { x: 70, y: 90, w: 670, h: 380 };
  page.drawRectangle({ x: box.x, y: box.y, width: box.w, height: box.h, borderColor: rgb(0.8, 0.84, 0.92), borderWidth: 1 });
  page.drawLine({ start: { x: box.x + 40, y: box.y + 30 }, end: { x: box.x + 40, y: box.y + box.h - 30 }, thickness: 1.5, color: rgb(0.25, 0.28, 0.32) });
  page.drawLine({ start: { x: box.x + 40, y: box.y + 30 }, end: { x: box.x + box.w - 30, y: box.y + 30 }, thickness: 1.5, color: rgb(0.25, 0.28, 0.32) });

  const allPoints = visual.graph!.series.flatMap((s) => s.points);
  const xs = allPoints.map((p) => p.x);
  const ys = allPoints.map((p) => p.y);
  const minX = Math.min(...xs, 0);
  const maxX = Math.max(...xs, 1);
  const minY = Math.min(...ys, 0);
  const maxY = Math.max(...ys, 1);
  const plotW = box.w - 80;
  const plotH = box.h - 70;

  visual.graph!.series.forEach((series, idx) => {
    let prev: { x: number; y: number } | null = null;
    for (const p of series.points) {
      const px = box.x + 40 + ((p.x - minX) / Math.max(1e-6, maxX - minX)) * plotW;
      const py = box.y + 30 + ((p.y - minY) / Math.max(1e-6, maxY - minY)) * plotH;
      const flipped = { x: px, y: py };
      page.drawCircle({ x: flipped.x, y: flipped.y, size: 2.5, color: idx % 2 === 0 ? rgb(0.14, 0.35, 0.8) : rgb(0.8, 0.25, 0.25) });
      if (prev) page.drawLine({ start: prev, end: flipped, thickness: 1.8, color: idx % 2 === 0 ? rgb(0.14, 0.35, 0.8) : rgb(0.8, 0.25, 0.25) });
      if (p.label) page.drawText(p.label, { x: flipped.x + 4, y: flipped.y + 4, size: 8, font, color: rgb(0.33, 0.33, 0.4) });
      prev = flipped;
    }
    page.drawText(series.label, { x: box.x + 470, y: box.y + box.h - 24 - idx * 14, size: 9, font: fontBold, color: idx % 2 === 0 ? rgb(0.14, 0.35, 0.8) : rgb(0.8, 0.25, 0.25) });
  });

  page.drawText(visual.graph!.xLabel, { x: box.x + box.w / 2 - 20, y: box.y + 8, size: 10, font: fontBold, color: rgb(0.22, 0.22, 0.28) });
  page.drawText(visual.graph!.yLabel, { x: box.x + 6, y: box.y + box.h / 2, size: 10, font: fontBold, color: rgb(0.22, 0.22, 0.28) });
}

function drawTimeline(page: any, visual: VisualSpec, font: any, fontBold: any) {
  const events = visual.timeline!.events.slice(0, 8);
  const x = 120;
  const startY = 470;
  const gap = 48;
  page.drawLine({ start: { x, y: startY + 20 }, end: { x, y: startY - (events.length - 1) * gap - 20 }, thickness: 2, color: rgb(0.25, 0.35, 0.74) });
  events.forEach((event, i) => {
    const y = startY - i * gap;
    page.drawCircle({ x, y, size: 6, color: rgb(0.25, 0.35, 0.74) });
    page.drawText(event.year, { x: 40, y: y - 4, size: 11, font: fontBold, color: rgb(0.18, 0.22, 0.34) });
    page.drawText(event.label, { x: 145, y: y + 6, size: 11, font: fontBold, color: rgb(0.1, 0.1, 0.14), maxWidth: 560 });
    if (event.detail) page.drawText(event.detail, { x: 145, y: y - 10, size: 9, font, color: rgb(0.38, 0.39, 0.45), maxWidth: 560 });
  });
}

function drawTable(page: any, visual: VisualSpec, font: any, fontBold: any) {
  const cols = visual.table!.columns;
  const rows = visual.table!.rows.slice(0, 8);
  const startX = 50;
  const startY = 450;
  const tableW = 740;
  const colW = tableW / Math.max(1, cols.length);
  const rowH = 38;
  cols.forEach((col, i) => {
    page.drawRectangle({ x: startX + i * colW, y: startY, width: colW, height: rowH, borderColor: rgb(0.75, 0.8, 0.9), borderWidth: 1, color: rgb(0.95, 0.97, 1) });
    page.drawText(col, { x: startX + i * colW + 8, y: startY + 14, size: 10, font: fontBold, color: rgb(0.16, 0.22, 0.42), maxWidth: colW - 16 });
  });
  rows.forEach((row, r) => {
    row.forEach((cell, i) => {
      const y = startY - (r + 1) * rowH;
      page.drawRectangle({ x: startX + i * colW, y, width: colW, height: rowH, borderColor: rgb(0.82, 0.85, 0.9), borderWidth: 1 });
      page.drawText(cell, { x: startX + i * colW + 8, y: y + 12, size: 9, font, color: rgb(0.1, 0.1, 0.14), maxWidth: colW - 16 });
    });
  });
}

function drawFlowchart(page: any, visual: VisualSpec, font: any, fontBold: any) {
  const nodes = visual.flowchart!.nodes.slice(0, 6);
  const startX = 110;
  const startY = 430;
  const boxW = 180;
  const boxH = 56;
  const gapY = 74;

  nodes.forEach((node, i) => {
    const x = startX + (i % 2) * 280;
    const y = startY - Math.floor(i / 2) * gapY;
    page.drawRectangle({ x, y, width: boxW, height: boxH, borderColor: rgb(0.72, 0.8, 0.95), borderWidth: 1.2, color: rgb(0.97, 0.98, 1) });
    page.drawText(node.label, { x: x + 10, y: y + 22, size: 10, font: fontBold, color: rgb(0.13, 0.15, 0.22), maxWidth: boxW - 20 });
  });

  visual.flowchart!.edges.slice(0, 6).forEach((edge) => {
    const from = nodes.findIndex((n) => n.id === edge.from);
    const to = nodes.findIndex((n) => n.id === edge.to);
    if (from < 0 || to < 0) return;
    const fx = startX + (from % 2) * 280 + boxW / 2;
    const fy = startY - Math.floor(from / 2) * gapY;
    const tx = startX + (to % 2) * 280 + boxW / 2;
    const ty = startY - Math.floor(to / 2) * gapY + boxH;
    page.drawLine({ start: { x: fx, y: fy }, end: { x: tx, y: ty }, thickness: 1.2, color: rgb(0.45, 0.5, 0.6) });
    if (edge.label) page.drawText(edge.label, { x: (fx + tx) / 2 + 4, y: (fy + ty) / 2 + 4, size: 8, font, color: rgb(0.4, 0.4, 0.46) });
  });
}

function wrapText(text: string, maxLen: number) {
  const words = text.replace(/\s+/g, ' ').trim().split(' ');
  const lines: string[] = [];
  let current = '';
  for (const word of words) {
    const next = current ? `${current} ${word}` : word;
    if (next.length <= maxLen) current = next;
    else {
      if (current) lines.push(current);
      current = word;
    }
  }
  if (current) lines.push(current);
  return lines;
}

function extractImportantPoints(text: string) {
  const chunks = text
    .split(/\n|(?<=[.!?])\s+/)
    .map((chunk) => chunk.replace(/\s+/g, ' ').trim())
    .filter(Boolean);

  const priority = /핵심|중요|시험|주의|정의|공식|비교|포인트|결론|필수/i;
  const ranked = [...chunks].sort((a, b) => scoreChunk(b, priority) - scoreChunk(a, priority));
  return ranked;
}

function scoreChunk(chunk: string, priority: RegExp) {
  let score = Math.min(60, chunk.length);
  if (priority.test(chunk)) score += 120;
  if (/\d/.test(chunk)) score += 16;
  if (/[=:→]/.test(chunk)) score += 12;
  return score;
}
