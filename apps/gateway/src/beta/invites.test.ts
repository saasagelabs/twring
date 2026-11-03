import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { MemoryCollection } from '../store/collection';
import {
  createInviteService,
  hashCode,
  normalizeCode,
  redemptionRecordSchema,
  type InviteCodeRecord,
  type RedemptionRecord,
} from './invites';

const directories: string[] = [];
afterEach(async () => {
  for (const dir of directories.splice(0)) await rm(dir, { recursive: true, force: true });
});

function record(code: string, uses = 1, expires_at = '2099-01-01T00:00:00.000Z'): InviteCodeRecord {
  return {
    hash: hashCode(code),
    uses,
    expires_at,
    note: '',
    created_at: '2026-01-01T00:00:00.000Z',
  };
}

async function setup(ownerCodes: InviteCodeRecord[] = [], member = false) {
  const dir = await mkdtemp(join(tmpdir(), 'cord-invites-'));
  directories.push(dir);
  const codesFile = join(dir, 'invite-codes.json');
  await writeFile(codesFile, JSON.stringify({ codes: ownerCodes }));
  const autoCodes = new MemoryCollection<InviteCodeRecord>();
  const redemptions = new MemoryCollection<RedemptionRecord>();
  const onUnavailable = vi.fn();
  const service = createInviteService({
    members: { has: () => Promise.resolve(member) },
    codesFile,
    autoCodes,
    redemptions,
    onUnavailable,
  });
  return { codesFile, autoCodes, redemptions, service, onUnavailable };
}

describe('letting people in without a code', () => {
  async function open(perDay: number, clock: { now: Date }) {
    const dir = await mkdtemp(join(tmpdir(), 'cord-admit-'));
    directories.push(dir);
    const codesFile = join(dir, 'invite-codes.json');
    await writeFile(codesFile, JSON.stringify({ codes: [record('123456')] }));
    const redemptions = new MemoryCollection<RedemptionRecord>();
    const service = createInviteService({
      members: { has: () => Promise.resolve(false) },
      codesFile,
      autoCodes: new MemoryCollection<InviteCodeRecord>(),
      redemptions,
      autoAdmitPerDay: perDay,
      now: () => clock.now,
    });
    return { service, redemptions };
  }

  it('lets people in up to the daily limit, then keeps the rest waiting', async () => {
    const clock = { now: new Date('2026-10-23T10:00:00.000Z') };
    const { service, redemptions } = await open(2, clock);
    expect(await service.admit('a@example.com', 'ua')).toBe('admitted');
    expect(await service.admit('b@example.com', 'ub')).toBe('admitted');
    expect(await service.admit('c@example.com', 'uc')).toBe('full');
    expect(await service.isMember('a@example.com')).toBe(true);
    expect(await service.isMember('c@example.com')).toBe(false);
    expect(await redemptions.read()).toMatchObject([
      { email: 'a@example.com', user_id: 'ua', auto: true },
      { email: 'b@example.com', user_id: 'ub', auto: true },
    ]);
  });

  it('a new UTC day opens new places, and members are never counted twice', async () => {
    const clock = { now: new Date('2026-10-23T23:59:00.000Z') };
    const { service, redemptions } = await open(1, clock);
    expect(await service.admit('a@example.com', 'ua')).toBe('admitted');
    expect(await service.admit('a@example.com', 'ua')).toBe('member');
    expect(await service.admit('b@example.com', 'ub')).toBe('full');
    clock.now = new Date('2026-10-24T00:01:00.000Z');
    expect(await service.admit('b@example.com', 'ub')).toBe('admitted');
    expect(await redemptions.read()).toHaveLength(2);
  });

  it('codes redeemed today do not use up the automatic places', async () => {
    const clock = { now: new Date('2026-10-23T10:00:00.000Z') };
    const { service } = await open(1, clock);
    expect(await service.redeem('a@example.com', '123456', 'ua')).toBe('redeemed');
    expect(await service.admit('b@example.com', 'ub')).toBe('admitted');
  });

  it('someone emailed an invite is in by email address, without using a daily place', async () => {
    const clock = { now: new Date('2026-10-23T10:00:00.000Z') };
    const { service, redemptions } = await open(1, clock);
    await service.letIn(' Web@Example.com ');
    await service.letIn('web@example.com');
    expect(await service.isMember('web@example.com')).toBe(true);
    expect(await redemptions.read()).toMatchObject([{ email: 'web@example.com', invited: true }]);
    expect(await redemptions.read()).toHaveLength(1);
    expect(await service.admit('app@example.com', 'ua')).toBe('admitted');
  });

  it('a full day answers without rewriting the file', async () => {
    const clock = { now: new Date('2026-10-23T10:00:00.000Z') };
    const { service, redemptions } = await open(1, clock);
    expect(await service.admit('a@example.com', 'ua')).toBe('admitted');
    const update = vi.spyOn(redemptions, 'update');
    expect(await service.admit('b@example.com', 'ub')).toBe('full');
    expect(update).not.toHaveBeenCalled();
  });

  it('is off when the limit is 0', async () => {
    const clock = { now: new Date('2026-10-23T10:00:00.000Z') };
    const { service } = await open(0, clock);
    expect(await service.admit('a@example.com', 'ua')).toBe('closed');
  });

  it('two sign-ins at once cannot both take the last place', async () => {
    const clock = { now: new Date('2026-10-23T10:00:00.000Z') };
    const { service } = await open(1, clock);
    const results = await Promise.all([
      service.admit('a@example.com', 'ua'),
      service.admit('b@example.com', 'ub'),
    ]);
    expect(results.sort()).toEqual(['admitted', 'full']);
  });
});

