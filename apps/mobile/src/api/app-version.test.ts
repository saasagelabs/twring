import { describe, expect, it } from 'vitest';

import { appVersionLabel } from './app-version';

describe('appVersionLabel', () => {
  it('names the version, the build when known, and the platform', () => {
    expect(appVersionLabel({ version: '0.1.0', android: { versionCode: 12 } }, 'android')).toBe(
      '0.1.0 (12) android',
    );
    expect(appVersionLabel({ version: '0.1.0', ios: { buildNumber: '13' } }, 'ios')).toBe(
      '0.1.0 (13) ios',
    );
    expect(appVersionLabel({ version: '0.1.0' }, 'ios')).toBe('0.1.0 ios');
    expect(appVersionLabel(undefined, 'android')).toBe('unknown android');
  });
});
