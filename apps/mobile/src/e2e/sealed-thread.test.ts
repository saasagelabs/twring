import {
  base64urlEncode,
  deviceIdFor,
  generateSealKeyPair,
  messageAad,
  newMessageKey,
  sealBody,
  wrapKey,
  type SealedEnvelopeV1,
  type SealedPayload,
  type ThreadMessage,
} from '@twring/contracts';
import { describe, expect, it } from 'vitest';

import type { TrustedDevice } from './pairing';
import {
  aadIdsFor,
  createPhoneContext,
  openMessage,
  openMessages,
  sealOutgoing,
  seenToSave,
  TooLongError,
  type PhoneSealContext,
} from './sealed-thread';

const ACCOUNT = 'con_' + 'a'.repeat(20);
const AGENT = 'claude';
const phone = generateSealKeyPair();
const computer = generateSealKeyPair();
const stranger = generateSealKeyPair();
const PHONE_ID = deviceIdFor(phone.publicKey);
const COMPUTER_ID = deviceIdFor(computer.publicKey);

const trustedComputer: TrustedDevice = {
  id: COMPUTER_ID,
  kind: 'computer',
  name: 'Computer',
  public_key: base64urlEncode(computer.publicKey),
  verified_at: '2026-11-25T00:00:00.000Z',
};

function phoneCtx(seqStart = 0): PhoneSealContext {
  let seq = seqStart;
  return createPhoneContext({
    accountId: ACCOUNT,
    agentId: AGENT,
    me: { deviceId: PHONE_ID, publicKey: phone.publicKey, privateKey: phone.privateKey },
    trusted: [trustedComputer],
    nextSeq: () => ++seq,
  });
}

/** What the computer sends (apps/connector/src/e2e/sealed.ts `sealOutgoing`). */
function sealFromComputer(
  payload: SealedPayload,
  seq = 1,
  chunk?: { index: number; final: boolean },
  signer = computer.privateKey,
  v2 = false,
): SealedEnvelopeV1 {
  const key = newMessageKey();
  const aad = messageAad({
    accountId: ACCOUNT,
    agentId: AGENT,
    senderDevice: COMPUTER_ID,
    senderSeq: seq,
    ...(chunk !== undefined && { chunk: chunk.index }),
    ...(chunk !== undefined && v2 && { final: chunk.final }),
  });
  const { nonce, body } = sealBody(key, payload, aad);
  return {
    v: 1,
    sender_device: COMPUTER_ID,
    sender_seq: seq,
    nonce,
    body,
    keys: [
      { device: COMPUTER_ID, wrapped: wrapKey(key, signer, computer.publicKey, aad) },
      { device: PHONE_ID, wrapped: wrapKey(key, signer, phone.publicKey, aad) },
    ],
    ...(chunk !== undefined && { chunk }),
  };
}

let ids = 0;
function sealedMsg(
  sealed: SealedEnvelopeV1 | SealedEnvelopeV1[],
  author: 'user' | 'agent' = 'agent',
): Extract<ThreadMessage, { kind: 'sealed' }> {
  return {
    id: `msg_${String(++ids).padStart(26, 'a')}`,
    kind: 'sealed',
    author,
    sealed: Array.isArray(sealed) ? sealed : [sealed],
    created_at: '2026-11-25T00:00:00.000Z',
  } as unknown as Extract<ThreadMessage, { kind: 'sealed' }>;
}

/** Changes the first character: the last one of base64url can hold only padding bits. */
function flipFirstChar(text: string): string {
  return (text.startsWith('A') ? 'B' : 'A') + text.slice(1);
}

function reply(parts: string[], seq = 1): SealedEnvelopeV1[] {
  return parts.map((text, index) =>
    sealFromComputer({ text }, seq, { index, final: index === parts.length - 1 }),
  );
}

