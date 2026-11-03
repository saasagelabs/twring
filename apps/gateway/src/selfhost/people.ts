import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { join } from 'node:path';

import {
  base64urlEncode,
  generateSealKeyPair,
  normalizePairingCode,
  personRoleSchema,
} from '@twring/contracts';
import { z } from 'zod';

import { newPairingCode, PAIRING_TTL_MS } from '../connectors/pairing';
import { sealedSecretSchema, type CredentialCipher } from '../store/cipher';
import { JsonFileCollection, MemoryCollection, type Collection } from '../store/collection';

export type PersonRole = z.infer<typeof personRoleSchema>;
export type Platform = 'android' | 'ios';

/** A person on this server. Their id is the `user_id` every per-user store already keys on. */
export const personRecordSchema = z.object({
  id: z.string().min(1),
  display_name: z.string().min(1).max(40),
  role: personRoleSchema,
  space_id: z.string().min(1),
  created_at: z.iso.datetime(),
  /** Set when an admin removed them; their phones then hear the removed-phone copy. */
  removed_at: z.iso.datetime().optional(),
});
export type PersonRecord = z.infer<typeof personRecordSchema>;

/** A paired phone. Only the SHA-256 of its token is kept; the server seal key only sealed. */
export const pairedDeviceRecordSchema = z.object({
  id: z.string().min(1),
  person_id: z.string().min(1),
  name: z.string().min(1).max(60),
  platform: z.enum(['android', 'ios']),
  token_hash: z.string().regex(/^[0-9a-f]{64}$/),
  /** The phone's X25519 public key (base64url). */
  seal_public_key: z.string().min(1),
  /** This server's X25519 key pair for the phone: public in clear, private sealed. */
  server_seal_public_key: z.string().min(1),
  server_seal_private_key: sealedSecretSchema,
  relay_handle: z.string().min(1).optional(),
  created_at: z.iso.datetime(),
  last_seen_at: z.iso.datetime().nullable(),
  removed_at: z.iso.datetime().optional(),
});
export type PairedDeviceRecord = z.infer<typeof pairedDeviceRecordSchema>;

/** An open pairing code: its hash, never the code. */
export const pairingCodeRecordSchema = z.object({
  hash: z.string().regex(/^[0-9a-f]{64}$/),
  role: personRoleSchema,
  space_id: z.string().min(1),
  expires_at: z.number().int(),
});
export type PairingCodeRecord = z.infer<typeof pairingCodeRecordSchema>;

const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

function sameHash(a: string, b: string): boolean {
  return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
}

/** The AAD binding a sealed server seal key to its device. */
export function deviceSealAad(deviceId: string): string {
  return `twring-device-seal:v1:${deviceId}`;
}

/** 32 random bytes, base64url, `twd_`. Shown once to the phone. */
export function newDeviceToken(): string {
  return `twd_${randomBytes(32).toString('base64url')}`;
}

export const hashDeviceToken = sha256;

const ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';
function newDeviceId(): string {
  let out = '';
  for (const byte of randomBytes(20)) out += ID_ALPHABET[byte & 31];
  return `dev_${out}`;
}

export class PeopleRepository {
  constructor(
    private readonly collection: Collection<PersonRecord>,
    private readonly now: () => Date = () => new Date(),
  ) {}

  create(input: { displayName: string; role: PersonRole; spaceId: string }): Promise<PersonRecord> {
    const person: PersonRecord = {
      id: randomUUID(),
      display_name: input.displayName,
      role: input.role,
      space_id: input.spaceId,
      created_at: this.now().toISOString(),
    };
    return this.collection.update((items) => ({ items: [...items, person], result: person }));
  }

  /** Includes removed people (so their phones get the removed copy). */
  async get(id: string): Promise<PersonRecord | undefined> {
    return (await this.collection.read()).find((p) => p.id === id);
  }

  /** People still on the server in one space. */
  async list(spaceId: string): Promise<PersonRecord[]> {
    return (await this.collection.read()).filter(
      (p) => p.space_id === spaceId && p.removed_at === undefined,
    );
  }

  /** People an admin removed whose records remain (they can still be purged). */
  async listRemoved(spaceId: string): Promise<PersonRecord[]> {
    return (await this.collection.read()).filter(
      (p) => p.space_id === spaceId && p.removed_at !== undefined,
    );
  }

  async countAdmins(spaceId: string): Promise<number> {
    return (await this.list(spaceId)).filter((p) => p.role === 'admin').length;
  }

