import fs from 'node:fs/promises';
import nodePath from 'node:path';

export async function GET(req: Request) {
  const url = new URL(req.url);
  const filePath = url.searchParams.get('path');
  if (!filePath) return new Response('missing path', { status: 400 });
  const resolved = nodePath.resolve(filePath);
  const root = nodePath.resolve(process.cwd(), 'uploads');
  if (!resolved.startsWith(root)) return new Response('forbidden', { status: 403 });
  const bytes = await fs.readFile(resolved);
  return new Response(bytes, {
    status: 200,
    headers: {
      'content-type': resolved.endsWith('.pdf') ? 'application/pdf' : 'application/octet-stream',
      'cache-control': 'no-store',
    },
  });
}