describe('opening private chat messages on the phone', () => {
  it('opens a message from the trusted computer', () => {
    const out = openMessage(phoneCtx(), sealedMsg(sealFromComputer({ text: 'hi' })));
    expect(out).toMatchObject({ state: 'ok', author: 'agent', text: 'hi' });
  });

  it('tampered body shows couldnt_open', () => {
    const env = sealFromComputer({ text: 'hi' });
    const flipped = { ...env, body: flipFirstChar(env.body) };
    expect(openMessage(phoneCtx(), sealedMsg(flipped)).state).toBe('couldnt_open');
  });

  it('refuses a forged sender: wrapped by a stranger key, labelled as the computer', () => {
    const ctx = phoneCtx();
    const forged = sealFromComputer({ text: 'evil' }, 1, undefined, stranger.privateKey);
    expect(openMessage(ctx, sealedMsg(forged)).state).toBe('couldnt_open');
    // It did not use up the real seq.
    expect(openMessage(ctx, sealedMsg(sealFromComputer({ text: 'real' }, 1)))).toMatchObject({
      state: 'ok',
      text: 'real',
    });
  });

  it('refuses an unknown sender and a message not wrapped for this phone', () => {
    const env = sealFromComputer({ text: 'x' });
    expect(
      openMessage(phoneCtx(), sealedMsg({ ...env, sender_device: 'dev_' + 'z'.repeat(20) })).state,
    ).toBe('couldnt_open');
    expect(
      openMessage(
        phoneCtx(),
        sealedMsg({ ...env, keys: env.keys.filter((k) => k.device !== PHONE_ID) }),
      ).state,
    ).toBe('couldnt_open');
  });

  it('binds account and agent: a message for another agent does not open', () => {
    const ctx = createPhoneContext({ ...phoneCtx(), agentId: 'other' });
    expect(openMessage(ctx, sealedMsg(sealFromComputer({ text: 'x' }))).state).toBe('couldnt_open');
  });

  it('a seq gap shows a missing message marker', () => {
    const ctx = phoneCtx();
    openMessage(ctx, sealedMsg(sealFromComputer({ text: 'a' }, 1)));
    const out = openMessages(ctx, [sealedMsg(sealFromComputer({ text: 'c' }, 3))]);
    expect(out[0]).toMatchObject({ state: 'missing_before', missing: 1 });
    expect(out[1]).toMatchObject({ state: 'ok', text: 'c' });
  });

  it('drops a replay silently but keeps the first copy', () => {
    const ctx = phoneCtx();
    const m = sealedMsg(sealFromComputer({ text: 'a' }, 1));
    const out = openMessages(ctx, [m, { ...m, id: 'msg_dup' }]);
    expect(out.filter((x) => x.state === 'ok')).toHaveLength(1);
    expect(out).toHaveLength(1);
  });

  it('reopens the same message as it grows, without calling it a replay', () => {
    const ctx = phoneCtx();
    const parts = reply(['Hel', 'lo'], 4);
    const partial = sealedMsg([sealFromComputer({ text: 'Hel' }, 4, { index: 0, final: false })]);
    expect(openMessage(ctx, partial)).toMatchObject({ state: 'ok', text: 'Hel', partial: true });
    const whole = { ...partial, sealed: [partial.sealed[0], parts[1]] };
    expect(openMessage(ctx, whole)).toMatchObject({ state: 'ok', text: 'Hello' });
    expect(openMessage(ctx, whole)).not.toHaveProperty('partial');
  });

  it('joins chunks by index, whatever order the server lists them in', () => {
    const parts = reply(['a', 'b', 'c'], 2);
    const out = openMessage(phoneCtx(), sealedMsg([parts[2], parts[0], parts[1]]));
    expect(out).toMatchObject({ state: 'ok', text: 'abc' });
  });

  it('takes an empty final chunk as the end, not an empty reply', () => {
    const out = openMessage(phoneCtx(), sealedMsg(reply(['long answer', ''], 2)));
    expect(out).toMatchObject({ state: 'ok', text: 'long answer' });
    expect(out).not.toHaveProperty('partial');
  });

  it('shows the files a streamed reply carries on its final chunk', () => {
    // The computer sends files on the final piece only (apps/connector/src/e2e/turn.ts).
    const files = [
      {
        file_id: 'fil_' + 'c'.repeat(20),
        key: 'k'.repeat(43),
        name: 'image-1.png',
        mime: 'image/png',
        size: 3400,
      },
    ];
    const out = openMessage(
      phoneCtx(),
      sealedMsg([
        sealFromComputer({ text: 'Making a chart. ' }, 5, { index: 0, final: false }),
        sealFromComputer({ text: 'Done.', files }, 5, { index: 1, final: true }),
      ]),
    );
    expect(out).toMatchObject({ state: 'ok', text: 'Making a chart. Done.', files });
  });

  it('opens any chunk count up to 64', () => {
    const parts = Array.from({ length: 64 }, (_, i) => String(i % 10));
    expect(openMessage(phoneCtx(), sealedMsg(reply(parts, 9)))).toMatchObject({
      state: 'ok',
      text: parts.join(''),
    });
    expect(openMessage(phoneCtx(), sealedMsg(reply(['only'], 9)))).toMatchObject({ text: 'only' });
  });

  it('refuses chunks with a hole, a mixed seq, or a chunk copied from another reply', () => {
    const parts = reply(['a', 'b', 'c'], 2);
    expect(openMessage(phoneCtx(), sealedMsg([parts[0], parts[2]])).state).toBe('couldnt_open');
    const other = sealFromComputer({ text: 'x' }, 3, { index: 1, final: true });
    expect(openMessage(phoneCtx(), sealedMsg([parts[0], other])).state).toBe('couldnt_open');
    const twice = sealFromComputer({ text: 'b' }, 2, { index: 1, final: false });
    expect(openMessage(phoneCtx(), sealedMsg([parts[0], twice, parts[1]])).state).toBe(
      'couldnt_open',
    );
  });

  it('shows the computer notice that it could not open a message', () => {
    const out = openMessage(
      phoneCtx(),
      sealedMsg(
        sealFromComputer({ text: '', notice: 'couldnt_open' }, 1, { index: 0, final: true }),
      ),
    );
    expect(out).toMatchObject({ state: 'ok', notice: 'couldnt_open' });
  });
});

