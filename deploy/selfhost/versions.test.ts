import { describe, expect, it } from 'vitest';

import { recordVersion, setFileDigest, VersionsError } from './versions';

const d = (c: string) => `sha256:${c.repeat(64)}`;

describe('versions.json publishing', () => {
  it('starts an empty list with the version as latest and its major', () => {
    expect(recordVersion(undefined, '1.0.0', d('a'))).toEqual({
      images: { '1.0.0': d('a'), '1': d('a'), latest: d('a') },
    });
  });

  it('moves latest and the major to the highest semver, not the newest publish', () => {
    let v = recordVersion(undefined, '1.2.0', d('a'));
    v = recordVersion(v, '2.0.0', d('b'));
    v = recordVersion(v, '1.10.0', d('c'));
    expect(v.images).toEqual({
      '1.2.0': d('a'),
      '2.0.0': d('b'),
      '1.10.0': d('c'),
      '1': d('c'),
      '2': d('b'),
      latest: d('b'),
    });
  });

  it('keeps kit and connect', () => {
    const current = setFileDigest(setFileDigest(undefined, 'kit', d('e')), 'connect', d('f'));
    const v = recordVersion(current, '1.0.0', d('a'));
    expect(v.kit).toBe(d('e'));
    expect(v.connect).toBe(d('f'));
  });

  it('refuses a version already recorded, bad input and a malformed file', () => {
    const v = recordVersion(undefined, '1.0.0', d('a'));
    expect(() => recordVersion(v, '1.0.0', d('b'))).toThrow(VersionsError);
    expect(() => recordVersion(v, '1.0', d('b'))).toThrow(VersionsError);
    expect(() => recordVersion(v, '1.0.1', 'sha256:xyz')).toThrow(VersionsError);
    expect(() => recordVersion({ '1.0.0': d('a') }, '1.0.1', d('b'))).toThrow(VersionsError);
    expect(() => recordVersion([], '1.0.1', d('b'))).toThrow(VersionsError);
    expect(() => setFileDigest(undefined, 'other' as 'kit', d('a'))).toThrow(VersionsError);
  });
});
