import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { generateSchema } from '@/lib/validators';
import { generateAnnotatedNotes, inferSubjectFromMaterials } from '@/lib/ai';
import { readNotionPageBlocks } from '@/lib/notion';
import { annotatePdfWithNotes, extractPdfText, extractPdfTextsByPage } from '@/lib/pdf';
import { putBuffer } from '@/lib/storage';
import { transcribeAudioFromBuffer } from '@/lib/transcribe';
import { getCurrentUserId } from '@/lib/auth-user';
import { ensureBillingBootstrap } from '@/lib/billing/bootstrap';
import { beginAiUsage, failAiUsage, finalizeAiUsage } from '@/lib/billing/usage';
import { assertWithinRateLimit } from '@/lib/rate-limit';
import { generateLocalStudyPack } from '@/lib/local-study';

export const maxDuration = 60;
const LOW_TOKEN_MODE = (process.env.AI_LOW_TOKEN_MODE || '').toLowerCase() === 'true';
const LOCAL_PIPELINE_MODE = (process.env.AI_USE_LOCAL_PIPELINE || '').toLowerCase() === 'true';

function inferTitleFromFiles(pdfName: string, fallbackName?: string) {
  const source = pdfName || fallbackName || '새 프로젝트';
  const stripped = source.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').trim();
  return stripped || '새 프로젝트';
}

function titleFromSubject(subject?: string, broadSubject?: string) {
  const cleaned = (subject || broadSubject || '').replace(/\s+/g, ' ').trim();
  return cleaned || '새 프로젝트';
}

function titleFromText(text: string) {
  const trimmed = text.replace(/\s+/g, ' ').trim();
  return trimmed.length > 28 ? `${trimmed.slice(0, 28)}…` : trimmed || '빠른 메모 프로젝트';
}

function isPdf(file: File) {
  return file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf');
}

function isAudio(file: File) {
  return file.type.startsWith('audio/');
}

function isTextLike(file: File) {
  if (file.type.startsWith('text/')) return true;
  return /\.(txt|md|csv|json|yaml|yml|rtf)$/i.test(file.name);
}

function decodeText(bytes: Buffer) {
  return new TextDecoder('utf-8', { fatal: false }).decode(bytes).trim();
}

async function readPdfAssetBytes(asset: { storageKey: string; publicUrl: string }) {
  if (asset.storageKey.startsWith('/')) {
    const { readStoredFile } = await import('@/lib/storage');
    return readStoredFile(asset.storageKey);
  }

  const response = await fetch(asset.publicUrl);
  if (!response.ok) {
    throw new Error(`PDF 원본을 불러오지 못했습니다. (status ${response.status})`);
  }
  return Buffer.from(await response.arrayBuffer());
}

