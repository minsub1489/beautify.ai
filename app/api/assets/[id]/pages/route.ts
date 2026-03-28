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

export async function GET(_: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const asset = await prisma.asset.findUnique({ where: { id } });

    if (!asset || asset.kind !== 'pdf') {
      return NextResponse.json({ error: 'PDF 파일을 찾을 수 없습니다.' }, { status: 404 });
    }

    const bytes = await readPdfAssetBytes({
      storageKey: asset.storageKey,
      publicUrl: asset.publicUrl,
    });
    const pdfDoc = await PDFDocument.load(bytes);

    return NextResponse.json({
      assetId: asset.id,
      pageCount: pdfDoc.getPageCount(),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'PDF 페이지 수를 읽는 중 오류가 발생했습니다.';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
