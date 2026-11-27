import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loadConfig, saveConfig } from '../config';
import { ensureDeviceKey } from './keys';
import { updateConfig, updateE2e, withCommandFields } from './store';
import { baseConfig } from './test-fixtures';

const WORKER = fileURLToPath(new URL('./store.worker.ts', import.meta.url));
const PHONE_A = `dev_${'a'.repeat(20)}`;
const PHONE_B = `dev_${'b'.repeat(20)}`;

let dir: string;
let path: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'twring-store-'));
  path = join(dir, 'config.json');
  await saveConfig(path, ensureDeviceKey(baseConfig).config);
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function worker(rounds: number, deviceId: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ['--import', 'tsx', WORKER, path, String(rounds), deviceId],
      { stdio: ['ignore', 'ignore', 'inherit'] },
    );
    child.on('error', reject);
    child.on('exit', (code) => resolve(code ?? 1));
  });
}

describe('updateE2e across processes', () => {
  it('loses neither a new phone nor a seq when two processes write at once', async () => {
    const rounds = 30;
    const codes = await Promise.all([worker(rounds, PHONE_A), worker(rounds, PHONE_B)]);
    expect(codes).toEqual([0, 0]);
    const saved = await loadConfig(path);
    expect(saved?.e2e?.seq).toBe(rounds * 2);
    expect(saved?.e2e?.devices.map((d) => d.id).sort()).toEqual([PHONE_A, PHONE_B]);
    await expect(stat(`${path}.lock`)).rejects.toThrow();
    if (process.platform !== 'win32') expect((await stat(path)).mode & 0o777).toBe(0o600);
  }, 60_000);

  it('takes over a lock left by a process that died', async () => {
    await writeFile(`${path}.lock`, 'old');
    const old = new Date(Date.now() - 60_000);
    await utimes(`${path}.lock`, old, old);
    const saved = await updateE2e(path, (current) => ({ ...current, seq: current.seq + 1 }));
    expect(saved?.seq).toBe(1);
    await expect(stat(`${path}.lock`)).rejects.toThrow();
  });

  it('gives up on a fresh lock after a bounded wait and changes nothing', async () => {
    await writeFile(`${path}.lock`, 'busy');
    await expect(
      updateE2e(path, (current) => ({ ...current, seq: current.seq + 1 }), { waitMs: 200 }),
    ).rejects.toThrow();
    expect((await loadConfig(path))?.e2e?.seq).toBe(0);
    expect(await readFile(`${path}.lock`, 'utf8')).toBe('busy');
  });

  it('refuses a change the next load would call damaged, and keeps the file readable', async () => {
    await expect(updateE2e(path, (current) => ({ ...current, seq: -1 }))).rejects.toThrow();
    expect((await loadConfig(path))?.e2e?.seq).toBe(0);
    await expect(stat(`${path}.lock`)).rejects.toThrow();
  });

  it('frees the lock when the change throws', async () => {
    await expect(
      updateE2e(path, () => {
        throw new Error('no');
      }),
    ).rejects.toThrow('no');
    await expect(stat(`${path}.lock`)).rejects.toThrow();
  });

  it('never removes a lock another process took over while this change ran', async () => {
    await updateE2e(path, (current) => {
      // As if this change ran past LOCK_STALE_MS and another process took the lock over.
      writeFileSync(`${path}.lock`, 'another process\n');
      return current;
    });
    expect(await readFile(`${path}.lock`, 'utf8')).toBe('another process\n');
  });
});

describe('updateConfig (R3-2)', () => {
  const phone = (id: string) => ({
    id,
    kind: 'phone' as const,
    name: 'Pixel',
    public_key: ensureDeviceKey(baseConfig).config.e2e!.public_key,
    verified_at: '2026-11-25T00:00:00.000Z',
  });

  it('keeps a private chat change the running copy made while a command was busy', async () => {
    await updateE2e(path, (current) => ({
      ...current,
      seq: 5,
      devices: [phone(PHONE_A), phone(PHONE_B)],
    }));
    // A command loads the config, then spends a while detecting agents or asking the server.
    const loaded = (await loadConfig(path))!;
    await updateE2e(path, (current) => ({
      ...current,
      seq: 9,
      devices: [phone(PHONE_A)],
      revoked: [PHONE_B],
    }));
    const agents = [{ ...loaded.agents[0]!, label: 'Claude' }];
    const written = await updateConfig(path, (current) =>
      withCommandFields(current, loaded, { name: 'Desk', agents }),
    );
    const saved = await loadConfig(path);
    expect(saved).toEqual(written);
    expect(saved?.e2e?.seq).toBe(9);
    expect(saved?.e2e?.devices.map((d) => d.id)).toEqual([PHONE_A]);
    expect(saved?.e2e?.revoked).toEqual([PHONE_B]);
    expect(saved?.name).toBe('Desk');
    expect(saved?.agents).toEqual(agents);
    await expect(stat(`${path}.lock`)).rejects.toThrow();
  });

  it("writes the command's own link when the file now holds another pairing", async () => {
    const loaded = (await loadConfig(path))!;
    await saveConfig(path, { ...baseConfig, connector_id: `con_${'z'.repeat(20)}` });
    const written = await updateConfig(path, (current) =>
      withCommandFields(current, loaded, { name: 'Desk' }),
    );
    expect(written).toEqual({ ...loaded, name: 'Desk' });
  });

  it('waits for a change in progress instead of writing over it', async () => {
    await writeFile(`${path}.lock`, 'busy');
    await expect(
      updateConfig(path, (current) => ({ ...current!, name: 'Desk' }), { waitMs: 200 }),
    ).rejects.toThrow();
    expect((await loadConfig(path))?.name).toBe('Laptop');
  });
});
