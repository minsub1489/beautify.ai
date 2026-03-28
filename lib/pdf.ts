import fs from 'node:fs/promises';
import path from 'node:path';
import pdf from 'pdf-parse';
import fontkit from '@pdf-lib/fontkit';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import type { VisualSpec } from './types';

type EmbeddedFonts = {
  body: any;
  bodyBold: any;
  label: any;
};

type NotePlacement = {
  x: number;
  y: number;
  width: number;
  height: number;
  side: 'left' | 'right';
};

type Box = {
  x: number;
  y: number;
  w: number;
  h: number;
};

const FONT_CANDIDATES = [
  process.env.PDF_ANNOTATION_FONT_PATH,
  path.join(process.cwd(), 'assets/fonts/NotoSansKR-Regular.ttf'),
  '/System/Library/Fonts/Supplemental/AppleGothic.ttf',
  '/System/Library/Fonts/Supplemental/AppleMyungjo.ttf',
  '/System/Library/Fonts/Supplemental/Arial Unicode.ttf',
  '/Library/Fonts/Arial Unicode.ttf',
].filter((value): value is string => Boolean(value));

export async function extractPdfText(bytes: Buffer) {
  const parsed = await pdf(bytes);
  return parsed.text || '';
}

export async function extractPdfTextsByPage(bytes: Buffer) {
  const pageTexts: string[] = [];
  await pdf(bytes, {
    pagerender: async (pageData: any) => {
      const textContent = await pageData.getTextContent({
        normalizeWhitespace: false,
        disableCombineTextItems: false,
      });

      let lastY: number | undefined;
      let text = '';
      for (const item of textContent.items as Array<{ str?: string; transform?: number[] }>) {
        const value = typeof item.str === 'string' ? item.str : '';
        const y = Array.isArray(item.transform) ? item.transform[5] : undefined;
        if (lastY === y || typeof lastY === 'undefined') {
          text += value;
        } else {
          text += `\n${value}`;
        }
        lastY = y;
      }

      pageTexts.push(text.trim());
      return text;
    },
  });
  return pageTexts;
}

export async function annotatePdfWithNotes(params: {
  originalPdf: Buffer;
  notesByPage: { page: number; notes: string }[];
  visuals: VisualSpec[];
}) {
  const doc = await PDFDocument.load(params.originalPdf);
  const fonts = await loadPdfFonts(doc);
  const pages = doc.getPages();
  const notePlacements = new Map<number, NotePlacement>();

  for (const item of params.notesByPage) {
    const pageIndex = clampPageIndex(item.page, pages.length);
    const placement = drawInlineNoteCard({
      page: pages[pageIndex],
      pageIndex,
      pageNumber: item.page,
      notes: item.notes,
      doc,
      fonts,
    });
    notePlacements.set(pageIndex, placement);
  }

  const visualsByPage = bucketVisualsByPage(params.visuals, pages.length);
  for (const [pageIndex, visuals] of visualsByPage.entries()) {
    const page = pages[pageIndex];
    if (!page || !visuals.length) continue;

    const boxes = pickVisualBoxes(page, notePlacements.get(pageIndex), visuals);
    visuals.slice(0, boxes.length).forEach((visual, index) => {
      drawInlineVisualCard(page, visual, boxes[index], fonts);
    });

    const overflow = visuals.slice(boxes.length);
    if (overflow.length) {
      insertExtraVisualPages({
        doc,
        sourcePage: pageIndex + 1,
        visuals: overflow,
        fonts,
      });
    }
  }

  return Buffer.from(await doc.save());
}

async function loadPdfFonts(doc: PDFDocument): Promise<EmbeddedFonts> {
  const fallbackBody = await doc.embedFont(StandardFonts.Helvetica);
  const fallbackBold = await doc.embedFont(StandardFonts.HelveticaBold);

  for (const fontPath of FONT_CANDIDATES) {
    try {
      const bytes = await fs.readFile(fontPath);
      doc.registerFontkit(fontkit);
      const custom = await doc.embedFont(bytes, { subset: true });
      return {
        body: custom,
        bodyBold: custom,
        label: custom,
      };
    } catch {
      // Try the next candidate font.
    }
  }

  return {
    body: fallbackBody,
    bodyBold: fallbackBold,
    label: fallbackBold,
  };
}

