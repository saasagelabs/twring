import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { runInNewContext } from 'node:vm';

import { describe, expect, it } from 'vitest';

// Our fixes to livekit-client live in one pnpm patch (patches/livekit-client@2.22.3.patch). These
// tests run the code the app actually ships. Metro bundles only dist/livekit-client.esm.mjs
// (checked with `expo export --dev`), so the minified UMD build is left alone. pnpm refuses an
// unused patch, so a livekit-client upgrade must revisit this file.

// TWRING-APP-3: React Native's AbortSignal can abort with no reason, and getAbortReasonAsString
// then ran `'toString' in undefined`, which throws inside the connect abort handler, so a
// cancelled connect never closed or settled.
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

// TWRING-APP-4: when the server asks for more media sections, livekit-client renegotiates without a
// catch. If the call has just ended, negotiate() rejects with "PC manager is closed" and the
// rejection escapes unhandled. The patch logs it, as livekit's other negotiate() calls do.
/** The shipped onMediaSectionsRequirement handler, bound to `engine`. */
function shippedMediaSectionsHandler(engine) {
  const source = readFileSync(join(dist, 'livekit-client.esm.mjs'), 'utf8');
  const start = source.indexOf('this.client.onMediaSectionsRequirement = ');
  expect(start).toBeGreaterThan(-1);
  const arrow = source.indexOf('requirement =>', start);
  const end = source.indexOf('\n    };', arrow) + '\n    }'.length;
  const make = runInNewContext(`(function () { return ${source.slice(arrow, end)}; })`, {});
  return make.call(engine);
}

describe('livekit-client media sections renegotiation (patched)', () => {
  it('keeps a renegotiation that fails after hang-up from escaping unhandled', async () => {
    const unhandled = [];
    const onUnhandled = (reason) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    const logged = [];
    const closed = new Error('PC manager is closed');
    const handler = shippedMediaSectionsHandler({
      addMediaSections: () => undefined,
      negotiate: () => Promise.reject(closed),
      log: { error: (e) => logged.push(e), warn: (e) => logged.push(e) },
    });
    try {
      handler({ numAudios: 1, numVideos: 0 });
      await new Promise((resolve) => setTimeout(resolve, 10));
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
    expect(unhandled).toEqual([]);
    expect(logged).toEqual([closed]);
  });
});
