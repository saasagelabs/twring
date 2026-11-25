import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  configDir,
  forgetLastRing,
  loadConfig,
  readLastRing,
  saveConfig,
  saveLastRing,
} from './config';
import { ensureDeviceKey } from './e2e/keys';
import { baseConfig } from './e2e/test-fixtures';

describe('private chats in the saved config', () => {
  it('keeps the device key through a save and load', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cord-e2e-config-'));
    try {
      const path = join(dir, 'config.json');
      const config = ensureDeviceKey(baseConfig).config;
      await saveConfig(path, config);
      expect(await loadConfig(path)).toEqual(config);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === 'win32')('keeps the file readable by this user only', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cord-e2e-config-'));
    try {
      const path = join(dir, 'config.json');
      await saveConfig(path, ensureDeviceKey(baseConfig).config);
      expect((await stat(path)).mode & 0o777).toBe(0o600);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('loads private chat settings saved by a newer connector, keeping the key', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cord-e2e-config-'));
    try {
      const path = join(dir, 'config.json');
      const config = ensureDeviceKey(baseConfig).config;
      const phone = {
        id: `dev_${'b'.repeat(20)}`,
        kind: 'phone',
        name: 'Pixel',
        public_key: config.e2e!.public_key,
        verified_at: '2026-11-25T10:00:00.000Z',
      };
      const newer = {
        ...config,
        e2e: { ...config.e2e, devices: [{ ...phone, later: 1 }], from_a_later_version: [1] },
      };
      await writeFile(path, JSON.stringify(newer));
      const loaded = await loadConfig(path);
      expect(loaded?.e2e?.private_key).toBe(config.e2e!.private_key);
      expect(loaded?.e2e?.devices).toEqual([phone]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('loads a config saved before private chats', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cord-e2e-config-'));
    try {
      const path = join(dir, 'config.json');
      await saveConfig(path, baseConfig);
      expect((await loadConfig(path))?.e2e).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

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
