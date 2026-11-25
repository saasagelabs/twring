import {
  base64urlEncode,
  deviceIdFor,
  generateSealKeyPair,
  type PhoneApproval,
  type TrustNote,
} from '@twring/contracts';
import { describe, expect, it, vi } from 'vitest';

import {
  approveWaiting,
  claimWaiting,
  approverUpdate,
  finishApproval,
  pollApproval,
  requestApproval,
  shownApprover,
  type ApproveApi,
} from './approve';
import { loadOrCreateDeviceKey, type DeviceKey } from './device-key';
import { syncTrusted } from './devices';
import { loadTrusted, saveTrusted, type TrustedDevice } from './pairing';
import { memoryStore } from './test-fixtures';

const APPROVAL = `pap_${'k'.repeat(20)}`;
const CON = `con_${'b'.repeat(20)}`;
const NOW = Date.parse('2026-11-25T12:00:00.000Z');
const at = '2026-11-25T11:00:00.000Z';

function other() {
  const pair = generateSealKeyPair();
  return { ...pair, id: deviceIdFor(pair.publicKey), key: base64urlEncode(pair.publicKey) };
}
const trustedEntry = (
  d: { id: string; key: string },
  kind: 'phone' | 'computer',
  connector?: string,
): TrustedDevice => ({
  id: d.id,
  kind,
  name: kind === 'phone' ? 'Pixel' : 'Laptop',
  public_key: d.key,
  verified_at: at,
  ...(connector !== undefined && { connector_id: connector }),
});
const keyOf = (k: DeviceKey) => ({ id: k.deviceId, key: base64urlEncode(k.publicKey) });

/** A fake server answer for one approval, in the state given. */
function approvalFor(n: DeviceKey, extra: Partial<PhoneApproval> = {}): PhoneApproval {
  return {
    id: APPROVAL,
    state: 'pending',
    device_id: n.deviceId,
    name: 'New phone',
    public_key: base64urlEncode(n.publicKey),
    created_at: at,
    expires_at: '2026-11-25T12:10:00.000Z',
    ...extra,
  };
}

async function setup() {
  const tStore = memoryStore();
  const nStore = memoryStore();
  const t = await loadOrCreateDeviceKey(tStore);
  const n = await loadOrCreateDeviceKey(nStore);
  const computer = other();
  await saveTrusted(tStore, [trustedEntry(computer, 'computer', CON)]);
  let sent: TrustNote | undefined;
  const api: ApproveApi = {
    request: () => Promise.resolve({ status: 200, body: approvalFor(n) }),
    status: () => Promise.resolve({ status: 200, body: approvalFor(n) }),
    list: () => Promise.resolve({ status: 200, body: { approvals: [approvalFor(n)] } }),
    claim: () =>
      Promise.resolve({
        status: 200,
        body: approvalFor(n, {
          state: 'claimed',
          approver: { id: t.deviceId, name: 'My Pixel', public_key: base64urlEncode(t.publicKey) },
        }),
      }),
    accept: (_id, _device, note) => {
      sent = note;
      return Promise.resolve({ status: 200, body: approvalFor(n, { state: 'accepted' }) });
    },
    deny: () => Promise.resolve({ status: 204, body: undefined }),
  };
  return { tStore, nStore, t, n, computer, api, sent: () => sent! };
}