describe('sealing on the phone', () => {
  it('seals so the phone reopens its own message, wrapped to itself and the computer', () => {
    const ctx = phoneCtx();
    const env = sealOutgoing(ctx, { text: 'hello' });
    expect(env.sender_device).toBe(PHONE_ID);
    expect(env.sender_seq).toBe(1);
    expect(env.keys.map((k) => k.device).sort()).toEqual([COMPUTER_ID, PHONE_ID].sort());
    expect(JSON.stringify(env)).not.toContain('hello');
    expect(openMessage(phoneCtx(), sealedMsg(env, 'user'))).toMatchObject({
      state: 'ok',
      author: 'user',
      text: 'hello',
    });
  });

  it('refuses 4,001 characters before sealing and uses no seq', () => {
    const ctx = phoneCtx();
    expect(() => sealOutgoing(ctx, { text: 'a'.repeat(4001) })).toThrow(TooLongError);
    expect(sealOutgoing(ctx, { text: 'a'.repeat(4000) }).sender_seq).toBe(1);
  });

  it('reads the AAD ids from the agent address', () => {
    expect(aadIdsFor(`cord-connector://${ACCOUNT}/${AGENT}`)).toEqual({
      accountId: ACCOUNT,
      agentId: AGENT,
    });
    expect(aadIdsFor('https://example.com')).toBeUndefined();
  });

  // Was about 6 s before message-seal.ts cached the wrap key per (my key, their key).
  it('opens 2,000 messages in under 3 seconds on node', () => {
    const ctx = phoneCtx();
    const list = Array.from({ length: 2000 }, (_, i) =>
      sealedMsg(sealFromComputer({ text: `m${i}` }, i + 1, { index: 0, final: true })),
    );
    const started = performance.now();
    const out = openMessages(ctx, list);
    expect(performance.now() - started).toBeLessThan(3000);
    expect(out.filter((m) => m.state === 'ok')).toHaveLength(2000);
  });
});

