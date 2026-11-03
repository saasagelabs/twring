/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return -- Fastify inject JSON is untyped. */
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { Writable } from 'node:stream';

import type { TwringAgentAdapter } from '@twring/agent-adapter';
import { loadGatewayEnv } from '@twring/config/gateway';
import type { UserTurn } from '@twring/contracts';
import { gatewayEnvFixture } from '@twring/test-fixtures';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildApp } from '../app';
import { TEST_KEYS } from '../connectors/harness';
import { CredentialCipher, messageKeys } from '../store/cipher';
import { createMemoryStores } from '../store/repositories';
import { PrerecordedTranscriptionError } from '../voice/deepgram-prerecorded';
import { ThreadService } from './service';
import { SqliteThreadStore } from './store';

type Transcribe = (
  a: Uint8Array,
  c: string,
  s?: AbortSignal,
  k?: readonly string[],
) => Promise<string>;
const closers: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const c of closers.splice(0)) await c();
});

type Listed = { kind: string; text?: string; voice?: unknown };
const textsOf = (messages: Listed[]) => messages.filter((m) => m.kind === 'user_text');

async function setup(
  opts: {
    transcribe?: Transcribe | undefined;
    messagesPerDay?: number;
    writeRatePerMinute?: number;
    logs?: string[];
    wordsFor?: (userId: string, agentId: string) => Promise<readonly string[]>;
  } = {},
) {
  const stores = createMemoryStores(TEST_KEYS);
  const store = new SqliteThreadStore(':memory:', new CredentialCipher(messageKeys(TEST_KEYS)));
  const now = new Date().toISOString();
  const mk = async (user: string, id: string) =>
    stores.agents.create({
      id,
      user_id: user,
      name: 'Agent',
      protocol: 'cord-rest',
      endpoint_url: 'https://example.com/agent',
      voice_id: 'flux-aura-en',
      status: 'ready',
      created_at: now,
      updated_at: now,
    });
  const agentId = `agt_${'a'.repeat(20)}`;
  const otherAgent = `agt_${'b'.repeat(20)}`;
  await mk('alice', agentId);
  await mk('bob', otherAgent);
  const turns: UserTurn[] = [];
  const adapter: TwringAgentAdapter = {
    name: 'fake',
    capabilities: {
      streamingText: true,
      cancellation: true,
      resumableStream: false,
      activityEvents: false,
      toolEvents: false,
      approvals: false,
      conversationResume: false,
      serverInitiatedCalls: false,
    },
    connect: () => Promise.resolve(),
    async *sendTurn(turn) {
      await Promise.resolve();
      turns.push(turn);
      yield { type: 'done', event_id: randomUUID(), turn_id: turn.turnId, status: 'completed' };
    },
    close: () => Promise.resolve(),
  };
  const service = new ThreadService({
    store,
    agents: stores.agents,
    agentFactory: () => () => Promise.resolve(adapter),
    agentStatus: () => 'online',
    hasLiveCallToAgent: () => false,
    notify: () => undefined,
  });
  await service.start();
  const logs = opts.logs;
  const stream = new Writable({
    write(chunk: Buffer, _enc, cb) {
      logs?.push(chunk.toString());
      cb();
    },
  });
  const transcribe = vi.fn<Transcribe>(opts.transcribe ?? (() => Promise.resolve('hello there')));
  const app = buildApp({
    env: loadGatewayEnv(gatewayEnvFixture()),
    ...(logs && { logger: { level: 'trace', stream } }),
    userFor: () => 'alice',
    agents: { stores, policy: { env: 'development' }, writeRatePerMinute: 100 },
    threads: {
      service,
      store,
      writeRatePerMinute: opts.writeRatePerMinute ?? 30,
      readRatePerMinute: 120,
      messagesPerDay: opts.messagesPerDay ?? 500,
      transcribeVoiceNote: transcribe,
      ...(opts.wordsFor && { wordsFor: opts.wordsFor }),
    },
  });
  closers.push(() => app.close());
  const url = (id: string, ms = 5000, agent = agentId, extra = '') =>
    `/v1/agents/${agent}/voice-notes?client_id=${id}&duration_ms=${ms}${extra}`;
  const voice = (
    id: string = randomUUID(),
    o: { ms?: number; agent?: string; type?: string; body?: Buffer; extra?: string } = {},
  ) =>
    app.inject({
      method: 'POST',
      url: url(id, o.ms, o.agent, o.extra),
      headers: { 'content-type': o.type ?? 'audio/mp4' },
      payload: o.body ?? Buffer.from([1, 2, 3]),
    });
  const typed = (id: string, text = 'typed hi') =>
    app.inject({
      method: 'POST',
      url: `/v1/agents/${agentId}/messages`,
      payload: { client_id: id, text },
    });
  const list = async (): Promise<Listed[]> =>
    (await app.inject({ method: 'GET', url: `/v1/agents/${agentId}/messages` })).json().messages;
  const waitTurns = async (n: number) => {
    const until = Date.now() + 1500;
    while (turns.length < n && Date.now() < until) await new Promise((r) => setTimeout(r, 5));
  };
  return { app, voice, typed, list, transcribe, turns, waitTurns, agentId, otherAgent, store };
}

