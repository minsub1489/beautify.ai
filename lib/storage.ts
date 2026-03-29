import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { del, put } from '@vercel/blob';

const uploadRoot = path.join(process.cwd(), 'uploads');

export async function putBuffer(params: {
  bytes: Buffer;
  filename: string;
  contentType: string;
  folder?: string;
}) {
  const safeName = `${params.folder ?? 'uploads'}/${crypto.randomUUID()}-${sanitize(params.filename)}`;

  if (process.env.BLOB_READ_WRITE_TOKEN) {
    const blob = await put(safeName, params.bytes, {
      access: 'public',
      contentType: params.contentType,
      token: process.env.BLOB_READ_WRITE_TOKEN,
      addRandomSuffix: false,
    });
    return { storageKey: safeName, publicUrl: blob.url };
  }

  await fs.mkdir(uploadRoot, { recursive: true });
  const fullPath = path.join(uploadRoot, safeName.replace(/\//g, '-'));
  await fs.writeFile(fullPath, params.bytes);
  return { storageKey: fullPath, publicUrl: `${process.env.APP_BASE_URL ?? ''}/api/local-file?path=${encodeURIComponent(fullPath)}` };
}

export async function readStoredFile(storageKeyOrPath: string, publicUrl?: string) {
  if (/^https?:\/\//.test(storageKeyOrPath)) {
    const res = await fetch(storageKeyOrPath);
    if (!res.ok) throw new Error(`파일을 읽을 수 없습니다. (status ${res.status})`);
    const arr = await res.arrayBuffer();
    return Buffer.from(arr);
  }
  if (storageKeyOrPath.startsWith('/')) {
    return fs.readFile(storageKeyOrPath);
  }
  if (publicUrl && /^https?:\/\//.test(publicUrl)) {
    const res = await fetch(publicUrl);
    if (!res.ok) throw new Error(`파일을 읽을 수 없습니다. (status ${res.status})`);
    const arr = await res.arrayBuffer();
    return Buffer.from(arr);
  }
  throw new Error('Unsupported storage key');
}

export async function deleteStoredFile(params: {
  storageKey: string;
  publicUrl?: string;
}) {
  if (params.storageKey.startsWith('/')) {
    try {
      await fs.unlink(params.storageKey);
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') {
        throw error;
      }
    }
    return;
  }

  if (process.env.BLOB_READ_WRITE_TOKEN && params.publicUrl) {
    await del(params.publicUrl, { token: process.env.BLOB_READ_WRITE_TOKEN });
  }
}

function sanitize(name: string) {
  return name.replace(/[^a-zA-Z0-9._-]/g, '_');
}
