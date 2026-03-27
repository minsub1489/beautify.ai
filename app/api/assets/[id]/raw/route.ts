import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { readStoredFile } from '@/lib/storage';

export async function GET(_: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const asset = await prisma.asset.findUnique({ where: { id } });

  if (!asset) {
    return NextResponse.json({ error: '파일을 찾을 수 없습니다.' }, { status: 404 });
  }

  try {
    const bytes = await readStoredFile(asset.storageKey);
    return new NextResponse(bytes, {
      status: 200,
      headers: {
        'content-type': asset.mimeType || 'application/octet-stream',
        'cache-control': 'no-store',
        'content-disposition': `inline; filename="${asset.originalName}"`,
      },
    });
  } catch (error) {
    console.error('asset raw read failed', error);
    return NextResponse.json({ error: '파일을 읽을 수 없습니다.' }, { status: 500 });
  }
}
