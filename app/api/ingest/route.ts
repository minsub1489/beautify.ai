import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { putBuffer } from '@/lib/storage';
import { extractPdfText } from '@/lib/pdf';

export const maxDuration = 60;

function inferTitleFromFiles(pdfName: string, audioName?: string) {
  const source = pdfName || audioName || '새 프로젝트';
  const stripped = source.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').trim();
  return stripped || '새 프로젝트';
}

export async function POST(req: Request) {
  const form = await req.formData();
  let projectId = String(form.get('projectId') || '').trim();
  const redirectTo = String(form.get('redirectTo') || '/').trim() || '/';
  const pdfFile = form.get('pdf') as File | null;
  const audioFile = form.get('audio') as File | null;

  if (!pdfFile && !audioFile) {
    return NextResponse.json({ error: 'PDF 또는 오디오 파일이 필요합니다.' }, { status: 400 });
  }

  const maxMb = Number(process.env.MAX_FILE_MB || '30');
  if (pdfFile && pdfFile.size > maxMb * 1024 * 1024) {
    return NextResponse.json({ error: `PDF는 ${maxMb}MB 이하만 허용됩니다.` }, { status: 400 });
  }
  if (audioFile && audioFile.size > maxMb * 1024 * 1024) {
    return NextResponse.json({ error: `오디오는 ${maxMb}MB 이하만 허용됩니다.` }, { status: 400 });
  }

  let project = projectId ? await prisma.project.findUnique({ where: { id: projectId } }) : null;

  if (!project) {
    project = await prisma.project.create({
      data: {
        title: inferTitleFromFiles(pdfFile?.name || '', audioFile?.name || ''),
        description: '홈 화면 업로드로 자동 생성된 프로젝트',
      },
    });
    projectId = project.id;
  }

  let pdfText = '';

  if (pdfFile) {
    const pdfBuffer = Buffer.from(await pdfFile.arrayBuffer());
    pdfText = await extractPdfText(pdfBuffer);
    const pdfStored = await putBuffer({
      bytes: pdfBuffer,
      filename: pdfFile.name,
      contentType: pdfFile.type || 'application/pdf',
      folder: 'pdf',
    });

    await prisma.asset.create({
      data: {
        projectId,
        kind: 'pdf',
        originalName: pdfFile.name,
        mimeType: pdfFile.type || 'application/pdf',
        size: pdfBuffer.length,
        storageKey: pdfStored.storageKey,
        publicUrl: pdfStored.publicUrl,
        extractedText: pdfText,
      },
    });
  }

  if (audioFile && audioFile.size > 0) {
    const audioBuffer = Buffer.from(await audioFile.arrayBuffer());
    const audioStored = await putBuffer({
      bytes: audioBuffer,
      filename: audioFile.name,
      contentType: audioFile.type || 'audio/mpeg',
      folder: 'audio',
    });

    await prisma.asset.create({
      data: {
        projectId,
        kind: 'audio',
        originalName: audioFile.name,
        mimeType: audioFile.type || 'audio/mpeg',
        size: audioBuffer.length,
        storageKey: audioStored.storageKey,
        publicUrl: audioStored.publicUrl,
        extractedText: '',
      },
    });
  }

  return NextResponse.redirect(new URL(`${redirectTo}?projectId=${projectId}`, req.url), 303);
}