describe('verifier edge cases', () => {
  it('reopens the whole thread again in the same session (every render lists it anew)', () => {
    const ctx = phoneCtx();
    const list = [1, 2, 3].map((s) => sealedMsg(sealFromComputer({ text: `m${s}` }, s)));
    openMessages(ctx, list);
    expect(openMessages(ctx, list).map((m) => m.state)).toEqual(['ok', 'ok', 'ok']);
  });

  // P3b ruling 1: the saved state carries the message id that first opened each (sender, seq).
  it('after a restart with the saved seq, the earlier history still opens', () => {
    const first = phoneCtx();
    const list = [1, 2, 3].map((s) => sealedMsg(sealFromComputer({ text: `m${s}` }, s)));
    openMessages(first, list);
    const after = createPhoneContext({ ...first, seen: seenToSave(first) });
    expect(openMessages(after, list).map((m) => m.state)).toEqual(['ok', 'ok', 'ok']);
  });

  it('after a restart, a replay of an old seq under another id is still dropped', () => {
    const first = phoneCtx();
    const m = sealedMsg(sealFromComputer({ text: 'a' }, 1));
    openMessages(first, [m]);
    const after = createPhoneContext({ ...first, seen: seenToSave(first) });
    expect(openMessages(after, [{ ...m, id: 'msg_copy' }])).toEqual([]);
    expect(openMessages(after, [sealedMsg(sealFromComputer({ text: 'b' }, 2))])).toHaveLength(1);
  });

  it('after a restart, a growing reply keeps opening under its saved id', () => {
    const first = phoneCtx();
    const c0 = sealFromComputer({ text: 'Hel' }, 4, { index: 0, final: false });
    const real = sealedMsg([c0]);
    openMessages(first, [real]);
    const after = createPhoneContext({ ...first, seen: seenToSave(first) });
    const c1 = sealFromComputer({ text: 'lo' }, 4, { index: 1, final: true });
    expect(openMessage(after, { ...real, sealed: [c0, c1] })).toMatchObject({ text: 'Hello' });
  });

  it('keeps at most 2,000 saved message ids', () => {
    const ctx = phoneCtx();
    const list = Array.from({ length: 2005 }, (_, i) =>
      sealedMsg(sealFromComputer({ text: `m${i}` }, i + 1, { index: 0, final: true })),
    );
    openMessages(ctx, list);
    expect(Object.keys(seenToSave(ctx).ids)).toHaveLength(2000);
  });

  it('refuses a final chunk in the middle', () => {
    const a = sealFromComputer({ text: 'a' }, 2, { index: 0, final: true });
    const b = sealFromComputer({ text: 'b' }, 2, { index: 1, final: true });
    expect(openMessage(phoneCtx(), sealedMsg([a, b])).state).toBe('couldnt_open');
  });

  it('refuses a reply listing the same chunk twice', () => {
    const parts = reply(['a', 'b'], 2);
    expect(openMessage(phoneCtx(), sealedMsg([parts[0], parts[0], parts[1]])).state).toBe(
      'couldnt_open',
    );
  });

  it('refuses a reply that mixes chunked and unchunked envelopes', () => {
    const a = sealFromComputer({ text: 'a' }, 2, { index: 0, final: false });
    const b = sealFromComputer({ text: 'b' }, 2);
    expect(openMessage(phoneCtx(), sealedMsg([a, b])).state).toBe('couldnt_open');
  });

  it('drops a copied chunk under another id while the real reply keeps growing', () => {
    const ctx = phoneCtx();
    const c0 = sealFromComputer({ text: 'Hel' }, 4, { index: 0, final: false });
    const real = sealedMsg([c0]);
    expect(openMessage(ctx, real)).toMatchObject({ state: 'ok', partial: true });
    expect(openMessages(ctx, [{ ...real, id: 'msg_copy' }])).toEqual([]);
    const c1 = sealFromComputer({ text: 'lo' }, 4, { index: 1, final: true });
    expect(openMessage(ctx, { ...real, sealed: [c0, c1] })).toMatchObject({ text: 'Hello' });
  });

  it('does not mark a gap for an older message arriving late, nor for its own seq gaps', () => {
    const ctx = phoneCtx(5);
    const out = openMessages(ctx, [
      sealedMsg(sealFromComputer({ text: 'c' }, 3)),
      sealedMsg(sealFromComputer({ text: 'b' }, 2)),
      sealedMsg(sealOutgoing(ctx, { text: 'mine' }), 'user'),
      sealedMsg(sealOutgoing(ctx, { text: 'mine2' }), 'user'),
    ]);
    expect(out.map((m) => m.state)).toEqual(['ok', 'ok', 'ok', 'ok']);
  });

  it('a forged chunk in an otherwise real reply burns none of its chunk windows', () => {
    const ctx = phoneCtx();
    const parts = reply(['a', 'b'], 7);
    const forged = sealFromComputer(
      { text: 'b' },
      7,
      { index: 1, final: true },
      stranger.privateKey,
    );
    expect(openMessage(ctx, sealedMsg([parts[0], forged])).state).toBe('couldnt_open');
    expect(openMessage(ctx, sealedMsg(parts))).toMatchObject({ state: 'ok', text: 'ab' });
  });
});

