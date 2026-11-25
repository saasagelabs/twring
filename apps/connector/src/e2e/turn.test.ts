import {
  base64urlEncode,
  deviceIdFor,
  generateSealKeyPair,
  MAX_RELAY_MESSAGE_BYTES,
  MAX_SEALED_REPLY_CHUNKS,
  SCOPED_SESSIONS_FEATURE,
  SEALED_CANCEL_FEATURE,
  SEALED_CHAT_FEATURE,
  type RelayConnectorMessage,
  type SealedPayload,
} from '@twring/contracts';
import { describe, expect, it } from 'vitest';

import { LocalAgentError, type LocalAgentAdapter, type LocalAgentEvent } from '../events';
import { ResultOutbox } from '../outbox';
import { ensureDeviceKey, type E2eConfig, type TrustedDevice } from './keys';
import { openIncoming, ReplayWindow, sealOutgoing, type SealContext } from './sealed';
import { baseConfig } from './test-fixtures';
import {
  CHUNK_INTERVAL_MS,
  helloFeatures,
  PrivateChats,
  privateTurnText,
  SIGNED_OUT_TEXT,
  UNKNOWN_SENDER_BUDGET,
  UNKNOWN_SENDERS_BUDGET,
} from './turn';

const AGENT = 'claude-code';
type Reply = Extract<RelayConnectorMessage, { type: 'sealed.reply' }>;

const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567';
const messageId = () =>
  `msg_${Array.from({ length: 20 }, () => BASE32[Math.floor(Math.random() * 32)]).join('')}`;

interface FakeRunOptions {
  agentSays?: string[];
  dropSocketOnce?: boolean;
  /** The socket stays down until `reconnect()`. */
  down?: boolean;
  agentThrows?: boolean | Error;
  now?: () => number;
}

function fakeRun(options: FakeRunOptions = {}) {
  const phoneKeys = generateSealKeyPair();
  const phone: TrustedDevice = {
    id: deviceIdFor(phoneKeys.publicKey),
    kind: 'phone',
    name: 'Pixel',
    public_key: base64urlEncode(phoneKeys.publicKey),
    verified_at: '2026-11-24T00:00:00.000Z',
  };
  let e2e: E2eConfig = { ...ensureDeviceKey(baseConfig).config.e2e!, devices: [phone] };
  const computer: TrustedDevice = {
    id: e2e.device_id,
    kind: 'computer',
    name: 'Laptop',
    public_key: e2e.public_key,
    verified_at: '2026-11-24T00:00:00.000Z',
  };
  const phoneCtx: SealContext = {
    accountId: baseConfig.connector_id,
    agentId: AGENT,
    myDeviceId: phone.id,
    myPublic: phone.public_key,
    myPrivate: phoneKeys.privateKey,
    trusted: [computer],
    seen: new ReplayWindow(),
  };
  let phoneSeq = 0;
  let writes = 0;
  const sent: RelayConnectorMessage[] = [];
  const inputs: string[] = [];
  let dropped = false;
  let up = options.down !== true;
  const outbox = new ResultOutbox();
  const adapter: LocalAgentAdapter = {
    // eslint-disable-next-line @typescript-eslint/require-await
    async *sendTurn(text: string): AsyncIterable<LocalAgentEvent> {
      inputs.push(text);
      if (options.agentThrows instanceof Error) throw options.agentThrows;
      if (options.agentThrows) throw new Error('agent crashed');
      for (const piece of options.agentSays ?? ['ok']) yield { type: 'text', text: piece };
    },
    close: () => undefined,
  };
  const chats = new PrivateChats({
    connectorId: baseConfig.connector_id,
    e2e: () => e2e,
    persist: (change) => {
      writes++;
      e2e = change(e2e);
      return Promise.resolve(e2e);
    },
    pool: {
      acquire: (agent) => (agent === AGENT ? adapter : undefined),
      release: () => undefined,
      runExclusive: (_agent, fn) => fn(),
    },
    send: (frame) => {
      if (!up) return false;
      if (options.dropSocketOnce && !dropped && frame.type === 'sealed.reply' && frame.final) {
        dropped = true;
        up = false;
        return false;
      }
      sent.push(frame);
      return true;
    },
    outbox,
    ...(options.now !== undefined && { now: options.now }),
  });
  const run = {
    phone,
    sealedFromPhone: (payload: SealedPayload, seq = ++phoneSeq) => ({
      type: 'sealed.message' as const,
      agent: AGENT,
      message_id: messageId(),
      sealed: sealOutgoing(phoneCtx, payload, seq),
    }),
    /** A message from a device this computer never paired, sealed to it properly. */
    sealedFromStranger: (seq = 1) => {
      const keys = generateSealKeyPair();
      const ctx: SealContext = {
        ...phoneCtx,
        myDeviceId: deviceIdFor(keys.publicKey),
        myPublic: base64urlEncode(keys.publicKey),
        myPrivate: keys.privateKey,
      };
      return {
        type: 'sealed.message' as const,
        agent: AGENT,
        message_id: messageId(),
        sealed: sealOutgoing(ctx, { text: 'x' }, seq),
      };
    },
    writes: () => writes,
    receive: (frame: Parameters<PrivateChats['receive']>[0]) => chats.receive(frame),
    agentInput: () => inputs.at(-1),
    agentTurns: () => inputs.length,
    sent: (type: 'sealed.reply') => sent.filter((f): f is Reply => f.type === type),
    phoneOpens: (frame: Reply) => {
      const opened = openIncoming({ ...phoneCtx, seen: new ReplayWindow() }, frame.sealed);
      if (!opened.ok) throw new Error(opened.reason);
      return opened.payload;
    },
    /** All chunks of one reply, opened by the phone and joined in index order. */
    phoneReads: (turnId: string) =>
      run
        .sent('sealed.reply')
        .filter((f) => f.turn_id === turnId)
        .sort((a, b) => a.sealed.chunk!.index - b.sealed.chunk!.index)
        .map((f) => run.phoneOpens(f).text)
        .join(''),
    reconnect: async () => {
      up = true;
      await outbox.flush();
    },
    e2e: () => e2e,
  };
  return run;
}

