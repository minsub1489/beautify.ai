import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { deleteStoredFile } from '@/lib/storage';

export async function DELETE(_: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const asset = await prisma.asset.findUnique({ where: { id } });

  if (!asset) {
    return NextResponse.json({ error: '삭제할 파일을 찾을 수 없습니다.' }, { status: 404 });
  }

  const assetsToDelete = asset.kind === 'pdf'
    ? [
        asset,
        ...await prisma.asset.findMany({
          where: {
            projectId: asset.projectId,
            kind: { in: ['translated_pdf', 'output_pdf'] },
          },
        }),
      ]
    : [asset];

  const assetIds = assetsToDelete.map((item) => item.id);

  if (asset.kind === 'pdf') {
    await prisma.$transaction([
      prisma.generationRun.deleteMany({ where: { projectId: asset.projectId } }),
      prisma.asset.deleteMany({ where: { id: { in: assetIds } } }),
    ]);
  } else {
    await prisma.asset.delete({ where: { id: asset.id } });
  }

  for (const item of assetsToDelete) {
    try {
      await deleteStoredFile({
        storageKey: item.storageKey,
        publicUrl: item.publicUrl,
      });
    } catch (error) {
      console.error('asset storage delete failed', item.id, error);
    }
  }

  return NextResponse.json({
    ok: true,
    deletedAssetIds: assetIds,
    resetGenerated: asset.kind === 'pdf',
  });
}
