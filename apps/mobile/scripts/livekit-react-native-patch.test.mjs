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

// On Android 12 (API 31) and later Twring's own audio route module is the only writer of the call
// audio route. LiveKit's AudioSwitch called setSpeakerphoneOn and start/stopBluetoothSco on its
// handler, racing Twring's setCommunicationDevice; the churn left Bluetooth SCO in a state that
// speaker taps could not undo. The patch keeps LiveKit's focus, call mode and mic mute handling
// on S+ but never creates AudioSwitch there. Decision record: ADR-049 in docs/DECISIONS.md.
const audioSwitchManager = readFileSync(
  join(root, 'android/src/main/java/com/livekit/reactnative/audio/AudioSwitchManager.java'),
  'utf8',
);

/** The body (braces included) of the first Java method whose header contains `header`. */
function javaMethod(header) {
  const start = audioSwitchManager.indexOf(header);
  expect(start, header).toBeGreaterThan(-1);
  const open = audioSwitchManager.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < audioSwitchManager.length; i++) {
    if (audioSwitchManager[i] === '{') depth++;
    if (audioSwitchManager[i] === '}' && --depth === 0)
      return audioSwitchManager.slice(open, i + 1);
  }
  throw new Error(`unclosed method ${header}`);
}

const routingCalls = [
  'startBluetoothSco',
  'stopBluetoothSco',
  'setSpeakerphoneOn',
  'selectDevice',
  'new AudioSwitch',
];

describe('@livekit/react-native Android audio routing on API 31+ (patched)', () => {
  it('guards on Android 12 (VERSION_CODES.S)', () => {
    expect(javaMethod('private static boolean twringRoutesAudio()')).toMatch(
      /Build\.VERSION\.SDK_INT >= Build\.VERSION_CODES\.S\b/,
    );
    for (const header of [
      'public void start()',
      'public void stop()',
      'public void enableSpeakerphone(',
    ]) {
      expect(javaMethod(header), header).toContain('twringRoutesAudio()');
    }
  });

  it('never routes audio on the S+ path', () => {
    for (const header of [
      'private synchronized void startWithoutRouting()',
      'private synchronized void stopWithoutRouting()',
    ]) {
      const body = javaMethod(header);
      for (const call of routingCalls) expect(body, `${header} ${call}`).not.toContain(call);
    }
    const select = javaMethod('public void selectAudioOutput(@NonNull Class');
    expect(select.indexOf('twringRoutesAudio()')).toBeGreaterThan(-1);
    expect(select.indexOf('twringRoutesAudio()')).toBeLessThan(select.indexOf('selectDevice'));
    const speaker = javaMethod('public void enableSpeakerphone(');
    expect(speaker.indexOf('twringRoutesAudio()')).toBeLessThan(
      speaker.indexOf('setSpeakerphoneOn'),
    );
  });

  it('sets the call mode before start() returns, not on the handler', () => {
    const start = javaMethod('public void start()');
    const guard = start.indexOf('twringRoutesAudio()');
    expect(guard).toBeGreaterThan(-1);
    expect(start.indexOf('startWithoutRouting()')).toBeLessThan(
      start.indexOf('postAtFrontOfQueue'),
    );
    const body = javaMethod('private synchronized void startWithoutRouting()');
    expect(body).not.toContain('handler.');
    expect(body).toContain('audioManager.getMode()');
    expect(body).toContain('audioManager.setMode(audioMode)');
  });

  it('requests and abandons audio focus with the fields AudioSwitch used', () => {
    const start = javaMethod('private synchronized void startWithoutRouting()');
    expect(start).toContain('if (manageAudioFocus)');
    expect(start).toContain('requestAudioFocus(');
    expect(start).toContain('setOnAudioFocusChangeListener(audioFocusChangeListener)');
    expect(start).toContain('new AudioFocusRequest.Builder(focusMode)');
    expect(start).toContain('setUsage(audioAttributeUsageType)');
    expect(start).toContain('setContentType(audioAttributeContentType)');
    expect(javaMethod('private synchronized void stopWithoutRouting()')).toContain(
      'abandonAudioFocusRequest(',
    );
  });

  it('saves the mic mute at start and restores it, then the mode, on stop', () => {
    expect(javaMethod('private synchronized void startWithoutRouting()')).toContain(
      'audioManager.isMicrophoneMute()',
    );
    const stop = javaMethod('private synchronized void stopWithoutRouting()');
    const mute = stop.indexOf('audioManager.setMicrophoneMute(');
    const mode = stop.indexOf('audioManager.setMode(');
    const focus = stop.indexOf('abandonAudioFocusRequest(');
    expect(mute).toBeGreaterThan(-1);
    expect(mute).toBeLessThan(mode);
    expect(mode).toBeLessThan(focus);
  });

  it('never dereferences a missing AudioSwitch in the setters', () => {
    const lines = audioSwitchManager.split('\n');
    lines.forEach((line, i) => {
      if (line.includes('requireNonNull(audioSwitch)')) {
        expect(lines[i - 1], `line ${i + 1}`).toContain('if (audioSwitch != null)');
      }
    });
  });
});