describe('voice notes: idempotency', () => {
  it('repeated client_id returns the stored message without transcribing again', async () => {
    const s = await setup();
    const id = randomUUID();
    expect((await s.voice(id)).statusCode).toBe(201);
    const again = await s.voice(id);
    expect(again.statusCode).toBe(200);
    expect(again.json().message.text).toBe('hello there');
    expect(s.transcribe).toHaveBeenCalledTimes(1);
  });

  it('concurrent uploads with the same client_id transcribe once and store one message', async () => {
    let release!: (t: string) => void;
    const s = await setup({
      transcribe: () =>
        new Promise<string>((r) => {
          release = r;
        }),
    });
    const id = randomUUID();
    const a = s.voice(id);
    const b = s.voice(id);
    await new Promise((r) => setTimeout(r, 30));
    release('one transcript');
    const [ra, rb] = await Promise.all([a, b]);
    expect([ra.statusCode, rb.statusCode].sort()).toEqual([200, 201]);
    expect(ra.json().message.id).toBe(rb.json().message.id);
    expect(s.transcribe).toHaveBeenCalledTimes(1);
    expect(textsOf(await s.list())).toHaveLength(1);
  });

  it('a client_id already used by a typed message returns it, unchanged, without transcribing', async () => {
    const s = await setup();
    const id = randomUUID();
    expect((await s.typed(id)).statusCode).toBe(201);
    const res = await s.voice(id);
    expect(res.statusCode).toBe(200);
    expect(res.json().message.text).toBe('typed hi');
    expect(res.json().message.voice).toBeUndefined();
    expect(s.transcribe).not.toHaveBeenCalled();
  });

  it('a typed send racing a pending voice note with the same client_id returns one message', async () => {
    let release!: (t: string) => void;
    const s = await setup({
      transcribe: () =>
        new Promise<string>((r) => {
          release = r;
        }),
    });
    const id = randomUUID();
    const v = s.voice(id);
    await new Promise((r) => setTimeout(r, 30));
    const t = s.typed(id);
    await new Promise((r) => setTimeout(r, 30));
    release('spoken');
    const [rv, rt] = await Promise.all([v, t]);
    expect(rv.json().message.id).toBe(rt.json().message.id);
    expect(textsOf(await s.list())).toHaveLength(1);
  });
});

