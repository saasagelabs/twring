import {
  base64urlEncode,
  deviceIdFor,
  generateSealKeyPair,
  sealTrustNote,
  type E2eDeviceWithNote,
  type TrustNote,
} from '@twring/contracts';
import { describe, expect, it } from 'vitest';

import { e2eConfigSchema, type E2eConfig, type TrustedDevice } from './keys';
import { applyTrustNotes, syncDevices } from './sync';
import { baseConfig } from './test-fixtures';

const APPROVAL = `pap_${'q'.repeat(20)}`;
const NOW = Date.parse('2026-11-25T12:00:00.000Z');

function device() {
  const pair = generateSealKeyPair();
  return { ...pair, id: deviceIdFor(pair.publicKey), key: base64urlEncode(pair.publicKey) };
}
type Dev = ReturnType<typeof device>;

const computer = device();
const trustedPhone = device();
const newPhone = device();
const stranger = device();
const me = { deviceId: computer.id, privateKey: computer.privateKey };

const trustedOf = (d: Dev, kind: 'phone' | 'computer' = 'phone'): TrustedDevice => ({
  id: d.id,
  kind,
  name: 'Pixel',
  public_key: d.key,
  verified_at: '2026-11-24T00:00:00.000Z',
});
const trusted = () => [trustedOf(trustedPhone)];

function noteFrom(sender: Dev, add: Dev = newPhone): TrustNote {
  return sealTrustNote({
    payload: {
      kind: 'trust_add',
      approval_id: APPROVAL,
      add: { id: add.id, kind: 'phone', name: 'New phone', public_key: add.key },
      known: [],
    },
    senderDevice: sender.id,
    senderPrivate: sender.privateKey,
    recipients: [
      { id: newPhone.id, publicKey: newPhone.publicKey },
      { id: computer.id, publicKey: computer.publicKey },
    ],
  });
}

const listed = (note: TrustNote, d: Dev = newPhone, extra = {}): E2eDeviceWithNote => ({
  id: d.id,
  kind: 'phone',
  name: 'New phone',
  public_key: d.key,
  added_at: '2026-11-25T11:59:00.000Z',
  trust_note: note,
  ...extra,
});

describe('applyTrustNotes (C3 #11, Task 27)', () => {
  it('trusts a device added by a trusted phone note', () => {
    const out = applyTrustNotes(trusted(), [listed(noteFrom(trustedPhone))], me, NOW);
    expect(out.trusted.map((d) => d.id)).toContain(newPhone.id);
    expect(out.added).toBe(1);
  });

  it('ignores a trust note from an untrusted sender', () => {
    const out = applyTrustNotes(trusted(), [listed(noteFrom(stranger))], me, NOW);
    expect(out.trusted.map((d) => d.id)).not.toContain(newPhone.id);
    expect(out.refused).toEqual(['sender_not_trusted']);
  });

  it('ignores a note from a trusted computer', () => {
    const out = applyTrustNotes(
      [trustedOf(stranger, 'computer')],
      [listed(noteFrom(stranger))],
      me,
      NOW,
    );
    expect(out.added).toBe(0);
    expect(out.refused).toEqual(['sender_not_trusted']);
  });

  it('ignores a note listed with a swapped public key', () => {
    // The server lists the note under another device with the same id but its own key.
    const swapped = { ...listed(noteFrom(trustedPhone)), public_key: stranger.key };
    const out = applyTrustNotes(trusted(), [swapped], me, NOW);
    expect(out.added).toBe(0);
    expect(out.refused).toEqual(['wrong_device']);
    // Or moves a real note onto another listed device.
    const moved = listed(noteFrom(trustedPhone), stranger);
    expect(applyTrustNotes(trusted(), [moved], me, NOW).refused).toEqual(['wrong_device']);
  });

  it('ignores a note with a tampered body', () => {
    const note = noteFrom(trustedPhone);
    const body = `${note.body.slice(0, 10)}${note.body[10] === 'A' ? 'B' : 'A'}${note.body.slice(11)}`;
    const out = applyTrustNotes(trusted(), [listed({ ...note, body })], me, NOW);
    expect(out.added).toBe(0);
    expect(out.refused).toEqual(['unopenable']);
  });

  it('skips revoked rows and does not let a newly vouched phone vouch in the same pass', () => {
    const revoked = listed(noteFrom(trustedPhone), newPhone, {
      revoked_at: '2026-11-25T11:59:30.000Z',
    });
    expect(applyTrustNotes(trusted(), [revoked], me, NOW).added).toBe(0);
    const chained = listed(noteFrom(newPhone, stranger), stranger);
    const out = applyTrustNotes(trusted(), [listed(noteFrom(trustedPhone)), chained], me, NOW);
    expect(out.trusted.map((d) => d.id)).toEqual([trustedPhone.id, newPhone.id]);
  });
});