function clampPageIndex(pageNumber: number, pageCount: number) {
  return Math.max(0, Math.min((pageNumber || 1) - 1, pageCount - 1));
}

function bucketVisualsByPage(visuals: VisualSpec[], pageCount: number) {
  const grouped = new Map<number, VisualSpec[]>();

  visuals.forEach((visual, index) => {
    const normalized = normalizeVisual(visual, index + 1);
    if (!normalized) return;
    const pageIndex = clampPageIndex(normalized.page || 1, pageCount);
    grouped.set(pageIndex, [...(grouped.get(pageIndex) || []), normalized]);
  });

  return grouped;
}

function normalizeVisual(visual: VisualSpec, fallbackPage: number) {
  const page = Number(visual.page || fallbackPage);
  const normalizedPage = Number.isFinite(page) && page > 0 ? Math.trunc(page) : fallbackPage;

  const base: VisualSpec = {
    ...visual,
    page: normalizedPage,
    title: (visual.title || '').trim() || '추가 필기 카드',
    caption: (visual.caption || '').trim(),
  };

  if (base.kind === 'graph' && base.graph?.series?.length) return base;
  if (base.kind === 'timeline' && base.timeline?.events?.length) return base;
  if (base.kind === 'table' && base.table?.columns?.length && base.table?.rows?.length) return base;
  if (base.kind === 'flowchart' && base.flowchart?.nodes?.length) return base;
  if (base.kind === 'formula' && base.formula?.expression?.trim()) return base;
  return null;
}

function drawInlineNoteCard(params: {
  page: any;
  pageIndex: number;
  pageNumber: number;
  notes: string;
  doc: PDFDocument;
  fonts: EmbeddedFonts;
}) {
  const { width, height } = params.page.getSize();
  const noteWidth = Math.min(218, Math.max(176, width * 0.25));
  const maxCardHeight = Math.min(height * 0.62, 360);
  const noteLines = wrapText(params.notes, 24);
  const important = extractImportantPoints(params.notes).slice(0, 3);

  const estimatedHeight = Math.min(
    maxCardHeight,
    58 + important.length * 34 + Math.max(42, noteLines.length * 10.6),
  );
  const placement = pickPlacement({
    pageIndex: params.pageIndex,
    width,
    height,
    noteWidth,
    noteHeight: estimatedHeight,
    text: params.notes,
  });

  params.page.drawRectangle({
    x: placement.x,
    y: placement.y,
    width: noteWidth,
    height: estimatedHeight,
    color: rgb(0.98, 0.985, 1),
    opacity: 0.96,
    borderColor: rgb(0.84, 0.89, 0.98),
    borderWidth: 1,
  });

  drawTextSafe(params.page, `AI Note · Page ${params.pageNumber}`, {
    x: placement.x + 10,
    y: placement.y + estimatedHeight - 18,
    size: 9.6,
    font: params.fonts.label,
    color: rgb(0.16, 0.24, 0.55),
  });

  let y = placement.y + estimatedHeight - 34;

  if (important.length) {
    drawTextSafe(params.page, 'Key points', {
      x: placement.x + 10,
      y,
      size: 8,
      font: params.fonts.label,
      color: rgb(0.46, 0.38, 0.05),
    });
    y -= 11;

    for (const point of important) {
      const pointLines = wrapText(point, 20).slice(0, 2);
      const boxHeight = Math.max(16, pointLines.length * 9 + 5);
      params.page.drawRectangle({
        x: placement.x + 8,
        y: y - boxHeight + 4,
        width: noteWidth - 16,
        height: boxHeight,
        color: rgb(1, 0.95, 0.56),
        opacity: 0.72,
      });

      let pointY = y - 4;
      for (const line of pointLines) {
        drawTextSafe(params.page, line, {
          x: placement.x + 12,
          y: pointY,
          size: 7.8,
          font: params.fonts.body,
          color: rgb(0.24, 0.23, 0.16),
        });
        pointY -= 8.8;
      }
      y -= boxHeight + 5;
      if (y < placement.y + 90) break;
    }
  }

  let lineCursor = 0;
  for (const line of noteLines) {
    drawTextSafe(params.page, line, {
      x: placement.x + 10,
      y,
      size: 8.4,
      font: params.fonts.body,
      color: rgb(0.12, 0.12, 0.15),
    });
    y -= 10.6;
    lineCursor += 1;
    if (y < placement.y + 10) break;
  }

  const overflow = noteLines.slice(lineCursor);
  if (overflow.length) {
    insertContinuationNotePages({
      doc: params.doc,
      sourcePage: params.pageNumber,
      lines: overflow,
      fonts: params.fonts,
    });
  }

  return {
    x: placement.x,
    y: placement.y,
    width: noteWidth,
    height: estimatedHeight,
    side: placement.side,
  };
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
  const side: NotePlacement['side'] = params.pageIndex % 2 === 0 ? 'right' : 'left';

  let x = side === 'right'
    ? params.width - params.noteWidth - baseMargin
    : baseMargin;

  const normalized = params.text.replace(/\s+/g, ' ').trim();
  const hash = normalized.split('').reduce((acc, ch) => (acc + ch.charCodeAt(0)) % 97, 0);
  const bucket = hash % 3;
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
    side,
  };
}