  /**
   * An admin removing someone: the record stays, marked removed, unless the last admin would go
   * (then nothing changes and the answer is `last_admin`).
   */
  remove(id: string): Promise<'removed' | 'not_found' | 'last_admin'> {
    const at = this.now().toISOString();
    return this.collection.update((items) => {
      const person = items.find((p) => p.id === id && p.removed_at === undefined);
      if (person === undefined) return { items, result: 'not_found' as const };
      const admins = items.filter(
        (p) => p.space_id === person.space_id && p.role === 'admin' && p.removed_at === undefined,
      );
      if (person.role === 'admin' && admins.length <= 1) {
        return { items, result: 'last_admin' as const };
      }
      return {
        items: items.map((p) => (p.id === id ? { ...p, removed_at: at } : p)),
        result: 'removed' as const,
      };
    });
  }

  /** Delete my data: the record itself goes. */
  delete(id: string): Promise<boolean> {
    return this.collection.update((items) => {
      const kept = items.filter((p) => p.id !== id);
      return { items: kept, result: kept.length !== items.length };
    });
  }
}

export interface ResolvedDevice {
  device: PairedDeviceRecord;
  person: PersonRecord | undefined;
}

export class DeviceTokenRepository {
  private readonly handleListeners: ((handles: string[]) => void)[] = [];

  constructor(
    private readonly collection: Collection<PairedDeviceRecord>,
    private readonly people: PeopleRepository,
    private readonly cipher: CredentialCipher,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /**
   * A new phone for a person. Generates this phone's server seal key pair; the private key is kept
   * only sealed. The token is returned once and never stored.
   */
  async create(input: {
    personId: string;
    name: string;
    platform: Platform;
    sealPublicKey: string;
  }): Promise<{ device: PairedDeviceRecord; token: string }> {
    const token = newDeviceToken();
    const id = newDeviceId();
    const pair = generateSealKeyPair();
    const device: PairedDeviceRecord = {
      id,
      person_id: input.personId,
      name: input.name,
      platform: input.platform,
      token_hash: hashDeviceToken(token),
      seal_public_key: input.sealPublicKey,
      server_seal_public_key: base64urlEncode(pair.publicKey),
      server_seal_private_key: this.cipher.seal(
        base64urlEncode(pair.privateKey),
        deviceSealAad(id),
      ),
      created_at: this.now().toISOString(),
      last_seen_at: null,
    };
    pair.privateKey.fill(0);
    await this.collection.update((items) => ({ items: [...items, device], result: undefined }));
    return { device, token };
  }

  /** The device for a token (removed ones included, so callers can tell), or undefined. */
  async resolve(token: string): Promise<ResolvedDevice | undefined> {
    const hash = hashDeviceToken(token);
    const device = (await this.collection.read()).find((d) => sameHash(d.token_hash, hash));
    if (device === undefined) return undefined;
    return { device, person: await this.people.get(device.person_id) };
  }

  async get(id: string): Promise<PairedDeviceRecord | undefined> {
    return (await this.collection.read()).find((d) => d.id === id);
  }

  /** A person's phones that are still paired. */
  async listFor(personId: string): Promise<PairedDeviceRecord[]> {
    return (await this.collection.read()).filter(
      (d) => d.person_id === personId && d.removed_at === undefined,
    );
  }

  /** Marks a phone removed: its token then answers 401, and it gets no more pushes. */
  async remove(id: string): Promise<boolean> {
    const at = this.now().toISOString();
    const { found, dropped } = await this.collection.update((items) => {
      const target = items.find((d) => d.id === id && d.removed_at === undefined);
      return {
        items:
          target === undefined
            ? items
            : items.map((d) => (d.id === id ? withoutHandle({ ...d, removed_at: at }) : d)),
        result: { found: target !== undefined, dropped: handlesOf(target ? [target] : []) },
      };
    });
    this.dropped(dropped);
    return found;
  }

  async removeAllFor(personId: string): Promise<number> {
    const at = this.now().toISOString();
    const { count, dropped } = await this.collection.update((items) => {
      const mine = items.filter((d) => d.person_id === personId && d.removed_at === undefined);
      const next = items.map((d) =>
        mine.includes(d) ? withoutHandle({ ...d, removed_at: at }) : d,
      );
      return { items: next, result: { count: mine.length, dropped: handlesOf(mine) } };
    });
    this.dropped(dropped);
    return count;
  }

  /** Delete my data: every record of the person's phones goes. */
  async deleteAllFor(personId: string): Promise<number> {
    const { count, dropped } = await this.collection.update((items) => {
      const kept = items.filter((d) => d.person_id !== personId);
      const gone = items.filter((d) => d.person_id === personId);
      return { items: kept, result: { count: gone.length, dropped: handlesOf(gone) } };
    });
    this.dropped(dropped);
    return count;
  }

  /**
   * The phone's ring relay handle; a replaced handle is dropped. Removed phones get none, and a
   * handle another phone holds is refused (`taken`), so one handle never names two phones.
   */
  async setRelayHandle(id: string, handle: string): Promise<'set' | 'not_found' | 'taken'> {
    const { outcome, dropped } = await this.collection.update((items) => {
      const target = items.find((d) => d.id === id && d.removed_at === undefined);
      const taken = items.some((d) => d.id !== id && d.relay_handle === handle);
      const ok = target !== undefined && !taken;
      return {
        items: ok ? items.map((d) => (d.id === id ? { ...d, relay_handle: handle } : d)) : items,
        result: {
          outcome:
            target === undefined
              ? ('not_found' as const)
              : taken
                ? ('taken' as const)
                : ('set' as const),
          dropped:
            ok && target.relay_handle !== undefined && target.relay_handle !== handle
              ? [target.relay_handle]
              : [],
        },
      };
    });
    this.dropped(dropped);
    return outcome;
  }

  /** Forgets a handle the relay called invalid, unless the phone has since sent a newer one. */
  clearRelayHandle(id: string, handle: string): Promise<boolean> {
    return this.collection.update((items) => {
      const found = items.some((d) => d.id === id && d.relay_handle === handle);
      return {
        items: found ? items.map((d) => (d.id === id ? withoutHandle(d) : d)) : items,
        result: found,
      };
    });
  }

  /** The phone turned rings off: forgets its handle whatever it is (and tells the relay). */
  async dropRelayHandle(id: string): Promise<boolean> {
    const dropped = await this.collection.update((items) => {
      const target = items.find((d) => d.id === id && d.removed_at === undefined);
      return {
        items:
          target === undefined ? items : items.map((d) => (d.id === id ? withoutHandle(d) : d)),
        result: target === undefined ? undefined : handlesOf([target]),
      };
    });
    if (dropped === undefined) return false;
    this.dropped(dropped);
    return true;
  }

  /** Called with the handles of phones that were removed or deleted (to tell the relay). */
  onRelayHandlesDropped(listener: (handles: string[]) => void): void {
    this.handleListeners.push(listener);
  }

  private dropped(handles: string[]): void {
    if (handles.length === 0) return;
    for (const listener of this.handleListeners) listener(handles);
  }
}

function withoutHandle(device: PairedDeviceRecord): PairedDeviceRecord {
  const rest = { ...device };
  delete rest.relay_handle;
  return rest;
}

function handlesOf(devices: PairedDeviceRecord[]): string[] {
  return devices.flatMap((d) => (d.relay_handle === undefined ? [] : [d.relay_handle]));
}

export class PairingCodeRepository {
  constructor(
    private readonly collection: Collection<PairingCodeRecord>,
    private readonly now: () => number = () => Date.now(),
  ) {}