describe('syncDevices with notes', () => {
  it('saves a phone a trusted phone approved', async () => {
    let e2e = {
      device_id: computer.id,
      public_key: computer.key,
      private_key: base64urlEncode(computer.privateKey),
      devices: trusted(),
      seq: 0,
    };
    const lines: string[] = [];
    const result = await syncDevices({
      server: baseConfig.server,
      token: baseConfig.token,
      fetch: () =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              devices: [
                listed(noteFrom(trustedPhone)),
                listed(noteFrom(stranger, stranger), stranger),
              ],
            }),
            { status: 200 },
          ),
        ),
      now: () => NOW,
      log: (line) => lines.push(line),
      persist: (change) => {
        e2e = change(e2e);
        return Promise.resolve(e2e);
      },
    });
    expect(result?.added).toBe(1);
    expect(e2e.devices.map((d) => d.id)).toEqual([trustedPhone.id, newPhone.id]);
    expect(lines).toEqual(['e2e_trust_note_refused sender_not_trusted (1)']);
  });
});

describe('a removed phone listed again (C3 #11 P4b1 verify)', () => {
  it('never trusts a phone again after the server said it was removed', async () => {
    let e2e: E2eConfig = {
      device_id: computer.id,
      public_key: computer.key,
      private_key: base64urlEncode(computer.privateKey),
      devices: [...trusted(), trustedOf(newPhone)],
      seq: 0,
    };
    const note = noteFrom(trustedPhone);
    let rows: E2eDeviceWithNote[] = [
      listed(note, newPhone, { revoked_at: '2026-11-25T11:59:30.000Z' }),
    ];
    const sync = () =>
      syncDevices({
        server: baseConfig.server,
        token: baseConfig.token,
        fetch: () =>
          Promise.resolve(new Response(JSON.stringify({ devices: rows }), { status: 200 })),
        now: () => NOW,
        persist: (change) => {
          e2e = e2eConfigSchema.parse(change(e2e));
          return Promise.resolve(e2e);
        },
      });
    await sync();
    expect(e2e.devices.map((d) => d.id)).toEqual([trustedPhone.id]);
    // A hostile server lists the removed phone as active again with its old, valid note.
    rows = [listed(note)];
    const second = await sync();
    expect(second?.added).toBe(0);
    expect(e2e.devices.map((d) => d.id)).toEqual([trustedPhone.id]);
  });
});

