import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');
const sourceRoot = path.join(projectRoot, 'node_modules', 'pdfjs-dist');
const publicRoot = path.join(projectRoot, 'public', 'pdfjs');

const entriesToCopy = [
  ['build', 'build'],
  ['cmaps', 'cmaps'],
  ['standard_fonts', 'standard_fonts'],
  ['wasm', 'wasm'],
  [path.join('web', 'images'), path.join('web', 'images')],
];

if (!existsSync(sourceRoot)) {
  console.warn('[sync:pdfjs] pdfjs-dist가 설치되어 있지 않아 자산 복사를 건너뜁니다.');
  process.exit(0);
}

mkdirSync(publicRoot, { recursive: true });

for (const [fromPath, toPath] of entriesToCopy) {
  const from = path.join(sourceRoot, fromPath);
  const to = path.join(publicRoot, toPath);

  if (!existsSync(from)) continue;

  rmSync(to, { recursive: true, force: true });
  cpSync(from, to, { recursive: true });
}

console.log('[sync:pdfjs] PDF.js 자산을 public/pdfjs로 동기화했습니다.');