describe('voice notes: limits', () => {
  it('rejects over 2 MB with 413 before transcription', async () => {
    const s = await setup();
    const res = await s.voice(randomUUID(), { body: Buffer.alloc(2 * 1024 * 1024 + 1) });
    expect(res.statusCode).toBe(413);
    expect(s.transcribe).not.toHaveBeenCalled();
  });

  it('accepts exactly 2 MB', async () => {
    const s = await setup();
    const res = await s.voice(randomUUID(), { body: Buffer.alloc(2 * 1024 * 1024) });
    expect(res.statusCode).toBe(201);
  });

  it.each([
    'text/plain',
    'application/json',
    'application/octet-stream',
    'audio/wav',
    'audio/mpeg',
  ])('rejects content type %s before transcription', async (type) => {
    const s = await setup();
    const res = await s.voice(randomUUID(), { type });
    expect([400, 415]).toContain(res.statusCode);
    expect(s.transcribe).not.toHaveBeenCalled();
  });

  it.each([
    'audio/mp4',
    'audio/m4a',
    'audio/x-m4a',
    'audio/aac',
    'audio/mp4; codecs=mp4a.40.2',
    'AUDIO/MP4',
  ])('accepts content type %s', async (type) => {
    const s = await setup();
    const res = await s.voice(randomUUID(), { type });
    expect(res.statusCode).toBe(201);
    expect(s.transcribe).toHaveBeenCalledTimes(1);
  });

  // React Native on Android uploads a file Blob with an empty content type (seen on a moto g86).
  const m4a = Buffer.concat([
    Buffer.from([0, 0, 0, 0x1c]),
    Buffer.from('ftypM4A '),
    Buffer.alloc(16),
  ]);
  const rawUpload = (s: Awaited<ReturnType<typeof setup>>, payload: Buffer, type?: string) =>
    s.app.inject({
      method: 'POST',
      url: `/v1/agents/${s.agentId}/voice-notes?client_id=${randomUUID()}&duration_ms=5000`,
      headers: type === undefined ? {} : { 'content-type': type },
      payload,
    });
  it.each([
    ['no header', undefined],
    ['an empty header', ''],
    ['application/octet-stream', 'application/octet-stream'],
  ])('accepts an MP4 voice note with %s, as audio/mp4', async (_label, type) => {
    const s = await setup();
    const res = await rawUpload(s, m4a, type);
    expect(res.statusCode).toBe(201);
    expect(s.transcribe).toHaveBeenCalledWith(m4a, 'audio/mp4', undefined, []);
  });

  it('rejects a note with no header whose bytes are not MP4', async () => {
    const s = await setup();
    const res = await rawUpload(s, Buffer.from('not audio at all'));
    expect(res.statusCode).toBe(415);
    expect(s.transcribe).not.toHaveBeenCalled();
  });

  it('rejects an empty body before transcription', async () => {
    const s = await setup();
    const res = await s.voice(randomUUID(), { body: Buffer.alloc(0) });
    expect(res.statusCode).toBe(400);
    expect(s.transcribe).not.toHaveBeenCalled();
  });

  it.each([0, 999, 120_501, 999_999])('rejects duration_ms=%i with 400', async (ms) => {
    const s = await setup();
    expect((await s.voice(randomUUID(), { ms })).statusCode).toBe(400);
    expect(s.transcribe).not.toHaveBeenCalled();
  });

  it('accepts the duration bounds and clamps the stored seconds', async () => {
    const s = await setup();
    const lo = await s.voice(randomUUID(), { ms: 1000 });
    const hi = await s.voice(randomUUID(), { ms: 120_500 });
    expect(lo.json().message.voice.duration_s).toBe(1);
    expect(hi.json().message.voice.duration_s).toBe(120);
  });

  it('rejects an unknown query key, a missing duration, and a bad uuid', async () => {
    const s = await setup();
    expect((await s.voice(randomUUID(), { extra: '&foo=bar' })).statusCode).toBe(400);
    const missing = await s.app.inject({
      method: 'POST',
      url: `/v1/agents/${s.agentId}/voice-notes?client_id=${randomUUID()}`,
      headers: { 'content-type': 'audio/mp4' },
      payload: Buffer.from([1]),
    });
    expect(missing.statusCode).toBe(400);
    expect((await s.voice('not-a-uuid')).statusCode).toBe(400);
    expect(s.transcribe).not.toHaveBeenCalled();
  });

  it('counts the daily limit once per created message and releases it on failure', async () => {
    const s = await setup({ messagesPerDay: 2 });
    s.transcribe.mockRejectedValueOnce(new PrerecordedTranscriptionError('provider_failure'));
    expect((await s.voice()).statusCode).toBe(502);
    expect((await s.voice()).statusCode).toBe(201);
    const id = randomUUID();
    expect((await s.voice(id)).statusCode).toBe(201);
    // Replays of stored messages do not consume the allowance.
    expect((await s.voice(id)).statusCode).toBe(200);
    expect((await s.voice(id)).statusCode).toBe(200);
    expect((await s.voice()).statusCode).toBe(429);
    expect((await s.typed(randomUUID())).statusCode).toBe(429);
  });

  it('an empty transcript also releases the daily count', async () => {
    const s = await setup({ messagesPerDay: 1 });
    s.transcribe.mockResolvedValueOnce('   ');
    expect((await s.voice()).statusCode).toBe(400);
    expect((await s.voice()).statusCode).toBe(201);
  });

  it('applies the per-minute write limit once per created message, not for replays', async () => {
    const s = await setup({ writeRatePerMinute: 2 });
    const id = randomUUID();
    expect((await s.voice(id)).statusCode).toBe(201);
    expect((await s.voice(id)).statusCode).toBe(200);
    expect((await s.voice(id)).statusCode).toBe(200);
    expect((await s.voice()).statusCode).toBe(201);
    expect((await s.voice()).statusCode).toBe(429);
    expect(s.transcribe).toHaveBeenCalledTimes(2);
  });

  it('a rate-limited request is never transcribed', async () => {
    const s = await setup({ writeRatePerMinute: 1 });
    await s.voice();
    expect((await s.voice()).statusCode).toBe(429);
    expect(s.transcribe).toHaveBeenCalledTimes(1);
  });
});

