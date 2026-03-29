import { NextResponse } from 'next/server';
import { PDFDocument } from 'pdf-lib';
import { prisma } from '@/lib/prisma';
import { extractPdfText } from '@/lib/pdf';
import { deleteStoredFile, putBuffer, readStoredFile } from '@/lib/storage';

type MergePosition = 'before' | 'after';

async function readPdfAssetBytes(asset: { storageKey: string; publicUrl: string }) {
  return readStoredFile(asset.storageKey, asset.publicUrl);
}

function normalizeMergePosition(raw: FormDataEntryValue | null): MergePosition | null {
  const value = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  if (value === 'before' || value === 'after') return value;
  return null;
}

function buildMergedPdfName(currentName: string, extraName: string) {
  const currentBase = currentName.replace(/\.pdf$/i, '').trim() || 'current';
  const extraBase = extraName.replace(/\.pdf$/i, '').trim() || 'extra';
  return `${currentBase}-merged-${extraBase}.pdf`;
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const form = await req.formData();
    const position = normalizeMergePosition(form.get('position'));
    const extraPdf = form.get('pdf');

    if (!position) {
      return NextResponse.json({ error: '추가 PDF 위치 정보가 올바르지 않습니다.' }, { status: 400 });
    }

    if (!(extraPdf instanceof File) || extraPdf.size <= 0) {
      return NextResponse.json({ error: '추가할 PDF 파일이 필요합니다.' }, { status: 400 });
    }

    const maxMb = Number(process.env.MAX_FILE_MB || '30');
    if (extraPdf.size > maxMb * 1024 * 1024) {
      return NextResponse.json({ error: `PDF는 ${maxMb}MB 이하만 허용됩니다.` }, { status: 400 });
    }

    const [project, latestPdf] = await Promise.all([
      prisma.project.findUnique({ where: { id } }),
      prisma.asset.findFirst({
        where: { projectId: id, kind: 'pdf' },
        orderBy: { createdAt: 'desc' },
      }),
    ]);

    if (!project || !latestPdf) {
      return NextResponse.json({ error: '현재 프로젝트의 PDF를 찾을 수 없습니다.' }, { status: 404 });
    }

    const currentPdfBytes = await readPdfAssetBytes({
      storageKey: latestPdf.storageKey,
      publicUrl: latestPdf.publicUrl,
    });
    const extraPdfBytes = Buffer.from(await extraPdf.arrayBuffer());

    const currentDoc = await PDFDocument.load(currentPdfBytes);
    const extraDoc = await PDFDocument.load(extraPdfBytes);
    const mergedDoc = await PDFDocument.create();
    const sources = position === 'before'
      ? [
          { doc: extraDoc, pageCount: extraDoc.getPageCount() },
          { doc: currentDoc, pageCount: currentDoc.getPageCount() },
        ]
      : [
          { doc: currentDoc, pageCount: currentDoc.getPageCount() },
          { doc: extraDoc, pageCount: extraDoc.getPageCount() },
        ];

    for (const source of sources) {
      const pageIndexes = Array.from({ length: source.pageCount }, (_, index) => index);
      const pages = await mergedDoc.copyPages(source.doc, pageIndexes);
      pages.forEach((page) => mergedDoc.addPage(page));
    }

    const mergedBytes = Buffer.from(await mergedDoc.save());
    const mergedExtractedText = await extractPdfText(mergedBytes);
    const filename = buildMergedPdfName(latestPdf.originalName, extraPdf.name);

    const stored = await putBuffer({
      bytes: mergedBytes,
      filename,
      contentType: 'application/pdf',
      folder: 'pdf',
    });

    const staleGeneratedAssets = await prisma.asset.findMany({
      where: {
        projectId: id,
        kind: { in: ['output_pdf', 'translated_pdf'] },
      },
    });

    const nextAsset = await prisma.$transaction(async (tx) => {
      const createdAsset = await tx.asset.create({
        data: {
          projectId: id,
          kind: 'pdf',
          originalName: filename,
          mimeType: 'application/pdf',
          size: mergedBytes.length,
          storageKey: stored.storageKey,
          publicUrl: stored.publicUrl,
          extractedText: mergedExtractedText,
        },
      });

      await tx.generationRun.deleteMany({
        where: { projectId: id },
      });

      await tx.asset.deleteMany({
        where: {
          id: {
            in: [latestPdf.id, ...staleGeneratedAssets.map((asset) => asset.id)],
          },
        },
      });

      return createdAsset;
    });

    for (const asset of [latestPdf, ...staleGeneratedAssets]) {
      try {
        await deleteStoredFile({
          storageKey: asset.storageKey,
          publicUrl: asset.publicUrl,
        });
      } catch (error) {
        console.error('merged pdf stale file delete failed', asset.id, error);
      }
    }

    return NextResponse.json({
      ok: true,
      assetId: nextAsset.id,
      pageCount: mergedDoc.getPageCount(),
      resetGenerated: true,
      position,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : '추가 PDF를 병합하는 중 오류가 발생했습니다.';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