export async function POST(req: Request) {
  let usageRequestId = '';
  try {
    const userId = await getCurrentUserId();
    assertWithinRateLimit(userId, 'generate');
    await ensureBillingBootstrap();

    const form = await req.formData();
    const parsed = generateSchema.safeParse({
      projectId: String(form.get('projectId') || ''),
      notionPageId: String(form.get('notionPageId') || ''),
      customNotes: String(form.get('customNotes') || ''),
      noteText: String(form.get('noteText') || ''),
      redirectTo: String(form.get('redirectTo') || '/'),
    });

    if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });

    const redirectTo = parsed.data.redirectTo || '/';
    const noteText = parsed.data.noteText.trim();

    const directPdf = form.get('pdf');
    const directAudio = form.get('audio');
    const extraAttachments = form
      .getAll('attachments')
      .filter((value): value is File => value instanceof File && value.size > 0);

    const attachments: File[] = [];
    if (directPdf instanceof File && directPdf.size > 0) attachments.push(directPdf);
    if (directAudio instanceof File && directAudio.size > 0) attachments.push(directAudio);
    attachments.push(...extraAttachments);

    const maxMb = Number(process.env.MAX_FILE_MB || '30');
    for (const file of attachments) {
      if (file.size > maxMb * 1024 * 1024) {
        return NextResponse.json({ error: `${file.name} 파일은 ${maxMb}MB 이하만 허용됩니다.` }, { status: 400 });
      }
    }

    let project = parsed.data.projectId
      ? await prisma.project.findUnique({ where: { id: parsed.data.projectId } })
      : null;

    if (!project) {
      const firstPdf = attachments.find(isPdf);
      const firstFallback = attachments[0];
      project = await prisma.project.create({
        data: {
          title: firstPdf
            ? inferTitleFromFiles(firstPdf.name)
            : (noteText ? titleFromText(noteText) : inferTitleFromFiles('', firstFallback?.name || '')),
          description: '통합 입력으로 자동 생성된 프로젝트',
        },
      });
    }

    if (!project) {
      return NextResponse.json({ error: '프로젝트를 만들 수 없습니다.' }, { status: 500 });
    }

    const projectId = project.id;
    const noteSources: string[] = [];
    const uploadedPdfTexts: string[] = [];
    const uploadedTranscripts: string[] = [];

    for (const file of attachments) {
      const bytes = Buffer.from(await file.arrayBuffer());

    if (isPdf(file)) {
      const extracted = await extractPdfText(bytes);
      uploadedPdfTexts.push(extracted);
      const stored = await putBuffer({
        bytes,
        filename: file.name,
        contentType: file.type || 'application/pdf',
        folder: 'pdf',
      });

      await prisma.asset.create({
        data: {
          projectId,
          kind: 'pdf',
          originalName: file.name,
          mimeType: file.type || 'application/pdf',
          size: bytes.length,
          storageKey: stored.storageKey,
          publicUrl: stored.publicUrl,
          extractedText: extracted,
        },
      });
      continue;
    }

    if (isAudio(file)) {
      const transcript = await transcribeAudioFromBuffer(bytes, file.name, file.type || 'audio/mpeg');
      uploadedTranscripts.push(transcript);
      const stored = await putBuffer({
        bytes,
        filename: file.name,
        contentType: file.type || 'audio/mpeg',
        folder: 'audio',
      });

      await prisma.asset.create({
        data: {
          projectId,
          kind: 'audio',
          originalName: file.name,
          mimeType: file.type || 'audio/mpeg',
          size: bytes.length,
          storageKey: stored.storageKey,
          publicUrl: stored.publicUrl,
          extractedText: transcript,
        },
      });
      continue;
    }

    if (isTextLike(file)) {
      const extracted = decodeText(bytes);
      if (extracted) {
        noteSources.push(`[첨부 텍스트: ${file.name}]\n${extracted.slice(0, 12000)}`);
      }
      const stored = await putBuffer({
        bytes,
        filename: file.name,
        contentType: file.type || 'text/plain',
        folder: 'text',
      });

      await prisma.asset.create({
        data: {
          projectId,
          kind: 'text',
          originalName: file.name,
          mimeType: file.type || 'text/plain',
          size: bytes.length,
          storageKey: stored.storageKey,
          publicUrl: stored.publicUrl,
          extractedText: extracted,
        },
      });
      continue;
    }

    const stored = await putBuffer({
      bytes,
      filename: file.name,
      contentType: file.type || 'application/octet-stream',
      folder: 'uploads',
    });

    await prisma.asset.create({
      data: {
        projectId,
        kind: 'file',
        originalName: file.name,
        mimeType: file.type || 'application/octet-stream',
        size: bytes.length,
        storageKey: stored.storageKey,
        publicUrl: stored.publicUrl,
      },
    });
  }

    if (noteText) {
      await prisma.projectMessage.create({
        data: {
          projectId,
          role: 'user',
          text: noteText,
        },
      });
    }

    const projectWithAssets = await prisma.project.findUnique({
      where: { id: projectId },
      include: { assets: true },
    });

    if (!projectWithAssets) {
      return NextResponse.json({ error: '프로젝트를 찾을 수 없습니다.' }, { status: 404 });
    }

    const allPdfText = projectWithAssets.assets
      .filter((asset) => asset.kind === 'pdf')
      .map((asset) => asset.extractedText || '')
      .join('\n');

    const allTranscriptText = projectWithAssets.assets
      .filter((asset) => asset.kind === 'audio')
      .map((asset) => asset.extractedText || '')
      .join('\n');

    const subjectBaseText = uploadedPdfTexts.join('\n') || allPdfText;
    const transcriptBaseText = uploadedTranscripts.join('\n') || allTranscriptText;

    if (!LOW_TOKEN_MODE && (subjectBaseText || transcriptBaseText)) {
      try {
        const inferred = await inferSubjectFromMaterials({
          title: projectWithAssets.title,
          description: projectWithAssets.description || '',
          pdfText: subjectBaseText,
          transcriptText: transcriptBaseText,
        });

        const titleNeedsUpdate =
          projectWithAssets.title === '새 프로젝트' ||
          projectWithAssets.description === '홈 화면 업로드로 자동 생성된 프로젝트' ||
          projectWithAssets.description === '통합 입력으로 자동 생성된 프로젝트';

        await prisma.project.update({
          where: { id: projectId },
          data: {
            title: subjectBaseText && titleNeedsUpdate
              ? titleFromSubject(inferred.subject, inferred.broadSubject)
              : projectWithAssets.title,
            subject: projectWithAssets.subject?.trim() ? projectWithAssets.subject : inferred.subject,
            description: projectWithAssets.description?.trim() &&
              projectWithAssets.description !== '홈 화면 업로드로 자동 생성된 프로젝트' &&
              projectWithAssets.description !== '통합 입력으로 자동 생성된 프로젝트'
              ? projectWithAssets.description
              : `AI 자동 분석: ${inferred.subject} (${inferred.broadSubject})`,
          },
        });
      } catch (error) {
        console.error('subject inference failed', error);
      }
    }

    const projectForGeneration = await prisma.project.findUnique({
      where: { id: projectId },
      include: { assets: true, messages: { orderBy: { createdAt: 'asc' } } },
    });

    if (!projectForGeneration) {
      return NextResponse.json({ error: '프로젝트를 찾을 수 없습니다.' }, { status: 404 });
    }

    const latestPdf = projectForGeneration.assets
      .filter((asset) => asset.kind === 'pdf')
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];

    if (!latestPdf) {
      return NextResponse.json({ error: '먼저 PDF를 업로드하세요.' }, { status: 400 });
    }

    const originalPdf = await readPdfAssetBytes({
      storageKey: latestPdf.storageKey,
      publicUrl: latestPdf.publicUrl,
    });
    const pdfPageTexts = await extractPdfTextsByPage(originalPdf);

    const transcriptText = projectForGeneration.assets
      .filter((asset) => asset.kind === 'audio')
      .map((asset) => asset.extractedText || '')
      .join('\n');

    const notionText = parsed.data.notionPageId ? await readNotionPageBlocks(parsed.data.notionPageId) : '';
    const storedMessages = projectForGeneration.messages
      .map((message, index) => `메모 ${index + 1}: ${message.text}`)
      .join('\n');

    const mergedNotes = [
      storedMessages,
      parsed.data.customNotes || '',
      noteSources.join('\n'),
    ]
      .filter(Boolean)
      .join('\n');

    const usageGuard = await beginAiUsage({
      userId,
      feature: 'annotated_notes_generation',
      model: process.env.GEMINI_REASONING_MODEL || process.env.GEMINI_TEXT_MODEL || 'gemini-2.0-flash-lite',
      inputText: [
        projectForGeneration.title,
        projectForGeneration.subject || '',
        latestPdf.extractedText || '',
        transcriptText,
        notionText,
        mergedNotes,
      ].join('\n'),
      fileCount: projectForGeneration.assets.length,
      requestMetadata: {
        projectId: projectForGeneration.id,
      },
    });
    usageRequestId = usageGuard.requestId;

    let result;
    if (LOCAL_PIPELINE_MODE) {
      result = generateLocalStudyPack({
        lectureTitle: projectForGeneration.title,
        pdfText: latestPdf.extractedText || '',
        pdfPageTexts,
        transcriptText,
        notionText,
        customNotes: mergedNotes,
      });
    } else {
      try {
        result = await generateAnnotatedNotes({
          subject: projectForGeneration.subject ?? '미지정',
          lectureTitle: projectForGeneration.title,
          pdfText: latestPdf.extractedText || '',
          pdfPages: pdfPageTexts.map((text, index) => ({ page: index + 1, text })),
          transcriptText,
          notionText,
          customNotes: mergedNotes,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : '';
        if (/quota|rate limit|429|insufficient_quota|RESOURCE_EXHAUSTED/i.test(message)) {
          result = generateLocalStudyPack({
            lectureTitle: projectForGeneration.title,
            pdfText: latestPdf.extractedText || '',
            pdfPageTexts,
            transcriptText,
            notionText,
            customNotes: mergedNotes,
          });
        } else {
          throw error;
        }
      }
    }

    const annotated = await annotatePdfWithNotes({ originalPdf, notesByPage: result.notesByPage, visuals: result.visuals });
    const out = await putBuffer({ bytes: annotated, filename: `${projectForGeneration.title}-annotated.pdf`, contentType: 'application/pdf', folder: 'output' });

    const outputAsset = await prisma.asset.create({
      data: {
        projectId: projectForGeneration.id,
        kind: 'output_pdf',
        originalName: `${projectForGeneration.title}-annotated.pdf`,
        mimeType: 'application/pdf',
        size: annotated.length,
        storageKey: out.storageKey,
        publicUrl: out.publicUrl,
      },
    });

    await prisma.generationRun.create({
      data: {
        projectId: projectForGeneration.id,
        customNotes: mergedNotes,
        notionPageId: parsed.data.notionPageId || '',
        notionExtract: notionText,
        transcriptExtract: transcriptText,
        summary: result.summary,
        examFocusJson: result.examFocus,
        notesByPageJson: result.notesByPage,
        visualsJson: result.visuals,
        questionsJson: result.reviewQuestions,
        outputAssetId: outputAsset.id,
      },
    });

    await finalizeAiUsage({
      requestId: usageRequestId,
      outputText: JSON.stringify(result),
      metadata: {
        outputAssetId: outputAsset.id,
      },
    });

    return NextResponse.redirect(new URL(`${redirectTo}?projectId=${projectForGeneration.id}`, req.url), 303);
  } catch (error) {
    if (usageRequestId) {
      await failAiUsage({
        requestId: usageRequestId,
        errorCode: error instanceof Error ? error.name : 'UNKNOWN',
        metadata: {
          message: error instanceof Error ? error.message : 'unknown_error',
        },
      });
    }
    console.error('generate route failed', error);
    const message = error instanceof Error ? error.message : '생성 중 서버 오류가 발생했습니다.';
    const status = typeof error === 'object' && error !== null && 'status' in error
      ? Number((error as { status?: unknown }).status) || 500
      : 500;
    const userFacing = message === 'INSUFFICIENT_CREDIT'
      ? '크레딧이 부족합니다. 먼저 충전하거나 자동충전을 설정해 주세요.'
      : message;
    return NextResponse.json({ error: userFacing }, { status });
  }
}
