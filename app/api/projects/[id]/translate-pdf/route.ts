import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { putBuffer, readStoredFile } from '@/lib/storage';

export const maxDuration = 120;

async function readPdfAssetBytes(asset: { storageKey: string; publicUrl: string }) {
  if (asset.storageKey.startsWith('/')) {
    return readStoredFile(asset.storageKey);
  }

  const response = await fetch(asset.publicUrl);
  if (!response.ok) {
    throw new Error(`PDF 원본을 불러오지 못했습니다. (status ${response.status})`);
  }
  return Buffer.from(await response.arrayBuffer());
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function POST(_: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const apiKey = process.env.DEEPL_API_KEY || '';
    if (!apiKey) {
      return NextResponse.json({ error: '.env의 DEEPL_API_KEY를 설정해 주세요.' }, { status: 400 });
    }

    const latestPdf = await prisma.asset.findFirst({
      where: { projectId: id, kind: 'pdf' },
      orderBy: { createdAt: 'desc' },
    });

    if (!latestPdf) {
      return NextResponse.json({ error: '번역할 PDF가 없습니다.' }, { status: 400 });
    }

    const originalPdf = await readPdfAssetBytes({
      storageKey: latestPdf.storageKey,
      publicUrl: latestPdf.publicUrl,
    });

    const uploadForm = new FormData();
    uploadForm.set('target_lang', 'KO');
    uploadForm.set(
      'file',
      new Blob([originalPdf], { type: latestPdf.mimeType || 'application/pdf' }),
      latestPdf.originalName || 'source.pdf',
    );

    const uploadResponse = await fetch('https://api-free.deepl.com/v2/document', {
      method: 'POST',
      headers: { Authorization: `DeepL-Auth-Key ${apiKey}` },
      body: uploadForm,
    });

    const uploadPayload = await uploadResponse.json().catch(() => null) as
      | { document_id?: string; document_key?: string; message?: string }
      | null;

    if (!uploadResponse.ok || !uploadPayload?.document_id || !uploadPayload?.document_key) {
      const message = uploadPayload?.message || `DeepL 문서 업로드 실패 (status ${uploadResponse.status})`;
      return NextResponse.json({ error: message }, { status: uploadResponse.status || 500 });
    }

    const { document_id: documentId, document_key: documentKey } = uploadPayload;

    for (let i = 0; i < 30; i += 1) {
      const statusBody = new URLSearchParams();
      statusBody.set('document_key', documentKey);

      const statusResponse = await fetch(`https://api-free.deepl.com/v2/document/${documentId}`, {
        method: 'POST',
        headers: {
          Authorization: `DeepL-Auth-Key ${apiKey}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: statusBody.toString(),
      });

      const statusPayload = await statusResponse.json().catch(() => null) as
        | { status?: string; message?: string }
        | null;

      if (!statusResponse.ok) {
        const message = statusPayload?.message || `DeepL 상태 조회 실패 (status ${statusResponse.status})`;
        return NextResponse.json({ error: message }, { status: statusResponse.status || 500 });
      }

      if (statusPayload?.status === 'done') {
        break;
      }

      if (statusPayload?.status === 'error') {
        return NextResponse.json({ error: 'DeepL 문서 번역에 실패했습니다.' }, { status: 500 });
      }

      await sleep(1500);

      if (i === 29) {
        return NextResponse.json({ error: '번역 시간이 초과되었습니다. 잠시 후 다시 시도해 주세요.' }, { status: 504 });
      }
    }

    const resultBody = new URLSearchParams();
    resultBody.set('document_key', documentKey);

    const downloadResponse = await fetch(`https://api-free.deepl.com/v2/document/${documentId}/result`, {
      method: 'POST',
      headers: {
        Authorization: `DeepL-Auth-Key ${apiKey}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: resultBody.toString(),
    });

    if (!downloadResponse.ok) {
      const maybeJson = await downloadResponse.json().catch(() => null) as { message?: string } | null;
      const message = maybeJson?.message || `DeepL 결과 다운로드 실패 (status ${downloadResponse.status})`;
      return NextResponse.json({ error: message }, { status: downloadResponse.status || 500 });
    }

    const translatedBytes = Buffer.from(await downloadResponse.arrayBuffer());
    const translatedName = (latestPdf.originalName || 'translated.pdf').replace(/\.pdf$/i, '-translated-ko.pdf');

    const stored = await putBuffer({
      bytes: translatedBytes,
      filename: translatedName,
      contentType: 'application/pdf',
      folder: 'translated',
    });

    const translatedAsset = await prisma.asset.create({
      data: {
        projectId: id,
        kind: 'translated_pdf',
        originalName: translatedName,
        mimeType: 'application/pdf',
        size: translatedBytes.length,
        storageKey: stored.storageKey,
        publicUrl: stored.publicUrl,
      },
    });

    return NextResponse.json({ assetId: translatedAsset.id }, { status: 200 });
  } catch (error) {
    const message = error instanceof Error ? error.message : '번역 PDF 생성 중 오류가 발생했습니다.';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