describe('the removed-device memory cannot be flushed by the server (R3-9)', () => {
  const removedConfig = (): E2eConfig => ({
    device_id: computer.id,
    public_key: computer.key,
    private_key: base64urlEncode(computer.privateKey),
    devices: trusted(),
    revoked: [newPhone.id],
    seq: 0,
  });
  const fakeRevoked = (count: number): E2eDeviceWithNote[] =>
    Array.from({ length: count }, () => {
      const d = device();
      return {
        id: d.id,
        kind: 'phone' as const,
        name: 'Other',
        public_key: d.key,
        added_at: '2026-11-25T11:00:00.000Z',
        revoked_at: '2026-11-25T11:30:00.000Z',
      };
    });
  const syncWith = (state: { e2e: E2eConfig }, rows: E2eDeviceWithNote[]) =>
    syncDevices({
      server: baseConfig.server,
      token: baseConfig.token,
      fetch: () =>
        Promise.resolve(new Response(JSON.stringify({ devices: rows }), { status: 200 })),
      now: () => NOW,
      persist: (change) => {
        state.e2e = e2eConfigSchema.parse(change(state.e2e));
        return Promise.resolve(state.e2e);
      },
    });

  it('40 fresh revoked ids in one list do not let an old trust note bring a removed phone back', async () => {
    const state = { e2e: removedConfig() };
    const out = await syncWith(state, [...fakeRevoked(40), listed(noteFrom(trustedPhone))]);
    expect(out?.added).toBe(0);
    expect(state.e2e.devices.map((d) => d.id)).toEqual([trustedPhone.id]);
    expect(state.e2e.revoked).toEqual([newPhone.id]);
  });

  it('the same flush spread over two syncs does not bring it back either', async () => {
    const state = { e2e: removedConfig() };
    await syncWith(state, fakeRevoked(40));
    const out = await syncWith(state, [listed(noteFrom(trustedPhone))]);
    expect(out?.added).toBe(0);
    expect(state.e2e.devices.map((d) => d.id)).toEqual([trustedPhone.id]);
  });

  it('still remembers a phone it trusted once the server removes it', async () => {
    const state = {
      e2e: { ...removedConfig(), revoked: [], devices: [...trusted(), trustedOf(newPhone)] },
    };
    await syncWith(state, [
      listed(noteFrom(trustedPhone), newPhone, { revoked_at: '2026-11-25T11:59:30.000Z' }),
    ]);
    expect(state.e2e.revoked).toEqual([newPhone.id]);
  });
});

describe('a removed phone the server still lists as revoked', () => {
  const config = (): E2eConfig => ({
    device_id: computer.id,
    public_key: computer.key,
    private_key: base64urlEncode(computer.privateKey),
    devices: trusted(),
    revoked: [newPhone.id],
    seq: 0,
  });
  const run = (
    state: { e2e: E2eConfig },
    rows: E2eDeviceWithNote[],
    lines: string[],
    refusalLog?: { last?: string },
  ) =>
    syncDevices({
      server: baseConfig.server,
      token: baseConfig.token,
      fetch: () =>
        Promise.resolve(new Response(JSON.stringify({ devices: rows }), { status: 200 })),
      now: () => NOW,
      log: (line) => lines.push(line),
      ...(refusalLog !== undefined && { refusalLog }),
      persist: (change) => {
        state.e2e = e2eConfigSchema.parse(change(state.e2e));
        return Promise.resolve(state.e2e);
      },
    });

  it('is skipped silently, not counted as a refused note', async () => {
    const state = { e2e: config() };
    const lines: string[] = [];
    const out = await run(
      state,
      [listed(noteFrom(trustedPhone), newPhone, { revoked_at: '2026-11-25T11:59:30.000Z' })],
      lines,
    );
    expect(out?.added).toBe(0);
    expect(lines).toEqual([]);
    expect(state.e2e.devices.map((d) => d.id)).toEqual([trustedPhone.id]);
  });

  it('is still refused and never added when listed as active', async () => {
    const state = { e2e: config() };
    const lines: string[] = [];
    const out = await run(state, [listed(noteFrom(trustedPhone))], lines);
    expect(out?.added).toBe(0);
    expect(lines).toEqual(['e2e_trust_note_refused removed (1)']);
    expect(state.e2e.devices.map((d) => d.id)).toEqual([trustedPhone.id]);
  });

  it('logs the same refusals once per session and again when they change', async () => {
    const state = { e2e: config() };
    const lines: string[] = [];
    const refusalLog = {};
    const active = [listed(noteFrom(trustedPhone))];
    await run(state, active, lines, refusalLog);
    await run(state, active, lines, refusalLog);
    expect(lines).toEqual(['e2e_trust_note_refused removed (1)']);
    await run(state, [], lines, refusalLog);
    await run(state, active, lines, refusalLog);
    expect(lines).toEqual([
      'e2e_trust_note_refused removed (1)',
      'e2e_trust_note_refused removed (1)',
    ]);
  });
});
