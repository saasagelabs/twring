import { randomBytes } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { CredentialCipher, messageAad, messageKeys } from './cipher';

describe('message keys', () => {
  it('derives deterministic, separate keys and preserves versions', () => {
    const source = {
      currentVersion: 2,
      keys: new Map([
        [1, randomBytes(32).toString('base64')],
        [2, randomBytes(32).toString('base64')],
      ]),
    };
    const derived = messageKeys(source);
    expect(derived.currentVersion).toBe(2);
    expect([...derived.keys.keys()]).toEqual([1, 2]);
    expect(derived.keys.get(2)).not.toBe(source.keys.get(2));
    expect(messageKeys(source).keys.get(2)).toBe(derived.keys.get(2));
    const sealed = new CredentialCipher(derived).seal('secret', messageAad('u', 't', 'm'));
    expect(() => new CredentialCipher(source).open(sealed, messageAad('u', 't', 'm'))).toThrow();
  });
});