describe('the final flag of a streamed reply (R1-1, v2 AAD)', () => {
  const v2Reply = (parts: string[], seq = 1) =>
    parts.map((text, index) =>
      sealFromComputer(
        { text },
        seq,
        { index, final: index === parts.length - 1 },
        undefined,
        true,
      ),
    );

  it('opens v2-sealed chunks', () => {
    expect(openMessage(phoneCtx(), sealedMsg(v2Reply(['a', 'b', 'c'])))).toMatchObject({
      state: 'ok',
      text: 'abc',
    });
  });

  it('refuses a v2 reply cut short with an earlier chunk marked final', () => {
    const parts = v2Reply(['a', 'b', 'c']);
    const cut = [parts[0], { ...parts[1], chunk: { index: 1, final: true } }];
    expect(openMessage(phoneCtx(), sealedMsg(cut)).state).toBe('couldnt_open');
  });

  it('refuses a v2 final chunk marked not final', () => {
    const parts = v2Reply(['a', 'b']);
    const flipped = [parts[0], { ...parts[1], chunk: { index: 1, final: false } }];
    expect(openMessage(phoneCtx(), sealedMsg(flipped)).state).toBe('couldnt_open');
  });

  it('still opens v1-sealed chunks', () => {
    expect(openMessage(phoneCtx(), sealedMsg(reply(['a', 'b'])))).toMatchObject({
      state: 'ok',
      text: 'ab',
    });
  });
});

describe('who a sealed message is shown from (R4-3)', () => {
  it('shows this phone own message as the person even when the server says agent', () => {
    const ctx = phoneCtx();
    const relabeled = sealedMsg(sealOutgoing(ctx, { text: 'yes, delete it' }), 'agent');
    expect(openMessage(ctx, relabeled).state).toBe('couldnt_open');
    expect(openMessage(ctx, relabeled).state).toBe('couldnt_open');
  });

  it('refuses a computer reply the server labels as the person', () => {
    const ctx = phoneCtx();
    const relabeled = sealedMsg(sealFromComputer({ text: 'hi' }), 'user');
    expect(openMessage(ctx, relabeled).state).toBe('couldnt_open');
    expect(openMessage(ctx, relabeled).state).toBe('couldnt_open');
  });

  it('opens the same messages under their true author', () => {
    const ctx = phoneCtx();
    expect(openMessage(ctx, sealedMsg(sealOutgoing(ctx, { text: 'x' }), 'user'))).toMatchObject({
      state: 'ok',
      author: 'user',
    });
    expect(openMessage(ctx, sealedMsg(sealFromComputer({ text: 'y' })))).toMatchObject({
      state: 'ok',
      author: 'agent',
    });
  });
});
