import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { del, put } from '@vercel/blob';

const uploadRoot = path.join(process.cwd(), 'uploads');

function isHttpUrl(value: string) {
  return /^https?:\/\//i.test(value);
}

function parseLocalFileUrl(value?: string) {
  if (!value) return null;

  try {
    const url = value.startsWith('/')
      ? new URL(value, 'http://localhost')
      : new URL(value);

    if (url.pathname !== '/api/local-file') {
      return null;
    }

    const filePath = url.searchParams.get('path');
    return filePath?.trim() || null;
  } catch {
    return null;
  }
}

function getLocalStorageCandidates(input: string) {
  const trimmed = input.trim();
  if (!trimmed) return [];

  const candidates: string[] = [];
  const pushCandidate = (candidate: string) => {
    const resolved = path.resolve(candidate);
    if (!candidates.includes(resolved)) {
      candidates.push(resolved);
    }
  };

  if (trimmed.startsWith('/')) {
    pushCandidate(trimmed);
    pushCandidate(path.join(uploadRoot, path.basename(trimmed)));
    return candidates;
  }

  const normalized = trimmed.replace(/^\.?\/*/, '');
  pushCandidate(path.join(uploadRoot, normalized.replace(/\//g, '-')));
  pushCandidate(path.join(uploadRoot, path.basename(normalized)));
  return candidates;
}

async function readFromCandidates(candidates: string[]) {
  let lastError: unknown = null;

  for (const candidate of candidates) {
    try {
      return await fs.readFile(candidate);
    } catch (error) {
      lastError = error;
      if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') {
        throw error;
      }
    }
  }

  throw lastError instanceof Error ? lastError : new Error('파일을 읽을 수 없습니다.');
}

async function tryReadFromCandidates(candidates: string[]) {
  try {
    return await readFromCandidates(candidates);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

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
  const localUrlPath = parseLocalFileUrl(storageKeyOrPath) || parseLocalFileUrl(publicUrl);
  if (storageKeyOrPath.startsWith('/') || (!isHttpUrl(storageKeyOrPath) && storageKeyOrPath)) {
    const localBytes = await tryReadFromCandidates(getLocalStorageCandidates(storageKeyOrPath));
    if (localBytes) {
      return localBytes;
    }
  }
  if (localUrlPath) {
    const localUrlBytes = await tryReadFromCandidates(getLocalStorageCandidates(localUrlPath));
    if (localUrlBytes) {
      return localUrlBytes;
    }
  }
  if (isHttpUrl(storageKeyOrPath)) {
    const res = await fetch(storageKeyOrPath);
    if (!res.ok) throw new Error(`파일을 읽을 수 없습니다. (status ${res.status})`);
    const arr = await res.arrayBuffer();
    return Buffer.from(arr);
  }
  if (publicUrl && isHttpUrl(publicUrl)) {
    const res = await fetch(publicUrl);
    if (!res.ok) throw new Error(`파일을 읽을 수 없습니다. (status ${res.status})`);
    const arr = await res.arrayBuffer();
    return Buffer.from(arr);
  }
  throw new Error('Unsupported storage key');
}

export async function readPublicLocalFile(requestedPath: string) {
  const requested = requestedPath.trim();
  if (!requested) {
    throw new Error('missing path');
  }

  const resolvedUploadRoot = path.resolve(uploadRoot);
  const directCandidate = path.resolve(requested);

  if (directCandidate.startsWith(`${resolvedUploadRoot}${path.sep}`) || directCandidate === resolvedUploadRoot) {
    return fs.readFile(directCandidate);
  }

  return readFromCandidates([path.join(uploadRoot, path.basename(directCandidate))]);
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