describe('forged messages', () => {
  it('limits config writes and replies for a burst from one unknown sender', async () => {
    const run = fakeRun();
    const first = run.sealedFromStranger();
    for (let i = 0; i < 50; i++) await run.receive({ ...first, message_id: messageId() });
    // Each allowed one costs one re-read and one reply seq: within the per-sender budget.
    expect(run.sent('sealed.reply').length).toBe(UNKNOWN_SENDER_BUDGET);
    expect(run.writes()).toBeLessThanOrEqual(UNKNOWN_SENDER_BUDGET * 2);
    expect(run.agentTurns()).toBe(0);
  });

  it('limits a burst from many made-up senders as well', async () => {
    const run = fakeRun();
    for (let i = 0; i < 100; i++) await run.receive(run.sealedFromStranger());
    expect(run.sent('sealed.reply').length).toBe(UNKNOWN_SENDERS_BUDGET);
    expect(run.writes()).toBeLessThanOrEqual(UNKNOWN_SENDERS_BUDGET * 2);
  });

  it('allows more once a minute has passed, and still serves the paired phone', async () => {
    let t = 0;
    const run = fakeRun({ now: () => t });
    const first = run.sealedFromStranger();
    for (let i = 0; i < 20; i++) await run.receive({ ...first, message_id: messageId() });
    await run.receive(run.sealedFromPhone({ text: 'hi' }));
    expect(run.agentTurns()).toBe(1);
    t += 61_000;
    await run.receive({ ...first, message_id: messageId() });
    expect(run.sent('sealed.reply').filter((f) => f.turn_id !== undefined).length).toBe(
      UNKNOWN_SENDER_BUDGET + 2,
    );
  });
});