describe('voice notes: isolation', () => {
  it('another user agent and a malformed agent id are 404 and never transcribed', async () => {
    const s = await setup();
    expect((await s.voice(randomUUID(), { agent: s.otherAgent })).statusCode).toBe(404);
    expect((await s.voice(randomUUID(), { agent: 'nope' })).statusCode).toBe(404);
    expect((await s.voice(randomUUID(), { agent: `agt_${'c'.repeat(20)}` })).statusCode).toBe(404);
    expect(s.transcribe).not.toHaveBeenCalled();
  });
});

describe('voice notes: privacy', () => {
  it('never logs audio bytes or the transcript, on success or failure, and writes no file', async () => {
    const logs: string[] = [];
    const writes = [
      vi.spyOn(fs, 'writeFileSync'),
      vi.spyOn(fs, 'appendFileSync'),
      vi.spyOn(fs, 'createWriteStream'),
      vi.spyOn(fs.promises, 'writeFile'),
      vi.spyOn(fs.promises, 'appendFile'),
    ];
    const secret = 'SECRET-TRANSCRIPT-PHRASE';
    const s = await setup({ logs, transcribe: () => Promise.resolve(secret) });
    const marker = 'AUDIOMARKERBYTES';
    const body = Buffer.from(marker);
    await s.voice(randomUUID(), { body });
    s.transcribe.mockRejectedValueOnce(new PrerecordedTranscriptionError('timeout'));
    await s.voice(randomUUID(), { body });
    await s.voice(randomUUID(), { body, type: 'text/plain' });
    await s.voice(randomUUID(), { body: Buffer.alloc(2 * 1024 * 1024 + 1, 'A') });
    const all = logs.join('\n');
    expect(all.length).toBeGreaterThan(0);
    expect(all).not.toContain(secret);
    expect(all).not.toContain(marker);
    expect(all).not.toContain(Buffer.from(marker).toString('base64'));
    expect(all).not.toContain(Buffer.from(marker).toString('hex'));
    for (const w of writes) {
      expect(w).not.toHaveBeenCalled();
      w.mockRestore();
    }
  });
});

