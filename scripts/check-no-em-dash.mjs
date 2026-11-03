import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

const tracked = execFileSync('git', ['ls-files', '-z']);
const binaryExtensions = new Set([
  '.aab',
  '.apk',
  '.avif',
  '.bin',
  '.gif',
  '.ico',
  '.jar',
  '.jpeg',
  '.jpg',
  '.jks',
  '.mp3',
  '.mp4',
  '.otf',
  '.pdf',
  '.png',
  '.ttf',
  '.wav',
  '.webp',
  '.woff',
  '.woff2',
  '.zip',
]);
let found = false;

for (const file of tracked.toString('utf8').split('\0').filter(Boolean)) {
  if (path.posix.basename(file) === 'pnpm-lock.yaml') continue;
  if (binaryExtensions.has(path.posix.extname(file).toLowerCase())) continue;
  if (!existsSync(file)) continue;

  const bytes = readFileSync(file);
  if (bytes.includes(0)) continue;

  const lines = bytes.toString('utf8').split(/\r?\n/);
  for (const [index, line] of lines.entries()) {
    for (
      let offset = line.indexOf('\u2014');
      offset !== -1;
      offset = line.indexOf('\u2014', offset + 1)
    ) {
      process.stdout.write(`${file}:${index + 1}\n`);
      found = true;
    }
  }
}

if (found) process.exitCode = 1;
