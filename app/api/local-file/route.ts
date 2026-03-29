import { readPublicLocalFile } from '@/lib/storage';

export async function GET(req: Request) {
  const url = new URL(req.url);
  const filePath = url.searchParams.get('path');
  if (!filePath) return new Response('missing path', { status: 400 });

  try {
    const bytes = await readPublicLocalFile(filePath);
    return new Response(bytes, {
      status: 200,
      headers: {
        'content-type': filePath.endsWith('.pdf') ? 'application/pdf' : 'application/octet-stream',
        'cache-control': 'no-store',
      },
    });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    return new Response(code === 'ENOENT' ? 'not found' : 'failed to read file', {
      status: code === 'ENOENT' ? 404 : 500,
    });
  }
}
