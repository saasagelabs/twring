import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { runInNewContext } from 'node:vm';

import { describe, expect, it } from 'vitest';

// TWRING-APP-3: React Native's AbortSignal can abort with no reason, and livekit-client's
// getAbortReasonAsString then ran `'toString' in undefined`, which throws inside the connect abort
// handler, so a cancelled connect never closed or settled. The fix is a pnpm patch
// (patches/livekit-client@2.22.3.patch); these tests run the code the app actually ships. Metro
// bundles only dist/livekit-client.esm.mjs (checked with `expo export --dev`), so the minified UMD
// build is left alone. pnpm refuses an unused patch, so a livekit-client upgrade must revisit this.
const require = createRequire(import.meta.url);
const dist = dirname(require.resolve('livekit-client'));

/** The shipped getAbortReasonAsString, called with a signal that aborted with `reason`. */
function shippedHelper() {
  const source = readFileSync(join(dist, 'livekit-client.esm.mjs'), 'utf8');
  const start = source.indexOf('function getAbortReasonAsString(');
  const end = source.indexOf('\nfunction ', start + 1);
  expect(start).toBeGreaterThan(-1);
  class FakeAbortSignal {
    constructor(reason) {
      this.reason = reason;
    }
  }
  const helper = runInNewContext(`(${source.slice(start, end)})`, {
    AbortSignal: FakeAbortSignal,
    Error,
  });
  return (reason, fallback) => helper(new FakeAbortSignal(reason), fallback);
}

describe('livekit-client abort reason (patched)', () => {
  const describeReason = shippedHelper();

  it('uses the fallback when the signal aborted with no reason', () => {
    expect(describeReason(undefined, 'Abort handler called')).toBe('Abort handler called');
  });

  it('still describes string, error and other reasons', () => {
    expect(describeReason('user left', 'x')).toBe('user left');
    expect(describeReason(new Error('timed out'), 'x')).toBe('timed out');
    expect(describeReason(42, 'x')).toBe('42');
  });
});
