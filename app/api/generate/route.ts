import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { generateSchema } from '@/lib/validators';
import { generateAnnotatedNotes, generatePdfReviewQuestions } from '@/lib/ai';
import { readNotionPageBlocks } from '@/lib/notion';
import { annotatePdfWithNotes, extractPdfText, extractPdfTextsByPage } from '@/lib/pdf';
import { putBuffer, readStoredFile } from '@/lib/storage';
import { getCurrentUserId } from '@/lib/auth-user';
import { ensureBillingBootstrap } from '@/lib/billing/bootstrap';
import { beginAiUsage, failAiUsage, finalizeAiUsage } from '@/lib/billing/usage';
import { assertWithinRateLimit } from '@/lib/rate-limit';
import { generateLocalNotesPack } from '@/lib/local-study';

export const maxDuration = 60;
const LOW_TOKEN_MODE = (process.env.AI_LOW_TOKEN_MODE || '').toLowerCase() === 'true';
const LOCAL_PIPELINE_MODE = (process.env.AI_USE_LOCAL_PIPELINE || '').toLowerCase() === 'true';

function inferTitleFromFiles(pdfName: string, fallbackName?: string) {
  const source = pdfName || fallbackName || '새 프로젝트';
  const stripped = source.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').trim();
  return stripped || '새 프로젝트';
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
  return readStoredFile(asset.storageKey, asset.publicUrl);
}

function parseRequestedPageRange(input: {
  rangeStart?: string;
  rangeEnd?: string;
  pageCount: number;
}) {
  const pageCount = Math.max(1, Math.trunc(input.pageCount || 1));
  const rawStart = Number.parseInt(input.rangeStart || '', 10);
  const rawEnd = Number.parseInt(input.rangeEnd || '', 10);
  const start = Number.isFinite(rawStart) ? rawStart : 1;
  const end = Number.isFinite(rawEnd) ? rawEnd : pageCount;
  const boundedStart = Math.max(1, Math.min(pageCount, start));
  const boundedEnd = Math.max(1, Math.min(pageCount, end));

  return {
    start: Math.min(boundedStart, boundedEnd),
    end: Math.max(boundedStart, boundedEnd),
  };
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
      mode: String(form.get('mode') || 'notes'),
      rangeStart: String(form.get('rangeStart') || ''),
      rangeEnd: String(form.get('rangeEnd') || ''),
      redirectTo: String(form.get('redirectTo') || '/'),
    });

    if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });

    const redirectTo = parsed.data.redirectTo || '/';
    const mode = parsed.data.mode;
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

    for (const file of attachments) {
      const bytes = Buffer.from(await file.arrayBuffer());

    if (isPdf(file)) {
      const extracted = await extractPdfText(bytes);
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
          extractedText: '',
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

    if (noteText && mode === 'notes') {
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

    const projectForGeneration = await prisma.project.findUnique({
      where: { id: projectId },
      include: {
        assets: true,
        messages: { orderBy: { createdAt: 'asc' } },
        runs: { orderBy: { createdAt: 'desc' }, take: 1 },
      },
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
    const requestedRange = parseRequestedPageRange({
      rangeStart: parsed.data.rangeStart,
      rangeEnd: parsed.data.rangeEnd,
      pageCount: pdfPageTexts.length,
    });
    const selectedPdfPages = pdfPageTexts
      .slice(requestedRange.start - 1, requestedRange.end)
      .map((text, index) => ({
        page: requestedRange.start + index,
        text,
      }));
    const selectedPdfText = selectedPdfPages.map((page) => page.text).filter(Boolean).join('\n\n');
    const latestRun = projectForGeneration.runs[0] || null;

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

    const effectiveFeature = mode === 'quiz' ? 'pdf_quiz_generation' : 'annotated_notes_generation';
    const effectiveModel = mode === 'quiz'
      ? (process.env.GEMINI_REASONING_MODEL || process.env.GEMINI_TEXT_MODEL || 'gemini-2.0-flash')
      : (process.env.GEMINI_REASONING_MODEL || process.env.GEMINI_TEXT_MODEL || 'gemini-2.0-flash-lite');

    const usageGuard = await beginAiUsage({
      userId,
      feature: effectiveFeature,
      model: effectiveModel,
      inputText: [
        mode,
        `${requestedRange.start}-${requestedRange.end}`,
        projectForGeneration.title,
        projectForGeneration.subject || '',
        selectedPdfText || latestPdf.extractedText || '',
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

    if (mode === 'notes') {
      let result;
      if (LOCAL_PIPELINE_MODE) {
        result = generateLocalNotesPack({
          lectureTitle: projectForGeneration.title,
          pdfText: selectedPdfText || latestPdf.extractedText || '',
          pdfPageTexts: selectedPdfPages.map((page) => page.text),
          transcriptText,
          notionText,
          customNotes: mergedNotes,
        });
      } else {
        try {
          result = await generateAnnotatedNotes({
            subject: projectForGeneration.subject ?? '미지정',
            lectureTitle: projectForGeneration.title,
            pdfText: selectedPdfText || latestPdf.extractedText || '',
            pdfPages: selectedPdfPages,
            transcriptText,
            notionText,
            customNotes: mergedNotes,
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : '';
          if (/quota|rate limit|429|insufficient_quota|RESOURCE_EXHAUSTED/i.test(message)) {
            result = generateLocalNotesPack({
              lectureTitle: projectForGeneration.title,
              pdfText: selectedPdfText || latestPdf.extractedText || '',
              pdfPageTexts: selectedPdfPages.map((page) => page.text),
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
          questionsJson: latestRun?.questionsJson ?? undefined,
          outputAssetId: outputAsset.id,
        },
      });

      await finalizeAiUsage({
        requestId: usageRequestId,
        outputText: JSON.stringify(result),
        metadata: {
          mode,
          rangeStart: requestedRange.start,
          rangeEnd: requestedRange.end,
          outputAssetId: outputAsset.id,
        },
      });
    } else {
      const quizSourceText = (selectedPdfText || latestPdf.extractedText || '').trim();
      if (!quizSourceText) {
        return NextResponse.json(
          { error: '선택한 PDF 페이지에서 텍스트를 읽지 못했습니다. 텍스트가 포함된 PDF인지 확인한 뒤 다시 시도해 주세요.' },
          { status: 400 },
        );
      }
      const result = await generatePdfReviewQuestions({
        subject: projectForGeneration.subject ?? '미지정',
        lectureTitle: projectForGeneration.title,
        pdfText: quizSourceText,
        pdfPages: selectedPdfPages,
      });

      await prisma.generationRun.create({
        data: {
          projectId: projectForGeneration.id,
          customNotes: mergedNotes,
          notionPageId: parsed.data.notionPageId || '',
          notionExtract: notionText,
          transcriptExtract: transcriptText,
          summary: latestRun?.summary ?? undefined,
          examFocusJson: latestRun?.examFocusJson ?? undefined,
          notesByPageJson: latestRun?.notesByPageJson ?? undefined,
          visualsJson: latestRun?.visualsJson ?? undefined,
          questionsJson: result.reviewQuestions,
          outputAssetId: latestRun?.outputAssetId ?? null,
        },
      });

      await finalizeAiUsage({
        requestId: usageRequestId,
        outputText: JSON.stringify(result),
        metadata: {
          mode,
          rangeStart: requestedRange.start,
          rangeEnd: requestedRange.end,
        },
      });
    }

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
