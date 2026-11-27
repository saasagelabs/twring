import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

import { describe, expect, it } from 'vitest';

// Our change to @livekit/react-native lives in one pnpm patch
// (patches/@livekit__react-native@3.0.0.patch). pnpm refuses an unused patch, so an upgrade must
// revisit this file.
//
// On Android 10 and later, LiveKit turned on the phone's built-in echo canceller and noise
// suppressor, and WebRTC then skips its own echo canceller. On a moto g86 on loudspeaker the
// built-in one silenced the caller while the agent spoke and right after, so their words never
// reached speech recognition (headphones were fine). The patch keeps the built-in effects off, so
// WebRTC's software echo canceller (AEC3, switched on by echoCancellation in
// src/call/livekit-transport.ts) does the work. Decision record: ADR-048 in docs/DECISIONS.md.
const require = createRequire(import.meta.url);
/** The package folder (its exports hide package.json, so walk up from the main entry). */
function packageRoot(name) {
  let dir = dirname(require.resolve(name));
  while (!existsSync(join(dir, 'package.json')) || readPackageName(dir) !== name) {
    const parent = dirname(dir);
    if (parent === dir) throw new Error(`no package folder for ${name}`);
    dir = parent;
  }
  return dir;
}
function readPackageName(dir) {
  return JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).name;
}
const root = packageRoot('@livekit/react-native');
const kotlin = readFileSync(
  join(root, 'android/src/main/java/com/livekit/reactnative/LiveKitReactNative.kt'),
  'utf8',
);
const transport = readFileSync(
  join(import.meta.dirname, '../src/call/livekit-transport.ts'),
  'utf8',
);

/** The body of `private fun setupAdm`, which both setup() and invalidate() call. */
function setupAdmBody() {
  const start = kotlin.indexOf('private fun setupAdm(');
  expect(start).toBeGreaterThan(-1);
  const end = kotlin.indexOf('\n    }', start);
  return kotlin.slice(start, end);
}

describe('@livekit/react-native Android echo cancelling (patched)', () => {
  it('builds the audio module with the built-in echo canceller and noise suppressor off', () => {
    const body = setupAdmBody();
    expect(body).toMatch(/val useHardwareAudioProcessing = false\b/);
    expect(body).toContain('.setUseHardwareAcousticEchoCanceler(useHardwareAudioProcessing)');
    expect(body).toContain('.setUseHardwareNoiseSuppressor(useHardwareAudioProcessing)');
    expect(body).not.toContain('Build.VERSION');
  });

  it('keeps the call audio attributes and the samples callback LiveKit relies on', () => {
    const body = setupAdmBody();
    expect(body).toContain('.setAudioAttributes(audioType.audioAttributes)');
    expect(body).toContain('.setSamplesReadyCallback(audioRecordSamplesDispatcher)');
  });

  it('rebuilds the audio module the same way after invalidate()', () => {
    const start = kotlin.indexOf('internal fun invalidate(');
    expect(start).toBeGreaterThan(-1);
    expect(kotlin.slice(start)).toContain('setupAdm(context)');
    expect(kotlin.match(/JavaAudioDeviceModule\.builder\(/g)).toHaveLength(1);
  });

  it('still asks WebRTC for its own echo cancelling, so the agent never hears itself', () => {
    expect(transport).toMatch(/echoCancellation:\s*true/);
  });
});
