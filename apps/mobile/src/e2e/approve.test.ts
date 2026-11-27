import {
  approvalCode,
  approvalCommitment,
  base64urlEncode,
  deviceIdFor,
  generateSealKeyPair,
  type PhoneApproval,
  type TrustNote,
} from '@twring/contracts';
import { describe, expect, it, vi } from 'vitest';

import {
  approveWaiting,
  checkReveal,
  clearAfterApproves,
  claimWaiting,
  approverUpdate,
  denyWaiting,
  finishApproval,
  loadApprovalSecret,
  PENDING_APPROVE_KEY_NAME,
  pollApproval,
  requestApproval,
  resumePendingApprove,
  revealApproval,
  settlePendingApprove,
  shownApprover,
  type ApproveApi,
  type CheckedApproval,
} from './approve';
import { loadOrCreateDeviceKey, TRUSTED_KEY_NAME, type DeviceKey } from './device-key';
import { removeDevice, syncTrusted } from './devices';
import { loadTrusted, REMOVED_KEY_NAME, saveTrusted, type TrustedDevice } from './pairing';
import { forgetPrivateDevice } from './private-chats';
import { hasRewrapWork, REWRAP_JOBS_KEY } from './rewrap';
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

/** A fake server holding one approval, answering each call the way the gateway does. */
async function setup() {
  const tStore = memoryStore();
  const nStore = memoryStore();
  const t = await loadOrCreateDeviceKey(tStore);
  const n = await loadOrCreateDeviceKey(nStore);
  const computer = other();
  await saveTrusted(tStore, [trustedEntry(computer, 'computer', CON)]);
  let sent: TrustNote | undefined;
  let row = approvalFor(n);
  const calls: string[] = [];
  const ok = () => Promise.resolve({ status: 200, body: row });
  const approver = { id: t.deviceId, name: 'My Pixel', public_key: base64urlEncode(t.publicKey) };
  const api: ApproveApi = {
    request: (body) => {
      calls.push('request');
      row = approvalFor(n, { commitment: body.commitment });
      return ok();
    },
    status: () => ok(),
    list: () => Promise.resolve({ status: 200, body: { approvals: [row] } }),
    claim: () => {
      calls.push('claim');
      row = { ...row, state: 'claimed', approver };
      return ok();
    },
    nonce: (_id, _device, nonce) => {
      calls.push('nonce');
      row = { ...row, approver_nonce: nonce };
      return ok();
    },
    reveal: (_id, _device, reveal) => {
      calls.push('reveal');
      row = { ...row, reveal };
      return ok();
    },
    accept: (_id, _device, note) => {
      sent = note;
      row = { ...row, state: 'accepted', trust_note: note };
      return ok();
    },
    deny: () => Promise.resolve({ status: 204, body: undefined }),
  };
  return {
    tStore,
    nStore,
    t,
    n,
    computer,
    api,
    approver,
    calls,
    row: () => row,
    setRow: (next: PhoneApproval) => {
      row = next;
    },
    sent: () => sent!,
  };
}
type Env = Awaited<ReturnType<typeof setup>>;

/** Runs both phones to the codes they show: N's shown approver and A's checked approval. */
async function toCodes(env: Env) {
  const asked = await requestApproval({ api: env.api, store: env.nStore, phoneName: 'New' });
  if (!asked.ok) throw new Error('request failed');
  const claimed = await claimWaiting({ api: env.api, store: env.tStore }, APPROVAL);
  if (!claimed.ok) throw new Error('claim failed');
  expect(await checkReveal({ api: env.api, store: env.tStore }, claimed.claimed)).toEqual({
    ok: true,
    waiting: true,
  });
  const secret = (await loadApprovalSecret(env.nStore, APPROVAL))!;
  const shown = shownApprover(env.row(), env.n, secret)!;
  expect(await revealApproval({ api: env.api, store: env.nStore }, env.row())).toEqual({
    ok: true,
  });
  const checked = await checkReveal({ api: env.api, store: env.tStore }, claimed.claimed);
  if (!checked.ok || !('checked' in checked)) throw new Error('no code');
  return { shown, checked: checked.checked, claimed: claimed.claimed };
}