describe('invite codes', () => {
  it('normalizes only six digits and hashes consistently', () => {
    for (const value of ['123 456', '123-456', ' 123456 '])
      expect(normalizeCode(value)).toBe('123456');
    for (const value of ['12345', 'abcdef']) expect(normalizeCode(value)).toBeUndefined();
    expect(hashCode('123456')).toBe(hashCode('123456'));
    expect(hashCode('123456')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('redeems once, then the code is used up', async () => {
    const { service } = await setup([record('123456')]);
    expect(await service.redeem(' A@Example.com ', '123-456')).toBe('redeemed');
    expect(await service.isMember('a@example.com')).toBe(true);
    expect(await service.redeem('b@example.com', '123456')).toBe('invalid');
  });

  it('keeps the account id with a redemption, so a first call can be tied to the invite', async () => {
    const { service, redemptions } = await setup([record('123456', 2)]);
    expect(await service.redeem('a@example.com', '123456', 'user-a')).toBe('redeemed');
    expect(await service.redeem('b@example.com', '123456')).toBe('redeemed');
    const rows = await redemptions.read();
    expect(rows.find((row) => row.email === 'a@example.com')?.user_id).toBe('user-a');
    expect(rows.find((row) => row.email === 'b@example.com')).not.toHaveProperty('user_id');
  });

  it('reads redemptions stored before account ids were kept', () => {
    const old = {
      hash: hashCode('123456'),
      email: 'a@example.com',
      at: '2026-10-20T00:00:00.000Z',
    };
    expect(redemptionRecordSchema.parse(old)).toEqual(old);
  });

  it('rejects expired and unknown codes', async () => {
    const { service } = await setup([record('123456', 1, '2020-01-01T00:00:00.000Z')]);
    expect(await service.redeem('a@example.com', '123456')).toBe('invalid');
    expect(await service.redeem('a@example.com', '999999')).toBe('invalid');
  });

  it('does not spend a use for an existing member', async () => {
    const { service, redemptions } = await setup([record('123456')], true);
    expect(await service.redeem('a@example.com', '123456')).toBe('member');
    expect(await redemptions.read()).toEqual([]);
  });

  it('allows exactly one concurrent redemption of a single use code', async () => {
    const { service } = await setup([record('123456')]);
    const results = await Promise.all([
      service.redeem('a@example.com', '123456'),
      service.redeem('b@example.com', '123456'),
    ]);
    expect(results.sort()).toEqual(['invalid', 'redeemed']);
  });

  it('redeems an auto code and recognizes membership from a redemption', async () => {
    const { service } = await setup();
    const code = await service.createAutoCode('request a@example.com');
    expect(await service.isMember('a@example.com')).toBe(false);
    expect(await service.redeem('a@example.com', code)).toBe('redeemed');
    expect(await service.isMember(' A@EXAMPLE.COM ')).toBe(true);
  });

  it('treats missing and invalid owner files as empty', async () => {
    const { codesFile, service, onUnavailable } = await setup();
    await writeFile(codesFile, 'bad');
    expect(await service.redeem('a@example.com', '123456')).toBe('invalid');
    expect(onUnavailable).toHaveBeenCalledTimes(1);
    const missing = createInviteService({
      members: { has: () => Promise.resolve(false) },
      codesFile: join(tmpdir(), 'missing-cord-invite-codes.json'),
      autoCodes: new MemoryCollection<InviteCodeRecord>(),
      redemptions: new MemoryCollection<RedemptionRecord>(),
    });
    expect(await missing.redeem('a@example.com', '123456')).toBe('invalid');
  });
});