describe('voice notes: failures', () => {
  it('a word list that cannot be read only loses the hints: the note goes through, logged', async () => {
    const logs: string[] = [];
    const s = await setup({
      logs,
      wordsFor: () => Promise.reject(new Error('agents file damaged')),
    });
    const res = await s.voice();
    expect(res.statusCode).toBe(201);
    expect(s.transcribe.mock.calls[0]?.[3]).toEqual([]);
    expect(logs.some((line) => line.includes('"event":"voice_note_words_unavailable"'))).toBe(true);
  });

  it('an empty transcript is 400 and nothing is stored', async () => {
    const s = await setup({ transcribe: () => Promise.resolve('') });
    expect((await s.voice()).statusCode).toBe(400);
    expect(await s.list()).toHaveLength(0);
  });

  it('a provider failure is 502, nothing is stored, and the same client_id can retry', async () => {
    const s = await setup();
    const id = randomUUID();
    s.transcribe.mockRejectedValueOnce(new PrerecordedTranscriptionError('provider_failure'));
    expect((await s.voice(id)).statusCode).toBe(502);
    expect(await s.list()).toHaveLength(0);
    expect((await s.voice(id)).statusCode).toBe(201);
    expect(s.transcribe).toHaveBeenCalledTimes(2);
  });

  it('a timeout is 502', async () => {
    const s = await setup();
    s.transcribe.mockRejectedValueOnce(new PrerecordedTranscriptionError('timeout'));
    expect((await s.voice()).statusCode).toBe(502);
    expect(await s.list()).toHaveLength(0);
  });

  it('an unexpected transcriber error is a 500 and releases the in-flight entry', async () => {
    const s = await setup();
    const id = randomUUID();
    s.transcribe.mockRejectedValueOnce(new Error('boom'));
    expect((await s.voice(id)).statusCode).toBe(500);
    expect((await s.voice(id)).statusCode).toBe(201);
  });

  it('a client abort mid-transcription leaves no stuck in-flight entry', async () => {
    let calls = 0;
    let release!: (t: string) => void;
    const s = await setup({
      transcribe: () => {
        calls++;
        return new Promise<string>((r) => {
          release = r;
        });
      },
    });
    const id = randomUUID();
    const base = await s.app.listen({ port: 0, host: '127.0.0.1' });
    const ctrl = new AbortController();
    const target = (client: string) =>
      `${base}/v1/agents/${s.agentId}/voice-notes?client_id=${client}&duration_ms=3000`;
    const pending = fetch(target(id), {
      method: 'POST',
      headers: { 'content-type': 'audio/mp4' },
      body: Buffer.from([1, 2]),
      signal: ctrl.signal,
    }).catch(() => undefined);
    const until = Date.now() + 1000;
    while (calls === 0 && Date.now() < until) await new Promise((r) => setTimeout(r, 5));
    expect(calls).toBe(1);
    ctrl.abort();
    await pending;
    release('spoken after abort');
    await new Promise((r) => setTimeout(r, 50));
    // The work finished and cleaned up: a retry returns the stored message, no second transcription.
    const retry = await fetch(target(id), {
      method: 'POST',
      headers: { 'content-type': 'audio/mp4' },
      body: Buffer.from([1, 2]),
    });
    expect(retry.status).toBe(200);
    expect(calls).toBe(1);
    // A transcription that fails after the abort also clears the entry.
    const id2 = randomUUID();
    const ctrl2 = new AbortController();
    let reject: ((e: unknown) => void) | undefined;
    s.transcribe.mockImplementationOnce(
      () =>
        new Promise<string>((_r, j) => {
          reject = j;
        }),
    );
    const p2 = fetch(target(id2), {
      method: 'POST',
      headers: { 'content-type': 'audio/mp4' },
      body: Buffer.from([1]),
      signal: ctrl2.signal,
    }).catch(() => undefined);
    const until2 = Date.now() + 1500;
    while (reject === undefined && Date.now() < until2) await new Promise((r) => setTimeout(r, 5));
    ctrl2.abort();
    await p2;
    reject?.(new PrerecordedTranscriptionError('provider_failure'));
    await new Promise((r) => setTimeout(r, 50));
    s.transcribe.mockResolvedValueOnce('second chance');
    const retry2 = await fetch(target(id2), {
      method: 'POST',
      headers: { 'content-type': 'audio/mp4' },
      body: Buffer.from([1]),
    });
    expect(retry2.status).toBe(201);
  });
});

describe('voice notes: turn text', () => {
  it('the agent gets the voice line; stored and listed text is the transcript only', async () => {
    const s = await setup();
    const res = await s.voice(randomUUID());
    expect(res.json().message.text).toBe('hello there');
    await s.typed(randomUUID(), 'plain typed');
    await s.waitTurns(2);
    const texts = s.turns.map((t) => t.text);
    expect(texts).toContain('[Voice note, transcribed: some words may be wrong]\nhello there');
    expect(texts).toContain('plain typed');
    const listed = textsOf(await s.list());
    expect(listed.map((m) => m.text).sort()).toEqual(['hello there', 'plain typed']);
    expect(listed.find((m) => m.text === 'plain typed')?.voice).toBeUndefined();
  });

  it('truncates an oversized transcript to the message limit', async () => {
    const s = await setup({ transcribe: () => Promise.resolve('x'.repeat(50_000)) });
    const res = await s.voice();
    expect(res.statusCode).toBe(201);
    expect(res.json().message.text.length).toBeLessThan(50_000);
  });
});
