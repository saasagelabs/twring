import {
  base64urlEncode,
  deviceIdFor,
  generateSealKeyPair,
  type E2eDevice,
} from '@twring/contracts';
import { describe, expect, it } from 'vitest';

import { otherPhones } from './other-phones';

function device(kind: 'phone' | 'computer', name: string, extra: Partial<E2eDevice> = {}) {
  const pub = generateSealKeyPair().publicKey;
  return {
    id: deviceIdFor(pub),
    kind,
    name,
    public_key: base64urlEncode(pub),
    added_at: '2026-11-20T10:00:00.000Z',
    ...extra,
  } satisfies E2eDevice;
}

describe('otherPhones', () => {
  it('leaves out this phone, computers and removed phones', async () => {
    const me = device('phone', 'This');
    const iphone = device('phone', 'iPhone');
    const list = [
      me,
      iphone,
      device('computer', 'Laptop'),
      device('phone', 'Old', { revoked_at: '2026-11-21T10:00:00.000Z' }),
    ];
    expect(await otherPhones(() => Promise.resolve(list), me.id)).toEqual([
      { id: iphone.id, name: 'iPhone' },
    ]);
  });

  it('counts every active phone when this phone has no key yet', async () => {
    const a = device('phone', 'A');
    expect(await otherPhones(() => Promise.resolve([a]), undefined)).toEqual([
      { id: a.id, name: 'A' },
    ]);
  });
});
