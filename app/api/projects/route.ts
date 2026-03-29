import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { assignProjectSortOrder, getNextProjectSortOrder, persistProjectSortOrder } from '@/lib/project-sort';
import { createProjectSchema } from '@/lib/validators';

export async function PATCH(req: Request) {
  const body = await req.json().catch(() => ({})) as { projectIds?: unknown };
  const rawProjectIds = Array.isArray(body.projectIds) ? body.projectIds : [];
  const projectIds = rawProjectIds.filter((value: unknown): value is string => typeof value === 'string' && value.trim().length > 0);

  if (!projectIds.length) {
    return NextResponse.json({ error: '정렬할 프로젝트 목록이 비어 있습니다.' }, { status: 400 });
  }

  const uniqueProjectIds = [...new Set(projectIds)];
  if (uniqueProjectIds.length !== projectIds.length) {
    return NextResponse.json({ error: '중복된 프로젝트가 포함되어 있습니다.' }, { status: 400 });
  }

  const existing = await prisma.project.findMany({
    where: { id: { in: uniqueProjectIds } },
    select: { id: true },
  });

  if (existing.length !== uniqueProjectIds.length) {
    return NextResponse.json({ error: '일부 프로젝트를 찾을 수 없습니다.' }, { status: 404 });
  }

  const persisted = await persistProjectSortOrder(uniqueProjectIds);
  if (!persisted) {
    return NextResponse.json({ error: '프로젝트 순서를 저장하지 못했습니다.' }, { status: 500 });
  }

  return NextResponse.json({ ok: true, projectIds: uniqueProjectIds }, { status: 200 });
}

export async function POST(req: Request) {
  const contentType = req.headers.get('content-type') || '';

  if (contentType.includes('application/json')) {
    const body = await req.json();
    const parsed = createProjectSchema.safeParse({
      title: String(body.title || '새 프로젝트'),
      subject: String(body.subject || ''),
      description: String(body.description || ''),
    });

    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
    }

    const nextSortOrder = await getNextProjectSortOrder();
    const project = await prisma.project.create({
      data: {
        ...parsed.data,
      },
    });
    await assignProjectSortOrder(project.id, nextSortOrder);
    return NextResponse.json({ project });
  }

  const form = await req.formData();
  const parsed = createProjectSchema.safeParse({
    title: String(form.get('title') || ''),
    subject: String(form.get('subject') || ''),
    description: String(form.get('description') || ''),
  });

  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  const nextSortOrder = await getNextProjectSortOrder();
  const project = await prisma.project.create({
    data: {
      ...parsed.data,
    },
  });
  await assignProjectSortOrder(project.id, nextSortOrder);
  return NextResponse.redirect(new URL(`/?projectId=${project.id}`, req.url), 303);
}