  async mint(role: PersonRole, spaceId: string): Promise<{ code: string; expiresAt: Date }> {
    const code = newPairingCode();
    const now = this.now();
    const record: PairingCodeRecord = {
      hash: sha256(code),
      role,
      space_id: spaceId,
      expires_at: now + PAIRING_TTL_MS,
    };
    await this.collection.update((items) => ({
      items: [...items.filter((c) => c.expires_at > now), record],
      result: undefined,
    }));
    return { code, expiresAt: new Date(record.expires_at) };
  }

  /**
   * Takes a code out of circulation in one locked step, so of two simultaneous uses exactly one
   * gets it. Unknown, used and expired codes all answer undefined.
   */
  consume(input: string): Promise<{ role: PersonRole; spaceId: string } | undefined> {
    const code = normalizePairingCode(input);
    const now = this.now();
    if (code === undefined) return Promise.resolve(undefined);
    const hash = sha256(code);
    return this.collection.update((items) => {
      const live = items.filter((c) => c.expires_at > now);
      const match = live.find((c) => sameHash(c.hash, hash));
      if (match === undefined) return { items: live, result: undefined };
      return {
        items: live.filter((c) => c !== match),
        result: { role: match.role, spaceId: match.space_id },
      };
    });
  }
}

export interface SelfhostStores {
  people: PeopleRepository;
  devices: DeviceTokenRepository;
  codes: PairingCodeRepository;
}

export function createSelfhostFileStores(
  dataDir: string,
  cipher: CredentialCipher,
): SelfhostStores {
  const people = new PeopleRepository(
    new JsonFileCollection(join(dataDir, 'people.json'), personRecordSchema),
  );
  return {
    people,
    devices: new DeviceTokenRepository(
      new JsonFileCollection(join(dataDir, 'devices-paired.json'), pairedDeviceRecordSchema),
      people,
      cipher,
    ),
    codes: new PairingCodeRepository(
      new JsonFileCollection(join(dataDir, 'pairing-codes.json'), pairingCodeRecordSchema),
    ),
  };
}

export function createSelfhostMemoryStores(
  cipher: CredentialCipher,
  clock: { now?: () => Date; nowMs?: () => number } = {},
): SelfhostStores {
  const people = new PeopleRepository(new MemoryCollection(), clock.now);
  return {
    people,
    devices: new DeviceTokenRepository(new MemoryCollection(), people, cipher, clock.now),
    codes: new PairingCodeRepository(new MemoryCollection(), clock.nowMs),
  };
}
