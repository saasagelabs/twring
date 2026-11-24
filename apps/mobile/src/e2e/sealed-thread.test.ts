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
): SealedEnvelopeV1 {
  const key = newMessageKey();
  const aad = messageAad({
    accountId: ACCOUNT,
    agentId: AGENT,
    senderDevice: COMPUTER_ID,
    senderSeq: seq,
    ...(chunk !== undefined && { chunk: chunk.index }),
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
