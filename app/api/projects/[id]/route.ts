import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { deleteStoredFile } from '@/lib/storage';

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await req.json().catch(() => ({}));
  const title = String(body?.title || '').trim();

  if (!title) {
    return NextResponse.json({ error: '프로젝트 제목은 비어 있을 수 없습니다.' }, { status: 400 });
  }

  const existing = await prisma.project.findUnique({ where: { id } });
  if (!existing) {
    return NextResponse.json({ error: '프로젝트를 찾을 수 없습니다.' }, { status: 404 });
  }

  const project = await prisma.project.update({
    where: { id },
    data: { title },
  });

  return NextResponse.json({ project }, { status: 200 });
}

export async function DELETE(_: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const project = await prisma.project.findUnique({
    where: { id },
    include: { assets: true },
  });

  if (!project) {
    return NextResponse.json({ error: '프로젝트를 찾을 수 없습니다.' }, { status: 404 });
  }

  await prisma.project.delete({ where: { id } });

  for (const asset of project.assets) {
    try {
      await deleteStoredFile({
        storageKey: asset.storageKey,
        publicUrl: asset.publicUrl,
      });
    } catch (error) {
      console.error('project asset delete failed', asset.id, error);
    }
  }

  return NextResponse.json({
    ok: true,
    deletedProjectId: id,
  }, { status: 200 });
}
