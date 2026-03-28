import { NextResponse } from 'next/server';
import { PDFDocument } from 'pdf-lib';
import { prisma } from '@/lib/prisma';
import { extractPdfTextsByPage } from '@/lib/pdf';
import { deleteStoredFile, putBuffer, readStoredFile } from '@/lib/storage';

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

function normalizePageOrder(raw: unknown) {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value) && value > 0)
    .map((value) => Math.trunc(value));
}

function buildEditedPdfName(originalName: string) {
  if (/\.pdf$/i.test(originalName)) {
    return `${originalName.replace(/\.pdf$/i, '')}-edited.pdf`;
  }
  return `${originalName}-edited.pdf`;
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const body = await req.json().catch(() => ({}));
    const pageOrder = normalizePageOrder(body?.pageOrder);

    if (!pageOrder.length) {
      return NextResponse.json({ error: '적용할 PDF 페이지 구성이 비어 있습니다.' }, { status: 400 });
    }

    const [project, latestPdf] = await Promise.all([
      prisma.project.findUnique({ where: { id } }),
      prisma.asset.findFirst({
        where: { projectId: id, kind: 'pdf' },
        orderBy: { createdAt: 'desc' },
      }),
    ]);

    if (!project || !latestPdf) {
      return NextResponse.json({ error: '편집할 PDF를 찾을 수 없습니다.' }, { status: 404 });
    }

    const originalPdf = await readPdfAssetBytes({
      storageKey: latestPdf.storageKey,
      publicUrl: latestPdf.publicUrl,
    });
    const sourceDoc = await PDFDocument.load(originalPdf);
    const sourcePageCount = sourceDoc.getPageCount();
    const isUnchanged = pageOrder.length === sourcePageCount && pageOrder.every((page, index) => page === index + 1);

    if (pageOrder.some((page) => page < 1 || page > sourcePageCount)) {
      return NextResponse.json({ error: `페이지 번호는 1부터 ${sourcePageCount} 사이여야 합니다.` }, { status: 400 });
    }

    if (isUnchanged) {
      return NextResponse.json({
        ok: true,
        unchanged: true,
        assetId: latestPdf.id,
        pageCount: sourcePageCount,
      });
    }

    const sourcePageTexts = await extractPdfTextsByPage(originalPdf);
    const nextDoc = await PDFDocument.create();

    for (const pageNumber of pageOrder) {
      const [copiedPage] = await nextDoc.copyPages(sourceDoc, [pageNumber - 1]);
      nextDoc.addPage(copiedPage);
    }

    const nextBytes = Buffer.from(await nextDoc.save());
    const nextExtractedText = pageOrder
      .map((pageNumber) => sourcePageTexts[pageNumber - 1]?.trim() || '')
      .filter(Boolean)
      .join('\n\n');
    const filename = buildEditedPdfName(latestPdf.originalName);

    const stored = await putBuffer({
      bytes: nextBytes,
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
          size: nextBytes.length,
          storageKey: stored.storageKey,
          publicUrl: stored.publicUrl,
          extractedText: nextExtractedText,
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

      await tx.project.update({
        where: { id },
        data: { title: project.title },
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
        console.error('edited pdf stale file delete failed', asset.id, error);
      }
    }

    return NextResponse.json({
      ok: true,
      assetId: nextAsset.id,
      pageCount: pageOrder.length,
      resetGenerated: true,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'PDF 페이지 편집을 적용하는 중 오류가 발생했습니다.';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
