import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

/** The iOS workflows' safety settings: who can start them and what they keep. */

const workflows = join(import.meta.dirname, '..', '..', '..', '.github', 'workflows');
const read = (name) => readFileSync(join(workflows, name), 'utf8');

describe('ios-testflight.yml', () => {
  const text = read('ios-testflight.yml');

  it('starts by hand only, never on pull requests or pushes', () => {
    expect(text).toMatch(/^on:\s*\n\s+workflow_dispatch:/m);
    expect(text).not.toMatch(/^\s+(pull_request|pull_request_target|push|schedule):/m);
  });

  it('runs only from main, in the protected testflight environment', () => {
    expect(text).toContain("if: github.ref == 'refs/heads/main'");
    expect(text).toMatch(/environment:\s*testflight/);
  });

  it('always removes the signing material and never keeps the IPA', () => {
    expect(text).toMatch(
      /if: always\(\)\s*\n\s+run: bash apps\/mobile\/scripts\/ios-testflight\.sh cleanup/,
    );
    expect(text).not.toMatch(/\.ipa/);
  });
});

describe('ios-build-check.yml', () => {
  const text = read('ios-build-check.yml');

  it('uses no secrets and no environment', () => {
    expect(text).not.toMatch(/\$\{\{\s*secrets\./);
    expect(text).not.toMatch(/environment:/);
  });
});
