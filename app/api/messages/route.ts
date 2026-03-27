import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { messageSchema } from '@/lib/validators';

function titleFromText(text: string) {
  const trimmed = text.replace(/\s+/g, ' ').trim();
  return trimmed.length > 28 ? `${trimmed.slice(0, 28)}…` : trimmed || '빠른 메모 프로젝트';
}

export async function POST(req: Request) {
  const form = await req.formData();
  const parsed = messageSchema.safeParse({
    projectId: String(form.get('projectId') || ''),
    text: String(form.get('text') || ''),
    redirectTo: String(form.get('redirectTo') || '/'),
  });

  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  let projectId = parsed.data.projectId;

  if (!projectId) {
    const project = await prisma.project.create({
      data: {
        title: titleFromText(parsed.data.text),
        description: '홈 화면에서 메모로 시작된 프로젝트',
      },
    });
    projectId = project.id;
  }

  await prisma.projectMessage.create({
    data: {
      projectId,
      role: 'user',
      text: parsed.data.text.trim(),
    },
  });

  return NextResponse.redirect(new URL(`${parsed.data.redirectTo}?projectId=${projectId}`, req.url), 303);
}
