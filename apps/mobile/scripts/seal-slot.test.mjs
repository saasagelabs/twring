import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { HOSTED_SEAL_SLOT } from '../src/ring/hosted-seal';

// The JS stores the hosted seal key under HOSTED_SEAL_SLOT; the native stores refuse any id they
// do not allow, so the two must not drift apart (a refused slot made every sealed push unreadable).
const root = join(dirname(fileURLToPath(import.meta.url)), '..', 'modules', 'cord-call-service');

describe('native seal key slots', () => {
  it('Android accepts exactly the hosted slot name besides server ids', () => {
    const kotlin = readFileSync(
      join(root, 'android/src/main/java/expo/modules/cordcallservice/SealKeys.kt'),
      'utf8',
    );
    expect(kotlin).toContain(`const val HOSTED_SLOT = "${HOSTED_SEAL_SLOT}"`);
    expect(kotlin).toContain('require(serverId == HOSTED_SLOT || SERVER_ID.matches(serverId))');
  });

  it('iOS accepts exactly the hosted slot name besides server ids', () => {
    const swift = readFileSync(join(root, 'ios/CordSeal.swift'), 'utf8');
    expect(swift).toContain(`static let hostedSlot = "${HOSTED_SEAL_SLOT}"`);
    expect(swift).toContain('value == hostedSlot ||');
  });
});
