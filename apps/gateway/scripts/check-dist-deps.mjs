// Proves every third-party package the bundles in dist/ import loads from a deployed layout:
//   node scripts/check-dist-deps.mjs <app dir>   (the dir holding dist/ and node_modules/)
// It also loads the command entries (admin-cli, probe-echo, check-speech-key) themselves; they
// only run when started directly, so importing them is side-effect free. main.js starts the
// server on import, so only its imports are loaded. The Dockerfile runs this in the runtime stage
// so a missing or wrong-architecture package fails the image build, not a call.
import { readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const dir = process.argv[2];
if (dir === undefined) {
  console.error('Usage: node scripts/check-dist-deps.mjs <app dir>');
  process.exit(2);
}
const dist = join(dir, 'dist');
const entries = readdirSync(dist).filter((name) => name.endsWith('.js'));
const specifiers = new Set();
for (const name of entries) {
  const code = readFileSync(join(dist, name), 'utf8');
  // esbuild writes static imports one per line at the top level; dynamic ones as import("x").
  const found = [
    ...code.matchAll(/^import\s+(?:[^;"]*?\s+from\s+)?"([^"]+)";/gm),
    ...code.matchAll(/\bimport\(\s*"([^"]+)"\s*\)/g),
  ];
  for (const match of found) {
    const spec = match[1];
    if (spec.startsWith('.') || spec.startsWith('node:') || builtinModules.includes(spec)) continue;
    specifiers.add(spec);
  }
}
const commands = ['admin-cli.js', 'probe-echo.js', 'check-speech-key.js'];
const probe = join(dist, '.deps-check.mjs');
writeFileSync(
  probe,
  [...specifiers, ...commands.map((name) => `./${name}`)]
    .map((spec) => `await import(${JSON.stringify(spec)});`)
    .join('\n'),
);
try {
  await import(pathToFileURL(probe).href);
  console.log(`dist dependencies load: ${[...specifiers].sort().join(', ')}`);
  console.log(`commands load: ${commands.join(', ')}`);
} finally {
  rmSync(probe, { force: true });
}
