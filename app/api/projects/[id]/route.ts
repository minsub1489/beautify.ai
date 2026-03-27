import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';

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
