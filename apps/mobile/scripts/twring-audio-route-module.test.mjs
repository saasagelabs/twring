import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

// There is no Kotlin unit harness, so this checks the source of the twring-audio-route module:
// on Android 12+ it is the only call audio route writer (ADR-049), and it reads the device back
// and clears it with a call token. The JS side is covered in src/platform/audio-route.test.ts.
const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(
  join(
    here,
    '../modules/twring-audio-route/android/src/main/java/expo/modules/twringaudioroute/TwringAudioRouteModule.kt',
  ),
  'utf8',
);

function fn(name) {
  const start = source.indexOf(`Function("${name}")`);
  expect(start, `Function("${name}")`).toBeGreaterThan(-1);
  const next = source.indexOf('Function("', start + 1);
  return source.slice(start, next === -1 ? undefined : next);
}

describe('twring-audio-route native module', () => {
  it('records the call token on setCommunicationDevice', () => {
    const body = fn('setCommunicationDevice');
    expect(body).toMatch(/token: Int\?/);
    expect(body).toContain('lastToken = token');
  });

  it('reads back the communication device on Android 12+ only', () => {
    const body = fn('currentCallDevice');
    expect(body).toContain('VERSION_CODES.S');
    expect(body).toContain('communicationDevice');
  });

  it('reports whether the mode is MODE_IN_COMMUNICATION', () => {
    expect(fn('callModeActive')).toContain('MODE_IN_COMMUNICATION');
  });

  it('clears only when the last set had the same token', () => {
    const body = fn('clearCommunicationDevice');
    expect(body).toContain('clearCommunicationDevice()');
    expect(body).toMatch(/token != null && token != lastToken/);
  });

  it('maps every call device type and logs unknown raw types', () => {
    for (const type of [
      'TYPE_BLUETOOTH_SCO',
      'TYPE_BLE_HEADSET',
      'TYPE_BLE_SPEAKER',
      'TYPE_HEARING_AID',
      'TYPE_WIRED_HEADSET',
      'TYPE_WIRED_HEADPHONES',
      'TYPE_USB_HEADSET',
      'TYPE_BUILTIN_SPEAKER',
      'TYPE_BUILTIN_EARPIECE',
    ]) {
      expect(source).toContain(`AudioDeviceInfo.${type}`);
    }
    expect(source).toMatch(/Log\.\w\(TAG, .*unknown call device type/);
  });
});
