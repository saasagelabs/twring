import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { CredentialCipher } from '../store/cipher';

import { createSelfhostFileStores, createSelfhostMemoryStores } from './people';

const keys = { currentVersion: 1, keys: new Map([[1, Buffer.alloc(32, 7).toString('base64')]]) };
const cipher = new CredentialCipher(keys);
const PHONE_KEY = 'A'.repeat(43);

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('pairing codes', () => {
  it('mint returns XXXX-XXXX; consume works once, then undefined', async () => {
    const { codes } = createSelfhostMemoryStores(cipher);
    const { code } = await codes.mint('member', 'default');
    expect(code).toMatch(/^[A-HJKMNP-Z2-9]{4}-[A-HJKMNP-Z2-9]{4}$/);
    expect(await codes.consume(code)).toEqual({ role: 'member', spaceId: 'default' });
    expect(await codes.consume(code)).toBeUndefined();
  });

  it('accepts lower case and a missing dash', async () => {
    const { codes } = createSelfhostMemoryStores(cipher);
    const { code } = await codes.mint('admin', 'default');
    expect(await codes.consume(code.replace('-', '').toLowerCase())).toEqual({
      role: 'admin',
      spaceId: 'default',
    });
  });

  it('an expired code (11 minutes, injected clock) is undefined', async () => {
    let now = 1_000_000;
    const { codes } = createSelfhostMemoryStores(cipher, { nowMs: () => now });
    const { code } = await codes.mint('member', 'default');
    now += 11 * 60_000;
    expect(await codes.consume(code)).toBeUndefined();
  });

  it('a code is valid at 9:59 and invalid at 10:01', async () => {
    let now = 5_000_000;
    const { codes } = createSelfhostMemoryStores(cipher, { nowMs: () => now });
    const early = await codes.mint('member', 'default');
    const late = await codes.mint('member', 'default');
    now += 9 * 60_000 + 59_000;
    expect(await codes.consume(early.code)).toBeDefined();
    now += 2_000;
    expect(await codes.consume(late.code)).toBeUndefined();
  });

  it('two simultaneous consumes: exactly one gets the code', async () => {
    const { codes } = createSelfhostMemoryStores(cipher);
    const { code } = await codes.mint('member', 'default');
    const results = await Promise.all([codes.consume(code), codes.consume(code)]);
    expect(results.filter((r) => r !== undefined)).toHaveLength(1);
  });

  it('the stored file contains no plaintext code; the devices file only a token hash', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'twring-people-'));
    dirs.push(dir);
    const stores = createSelfhostFileStores(dir, cipher);
    const { code } = await stores.codes.mint('member', 'default');
    const codesFile = await readFile(join(dir, 'pairing-codes.json'), 'utf8');
    expect(codesFile).not.toContain(code);
    expect(codesFile).not.toContain(code.replace('-', ''));

    const person = await stores.people.create({
      displayName: 'Asha',
      role: 'admin',
      spaceId: 'default',
    });
    const { device, token } = await stores.devices.create({
      personId: person.id,
      name: 'Pixel',
      platform: 'android',
      sealPublicKey: PHONE_KEY,
    });
    const devicesFile = await readFile(join(dir, 'devices-paired.json'), 'utf8');
    expect(devicesFile).not.toContain(token);
    expect(devicesFile).not.toContain(token.slice(4));
    expect((await stores.devices.resolve(token))?.device.id).toBe(device.id);
  });
});

describe('people', () => {
  it('refuses to remove the last admin and counts admins', async () => {
    const { people } = createSelfhostMemoryStores(cipher);
    const admin = await people.create({ displayName: 'A', role: 'admin', spaceId: 'default' });
    const member = await people.create({ displayName: 'M', role: 'member', spaceId: 'default' });
    expect(await people.countAdmins('default')).toBe(1);
    expect(await people.remove(admin.id)).toBe('last_admin');
    expect(await people.remove(member.id)).toBe('removed');
    expect((await people.list('default')).map((p) => p.id)).toEqual([admin.id]);
    expect(await people.remove(member.id)).toBe('not_found');
  });
});
