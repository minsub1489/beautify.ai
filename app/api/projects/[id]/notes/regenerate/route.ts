import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { annotatePdfWithNotes, extractPdfTextsByPage } from '@/lib/pdf';
import { regeneratePageNote } from '@/lib/ai';
import { regenerateLocalPageNote } from '@/lib/local-study';
import { deleteStoredFile, putBuffer, readStoredFile } from '@/lib/storage';
import type { NotesByPage, VisualSpec } from '@/lib/types';

const LOCAL_PIPELINE_MODE = (process.env.AI_USE_LOCAL_PIPELINE || '').toLowerCase() === 'true';

async function readPdfAssetBytes(asset: { storageKey: string; publicUrl: string }) {
  if (asset.storageKey.startsWith('/')) {
    return readStoredFile(asset.storageKey);
  }

  const response = await fetch(asset.publicUrl);
  if (!response.ok) {
    throw new Error(`PDF 원본을 불러오지 못했습니다. (status ${response.status})`);
  }
  return Buffer.from(await response.arrayBuffer());
}

function parseNotesByPage(raw: unknown): NotesByPage {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((item) => {
      if (!item || typeof item !== 'object') return null;
      const record = item as Record<string, unknown>;
      const page = typeof record.page === 'number' ? record.page : Number(record.page);
      const notes = typeof record.notes === 'string' ? record.notes.trim() : '';
      if (!Number.isFinite(page) || page <= 0 || !notes) return null;
      return { page, notes };
    })
    .filter((item): item is NotesByPage[number] => Boolean(item));
}

function parseVisuals(raw: unknown): VisualSpec[] {
  return Array.isArray(raw) ? (raw as VisualSpec[]) : [];
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const body = await req.json().catch(() => ({}));
    const page = Number(body?.page);

    if (!Number.isFinite(page) || page <= 0) {
      return NextResponse.json({ error: '재생성할 페이지 번호가 올바르지 않습니다.' }, { status: 400 });
    }

    const [project, latestRun, latestPdf] = await Promise.all([
      prisma.project.findUnique({ where: { id } }),
      prisma.generationRun.findFirst({
        where: { projectId: id },
        orderBy: { createdAt: 'desc' },
      }),
      prisma.asset.findFirst({
        where: { projectId: id, kind: 'pdf' },
        orderBy: { createdAt: 'desc' },
      }),
    ]);

    if (!project || !latestRun || !latestPdf) {
      return NextResponse.json({ error: '페이지 필기를 다시 만들 자료를 찾을 수 없습니다.' }, { status: 404 });
    }

    const originalPdf = await readPdfAssetBytes({
      storageKey: latestPdf.storageKey,
      publicUrl: latestPdf.publicUrl,
    });
    const pageTexts = await extractPdfTextsByPage(originalPdf);
    const pageText = pageTexts[page - 1]?.trim() || '';

    if (!pageText) {
      return NextResponse.json({ error: '해당 페이지의 본문을 읽지 못했습니다.' }, { status: 400 });
    }

    const notesByPage = parseNotesByPage(latestRun.notesByPageJson);
    const visuals = parseVisuals(latestRun.visualsJson);
    const existingNote = notesByPage.find((item) => item.page === page)?.notes || '';
    const transcriptText = typeof latestRun.transcriptExtract === 'string' ? latestRun.transcriptExtract : '';
    const notionText = typeof latestRun.notionExtract === 'string' ? latestRun.notionExtract : '';
    const customNotes = typeof latestRun.customNotes === 'string' ? latestRun.customNotes : '';
    const summary = typeof latestRun.summary === 'string' ? latestRun.summary : '';
    const examFocus = Array.isArray(latestRun.examFocusJson)
      ? latestRun.examFocusJson.filter((item): item is string => typeof item === 'string')
      : [];

    let regeneratedNote = '';
    if (LOCAL_PIPELINE_MODE) {
      regeneratedNote = regenerateLocalPageNote({
        pageText,
        currentNote: existingNote,
      });
    } else {
      try {
        regeneratedNote = await regeneratePageNote({
          subject: project.subject ?? '미지정',
          lectureTitle: project.title,
          pageNumber: page,
          pageText,
          currentNote: existingNote,
          fullSummary: summary,
          examFocus,
          transcriptText,
          notionText,
          customNotes,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : '';
        if (/quota|rate limit|429|insufficient_quota|RESOURCE_EXHAUSTED/i.test(message)) {
          regeneratedNote = regenerateLocalPageNote({
            pageText,
            currentNote: existingNote,
          });
        } else {
          throw error;
        }
      }
    }

    const nextNotesByPage = notesByPage.some((item) => item.page === page)
      ? notesByPage.map((item) => (item.page === page ? { ...item, notes: regeneratedNote } : item))
      : [...notesByPage, { page, notes: regeneratedNote }].sort((a, b) => a.page - b.page);

    const annotated = await annotatePdfWithNotes({
      originalPdf,
      notesByPage: nextNotesByPage,
      visuals,
    });

    const stored = await putBuffer({
      bytes: annotated,
      filename: `${project.title}-annotated.pdf`,
      contentType: 'application/pdf',
      folder: 'output',
    });

    const newOutputAsset = await prisma.asset.create({
      data: {
        projectId: id,
        kind: 'output_pdf',
        originalName: `${project.title}-annotated.pdf`,
        mimeType: 'application/pdf',
        size: annotated.length,
        storageKey: stored.storageKey,
        publicUrl: stored.publicUrl,
      },
    });

    const staleAssets = await prisma.asset.findMany({
      where: {
        projectId: id,
        kind: { in: ['output_pdf', 'translated_pdf'] },
        id: { not: newOutputAsset.id },
      },
    });

    await prisma.$transaction([
      prisma.generationRun.update({
        where: { id: latestRun.id },
        data: {
          notesByPageJson: nextNotesByPage,
          outputAssetId: newOutputAsset.id,
        },
      }),
      prisma.asset.deleteMany({
        where: {
          id: { in: staleAssets.map((asset) => asset.id) },
        },
      }),
    ]);

    for (const asset of staleAssets) {
      try {
        await deleteStoredFile({
          storageKey: asset.storageKey,
          publicUrl: asset.publicUrl,
        });
      } catch (error) {
        console.error('stale generated asset delete failed', asset.id, error);
      }
    }

    return NextResponse.json({
      ok: true,
      note: regeneratedNote,
      page,
      assetId: newOutputAsset.id,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : '페이지 필기를 다시 생성하는 중 오류가 발생했습니다.';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
