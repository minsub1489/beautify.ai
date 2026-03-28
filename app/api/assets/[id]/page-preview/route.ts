import { NextResponse } from 'next/server';
import { PDFDocument } from 'pdf-lib';
import { prisma } from '@/lib/prisma';
import { readStoredFile } from '@/lib/storage';

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

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const pageParam = new URL(request.url).searchParams.get('page');
    const pageNumber = Number(pageParam);

    if (!Number.isInteger(pageNumber) || pageNumber <= 0) {
      return NextResponse.json({ error: '올바른 페이지 번호가 필요합니다.' }, { status: 400 });
    }

    const asset = await prisma.asset.findUnique({ where: { id } });

    if (!asset || asset.kind !== 'pdf') {
      return NextResponse.json({ error: 'PDF 파일을 찾을 수 없습니다.' }, { status: 404 });
    }

    const bytes = await readPdfAssetBytes({
      storageKey: asset.storageKey,
      publicUrl: asset.publicUrl,
    });
    const sourceDoc = await PDFDocument.load(bytes);
    const pageIndex = pageNumber - 1;

    if (pageIndex >= sourceDoc.getPageCount()) {
      return NextResponse.json({ error: '요청한 페이지가 PDF 범위를 벗어났습니다.' }, { status: 400 });
    }

    const previewDoc = await PDFDocument.create();
    const [page] = await previewDoc.copyPages(sourceDoc, [pageIndex]);
    previewDoc.addPage(page);

    const previewBytes = await previewDoc.save();
    const filenameBase = asset.originalName.replace(/\.pdf$/i, '');

    return new NextResponse(Buffer.from(previewBytes), {
      status: 200,
      headers: {
        'content-type': 'application/pdf',
        'cache-control': 'no-store',
        'content-disposition': `inline; filename="${filenameBase}-page-${pageNumber}.pdf"`,
      },
    });
  } catch (error) {
    console.error('asset page preview failed', error);
    const message = error instanceof Error ? error.message : '페이지 미리보기를 생성하지 못했습니다.';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