describe('private turns', () => {
  it('gives the agent the opened text with the phone-built quote', async () => {
    const run = fakeRun();
    await run.receive(
      run.sealedFromPhone({
        text: 'yes',
        quote: { message_id: `msg_${'c'.repeat(20)}`, text: 'Ship it?', from: 'agent' },
      }),
    );
    expect(run.agentInput()).toBe(
      `[Twring message]\nReplying to your earlier message: "Ship it?"\n\nyes`,
    );
  });

  it('formats quotes like the server did for plain chats', () => {
    expect(
      privateTurnText({
        text: 'yes',
        quote: { message_id: `msg_${'c'.repeat(20)}`, text: 'a\n b' },
      }),
    ).toBe('Replying to my earlier message: "a b"\n\nyes');
    expect(privateTurnText({ text: 'plain' })).toBe('plain');
  });

  it('streams sealed chunks and a final reply', async () => {
    const run = fakeRun({ agentSays: ['Hel', 'lo'] });
    const message = run.sealedFromPhone({ text: 'hi' });
    await run.receive(message);
    const frames = run.sent('sealed.reply');
    expect(frames.at(-1)).toMatchObject({ final: true, turn_id: message.message_id });
    expect(frames.every((f) => f.turn_id === message.message_id)).toBe(true);
    expect(frames.map((f) => f.sealed.chunk!.index)).toEqual(frames.map((_, i) => i));
    expect(frames.filter((f) => f.final)).toHaveLength(1);
    expect(frames.at(-1)!.sealed.chunk!.final).toBe(true);
    expect(run.phoneReads(message.message_id)).toBe('Hello');
  });

  it('keeps a reply within the server chunk cap when the agent pauses often', async () => {
    // 300 one-character events, each more than the flush interval apart.
    let t = 0;
    const says = Array.from({ length: 300 }, (_, i) => String.fromCharCode(97 + (i % 26)));
    const run = fakeRun({
      agentSays: says,
      now: () => (t += CHUNK_INTERVAL_MS + 1),
    });
    const message = run.sealedFromPhone({ text: 'slow please' });
    await run.receive(message);
    const frames = run.sent('sealed.reply');
    expect(frames.length).toBeLessThanOrEqual(MAX_SEALED_REPLY_CHUNKS);
    expect(frames.map((f) => f.sealed.chunk!.index)).toEqual(frames.map((_, i) => i));
    expect(frames.filter((f) => f.final)).toHaveLength(1);
    expect(frames.at(-1)!.final).toBe(true);
    expect(run.phoneReads(message.message_id)).toBe(says.join(''));
  });

  it('keeps a reply within the chunk cap when slow chunks are followed by control-character bursts', async () => {
    // 60 slow one-character events, then bursts of escaped control characters each just past a
    // size flush, so every size flush is split and every piece may be halved for the relay limit.
    let t = 0;
    const slow = Array.from({ length: 60 }, () => '\u0001');
    const burst = Array.from({ length: 3 }, () => '\u0001'.repeat(8_001));
    const says = [...slow, ...burst, '\u0001'.repeat(20_000)];
    const run = fakeRun({ agentSays: says, now: () => (t += CHUNK_INTERVAL_MS + 1) });
    const message = run.sealedFromPhone({ text: 'slow then big' });
    await run.receive(message);
    const frames = run.sent('sealed.reply');
    expect(frames.length).toBeLessThanOrEqual(MAX_SEALED_REPLY_CHUNKS);
    expect(frames.filter((f) => f.final)).toHaveLength(1);
    for (const frame of frames)
      expect(Buffer.byteLength(JSON.stringify(frame), 'utf8')).toBeLessThanOrEqual(
        MAX_RELAY_MESSAGE_BYTES,
      );
  });

  it('splits a long reply so no frame passes the relay limit', async () => {
    // 20,000 characters of a 4-byte character: 80,000 bytes, more than one frame can carry.
    const run = fakeRun({ agentSays: ['😀'.repeat(5_000), '😀'.repeat(5_000)] });
    const message = run.sealedFromPhone({ text: 'long please' });
    await run.receive(message);
    const frames = run.sent('sealed.reply');
    expect(frames.length).toBeGreaterThan(1);
    for (const frame of frames)
      expect(Buffer.byteLength(JSON.stringify(frame), 'utf8')).toBeLessThanOrEqual(
        MAX_RELAY_MESSAGE_BYTES,
      );
    expect(run.phoneReads(message.message_id)).toBe('😀'.repeat(10_000));
  });

  it('seals every chunk of a reply with one seq it never used before', async () => {
    const run = fakeRun({ agentSays: ['a'] });
    await run.receive(run.sealedFromPhone({ text: 'one' }));
    await run.receive(run.sealedFromPhone({ text: 'two' }));
    const seqs = run.sent('sealed.reply').map((f) => f.sealed.sender_seq);
    expect(new Set(seqs).size).toBe(2);
    expect(run.e2e().seq).toBe(Math.max(...seqs));
  });

  it('does not run the agent on a replayed message', async () => {
    const run = fakeRun();
    const m = run.sealedFromPhone({ text: 'hi' });
    await run.receive(m);
    await run.receive(m);
    expect(run.agentTurns()).toBe(1);
    expect(run.e2e().seen).toEqual({ [run.phone.id]: 1 });
  });

  it('runs nothing and says so when a message cannot be opened', async () => {
    const run = fakeRun();
    const m = run.sealedFromPhone({ text: 'hi' });
    const tampered = { ...m, sealed: { ...m.sealed, body: `A${m.sealed.body.slice(1)}` } };
    if (tampered.sealed.body === m.sealed.body) tampered.sealed.body = `B${m.sealed.body.slice(1)}`;
    await run.receive(tampered);
    expect(run.agentTurns()).toBe(0);
    const [notice] = run.sent('sealed.reply');
    expect(notice).toMatchObject({ final: true, turn_id: m.message_id });
    expect(run.phoneOpens(notice!)).toEqual({ text: '', notice: 'couldnt_open' });
    // The real message still opens afterwards: the forgery did not use up its seq.
    await run.receive(m);
    expect(run.agentTurns()).toBe(1);
  });

  it('retries a sealed reply through the outbox after a drop', async () => {
    const run = fakeRun({ dropSocketOnce: true });
    const message = run.sealedFromPhone({ text: 'hi' });
    await run.receive(message);
    expect(run.sent('sealed.reply').filter((f) => f.final)).toHaveLength(0);
    await run.reconnect();
    expect(run.sent('sealed.reply').filter((f) => f.final)).toHaveLength(1);
    expect(run.phoneReads(message.message_id)).toBe('ok');
  });

  it('says something went wrong when the agent fails', async () => {
    const run = fakeRun({ agentThrows: true });
    const message = run.sealedFromPhone({ text: 'hi' });
    await run.receive(message);
    const frames = run.sent('sealed.reply');
    expect(frames.at(-1)!.final).toBe(true);
    expect(run.phoneReads(message.message_id)).toMatch(/went wrong/);
  });

  it('says Claude Code is signed out when the agent reports a sign-in failure', async () => {
    const run = fakeRun({
      agentThrows: new LocalAgentError('agent_signed_out', 'Claude Code is signed out'),
    });
    const message = run.sealedFromPhone({ text: 'hi' });
    await run.receive(message);
    expect(run.phoneReads(message.message_id)).toBe(SIGNED_OUT_TEXT);
  });

  it('caps a reply of 4-byte characters at the stored limit, every frame under the relay limit', async () => {
    const e = '\u{1F600}';
    const run = fakeRun({ agentSays: [e.repeat(7_001), e.repeat(7_001), `x${e}`.repeat(3_000)] });
    const message = run.sealedFromPhone({ text: 'long please' });
    await run.receive(message);
    const frames = run.sent('sealed.reply');
    for (const frame of frames) {
      expect(Buffer.byteLength(JSON.stringify(frame), 'utf8')).toBeLessThanOrEqual(
        MAX_RELAY_MESSAGE_BYTES,
      );
      expect(frame.turn_id).toBe(message.message_id);
    }
    expect(frames.filter((f) => f.final)).toHaveLength(1);
    expect(frames.at(-1)!.final).toBe(true);
    expect(frames.map((f) => f.sealed.chunk!.index)).toEqual(frames.map((_, i) => i));
    expect(new Set(frames.map((f) => f.sealed.sender_seq)).size).toBe(1);
    const text = run.phoneReads(message.message_id);
    expect(text.length).toBeLessThanOrEqual(20_000);
    expect(text.length).toBeGreaterThan(19_990);
    expect(
      /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(text),
    ).toBe(false);
  });

  it('keeps a reply of escaped control characters under the relay limit', async () => {
    const run = fakeRun({ agentSays: ['\u0001'.repeat(20_000)] });
    const message = run.sealedFromPhone({ text: 'hi' });
    await run.receive(message);
    for (const frame of run.sent('sealed.reply'))
      expect(Buffer.byteLength(JSON.stringify(frame), 'utf8')).toBeLessThanOrEqual(
        MAX_RELAY_MESSAGE_BYTES,
      );
    expect(run.phoneReads(message.message_id)).toBe('\u0001'.repeat(20_000));
  });

  it('sends final once, in order, when the link drops mid-reply and comes back twice', async () => {
    const run = fakeRun({
      agentSays: ['a'.repeat(9_000), 'b'.repeat(9_000)],
      dropSocketOnce: true,
    });
    const message = run.sealedFromPhone({ text: 'hi' });
    await run.receive(message);
    await run.reconnect();
    await run.reconnect();
    const frames = run.sent('sealed.reply');
    expect(frames.filter((f) => f.final)).toHaveLength(1);
    expect(frames.map((f) => f.sealed.chunk!.index)).toEqual(frames.map((_, i) => i));
    expect(run.phoneReads(message.message_id)).toBe('a'.repeat(9_000) + 'b'.repeat(9_000));
  });

  it('a forged sender never reaches the agent and leaves the real seq usable', async () => {
    const run = fakeRun();
    const real = run.sealedFromPhone({ text: 'hi' }, 7);
    const stranger = generateSealKeyPair();
    const forgedCtx: SealContext = {
      accountId: baseConfig.connector_id,
      agentId: AGENT,
      myDeviceId: run.phone.id,
      myPublic: base64urlEncode(stranger.publicKey),
      myPrivate: stranger.privateKey,
      trusted: [
        {
          id: run.e2e().device_id,
          kind: 'computer',
          name: 'Laptop',
          public_key: run.e2e().public_key,
          verified_at: '2026-11-24T00:00:00.000Z',
        },
      ],
      seen: new ReplayWindow(),
    };
    await run.receive({ ...real, sealed: sealOutgoing(forgedCtx, { text: 'evil' }, 7) });
    expect(run.agentTurns()).toBe(0);
    expect(run.e2e().seen ?? {}).toEqual({});
    await run.receive(real);
    expect(run.agentInput()).toContain('hi');
  });

  it('remembers seen seqs across a restart', async () => {
    const run = fakeRun();
    await run.receive(run.sealedFromPhone({ text: 'hi' }, 5));
    const window = new ReplayWindow(run.e2e().seen ?? {});
    expect(window.fresh(run.phone.id, 5)).toBe(false);
    expect(window.fresh(run.phone.id, 4)).toBe(false);
    expect(window.fresh(run.phone.id, 6)).toBe(true);
  });
});

describe('helloFeatures', () => {
  it('does not announce sealed_chat without a trusted phone', () => {
    expect(helloFeatures(undefined)).toEqual([SCOPED_SESSIONS_FEATURE]);
    expect(helloFeatures(ensureDeviceKey(baseConfig).config.e2e)).not.toContain(
      SEALED_CHAT_FEATURE,
    );
  });

  it('announces sealed_chat once a phone is trusted', () => {
    const e2e = ensureDeviceKey(baseConfig).config.e2e!;
    const phone = generateSealKeyPair().publicKey;
    expect(
      helloFeatures({
        ...e2e,
        devices: [
          {
            id: deviceIdFor(phone),
            kind: 'phone',
            name: 'Pixel',
            public_key: base64urlEncode(phone),
            verified_at: '2026-11-24T00:00:00.000Z',
          },
        ],
      }),
    ).toEqual([SCOPED_SESSIONS_FEATURE, SEALED_CHAT_FEATURE, SEALED_CANCEL_FEATURE]);
  });
});
