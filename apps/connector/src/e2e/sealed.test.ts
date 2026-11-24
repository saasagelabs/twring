import { base64urlEncode, deviceIdFor, generateSealKeyPair } from '@twring/contracts';
import { describe, expect, it } from 'vitest';

import type { TrustedDevice } from './keys';
import { openIncoming, ReplayWindow, sealOutgoing, type SealContext } from './sealed';

const ACCOUNT = `con_${'a'.repeat(20)}`;

function device(kind: 'phone' | 'computer') {
  const pair = generateSealKeyPair();
  const id = deviceIdFor(pair.publicKey);
  const trusted: TrustedDevice = {
    id,
    kind,
    name: kind === 'phone' ? 'Pixel' : 'Laptop',
    public_key: base64urlEncode(pair.publicKey),
    verified_at: '2026-11-24T00:00:00.000Z',
  };
  return { pair, id, trusted };
}

function ctxFor(
  me: ReturnType<typeof device>,
  trusted: TrustedDevice[],
  over: Partial<SealContext> = {},
): SealContext {
  return {
    accountId: ACCOUNT,
    agentId: 'claude-code',
    myDeviceId: me.id,
    myPublic: me.trusted.public_key,
    myPrivate: me.pair.privateKey,
    trusted,
    seen: new ReplayWindow(),
    ...over,
  };
}

function pair() {
  const phone = device('phone');
  const computer = device('computer');
  return {
    phone,
    computer,
    phoneCtx: ctxFor(phone, [computer.trusted]),
    computerCtx: ctxFor(computer, [phone.trusted]),
  };
}

function strangerCtx(target: SealContext): SealContext {
  const stranger = device('phone');
  return ctxFor(stranger, [
    {
      id: target.myDeviceId,
      kind: 'computer',
      name: 'Laptop',
      public_key: target.myPublic,
      verified_at: '2026-11-24T00:00:00.000Z',
    },
  ]);
}

describe('openIncoming and sealOutgoing', () => {
  it('opens what a trusted phone sealed', () => {
    const { phoneCtx, computerCtx } = pair();
    const env = sealOutgoing(phoneCtx, { text: 'hi' }, 1);
    expect(openIncoming(computerCtx, env)).toEqual({ ok: true, payload: { text: 'hi' } });
  });

  it('refuses a replay of the same sender seq', () => {
    const { phoneCtx, computerCtx } = pair();
    const env = sealOutgoing(phoneCtx, { text: 'hi' }, 1);
    openIncoming(computerCtx, env);
    expect(openIncoming(computerCtx, env)).toMatchObject({ ok: false, reason: 'replay' });
  });

  it('accepts out of order seqs once each', () => {
    const { phoneCtx, computerCtx } = pair();
    const third = sealOutgoing(phoneCtx, { text: '3' }, 3);
    const first = sealOutgoing(phoneCtx, { text: '1' }, 1);
    expect(openIncoming(computerCtx, third)).toMatchObject({ ok: true });
    expect(openIncoming(computerCtx, first)).toMatchObject({ ok: true });
    expect(openIncoming(computerCtx, first)).toMatchObject({ reason: 'replay' });
  });

  it('refuses an untrusted sender even if wrapped to me', () => {
    const { computerCtx } = pair();
    const env = sealOutgoing(strangerCtx(computerCtx), { text: 'x' }, 1);
    expect(openIncoming(computerCtx, env)).toMatchObject({ ok: false, reason: 'unknown_sender' });
  });

  it('refuses a forged sender: stranger key, sender_device set to the trusted phone', () => {
    const { phoneCtx, computerCtx } = pair();
    // What a malicious server could build: it knows the computer's public key and the phone's id.
    const forger = { ...strangerCtx(computerCtx), myDeviceId: phoneCtx.myDeviceId };
    const env = sealOutgoing(forger, { text: 'run rm -rf' }, 1);
    expect(openIncoming(computerCtx, env)).toMatchObject({ ok: false, reason: 'bad_ciphertext' });
    // and the real phone's seq 1 still opens afterwards (the forgery did not burn it)
    expect(openIncoming(computerCtx, sealOutgoing(phoneCtx, { text: 'hi' }, 1))).toMatchObject({
      ok: true,
    });
  });

  it('refuses a body moved to another agent', () => {
    const { phoneCtx, computerCtx } = pair();
    const env = sealOutgoing(phoneCtx, { text: 'hi' }, 1);
    expect(openIncoming({ ...computerCtx, agentId: 'other' }, env)).toMatchObject({
      reason: 'bad_ciphertext',
    });
  });

  it('refuses a body moved to another computer of the account', () => {
    const { phoneCtx, computerCtx } = pair();
    const env = sealOutgoing(phoneCtx, { text: 'hi' }, 1);
    expect(openIncoming({ ...computerCtx, accountId: `con_${'b'.repeat(20)}` }, env)).toMatchObject(
      { reason: 'bad_ciphertext' },
    );
  });

  it('refuses a flipped byte and a message not wrapped to me', () => {
    const { phoneCtx, computerCtx } = pair();
    const env = sealOutgoing(phoneCtx, { text: 'hi' }, 1);
    const flipped = { ...env, body: `${env.body[0] === 'A' ? 'B' : 'A'}${env.body.slice(1)}` };
    expect(openIncoming(computerCtx, flipped)).toMatchObject({ reason: 'bad_ciphertext' });
    const notMine = { ...env, keys: env.keys.filter((k) => k.device !== computerCtx.myDeviceId) };
    expect(openIncoming(computerCtx, notMine)).toMatchObject({ reason: 'not_for_me' });
  });

  it('wraps to every trusted device and to itself, and to nothing else', () => {
    const { computer, computerCtx, phone } = pair();
    const other = device('phone');
    const env = sealOutgoing(
      { ...computerCtx, trusted: [phone.trusted, other.trusted] },
      { text: 'hi' },
      1,
    );
    expect(env.keys.map((k) => k.device).sort()).toEqual([computer.id, phone.id, other.id].sort());
  });

  it('binds the chunk index', () => {
    const { phoneCtx, computerCtx } = pair();
    const env = sealOutgoing(phoneCtx, { text: 'part' }, 1, { index: 1, final: false });
    expect(openIncoming(computerCtx, { ...env, chunk: { index: 2, final: false } })).toMatchObject({
      reason: 'bad_ciphertext',
    });
  });
});

describe('ReplayWindow', () => {
  it('starts from the highest seq saved before a restart', () => {
    const window = new ReplayWindow({ dev_a: 10 });
    expect(window.accept('dev_a', 10)).toBe(false);
    expect(window.accept('dev_a', 3)).toBe(false);
    expect(window.accept('dev_a', 11)).toBe(true);
    expect(window.highest()).toEqual({ dev_a: 11 });
  });

  it('refuses a seq older than the window', () => {
    const window = new ReplayWindow();
    expect(window.accept('dev_a', 100)).toBe(true);
    expect(window.accept('dev_a', 36)).toBe(false);
    expect(window.accept('dev_a', 37)).toBe(true);
  });
});