describe('approving a second phone (C3 #11, Task 27)', () => {
  it('both phones show the same code, and N trusts the approver and what it knows', async () => {
    const env = await setup();
    const asked = await requestApproval({ api: env.api, store: env.nStore, phoneName: 'New' });
    expect(asked.ok).toBe(true);
    const claimed = await claimWaiting({ api: env.api, store: env.tStore }, APPROVAL);
    if (!claimed.ok) throw new Error('claim failed');
    const approver = {
      id: env.t.deviceId,
      name: 'My Pixel',
      public_key: base64urlEncode(env.t.publicKey),
    };
    const shown = shownApprover(approvalFor(env.n, { state: 'claimed', approver }), env.n)!;
    expect(shown.code).toBe(claimed.claimed.code);

    expect(
      await approveWaiting({ api: env.api, store: env.tStore }, claimed.claimed.approval),
    ).toEqual({ ok: true });
    // The approving phone trusts the new phone too.
    expect((await loadTrusted(env.tStore)).map((d) => d.id)).toContain(env.n.deviceId);

    const accepted = approvalFor(env.n, { state: 'accepted', approver, trust_note: env.sent() });
    expect(await finishApproval({ store: env.nStore, now: () => NOW }, accepted, shown)).toBe(true);
    const mine = await loadTrusted(env.nStore);
    expect(mine.map((d) => d.id).sort()).toEqual([env.t.deviceId, env.computer.id].sort());
    expect(mine.find((d) => d.id === env.computer.id)?.connector_id).toBe(CON);
    expect(mine.some((d) => d.id === env.n.deviceId)).toBe(false);
  });

  it('N refuses a note from a device other than the one whose code it showed', async () => {
    const env = await setup();
    const claimed = await claimWaiting({ api: env.api, store: env.tStore }, APPROVAL);
    if (!claimed.ok) throw new Error('claim failed');
    await approveWaiting({ api: env.api, store: env.tStore }, claimed.claimed.approval);
    const someoneElse = other();
    const shown = {
      id: someoneElse.id,
      name: 'Other',
      public_key: someoneElse.key,
    };
    const accepted = approvalFor(env.n, { state: 'accepted', trust_note: env.sent() });
    expect(await finishApproval({ store: env.nStore }, accepted, shown)).toBe(false);
    // Nor a note relabelled as sent by the shown device (it does not open with that key).
    const relabelled = { ...env.sent(), sender_device: someoneElse.id };
    expect(
      await finishApproval({ store: env.nStore }, { ...accepted, trust_note: relabelled }, shown),
    ).toBe(false);
    expect(await loadTrusted(env.nStore)).toEqual([]);
  });

  it('a key swapped by the server gives different codes on the two screens', async () => {
    const env = await setup();
    const claimed = await claimWaiting({ api: env.api, store: env.tStore }, APPROVAL);
    if (!claimed.ok) throw new Error('claim failed');
    const swapped = other();
    const shown = shownApprover(
      approvalFor(env.n, {
        state: 'claimed',
        approver: { id: swapped.id, name: 'My Pixel', public_key: swapped.key },
      }),
      env.n,
    )!;
    expect(shown.code).not.toBe(claimed.claimed.code);
    // And a claim answer naming another new-phone key gives the approver a different code.
    const mitm = other();
    const api = {
      claim: () =>
        Promise.resolve({
          status: 200,
          body: approvalFor(env.n, { device_id: mitm.id, public_key: mitm.key, state: 'claimed' }),
        }),
    };
    const theirs = await claimWaiting({ api, store: env.tStore }, APPROVAL);
    if (!theirs.ok) throw new Error('claim failed');
    expect(theirs.claimed.code).not.toBe(shown.code);
  });

  it('another trusted phone trusts the new phone from the note on the server list', async () => {
    const env = await setup();
    const pStore = memoryStore();
    const p = await loadOrCreateDeviceKey(pStore);
    await saveTrusted(env.tStore, [trustedEntry(keyOf(p), 'phone')]);
    await saveTrusted(pStore, [trustedEntry(keyOf(env.t), 'phone')]);
    const claimed = await claimWaiting({ api: env.api, store: env.tStore }, APPROVAL);
    if (!claimed.ok) throw new Error('claim failed');
    await approveWaiting({ api: env.api, store: env.tStore }, claimed.claimed.approval);
    const row = {
      id: env.n.deviceId,
      kind: 'phone' as const,
      name: 'New phone',
      public_key: base64urlEncode(env.n.publicKey),
      added_at: at,
      trust_note: env.sent(),
    };
    const me = { deviceId: p.deviceId, privateKey: p.privateKey };
    const out = await syncTrusted(pStore, [row], undefined, me, () => NOW);
    expect(out.map((d) => d.id)).toContain(env.n.deviceId);

    // A phone that does not trust the approver ignores the note.
    const qStore = memoryStore();
    const q = await loadOrCreateDeviceKey(qStore);
    const events: string[] = [];
    const ignored = await syncTrusted(qStore, [row], (event) => events.push(event), {
      deviceId: q.deviceId,
      privateKey: q.privateKey,
    });
    expect(ignored).toEqual([]);
    expect(events).toEqual(['e2e_trust_note_refused']);
  });

  it('polls without overlap and stops for good', async () => {
    vi.useFakeTimers();
    try {
      let calls = 0;
      let release: (() => void) | undefined;
      const stop = pollApproval(() => {
        calls += 1;
        return new Promise<void>((resolve) => (release = resolve));
      }, 2000);
      await vi.advanceTimersByTimeAsync(7000);
      expect(calls).toBe(1);
      release?.();
      await vi.advanceTimersByTimeAsync(2000);
      expect(calls).toBe(2);
      stop();
      release?.();
      await vi.advanceTimersByTimeAsync(10_000);
      expect(calls).toBe(2);
      const failing = pollApproval(() => Promise.reject(new Error('net')), 2000);
      await vi.advanceTimersByTimeAsync(4000);
      failing();
    } finally {
      vi.useRealTimers();
    }
  });

  it('a claim whose approver changes after a code was shown is refused, not shown', () => {
    const a = { id: 'a', name: 'A', public_key: 'ka', code: '111111' };
    expect(approverUpdate(undefined, a)).toBe('show');
    expect(approverUpdate(a, { ...a })).toBe('same');
    expect(approverUpdate(a, { ...a, public_key: 'kb' })).toBe('changed');
    expect(approverUpdate(a, { ...a, id: 'b' })).toBe('changed');
  });

  it('a removed phone listed active again with its old note is not trusted again', async () => {
    const env = await setup();
    const pStore = memoryStore();
    const p = await loadOrCreateDeviceKey(pStore);
    await saveTrusted(env.tStore, [trustedEntry(keyOf(p), 'phone')]);
    await saveTrusted(pStore, [trustedEntry(keyOf(env.t), 'phone')]);
    const claimed = await claimWaiting({ api: env.api, store: env.tStore }, APPROVAL);
    if (!claimed.ok) throw new Error('claim failed');
    await approveWaiting({ api: env.api, store: env.tStore }, claimed.claimed.approval);
    const row = {
      id: env.n.deviceId,
      kind: 'phone' as const,
      name: 'New phone',
      public_key: base64urlEncode(env.n.publicKey),
      added_at: at,
      trust_note: env.sent(),
    };
    const me = { deviceId: p.deviceId, privateKey: p.privateKey };
    expect((await syncTrusted(pStore, [row], undefined, me, () => NOW)).map((d) => d.id)).toContain(
      env.n.deviceId,
    );
    const removed = await syncTrusted(
      pStore,
      [{ ...row, revoked_at: '2026-11-25T12:01:00.000Z' }],
      undefined,
      me,
      () => NOW,
    );
    expect(removed.map((d) => d.id)).not.toContain(env.n.deviceId);
    // A hostile server lists it as active again with the same, valid note.
    const events: string[] = [];
    const again = await syncTrusted(
      pStore,
      [row],
      (e) => events.push(e),
      me,
      () => NOW,
    );
    expect(again.map((d) => d.id)).not.toContain(env.n.deviceId);
    expect(events).toContain('e2e_trust_note_refused');
  });
});
