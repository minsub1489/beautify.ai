import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { GEMINI_MODELS, generateGeminiJson, toUserFacingGeminiError } from '@/lib/openai';

function looksEnglish(text: string) {
  const letters = (text.match(/[A-Za-z]/g) || []).length;
  const korean = (text.match(/[가-힣]/g) || []).length;
  return letters > 120 && letters > korean * 1.3;
}

function pickSentences(text: string) {
  return text
    .replace(/\s+/g, ' ')
    .split(/(?<=[.!?])\s+/)
    .map((line) => line.trim())
    .filter((line) => /[A-Za-z]/.test(line) && line.length > 40)
    .slice(0, 8);
}

export async function GET(_: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const latestPdf = await prisma.asset.findFirst({
    where: { projectId: id, kind: 'pdf' },
    orderBy: { createdAt: 'desc' },
  });

  if (!latestPdf?.extractedText) {
    return NextResponse.json({ detected: false, lines: [] }, { status: 200 });
  }

  const source = latestPdf.extractedText.slice(0, 12000);
  if (!looksEnglish(source)) {
    return NextResponse.json({ detected: false, lines: [] }, { status: 200 });
  }

  const sentences = pickSentences(source);
  if (!sentences.length) {
    return NextResponse.json({ detected: true, lines: [] }, { status: 200 });
  }

  try {
    const parsed = await generateGeminiJson<{ lines: { original: string; translation: string }[] }>({
      model: GEMINI_MODELS.text,
      prompt: `
다음 영어 문장을 자연스러운 한국어로 번역해라.
전문 용어는 의미를 유지하고, 결과는 JSON만 출력해라.
문장 목록:
${sentences.map((line, idx) => `${idx + 1}. ${line}`).join('\n')}
`,
      schema: {
        type: 'object',
        properties: {
          lines: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                original: { type: 'string' },
                translation: { type: 'string' },
              },
              required: ['original', 'translation'],
            },
          },
        },
        required: ['lines'],
      },
    });
    return NextResponse.json({ detected: true, lines: parsed.lines.slice(0, 8) }, { status: 200 });
  } catch (error) {
    return NextResponse.json({ error: toUserFacingGeminiError(error) }, { status: 500 });
  }
}
