import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

import { describe, expect, it } from 'vitest';

// Our backport of software-mansion/react-native-reanimated#10435 (released in 4.8.0) lives in one
// pnpm patch (patches/react-native-reanimated@4.5.1.patch). On a Moto g86 a call logged 902
// "synchronouslyUpdateUIProps failed" warnings in 2 seconds, each with a full stack trace, because
// the SVG waveform kept updating a view whose surface was gone (upstream issue #10280, which can
// cause ANRs). These tests read the Kotlin the app actually builds. pnpm refuses an unused patch,
// so a Reanimated upgrade must revisit this file (drop the patch once we are on 4.8 or newer).
const require = createRequire(import.meta.url);
const root = dirname(require.resolve('react-native-reanimated/package.json'));
const source = readFileSync(
  join(root, 'android/src/main/java/com/swmansion/reanimated/NativeProxy.kt'),
  'utf8',
);

/** The body of the shipped synchronouslyUpdateUIProps. */
function updateBody() {
  const start = source.indexOf('fun synchronouslyUpdateUIProps(');
  expect(start).toBeGreaterThan(-1);
  const end = source.indexOf('@DoNotStrip', start);
  return source.slice(start, end);
}

describe('react-native-reanimated synchronous props (patched)', () => {
  it('looks up MountingManager.getViewExists', () => {
    expect(source).toMatch(/getMethod\("getViewExists", Int::class\.javaPrimitiveType\)/);
  });

  it('skips a view that no longer exists before updating it', () => {
    const body = updateBody();
    const guard = body.indexOf('getViewExistsMethod?.invoke(mountingManager, viewTag) == false');
    const update = body.indexOf('updatePropsSynchronouslyMethod.invoke(');
    expect(guard).toBeGreaterThan(-1);
    expect(update).toBeGreaterThan(guard);
    expect(body.slice(guard, update)).toContain('return@parse');
  });

  it('logs one line per failure, not a stack trace', () => {
    const body = updateBody();
    expect(body).not.toMatch(/Log\.w\([^)]*,\s*e\)/);
    expect(body).toContain('failed for tag $viewTag: ${e.cause ?: e}');
  });
});
