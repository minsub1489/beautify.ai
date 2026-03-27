import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';

export async function DELETE(_: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const existing = await prisma.projectMessage.findUnique({ where: { id } });

  if (!existing) {
    return NextResponse.json({ error: '메모를 찾을 수 없습니다.' }, { status: 404 });
  }

  await prisma.projectMessage.delete({ where: { id } });
  return NextResponse.json({ ok: true, projectId: existing.projectId });
}