function pickVisualBoxes(page: any, notePlacement: NotePlacement | undefined, visuals: VisualSpec[]) {
  const { width, height } = page.getSize();
  const margin = Math.max(14, width * 0.02);
  const side = notePlacement?.side === 'right' ? 'left' : 'right';
  const cardWidth = Math.min(226, Math.max(170, width * 0.24));
  const boxes: Box[] = [];

  let cursorY = height - margin;
  for (const visual of visuals) {
    const cardHeight = estimateVisualHeight(visual, height);
    const y = cursorY - cardHeight;
    if (y < margin) break;

    boxes.push({
      x: side === 'right' ? width - cardWidth - margin : margin,
      y,
      w: cardWidth,
      h: cardHeight,
    });

    cursorY = y - 12;
  }

  return boxes;
}

function estimateVisualHeight(visual: VisualSpec, pageHeight: number) {
  const base =
    visual.kind === 'graph' ? 172 :
    visual.kind === 'timeline' ? 180 :
    visual.kind === 'table' ? 164 :
    visual.kind === 'flowchart' ? 158 :
    138;
  return Math.min(base, pageHeight * 0.28);
}

function drawInlineVisualCard(page: any, visual: VisualSpec, box: Box, fonts: EmbeddedFonts) {
  page.drawRectangle({
    x: box.x,
    y: box.y,
    width: box.w,
    height: box.h,
    color: rgb(1, 0.985, 0.93),
    opacity: 0.97,
    borderColor: rgb(0.95, 0.82, 0.44),
    borderWidth: 1,
  });

  drawTextSafe(page, visual.title, {
    x: box.x + 10,
    y: box.y + box.h - 18,
    size: 9,
    font: fonts.label,
    color: rgb(0.44, 0.31, 0.04),
    maxWidth: box.w - 20,
  });

  if (visual.caption) {
    drawTextSafe(page, visual.caption, {
      x: box.x + 10,
      y: box.y + box.h - 30,
      size: 7.2,
      font: fonts.body,
      color: rgb(0.42, 0.39, 0.29),
      maxWidth: box.w - 20,
    });
  }

  const inner: Box = {
    x: box.x + 10,
    y: box.y + 10,
    w: box.w - 20,
    h: box.h - 48,
  };

  if (visual.kind === 'graph' && visual.graph) drawCompactGraph(page, visual, inner, fonts);
  if (visual.kind === 'timeline' && visual.timeline) drawCompactTimeline(page, visual, inner, fonts);
  if (visual.kind === 'table' && visual.table) drawCompactTable(page, visual, inner, fonts);
  if (visual.kind === 'flowchart' && visual.flowchart) drawCompactFlowchart(page, visual, inner, fonts);
  if (visual.kind === 'formula' && visual.formula) drawCompactFormula(page, visual, inner, fonts);
}

