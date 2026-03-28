import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';

function pickSentences(text: string) {
  return text
    .replace(/\s+/g, ' ')
    .split(/(?<=[.!?])\s+/)
    .map((line) => line.trim())
    .filter((line) => /\p{L}/u.test(line) && line.length > 24)
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
  const sentences = pickSentences(source);
  if (!sentences.length) {
    return NextResponse.json({ detected: true, lines: [] }, { status: 200 });
  }

  const apiKey = process.env.DEEPL_API_KEY || '';
  if (!apiKey) {
    return NextResponse.json(
      { error: 'DeepL API 키가 없습니다. .env의 DEEPL_API_KEY를 설정해 주세요.' },
      { status: 400 },
    );
  }

  try {
    const body = new URLSearchParams();
    body.set('target_lang', 'KO');
    body.set('preserve_formatting', '1');
    for (const sentence of sentences) {
      body.append('text', sentence);
    }

    const response = await fetch('https://api-free.deepl.com/v2/translate', {
      method: 'POST',
      headers: {
        Authorization: `DeepL-Auth-Key ${apiKey}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: body.toString(),
    });

    const payload = await response.json().catch(() => null) as
      | { translations?: { text?: string }[]; message?: string }
      | null;

    if (!response.ok) {
      const message = payload?.message || `DeepL 번역 요청 실패 (status ${response.status})`;
      return NextResponse.json({ error: message }, { status: response.status || 500 });
    }

    const translated = Array.isArray(payload?.translations) ? payload.translations : [];
    const lines = sentences.map((original, index) => ({
      original,
      translation: translated[index]?.text || '',
    }));

    return NextResponse.json({ detected: true, lines }, { status: 200 });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'DeepL 번역 중 서버 오류가 발생했습니다.';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
