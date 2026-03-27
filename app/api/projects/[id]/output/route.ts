import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const run = await prisma.generationRun.findFirst({ where: { projectId: id }, orderBy: { createdAt: 'desc' }, include: { outputAsset: true } });
  if (!run?.outputAsset?.publicUrl) return NextResponse.json({ error: '생성된 PDF가 없습니다.' }, { status: 404 });
  return NextResponse.redirect(run.outputAsset.publicUrl, 302);
}