function insertContinuationNotePages(params: {
  doc: PDFDocument;
  sourcePage: number;
  lines: string[];
  fonts: EmbeddedFonts;
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

    drawTextSafe(page, `Extra Note · Source page ${params.sourcePage}`, {
      x: 42,
      y: height - 42,
      size: 14,
      font: params.fonts.label,
      color: rgb(0.16, 0.24, 0.55),
    });

    drawTextSafe(page, `Auto expanded page ${pageCount}`, {
      x: width - 190,
      y: height - 42,
      size: 10,
      font: params.fonts.body,
      color: rgb(0.4, 0.45, 0.55),
    });

    let y = height - 68;
    while (cursor < params.lines.length) {
      drawTextSafe(page, params.lines[cursor], {
        x: 42,
        y,
        size: 10.5,
        font: params.fonts.body,
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

function insertExtraVisualPages(params: {
  doc: PDFDocument;
  sourcePage: number;
  visuals: VisualSpec[];
  fonts: EmbeddedFonts;
}) {
  let cursor = 0;
  while (cursor < params.visuals.length) {
    const page = params.doc.addPage([595, 842]);
    drawTextSafe(page, `Extra Visual · Source page ${params.sourcePage}`, {
      x: 38,
      y: 812,
      size: 14,
      font: params.fonts.label,
      color: rgb(0.44, 0.31, 0.04),
    });

    const boxes: Box[] = [
      { x: 36, y: 440, w: 240, h: 170 },
      { x: 318, y: 440, w: 240, h: 170 },
      { x: 36, y: 220, w: 240, h: 170 },
      { x: 318, y: 220, w: 240, h: 170 },
    ];

    while (cursor < params.visuals.length && cursor % boxes.length !== 0) {
      break;
    }

    for (const box of boxes) {
      const visual = params.visuals[cursor];
      if (!visual) break;
      drawInlineVisualCard(page, visual, box, params.fonts);
      cursor += 1;
    }
  }
}

function drawCompactGraph(page: any, visual: VisualSpec, box: Box, fonts: EmbeddedFonts) {
  const allPoints = visual.graph?.series.flatMap((series) => series.points) || [];
  if (!allPoints.length) return;

  const padX = 20;
  const padY = 16;
  const plot: Box = {
    x: box.x + padX,
    y: box.y + padY,
    w: box.w - padX - 8,
    h: box.h - padY - 8,
  };

  page.drawRectangle({ x: plot.x, y: plot.y, width: plot.w, height: plot.h, borderColor: rgb(0.86, 0.88, 0.94), borderWidth: 1 });
  page.drawLine({ start: { x: plot.x + 12, y: plot.y + 12 }, end: { x: plot.x + 12, y: plot.y + plot.h - 10 }, thickness: 1, color: rgb(0.28, 0.3, 0.36) });
  page.drawLine({ start: { x: plot.x + 12, y: plot.y + 12 }, end: { x: plot.x + plot.w - 10, y: plot.y + 12 }, thickness: 1, color: rgb(0.28, 0.3, 0.36) });

  const xs = allPoints.map((point) => point.x);
  const ys = allPoints.map((point) => point.y);
  const minX = Math.min(...xs, 0);
  const maxX = Math.max(...xs, 1);
  const minY = Math.min(...ys, 0);
  const maxY = Math.max(...ys, 1);
  const plotW = plot.w - 24;
  const plotH = plot.h - 24;

  visual.graph?.series.slice(0, 2).forEach((series, seriesIndex) => {
    const color = seriesIndex === 0 ? rgb(0.2, 0.41, 0.86) : rgb(0.86, 0.29, 0.28);
    let prev: { x: number; y: number } | null = null;
    series.points.forEach((point) => {
      const px = plot.x + 12 + ((point.x - minX) / Math.max(1e-6, maxX - minX)) * plotW;
      const py = plot.y + 12 + ((point.y - minY) / Math.max(1e-6, maxY - minY)) * plotH;
      const position = { x: px, y: py };
      page.drawCircle({ x: position.x, y: position.y, size: 2, color });
      if (prev) page.drawLine({ start: prev, end: position, thickness: 1.1, color });
      prev = position;
    });

    drawTextSafe(page, series.label, {
      x: plot.x + plot.w - 72,
      y: plot.y + plot.h - 12 - seriesIndex * 10,
      size: 6.6,
      font: fonts.bodyBold,
      color,
      maxWidth: 66,
    });
  });

  drawTextSafe(page, visual.graph?.xLabel || 'x', {
    x: plot.x + plot.w / 2 - 12,
    y: box.y + 2,
    size: 6.8,
    font: fonts.bodyBold,
    color: rgb(0.28, 0.3, 0.36),
  });
  drawTextSafe(page, visual.graph?.yLabel || 'y', {
    x: box.x,
    y: plot.y + plot.h / 2,
    size: 6.8,
    font: fonts.bodyBold,
    color: rgb(0.28, 0.3, 0.36),
  });
}

function drawCompactTimeline(page: any, visual: VisualSpec, box: Box, fonts: EmbeddedFonts) {
  const events = visual.timeline?.events.slice(0, 4) || [];
  if (!events.length) return;

  const lineX = box.x + 24;
  const gap = Math.max(20, Math.min(32, (box.h - 18) / Math.max(1, events.length)));
  let cursorY = box.y + box.h - 14;

  page.drawLine({
    start: { x: lineX, y: box.y + 8 },
    end: { x: lineX, y: box.y + box.h - 8 },
    thickness: 1.5,
    color: rgb(0.25, 0.35, 0.74),
  });

  events.forEach((event) => {
    page.drawCircle({ x: lineX, y: cursorY, size: 3.6, color: rgb(0.25, 0.35, 0.74) });
    drawTextSafe(page, event.year, {
      x: box.x,
      y: cursorY - 3,
      size: 6.8,
      font: fonts.bodyBold,
      color: rgb(0.18, 0.22, 0.34),
      maxWidth: 20,
    });
    drawTextSafe(page, event.label, {
      x: lineX + 12,
      y: cursorY + 1,
      size: 7.4,
      font: fonts.bodyBold,
      color: rgb(0.1, 0.1, 0.14),
      maxWidth: box.w - 42,
    });
    if (event.detail) {
      drawTextSafe(page, event.detail, {
        x: lineX + 12,
        y: cursorY - 9,
        size: 6.4,
        font: fonts.body,
        color: rgb(0.38, 0.39, 0.45),
        maxWidth: box.w - 42,
      });
    }
    cursorY -= gap;
  });
}

function drawCompactTable(page: any, visual: VisualSpec, box: Box, fonts: EmbeddedFonts) {
  const columns = visual.table?.columns.slice(0, 3) || [];
  const rows = visual.table?.rows.slice(0, 3) || [];
  if (!columns.length || !rows.length) return;

  const rowHeight = Math.max(22, Math.min(28, box.h / (rows.length + 1.2)));
  const colWidth = box.w / columns.length;
  const startY = box.y + box.h - rowHeight;

  columns.forEach((column, index) => {
    page.drawRectangle({
      x: box.x + index * colWidth,
      y: startY,
      width: colWidth,
      height: rowHeight,
      borderColor: rgb(0.78, 0.84, 0.94),
      borderWidth: 1,
      color: rgb(0.96, 0.98, 1),
    });
    drawTextSafe(page, column, {
      x: box.x + index * colWidth + 4,
      y: startY + rowHeight - 9,
      size: 6.4,
      font: fonts.bodyBold,
      color: rgb(0.16, 0.22, 0.42),
      maxWidth: colWidth - 8,
    });
  });

  rows.forEach((row, rowIndex) => {
    row.slice(0, columns.length).forEach((cell, columnIndex) => {
      const y = startY - (rowIndex + 1) * rowHeight;
      page.drawRectangle({
        x: box.x + columnIndex * colWidth,
        y,
        width: colWidth,
        height: rowHeight,
        borderColor: rgb(0.82, 0.85, 0.9),
        borderWidth: 1,
      });
      drawTextSafe(page, cell, {
        x: box.x + columnIndex * colWidth + 4,
        y: y + rowHeight - 9,
        size: 6.2,
        font: fonts.body,
        color: rgb(0.1, 0.1, 0.14),
        maxWidth: colWidth - 8,
      });
    });
  });
}

function drawCompactFlowchart(page: any, visual: VisualSpec, box: Box, fonts: EmbeddedFonts) {
  const nodes = visual.flowchart?.nodes.slice(0, 3) || [];
  if (!nodes.length) return;

  const boxWidth = box.w - 28;
  const boxHeight = Math.max(24, Math.min(30, (box.h - 24) / nodes.length));
  let cursorY = box.y + box.h - boxHeight;

  nodes.forEach((node, index) => {
    page.drawRectangle({
      x: box.x + 14,
      y: cursorY,
      width: boxWidth,
      height: boxHeight,
      borderColor: rgb(0.72, 0.8, 0.95),
      borderWidth: 1,
      color: rgb(0.97, 0.98, 1),
    });
    drawTextSafe(page, node.label, {
      x: box.x + 20,
      y: cursorY + boxHeight / 2 - 3,
      size: 7,
      font: fonts.bodyBold,
      color: rgb(0.13, 0.15, 0.22),
      maxWidth: boxWidth - 12,
    });

    if (index < nodes.length - 1) {
      page.drawLine({
        start: { x: box.x + box.w / 2, y: cursorY },
        end: { x: box.x + box.w / 2, y: cursorY - 10 },
        thickness: 1,
        color: rgb(0.45, 0.5, 0.6),
      });
    }
    cursorY -= boxHeight + 10;
  });
}

function drawCompactFormula(page: any, visual: VisualSpec, box: Box, fonts: EmbeddedFonts) {
  const expressionLines = wrapText(visual.formula?.expression || '', 22).slice(0, 2);
  let y = box.y + box.h - 16;

  for (const line of expressionLines) {
    drawTextSafe(page, line, {
      x: box.x + 6,
      y,
      size: 9.2,
      font: fonts.bodyBold,
      color: rgb(0.2, 0.16, 0.46),
      maxWidth: box.w - 12,
    });
    y -= 11;
  }

  if (visual.formula?.meaning) {
    drawTextSafe(page, visual.formula.meaning, {
      x: box.x + 6,
      y: y - 2,
      size: 7.1,
      font: fonts.body,
      color: rgb(0.22, 0.22, 0.28),
      maxWidth: box.w - 12,
    });
    y -= 22;
  }

  if (visual.formula?.example) {
    drawTextSafe(page, visual.formula.example, {
      x: box.x + 6,
      y: y - 2,
      size: 6.6,
      font: fonts.body,
      color: rgb(0.42, 0.39, 0.29),
      maxWidth: box.w - 12,
    });
  }
}

function normalizeDrawableText(input: string, font: any) {
  const value = (input || '').replace(/\r/g, '').trim();
  if (!value) return '';

  try {
    font.encodeText(value);
    return value;
  } catch {
    const safe = toWinAnsiSafeText(value);
    if (!safe) return '';
    try {
      font.encodeText(safe);
      return safe;
    } catch {
      return '';
    }
  }
}

function toWinAnsiSafeText(input: string) {
  return (input || '')
    .normalize('NFKD')
    .replace(/[^\x20-\x7E\xA0-\xFF]/g, '?')
    .replace(/\?{3,}/g, '??')
    .trim();
}

function drawTextSafe(page: any, text: string, options: any) {
  const safeText = normalizeDrawableText(text, options.font);
  if (!safeText) return;
  page.drawText(safeText, options);
}

function wrapText(text: string, maxLen: number) {
  const tokens = text.replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
  const lines: string[] = [];
  let current = '';

  for (const token of tokens) {
    if (token.length > maxLen) {
      if (current) {
        lines.push(current);
        current = '';
      }
      for (let index = 0; index < token.length; index += maxLen) {
        lines.push(token.slice(index, index + maxLen));
      }
      continue;
    }

    const next = current ? `${current} ${token}` : token;
    if (next.length <= maxLen) {
      current = next;
    } else {
      if (current) lines.push(current);
      current = token;
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
  return [...chunks].sort((a, b) => scoreChunk(b, priority) - scoreChunk(a, priority));
}

function scoreChunk(chunk: string, priority: RegExp) {
  let score = Math.min(60, chunk.length);
  if (priority.test(chunk)) score += 120;
  if (/\d/.test(chunk)) score += 16;
  if (/[=:→]/.test(chunk)) score += 12;
  return score;
}
