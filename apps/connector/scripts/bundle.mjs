// Builds the one file agents download: dist/twring-connect.mjs (served at /downloads/twring-connect.mjs).
// Run: pnpm --filter ./apps/connector bundle
//
// The file is a short prelude in plain syntax, then the whole connector as one string. Node parses
// a module and links its static imports before running any of it, so a check inside a bundle that
// uses new syntax (`??`, `?.`) or new built-ins (`node:readline/promises`) never runs on an old
// Node: it fails with a SyntaxError or a missing-module error instead. The prelude imports only
// modules every Node has, checks the version, and only then compiles the connector.
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { build } from 'esbuild';
import { generateSkill } from './gen-skill.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const outfile = join(root, 'dist', 'twring-connect.mjs');

await generateSkill();

const result = await build({
  absWorkingDir: root,
  entryPoints: ['src/cli.ts'],
  bundle: true,
  write: false,
  platform: 'node',
  target: 'node20',
  // CommonJS inside: the string is compiled as a function body, which cannot hold `import`.
  format: 'cjs',
  external: ['bufferutil', 'utf-8-validate'],
  logLevel: 'warning',
});
const code = result.outputFiles[0].text;

const prelude = `// twring-connect: lets the Twring app on your phone call the AI agents on this machine.
// Run it with Node.js 20 or newer: node twring-connect.mjs --help
import nodeModule from 'module';
import url from 'url';
import vm from 'vm';
var major = Number(String(process.versions.node).split('.')[0]);
if (!(major >= 20)) {
  process.stderr.write('Node ' + major + ' is too old: install Node.js 20 or newer, then run this again.\\n');
  process.exit(1);
}
var file = url.fileURLToPath(import.meta.url);
var dir = file.replace(/[\\\\/][^\\\\/]*$/, '');
`;
// esbuild starts the code with "use strict", as the ES modules it came from were.
const wrapped = `(function (require, __filename, __dirname) {\n${code}\n})`;
const text = `${prelude}var code = ${JSON.stringify(wrapped)};
vm.runInThisContext(code, { filename: file })(nodeModule.createRequire(file), file, dir);
`;

await mkdir(dirname(outfile), { recursive: true });
await writeFile(outfile, text);
process.stdout.write(`${outfile}  ${Math.round(text.length / 1024)} kB\n`);
