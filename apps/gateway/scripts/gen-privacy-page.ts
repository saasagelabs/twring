/**
 * Regenerates src/pages/privacy.generated.ts from docs/PRIVACY.md. Run after editing the notice:
 * `pnpm --filter @twring/gateway gen:privacy` (a test fails while the two differ).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { renderPrivacyNotice } from '../src/pages/privacy-notice';

const source = fileURLToPath(new URL('../../../docs/PRIVACY.md', import.meta.url));
const target = fileURLToPath(new URL('../src/pages/privacy.generated.ts', import.meta.url));

const html = renderPrivacyNotice(readFileSync(source, 'utf8'));
writeFileSync(
  target,
  `// Generated from docs/PRIVACY.md by scripts/gen-privacy-page.ts. Do not edit by hand.\n` +
    `export const PRIVACY_BODY_HTML = ${JSON.stringify(html)};\n`,
  'utf8',
);
process.stdout.write(`wrote ${target}\n`);