describe('approving a second phone (C3 #11, Task 27)', () => {
  it('both phones show the same code, and N trusts the approver and what it knows', async () => {
    const env = await setup();
    const approver = env.approver;
    const { shown, checked } = await toCodes(env);
    expect(shown.code).toMatch(/^\d{3} \d{3}$/);
    expect(shown.code).toBe(checked.code);
    // A sent its nonce only after it held N's commitment; N revealed only after the nonce.
    expect(env.calls).toEqual(['request', 'claim', 'nonce', 'reveal']);

    expect(await approveWaiting({ api: env.api, store: env.tStore }, checked)).toEqual({
      ok: true,
    });
    // The approving phone trusts the new phone too.
    expect((await loadTrusted(env.tStore)).map((d) => d.id)).toContain(env.n.deviceId);

    const accepted = approvalFor(env.n, { state: 'accepted', approver, trust_note: env.sent() });
    expect(await finishApproval({ store: env.nStore, now: () => NOW }, accepted, shown)).toBe(true);
    const mine = await loadTrusted(env.nStore);
    expect(mine.map((d) => d.id).sort()).toEqual([env.t.deviceId, env.computer.id].sort());
    expect(mine.find((d) => d.id === env.computer.id)?.connector_id).toBe(CON);
    expect(mine.some((d) => d.id === env.n.deviceId)).toBe(false);
    // Both secrets are gone once the approval ends.
    expect(await loadApprovalSecret(env.nStore, APPROVAL)).toBeUndefined();
  });

  it('finishApproval queues sharing for the approver', async () => {
    const env = await setup();
    const approver = env.approver;
    const { shown, checked } = await toCodes(env);
    await approveWaiting({ api: env.api, store: env.tStore }, checked);
    expect(await hasRewrapWork(env.nStore)).toBe(false);
    const accepted = approvalFor(env.n, { state: 'accepted', approver, trust_note: env.sent() });
    expect(await finishApproval({ store: env.nStore, now: () => NOW }, accepted, shown)).toBe(true);
    expect(await hasRewrapWork(env.nStore)).toBe(true);
    const job = JSON.parse((await env.nStore.getItemAsync(REWRAP_JOBS_KEY)) ?? '[]') as {
      for: string;
    }[];
    expect(job.map((j) => j.for)).toEqual([env.t.deviceId]);
  });

  it('N refuses a note from a device other than the one whose code it showed', async () => {
    const env = await setup();
    const { checked } = await toCodes(env);
    await approveWaiting({ api: env.api, store: env.tStore }, checked);
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

  it('a substituted key with its own commitment gives different codes for fixed nonces', () => {
    // The server swaps N's key for Fn and commits to Fn itself. N's code covers Pn, A's covers Fn,
    // and the server had to fix Fn (and its secret) before it saw A's nonce, so it cannot grind.
    const pn = generateSealKeyPair().publicKey;
    const pa = generateSealKeyPair().publicKey;
    const fn = generateSealKeyPair().publicKey;
    const rn = new Uint8Array(32).fill(1);
    const rf = new Uint8Array(32).fill(2);
    const ra = new Uint8Array(32).fill(3);
    expect(approvalCommitment(fn, rf)).not.toEqual(approvalCommitment(pn, rn));
    expect(approvalCode(fn, pa, rf, ra)).not.toBe(approvalCode(pn, pa, rn, ra));
    expect(approvalCode(fn, pa, rn, ra)).not.toBe(approvalCode(pn, pa, rn, ra));
  });

  it('A refuses a request without a commitment and never sends a nonce for it', async () => {
    const env = await setup();
    env.setRow(approvalFor(env.n));
    const out = await claimWaiting({ api: env.api, store: env.tStore }, APPROVAL);
    expect(out).toEqual({ ok: false, code: 'outdated' });
    expect(env.calls).toEqual(['claim']);
  });

  it('A refuses a reveal that does not open the commitment', async () => {
    const env = await setup();
    await requestApproval({ api: env.api, store: env.nStore, phoneName: 'New' });
    const claimed = await claimWaiting({ api: env.api, store: env.tStore }, APPROVAL);
    if (!claimed.ok) throw new Error('claim failed');
    env.setRow({ ...env.row(), reveal: base64urlEncode(new Uint8Array(32).fill(9)) });
    expect(await checkReveal({ api: env.api, store: env.tStore }, claimed.claimed)).toEqual({
      ok: false,
      code: 'mismatch',
    });
    const forged: CheckedApproval = {
      approval: { ...claimed.claimed.approval, reveal: env.row().reveal },
      code: '000 000',
    };
    expect(await approveWaiting({ api: env.api, store: env.tStore }, forged)).toEqual({
      ok: false,
      code: 'mismatch',
    });
  });

  it('A stops when the key, commitment or its nonce changes before the reveal', async () => {
    const env = await setup();
    await requestApproval({ api: env.api, store: env.nStore, phoneName: 'New' });
    const claimed = await claimWaiting({ api: env.api, store: env.tStore }, APPROVAL);
    if (!claimed.ok) throw new Error('claim failed');
    const swapped = other();
    const base = env.row();
    const fake = new Uint8Array(32).fill(4);
    for (const next of [
      { ...base, device_id: swapped.id, public_key: swapped.key },
      { ...base, commitment: base64urlEncode(approvalCommitment(swapped.publicKey, fake)) },
      { ...base, approver_nonce: base64urlEncode(fake) },
    ]) {
      env.setRow(next);
      expect(await checkReveal({ api: env.api, store: env.tStore }, claimed.claimed)).toEqual({
        ok: false,
        code: 'mismatch',
      });
    }
  });

  it('another trusted phone trusts the new phone from the note on the server list', async () => {
    const env = await setup();
    const pStore = memoryStore();
    const p = await loadOrCreateDeviceKey(pStore);
    await saveTrusted(env.tStore, [trustedEntry(keyOf(p), 'phone')]);
    await saveTrusted(pStore, [trustedEntry(keyOf(env.t), 'phone')]);
    const { checked } = await toCodes(env);
    await approveWaiting({ api: env.api, store: env.tStore }, checked);
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

  it('a claim whose approver, key or nonce changes after a code was shown is refused', () => {
    const a = { id: 'a', name: 'A', public_key: 'ka', nonce: 'na', code: '111111' };
    expect(approverUpdate(undefined, a)).toBe('show');
    expect(approverUpdate(a, { ...a })).toBe('same');
    expect(approverUpdate(a, { ...a, public_key: 'kb' })).toBe('changed');
    expect(approverUpdate(a, { ...a, id: 'b' })).toBe('changed');
    expect(approverUpdate(a, { ...a, nonce: 'nb' })).toBe('changed');
  });

  it('N shows no code before the nonce, and refuses a reveal that is not its own', async () => {
    const env = await setup();
    await requestApproval({ api: env.api, store: env.nStore, phoneName: 'New' });
    const secret = (await loadApprovalSecret(env.nStore, APPROVAL))!;
    const claimedRow = { ...env.row(), state: 'claimed' as const, approver: env.approver };
    expect(shownApprover(claimedRow, env.n, secret)).toBeUndefined();
    const withNonce = { ...claimedRow, approver_nonce: base64urlEncode(new Uint8Array(32)) };
    const alreadyRevealed = { ...withNonce, reveal: base64urlEncode(new Uint8Array(32).fill(5)) };
    expect(await revealApproval({ api: env.api, store: env.nStore }, alreadyRevealed)).toEqual({
      ok: false,
      code: 'mismatch',
    });
  });

  it('N refuses a new approver nonce after its reveal answer was dropped', async () => {
    const env = await setup();
    await requestApproval({ api: env.api, store: env.nStore, phoneName: 'New' });
    const claimed = await claimWaiting({ api: env.api, store: env.tStore }, APPROVAL);
    if (!claimed.ok) throw new Error('claim failed');
    const first = env.row();
    // The server stores the reveal but the phone sees a network error.
    const dropping: ApproveApi = {
      ...env.api,
      reveal: async (id, device, reveal) => {
        await env.api.reveal(id, device, reveal);
        throw new Error('dropped');
      },
    };
    expect(await revealApproval({ api: dropping, store: env.nStore }, first)).toEqual({
      ok: false,
      code: 'network',
    });
    const regrind = { ...env.row(), approver_nonce: base64urlEncode(new Uint8Array(32).fill(7)) };
    expect(await revealApproval({ api: env.api, store: env.nStore }, regrind)).toEqual({
      ok: false,
      code: 'mismatch',
    });
    const evil = other();
    const swapped = { ...env.row(), approver: { id: evil.id, name: 'X', public_key: evil.key } };
    expect(await revealApproval({ api: env.api, store: env.nStore }, swapped)).toEqual({
      ok: false,
      code: 'mismatch',
    });
    // The same approver and nonce it revealed against still show (a restart, no shown step).
    expect(await revealApproval({ api: env.api, store: env.nStore }, env.row())).toEqual({
      ok: true,
    });
  });

  it('N refuses an already revealed approval it never revealed against', async () => {
    const env = await setup();
    await requestApproval({ api: env.api, store: env.nStore, phoneName: 'New' });
    const secret = (await loadApprovalSecret(env.nStore, APPROVAL))!;
    const row = {
      ...env.row(),
      state: 'claimed' as const,
      approver: env.approver,
      approver_nonce: base64urlEncode(new Uint8Array(32).fill(2)),
      reveal: base64urlEncode(secret),
    };
    expect(await revealApproval({ api: env.api, store: env.nStore }, row)).toEqual({
      ok: false,
      code: 'mismatch',
    });
  });

  it('A re-claiming with its kept nonce refuses a different key or commitment', async () => {
    const env = await setup();
    await requestApproval({ api: env.api, store: env.nStore, phoneName: 'New' });
    const claimed = await claimWaiting({ api: env.api, store: env.tStore }, APPROVAL);
    if (!claimed.ok) throw new Error('claim failed');
    const base = env.row();
    const swapped = other();
    const fake = new Uint8Array(32).fill(4);
    for (const next of [
      {
        ...base,
        device_id: swapped.id,
        public_key: swapped.key,
        commitment: base64urlEncode(approvalCommitment(swapped.publicKey, fake)),
      },
      { ...base, commitment: base64urlEncode(approvalCommitment(env.n.publicKey, fake)) },
    ]) {
      env.setRow(next);
      expect(await claimWaiting({ api: env.api, store: env.tStore }, APPROVAL)).toEqual({
        ok: false,
        code: 'mismatch',
      });
    }
    env.setRow(base);
    const again = await claimWaiting({ api: env.api, store: env.tStore }, APPROVAL);
    expect(again.ok && again.claimed.nonce).toBe(claimed.claimed.nonce);
  });

  it('A refuses a claim that already has a nonce it did not keep', async () => {
    const env = await setup();
    await requestApproval({ api: env.api, store: env.nStore, phoneName: 'New' });
    env.setRow({
      ...env.row(),
      state: 'claimed',
      approver: env.approver,
      approver_nonce: base64urlEncode(new Uint8Array(32).fill(3)),
    });
    expect(await claimWaiting({ api: env.api, store: env.tStore }, APPROVAL)).toEqual({
      ok: false,
      code: 'mismatch',
    });
  });

  it('a removed phone listed active again with its old note is not trusted again', async () => {
    const env = await setup();
    const pStore = memoryStore();
    const p = await loadOrCreateDeviceKey(pStore);
    await saveTrusted(env.tStore, [trustedEntry(keyOf(p), 'phone')]);
    await saveTrusted(pStore, [trustedEntry(keyOf(env.t), 'phone')]);
    const { checked } = await toCodes(env);
    await approveWaiting({ api: env.api, store: env.tStore }, checked);
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

describe('approval and other trust changes, one at a time', () => {
  it('a removal while A approves is not saved back by the approval', async () => {
    const env = await setup();
    const { checked } = await toCodes(env);
    // After the accept answer, A's read of its trusted list is slow: a removal that is not held
    // back would save in between, and A would then save the list it read, with the computer.
    let accepted = false;
    const accept = env.api.accept.bind(env.api);
    env.api.accept = async (...args) => {
      const out = await accept(...args);
      accepted = true;
      return out;
    };
    const read = env.tStore.getItemAsync.bind(env.tStore);
    let slowed = false;
    env.tStore.getItemAsync = async (key: string) => {
      const value = await read(key);
      if (accepted && key === TRUSTED_KEY_NAME && !slowed) {
        slowed = true;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      return value;
    };
    const approving = approveWaiting({ api: env.api, store: env.tStore }, checked);
    while (!accepted) await new Promise((resolve) => setTimeout(resolve, 1));
    const removing = removeDevice(
      {
        api: { remove: () => Promise.resolve() },
        store: env.tStore,
        forgetSelf: () => Promise.resolve(),
      },
      env.computer.id,
    );
    expect(await approving).toEqual({ ok: true });
    await removing;
    const ids = (await loadTrusted(env.tStore)).map((d) => d.id);
    expect(ids).toContain(env.n.deviceId);
    expect(ids).not.toContain(env.computer.id);
  });

  it('A leaves a device it removed out of the note and the saved list', async () => {
    const env = await setup();
    const { checked } = await toCodes(env);
    await env.tStore.setItemAsync(REMOVED_KEY_NAME, JSON.stringify([env.computer.id]));
    expect(await approveWaiting({ api: env.api, store: env.tStore }, checked)).toEqual({
      ok: true,
    });
    expect((await loadTrusted(env.tStore)).map((d) => d.id)).toEqual([env.n.deviceId]);
  });

  it('N never takes back a device it removed from the note, except the approver it checked', async () => {
    const env = await setup();
    const approver = env.approver;
    const { shown, checked } = await toCodes(env);
    await approveWaiting({ api: env.api, store: env.tStore }, checked);
    await env.nStore.setItemAsync(
      REMOVED_KEY_NAME,
      JSON.stringify([env.computer.id, env.t.deviceId]),
    );
    const accepted = approvalFor(env.n, { state: 'accepted', approver, trust_note: env.sent() });
    expect(await finishApproval({ store: env.nStore, now: () => NOW }, accepted, shown)).toBe(true);
    expect((await loadTrusted(env.nStore)).map((d) => d.id)).toEqual([env.t.deviceId]);
    // The approver left the removed memory, so the next sync keeps it.
    expect(JSON.parse((await env.nStore.getItemAsync(REMOVED_KEY_NAME)) ?? '[]')).toEqual([
      env.computer.id,
    ]);
  });
});

describe('an approve whose answer was lost', () => {
  it('sends the same note again and finishes, since the server already took it', async () => {
    const env = await setup();
    const { checked } = await toCodes(env);
    const accept = env.api.accept.bind(env.api);
    const notes: TrustNote[] = [];
    env.api.accept = async (id, device, note) => {
      notes.push(note);
      const out = await accept(id, device, note);
      // The first answer never arrives, though the server applied it.
      if (notes.length === 1) throw new Error('offline');
      return out;
    };
    const waits: number[] = [];
    const wait = (ms: number) => {
      waits.push(ms);
      return Promise.resolve();
    };
    expect(await approveWaiting({ api: env.api, store: env.tStore, wait }, checked)).toEqual({
      ok: true,
    });
    expect(waits).toEqual([1_000]);
    expect(notes).toHaveLength(2);
    expect(notes[1]).toEqual(notes[0]);
    expect((await loadTrusted(env.tStore)).map((d) => d.id)).toContain(env.n.deviceId);
    expect(await hasRewrapWork(env.tStore)).toBe(true);
  });

  it('keeps the claim when every try failed, so tapping again carries on', async () => {
    const env = await setup();
    const { checked } = await toCodes(env);
    let tries = 0;
    env.api.accept = () => {
      tries += 1;
      return Promise.reject(new Error('offline'));
    };
    const waits: number[] = [];
    const wait = (ms: number) => {
      waits.push(ms);
      return Promise.resolve();
    };
    expect(await approveWaiting({ api: env.api, store: env.tStore, wait }, checked)).toEqual({
      ok: false,
      code: 'network',
    });
    expect(tries).toBe(3);
    expect(waits).toEqual([1_000, 3_000]);
    expect((await loadTrusted(env.tStore)).map((d) => d.id)).not.toContain(env.n.deviceId);
    expect((await claimWaiting({ api: env.api, store: env.tStore }, APPROVAL)).ok).toBe(true);
  });

  it('is finished later, once the connection is back, if the person left the screen', async () => {
    const env = await setup();
    const { checked } = await toCodes(env);
    const accept = env.api.accept.bind(env.api);
    let online = false;
    env.api.accept = async (id, device, note) => {
      // The server takes the first try; its answer, and every try after it, is lost.
      const out = await accept(id, device, note);
      if (!online) throw new Error('offline');
      return out;
    };
    const wait = () => Promise.resolve();
    expect((await approveWaiting({ api: env.api, store: env.tStore, wait }, checked)).ok).toBe(
      false,
    );
    // Still offline the next time Devices opens: kept for later.
    expect(await resumePendingApprove({ api: env.api, store: env.tStore, wait })).toBe('waiting');
    online = true;
    expect(await resumePendingApprove({ api: env.api, store: env.tStore, wait })).toBe('done');
    expect((await loadTrusted(env.tStore)).map((d) => d.id)).toContain(env.n.deviceId);
    expect(await hasRewrapWork(env.tStore)).toBe(true);
    // Done once: nothing is left to finish.
    expect(await resumePendingApprove({ api: env.api, store: env.tStore, wait })).toBe('none');
  });

  it('is dropped, not finished, when the person removed that phone in the meantime', async () => {
    const env = await setup();
    const { checked } = await toCodes(env);
    let tries = 0;
    env.api.accept = () => {
      tries += 1;
      return Promise.reject(new Error('offline'));
    };
    const wait = () => Promise.resolve();
    await approveWaiting({ api: env.api, store: env.tStore, wait }, checked);
    await env.tStore.setItemAsync(REMOVED_KEY_NAME, JSON.stringify([env.n.deviceId]));
    tries = 0;
    expect(await resumePendingApprove({ api: env.api, store: env.tStore, wait })).toBe('removed');
    expect(tries).toBe(0);
    expect((await loadTrusted(env.tStore)).map((d) => d.id)).not.toContain(env.n.deviceId);
    expect(await resumePendingApprove({ api: env.api, store: env.tStore, wait })).toBe('none');
  });

  it('runs once at a time, and an approve tapped meanwhile waits for it', async () => {
    const env = await setup();
    const { checked } = await toCodes(env);
    env.api.accept = () => Promise.reject(new Error('offline'));
    const wait = () => Promise.resolve();
    await approveWaiting({ api: env.api, store: env.tStore, wait }, checked);
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let accepts = 0;
    env.api.accept = async () => {
      accepts += 1;
      await held;
      return { status: 200, body: { ...env.row(), state: 'accepted' } };
    };
    const first = resumePendingApprove({ api: env.api, store: env.tStore, wait });
    const second = resumePendingApprove({ api: env.api, store: env.tStore, wait });
    expect(second).toBe(first);
    let settled = false;
    const settling = settlePendingApprove(env.tStore).then(() => {
      settled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(settled).toBe(false);
    release();
    expect(await first).toBe('done');
    await settling;
    expect(accepts).toBe(1);
  });

  it('ends a saved approve the server turned down, and a saved record it cannot read', async () => {
    const env = await setup();
    const { checked } = await toCodes(env);
    env.api.accept = () => Promise.reject(new Error('offline'));
    const wait = () => Promise.resolve();
    await approveWaiting({ api: env.api, store: env.tStore, wait }, checked);
    env.api.accept = () =>
      Promise.resolve({ status: 410, body: { error: { code: 'expired', message: 'x' } } });
    expect(await resumePendingApprove({ api: env.api, store: env.tStore, wait })).toBe('ended');
    expect(await resumePendingApprove({ api: env.api, store: env.tStore, wait })).toBe('none');
    // Its claim went with it: the same claim again would carry a nonce this phone no longer has.
    expect(await claimWaiting({ api: env.api, store: env.tStore }, APPROVAL)).toEqual({
      ok: false,
      code: 'mismatch',
    });
    await env.tStore.setItemAsync(PENDING_APPROVE_KEY_NAME, '{not json');
    expect(await resumePendingApprove({ api: env.api, store: env.tStore, wait })).toBe('none');
    expect(await env.tStore.getItemAsync(PENDING_APPROVE_KEY_NAME)).toBe(null);
  });
});

describe('a saved approve and other approvals', () => {
  it('stays when a different approval finishes or is turned down', async () => {
    const env = await setup();
    const { checked } = await toCodes(env);
    const other = JSON.stringify({
      ...checked,
      approval: { ...checked.approval, id: `pap_${'m'.repeat(20)}` },
    });
    await env.tStore.setItemAsync(PENDING_APPROVE_KEY_NAME, other);
    expect((await approveWaiting({ api: env.api, store: env.tStore }, checked)).ok).toBe(true);
    expect(await env.tStore.getItemAsync(PENDING_APPROVE_KEY_NAME)).toBe(other);
  });

  it('sign-out during a resume leaves nothing of it saved after the keys went', async () => {
    const env = await setup();
    const { checked } = await toCodes(env);
    env.api.accept = () => Promise.reject(new Error('offline'));
    const wait = () => Promise.resolve();
    await approveWaiting({ api: env.api, store: env.tStore, wait }, checked);
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    env.api.accept = async () => {
      await held;
      throw new Error('offline');
    };
    const resumed = resumePendingApprove({ api: env.api, store: env.tStore, wait });
    await new Promise((resolve) => setTimeout(resolve, 5));
    // The resume is waiting on the server; sign-out does not wait for it (this would hang).
    await forgetPrivateDevice(env.tStore);
    release();
    expect(await resumed).toBe('waiting');
    expect(await env.tStore.getItemAsync(PENDING_APPROVE_KEY_NAME)).toBe(null);
  });

  it('a resume the server took while sign-out cleared the keys is dropped without a word', async () => {
    const env = await setup();
    const { checked } = await toCodes(env);
    env.api.accept = () => Promise.reject(new Error('offline'));
    const wait = () => Promise.resolve();
    await approveWaiting({ api: env.api, store: env.tStore, wait }, checked);
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    env.api.accept = async () => {
      await held;
      return { status: 200, body: { ...env.row(), state: 'accepted' } };
    };
    const resumed = resumePendingApprove({ api: env.api, store: env.tStore, wait });
    await new Promise((resolve) => setTimeout(resolve, 5));
    await forgetPrivateDevice(env.tStore);
    release();
    // Not 'ended': Devices would say the approve failed, after the person's own sign-out.
    expect(await resumed).toBe('removed');
    expect(await loadTrusted(env.tStore)).toEqual([]);
    expect(await hasRewrapWork(env.tStore)).toBe(false);
  });

  it('an approve that starts while sign-out is clearing the keys saves nothing either', async () => {
    const env = await setup();
    const { checked } = await toCodes(env);
    const store = env.tStore;
    let clearNow: () => void = () => undefined;
    const clearHeld = new Promise<void>((resolve) => {
      clearNow = resolve;
    });
    let answerNow: () => void = () => undefined;
    const answerHeld = new Promise<void>((resolve) => {
      answerNow = resolve;
    });
    const remove = store.deleteItemAsync.bind(store);
    store.deleteItemAsync = async (key) => {
      await clearHeld;
      return remove(key);
    };
    const accept = env.api.accept.bind(env.api);
    env.api.accept = async (id, device, note) => {
      await answerHeld;
      return accept(id, device, note);
    };
    const forgot = forgetPrivateDevice(store);
    // Starts with the keys still there, and is answered only after they went.
    const approving = approveWaiting(
      { api: env.api, store, wait: () => Promise.resolve() },
      checked,
    );
    await new Promise((resolve) => setTimeout(resolve, 5));
    clearNow();
    await forgot;
    answerNow();
    expect(await approving).toEqual({ ok: false, code: 'forgotten' });
    expect(await loadTrusted(store)).toEqual([]);
    expect(await hasRewrapWork(store)).toBe(false);
  });

  it.each([
    ['its answer lost', 'network'],
    ['the server taking it', 'forgotten'],
  ] as const)(
    'an approve from the sheet still on its way at sign-out saves nothing (%s)',
    async (_, code) => {
      const env = await setup();
      const { checked } = await toCodes(env);
      const accept = env.api.accept.bind(env.api);
      let release: () => void = () => undefined;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      env.api.accept = async (id, device, note) => {
        await held;
        if (code === 'network') throw new Error('offline');
        return accept(id, device, note);
      };
      const wait = () => Promise.resolve();
      const approving = approveWaiting({ api: env.api, store: env.tStore, wait }, checked);
      await new Promise((resolve) => setTimeout(resolve, 5));
      // Sign-out never waits for the network: this would hang if it did.
      await forgetPrivateDevice(env.tStore);
      release();
      expect(await approving).toEqual({ ok: false, code });
      expect(await env.tStore.getItemAsync(PENDING_APPROVE_KEY_NAME)).toBe(null);
      expect(await loadTrusted(env.tStore)).toEqual([]);
      expect(await hasRewrapWork(env.tStore)).toBe(false);
    },
  );

  it('an approve started after an earlier sign-out is saved as usual', async () => {
    const env = await setup();
    const { checked } = await toCodes(env);
    await clearAfterApproves(env.tStore, () => Promise.resolve());
    expect(await approveWaiting({ api: env.api, store: env.tStore }, checked)).toEqual({
      ok: true,
    });
    expect((await loadTrusted(env.tStore)).map((d) => d.id)).toContain(env.n.deviceId);
    expect(await hasRewrapWork(env.tStore)).toBe(true);
  });
});

describe('turning a phone down', () => {
  it('a deny that never got through keeps the claim, so trying again carries on', async () => {
    const env = await setup();
    await toCodes(env);
    const deny = env.api.deny.bind(env.api);
    env.api.deny = () => Promise.reject(new Error('offline'));
    expect(await denyWaiting({ api: env.api, store: env.tStore }, APPROVAL)).toEqual({
      ok: false,
      code: 'network',
    });
    // Its nonce is still kept: claiming again is not refused as a mismatch.
    expect((await claimWaiting({ api: env.api, store: env.tStore }, APPROVAL)).ok).toBe(true);
    env.api.deny = deny;
    expect(await denyWaiting({ api: env.api, store: env.tStore }, APPROVAL)).toEqual({ ok: true });
    // Now it is gone: the same claim with that nonce would be one this phone never kept.
    expect(await claimWaiting({ api: env.api, store: env.tStore }, APPROVAL)).toEqual({
      ok: false,
      code: 'mismatch',
    });
  });
});
