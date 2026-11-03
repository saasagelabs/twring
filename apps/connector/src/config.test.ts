import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { configDir, forgetLastRing, readLastRing, saveLastRing } from './config';

describe('configDir', () => {
  it('keeps the existing directory under XDG_CONFIG_HOME', () => {
    const base = join('test-home', '.config');
    expect(configDir({ XDG_CONFIG_HOME: base })).toBe(join(base, 'cord-connect'));
  });

  it('keeps the existing directory under APPDATA on Windows', () => {
    if (process.platform !== 'win32') return;
    const base = join('test-home', 'AppData', 'Roaming');
    expect(configDir({ APPDATA: base })).toBe(join(base, 'cord-connect'));
  });

  it('preserves the explicit directory override', () => {
    const directory = join('test-home', 'custom');
    expect(configDir({ CORD_CONNECT_CONFIG_DIR: directory })).toBe(directory);
  });
});

describe('last ring file (ring --cancel)', () => {
  it('keeps one valid invite id, forgets it, and ignores anything else in the file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cord-last-ring-'));
    try {
      expect(await readLastRing(dir)).toBeUndefined();
      const id = `inv_${'a'.repeat(26)}`;
      await saveLastRing(dir, id);
      expect(await readLastRing(dir)).toBe(id);
      await forgetLastRing(dir);
      expect(await readLastRing(dir)).toBeUndefined();
      await writeFile(join(dir, 'last-ring'), '../../etc/passwd');
      expect(await readLastRing(dir)).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
