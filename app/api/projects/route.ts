import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { createProjectSchema } from '@/lib/validators';

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

    const project = await prisma.project.create({ data: parsed.data });
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

  const project = await prisma.project.create({ data: parsed.data });
  return NextResponse.redirect(new URL(`/?projectId=${project.id}`, req.url), 303);
}
