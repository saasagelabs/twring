import {
  base64urlDecode,
  messageAad,
  openBody,
  unwrapKey,
  type RelayConnectorMessage,
} from '@twring/contracts';
import { describe, expect, it } from 'vitest';

import type { LocalAgentAdapter, LocalAgentEvent } from '../events';
import { ResultOutbox } from '../outbox';
import type { E2eConfig } from './keys';
import { sealOutgoing } from './sealed';
import { pairedFixture } from './test-fixtures';
import { PrivateChats } from './turn';

const AGENT = 'claude-code';
type Reply = Extract<RelayConnectorMessage, { type: 'sealed.reply' }>;
const id = (c: string) => `msg_${c.repeat(20)}`;

function setup(persistFails: () => boolean = () => false) {
  const fixture = pairedFixture(AGENT);
  const sent: RelayConnectorMessage[] = [];
  const lines: string[] = [];
  const turns: string[] = [];
  let clock = 0;
  const adapter: LocalAgentAdapter = {
    // eslint-disable-next-line @typescript-eslint/require-await
    async *sendTurn(text: string): AsyncIterable<LocalAgentEvent> {
      turns.push(text);
      for (const text of ['one ', 'two ', 'three']) yield { type: 'text', text };
    },
    close: () => undefined,
  };
  const chats = new PrivateChats({
    connectorId: fixture.config.connector_id,
    e2e: fixture.e2e,
    persist: (change: (current: E2eConfig) => E2eConfig) => {
      // Only a change that reserves a seq fails; a read or a `seen` save goes through.
      const before = fixture.e2e();
      const probe = change(before);
      if (probe.seq !== before.seq && persistFails()) return Promise.resolve(undefined);
      return fixture.store(change);
    },
    pool: {
      acquire: () => adapter,
      release: () => undefined,
      runExclusive: (_agent, fn) => fn(),
    },
    send: (frame) => {
      sent.push(frame);
      return true;
    },
    outbox: new ResultOutbox(),
    log: (line) => lines.push(line),
    // Each read is minutes later, so every piece of text goes out as its own chunk.
    now: () => (clock += 10 * 60_000),
    seqRetryDelaysMs: [0, 0],
  });
  const replies = () => sent.filter((f): f is Reply => f.type === 'sealed.reply');
  return { fixture, chats, replies, lines, turns };
}

describe('one message key per private reply (ADR-044)', () => {
  it('seals every chunk of a streamed reply with one key under its own AAD', async () => {
    const { fixture, chats, replies } = setup();
    const phone = fixture.phoneCtx;
    await chats.receive({
      type: 'sealed.message',
      agent: AGENT,
      message_id: id('a'),
      sealed: sealOutgoing(phone, { text: 'hi' }, 1),
    });
    const chunks = replies();
    expect(chunks.length).toBeGreaterThanOrEqual(3);
    const computer = fixture.e2e();
    const keyOf = (r: Reply) => {
      const aad = messageAad({
        accountId: phone.accountId,
        agentId: AGENT,
        senderDevice: r.sealed.sender_device,
        senderSeq: r.sealed.sender_seq,
        chunk: r.sealed.chunk!.index,
      });
      const mine = r.sealed.keys.find((k) => k.device === phone.myDeviceId)!;
      return unwrapKey(mine.wrapped, phone.myPrivate, base64urlDecode(computer.public_key), aad);
    };
    const first = keyOf(chunks[0]!);
    const nonces = new Set<string>();
    let text = '';
    for (const [i, r] of chunks.entries()) {
      expect(r.sealed.chunk?.index).toBe(i);
      expect(Buffer.from(keyOf(r)).equals(Buffer.from(first))).toBe(true);
      nonces.add(r.sealed.nonce);
      // The first chunk's key, re-wrapped once for a new phone, opens every chunk.
      const aad = messageAad({
        accountId: phone.accountId,
        agentId: AGENT,
        senderDevice: r.sealed.sender_device,
        senderSeq: r.sealed.sender_seq,
        chunk: i,
      });
      text += openBody(first, r.sealed.nonce, r.sealed.body, aad).text;
    }
    expect(nonces.size).toBe(chunks.length);
    expect(text).toBe('one two three');
  });
});

describe('a private message while the config is busy', () => {
  it('logs it without text and keeps the replay window, so a resend runs', async () => {
    let busy = true;
    const { fixture, chats, replies, lines, turns } = setup(() => busy);
    const frame = {
      type: 'sealed.message' as const,
      agent: AGENT,
      message_id: id('b'),
      sealed: sealOutgoing(fixture.phoneCtx, { text: 'secret words' }, 1),
    };
    await chats.receive(frame);
    expect(turns).toHaveLength(0);
    expect(replies()).toHaveLength(0);
    expect(lines).toContain(`private message ${frame.message_id} not answered (config busy)`);
    expect(lines.join('\n')).not.toContain('secret words');
    busy = false;
    await chats.receive(frame);
    expect(turns).toHaveLength(1);
    expect(replies().at(-1)?.final).toBe(true);
    expect(lines.some((line) => line.includes('replay'))).toBe(false);
  });

  it('retries the seq reservation before giving up', async () => {
    let failures = 2;
    const { fixture, chats, turns } = setup(() => failures-- > 0);
    await chats.receive({
      type: 'sealed.message',
      agent: AGENT,
      message_id: id('c'),
      sealed: sealOutgoing(fixture.phoneCtx, { text: 'hi' }, 1),
    });
    expect(turns).toHaveLength(1);
  });
});
