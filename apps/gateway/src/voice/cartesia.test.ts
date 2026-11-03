import { cartesiaConfig, loadGatewayEnv } from '@twring/config/gateway';
import { gatewayEnvFixture } from '@twring/test-fixtures';
import { describe, expect, it } from 'vitest';

import { SAMPLES_PER_FRAME } from '../audio/pcm';
import { FrameAssembler } from '../audio/resample';
import { ManualScheduler, flushMicrotasks, recordingLogger } from '../calls/testing';

import {
  CARTESIA_API_VERSION,
  CARTESIA_KEEPALIVE_MS,
  MAX_GENERATION_CHARS,
  createCartesiaTts,
} from './cartesia-tts';
import { VoicePipeline } from './pipeline';
import { FakeSttProvider, fakeSocketFactory } from './testing';
import { VoiceProviderError, type TtsEvent } from './types';

const KEY = 'fake-cartesia-key';
const VOICE = { voiceUuid: 'voice-uuid-1', locale: 'en-IN' };
const signal = () => new AbortController().signal;

async function openTts(
  controller = new AbortController(),
  scheduler = new ManualScheduler(),
  speed?: number,
) {
  const factory = fakeSocketFactory();
  const events: TtsEvent[] = [];
  const tts = createCartesiaTts({
    apiKey: KEY,
    model: 'sonic-3.6',
    voice: VOICE,
    socketFactory: factory,
    setInterval: (callback, ms) => scheduler.setInterval(callback, ms),
    ...(speed !== undefined && { speed }),
  });
  const session = await tts.open((e) => events.push(e), controller.signal);
  const socket = factory.sockets[0]!;
  const sent = () => socket.jsonSent() as Record<string, unknown>[];
  const contextOf = (index: number) => sent()[index]!['context_id'] as string;
  const chunk = (contextId: string, bytes: number[]) =>
    socket.receive({
      type: 'chunk',
      data: Buffer.from(bytes).toString('base64'),
      done: false,
      status_code: 206,
      context_id: contextId,
    });
  const done = (contextId: string) =>
    socket.receive({ type: 'done', done: true, status_code: 206, context_id: contextId });
  const audio = () =>
    events
      .filter((e): e is Extract<TtsEvent, { type: 'audio' }> => e.type === 'audio')
      .map((e) => [e.generationId, ...e.bytes]);
  return { session, socket, events, sent, contextOf, chunk, done, audio };
}

describe('Cartesia Sonic TTS', () => {
  it('connects with the key in a header and the API version in the query', async () => {
    const { socket } = await openTts();
    const url = new URL(socket.url);
    expect(`${url.origin}${url.pathname}`).toBe('wss://api.cartesia.ai/tts/websocket');
    expect(url.searchParams.get('cartesia_version')).toBe(CARTESIA_API_VERSION);
    expect(socket.url).not.toContain(KEY);
    expect(socket.headers).toEqual({ 'X-API-Key': KEY });
  });

  it('streams text with continue:true and ends the context with an empty final input', async () => {
    const { session, sent } = await openTts();
    session.speak('g1', 'Hello, ');
    session.speak('g1', 'world.');
    session.flush('g1');
    const messages = sent();
    expect(messages).toHaveLength(3);
    expect(messages[0]).toEqual({
      model_id: 'sonic-3.6',
      transcript: 'Hello, ',
      voice: { mode: 'id', id: 'voice-uuid-1' },
      output_format: { container: 'raw', encoding: 'pcm_s16le', sample_rate: 48000 },
      locale: 'en-IN',
      context_id: messages[0]!['context_id'],
      continue: true,
    });
    expect(messages[1]).toMatchObject({ transcript: 'world.', continue: true });
    expect(messages[2]).toMatchObject({ transcript: '', continue: false });
    expect(new Set(messages.map((m) => m['context_id'])).size).toBe(1);
  });

  it('sends the speaking pace as generation_config.speed, and nothing at the default pace', async () => {
    const slow = await openTts(undefined, undefined, 0.85);
    slow.session.speak('g1', 'Hello.');
    expect(slow.sent()[0]).toMatchObject({ generation_config: { speed: 0.85 } });
    const normal = await openTts(undefined, undefined, 1);
    normal.session.speak('g1', 'Hello.');
    expect(normal.sent()[0]).not.toHaveProperty('generation_config');
  });

  it('delivers decoded audio for the active context, then done', async () => {
    const { session, contextOf, chunk, done, audio, events } = await openTts();
    session.speak('g1', 'Hi.');
    session.flush('g1');
    chunk(contextOf(0), [1, 2]);
    chunk(contextOf(0), [3, 4]);
    done(contextOf(0));
    expect(audio()).toEqual([
      ['g1', 1, 2],
      ['g1', 3, 4],
    ]);
    expect(events.at(-1)).toEqual({ type: 'done', generationId: 'g1' });
  });

  it('cancel sends Cartesia cancel and drops late chunks of that context', async () => {
    const { session, sent, contextOf, chunk, done, audio, events } = await openTts();
    session.speak('g1', 'A long answer.');
    const first = contextOf(0);
    chunk(first, [1]);
    session.cancel('g1');
    expect(sent().at(-1)).toEqual({ context_id: first, cancel: true });
    // Cartesia keeps generating what had started: those chunks must never be heard.
    chunk(first, [2]);
    done(first);
    expect(audio()).toEqual([['g1', 1]]);
    expect(events.some((e) => e.type === 'done')).toBe(false);
  });

  it('runs two generations back to back on separate contexts, with interleaved late chunks dropped', async () => {
    const { session, contextOf, chunk, done, audio, events } = await openTts();
    session.speak('g1', 'First.');
    session.cancel('g1');
    session.speak('g2', 'Second.');
    session.flush('g2');
    const [first, second] = [contextOf(0), contextOf(2)];
    expect(first).not.toBe(second);
    chunk(first, [9]);
    chunk(second, [1]);
    chunk(first, [9]);
    chunk(second, [2]);
    done(first);
    done(second);
    expect(audio()).toEqual([
      ['g2', 1],
      ['g2', 2],
    ]);
    expect(events.filter((e) => e.type === 'done')).toEqual([{ type: 'done', generationId: 'g2' }]);
  });

  it('a new generation implicitly cancels the unfinished one', async () => {
    const { session, sent, contextOf } = await openTts();
    session.speak('g1', 'First.');
    session.speak('g2', 'Second.');
    expect(sent()[1]).toEqual({ context_id: contextOf(0), cancel: true });
    expect(sent()[2]).toMatchObject({ transcript: 'Second.' });
  });

  it('completes sequential generations normally', async () => {
    const { session, contextOf, chunk, done, events } = await openTts();
    session.speak('g1', 'One.');
    session.flush('g1');
    chunk(contextOf(0), [1]);
    done(contextOf(0));
    session.speak('g2', 'Two.');
    session.flush('g2');
    chunk(contextOf(2), [2]);
    done(contextOf(2));
    expect(events.map((e) => `${e.type} ${'generationId' in e ? e.generationId : ''}`)).toEqual([
      'audio g1',
      'done g1',
      'audio g2',
      'done g2',
    ]);
  });

  it('ignores chunks for unknown contexts and informational messages', async () => {
    const { session, socket, chunk, events } = await openTts();
    session.speak('g1', 'Hi.');
    chunk('someone-else', [1]);
    socket.receive({ type: 'flush_done', flush_done: true, context_id: 'x' });
    socket.receive({ type: 'timestamps', context_id: 'x' });
    expect(events).toEqual([]);
  });

  it('ignores speak after flush, empty text, and flush/cancel for other generations', async () => {
    const { session, sent } = await openTts();
    session.speak('g1', '');
    expect(sent()).toHaveLength(0);
    session.speak('g1', 'Hi.');
    session.flush('other');
    session.cancel('other');
    session.flush('g1');
    session.flush('g1');
    session.speak('g1', 'late');
    expect(sent().map((m) => m['transcript'])).toEqual(['Hi.', '']);
  });

  it('bounds the text one generation can carry', async () => {
    const { session, sent } = await openTts();
    session.speak('g1', 'x'.repeat(MAX_GENERATION_CHARS - 5));
    session.speak('g1', 'y'.repeat(10));
    session.speak('g1', 'z');
    const lengths = sent().map((m) => (m['transcript'] as string).length);
    expect(lengths).toEqual([MAX_GENERATION_CHARS - 5, 5]);
  });

  it('a malformed frame is a protocol error for the active generation and ends the session', async () => {
    const { session, socket, events, sent } = await openTts();
    session.speak('g1', 'Hi.');
    socket.receive('{not json');
    expect(events).toEqual([
      { type: 'error', generationId: 'g1', error: { code: 'protocol_error', recoverable: true } },
    ]);
    expect(socket.closedWith).toBe(1011);
    session.speak('g2', 'ignored');
    expect(sent()).toHaveLength(1);
  });

  it('a frame without a type, or a binary frame, is a protocol error', async () => {
    const a = await openTts();
    a.socket.receive({ context_id: 'x' });
    expect(a.events[0]).toMatchObject({ type: 'error', error: { code: 'protocol_error' } });
    const b = await openTts();
    b.socket.receive(new Uint8Array([1, 2]));
    expect(b.events[0]).toMatchObject({ type: 'error', error: { code: 'protocol_error' } });
  });

  it('a context error fails only that generation; the session keeps working', async () => {
    const { session, socket, contextOf, chunk, audio, events } = await openTts();
    session.speak('g1', 'Hi.');
    socket.receive({
      type: 'error',
      title: 'bad',
      message: 'provider text',
      status_code: 400,
      context_id: contextOf(0),
    });
    expect(events).toEqual([
      {
        type: 'generation_error',
        generationId: 'g1',
        error: { code: 'provider_error', recoverable: true },
      },
    ]);
    session.speak('g2', 'Again.');
    chunk(contextOf(1), [7]);
    expect(audio()).toEqual([['g2', 7]]);
    expect(socket.closedWith).toBeUndefined();
  });

  it('pings the idle socket well inside the 5-minute idle close, never mid-generation', async () => {
    const scheduler = new ManualScheduler();
    const { session, socket, contextOf, done } = await openTts(undefined, scheduler);
    expect(CARTESIA_KEEPALIVE_MS).toBeLessThan(5 * 60_000);
    scheduler.advance(5 * 60_000);
    expect(socket.pings).toBe(Math.floor((5 * 60_000) / CARTESIA_KEEPALIVE_MS));
    const before = socket.pings;
    session.speak('g1', 'Hi.');
    scheduler.advance(CARTESIA_KEEPALIVE_MS * 2);
    expect(socket.pings).toBe(before); // a live generation keeps the socket busy
    done(contextOf(0));
    scheduler.advance(CARTESIA_KEEPALIVE_MS);
    expect(socket.pings).toBe(before + 1);
    expect(socket.sent.length).toBe(1); // pings are control frames, not billable messages
  });

  it('stops the keepalive on close, on a provider close, and on a session failure', async () => {
    for (const end of ['close', 'drop', 'fail'] as const) {
      const scheduler = new ManualScheduler();
      const { session, socket } = await openTts(undefined, scheduler);
      expect(scheduler.pending).toBe(1);
      if (end === 'close') await session.close();
      else if (end === 'drop') socket.drop(1006);
      else socket.receive({ type: 'error', status_code: 500 });
      expect(scheduler.pending).toBe(0);
      scheduler.advance(10 * CARTESIA_KEEPALIVE_MS);
      expect(socket.pings).toBe(0);
    }
  });

  it('an error for a cancelled context is ignored', async () => {
    const { session, socket, contextOf, events } = await openTts();
    session.speak('g1', 'Hi.');
    session.cancel('g1');
    socket.receive({ type: 'error', status_code: 500, context_id: contextOf(0) });
    expect(events).toEqual([]);
  });

  it.each([402, 403])('maps a %i error to auth_failed', async (status) => {
    const auth = await openTts();
    auth.session.speak('g1', 'Hi.');
    auth.socket.receive({ type: 'error', status_code: status, context_id: auth.contextOf(0) });
    expect(auth.events).toEqual([
      { type: 'error', generationId: 'g1', error: { code: 'auth_failed', recoverable: false } },
    ]);
  });

  it('maps auth errors and session-level errors', async () => {
    const auth = await openTts();
    auth.session.speak('g1', 'Hi.');
    auth.socket.receive({ type: 'error', status_code: 401, context_id: auth.contextOf(0) });
    expect(auth.events).toEqual([
      { type: 'error', generationId: 'g1', error: { code: 'auth_failed', recoverable: false } },
    ]);
    const general = await openTts();
    general.socket.receive({ type: 'error', status_code: 500 });
    expect(general.events).toEqual([
      {
        type: 'error',
        generationId: undefined,
        error: { code: 'provider_error', recoverable: true },
      },
    ]);
    expect(general.socket.closedWith).toBe(1011);
  });

  it('maps a close mid-generation, auth closes included, without leaking provider text', async () => {
    const lost = await openTts();
    lost.session.speak('g1', 'Hi.');
    lost.socket.drop(1006);
    expect(lost.events).toEqual([
      { type: 'error', generationId: 'g1', error: { code: 'connection_lost', recoverable: true } },
    ]);
    expect(JSON.stringify(lost.events)).not.toContain('server text');
    const auth = await openTts();
    auth.socket.drop(1008);
    expect(auth.events).toEqual([
      {
        type: 'error',
        generationId: undefined,
        error: { code: 'auth_failed', recoverable: false },
      },
    ]);
  });

  it('close is idempotent and silences everything after it', async () => {
    const { session, socket, contextOf, chunk, events } = await openTts();
    session.speak('g1', 'Hi.');
    await session.close();
    await session.close();
    expect(socket.closedWith).toBe(1000);
    chunk(contextOf(0), [1]);
    expect(events).toEqual([]);
  });

  it('aborting the signal after open closes the session silently', async () => {
    const controller = new AbortController();
    const { session, socket, events, sent } = await openTts(controller);
    session.speak('g1', 'Hi.');
    controller.abort();
    expect(socket.closedWith).toBe(1000);
    session.speak('g1', 'more');
    expect(sent()).toHaveLength(1);
    expect(events).toEqual([]);
  });

  it('open fails on abort, and on a rejected handshake with the right code', async () => {
    const controller = new AbortController();
    controller.abort();
    const tts = createCartesiaTts({
      apiKey: KEY,
      model: 'sonic-3.6',
      voice: VOICE,
      socketFactory: fakeSocketFactory(false),
    });
    await expect(tts.open(() => undefined, controller.signal)).rejects.toBeInstanceOf(
      VoiceProviderError,
    );

    const factory = fakeSocketFactory(false);
    const rejecting = createCartesiaTts({
      apiKey: KEY,
      model: 'sonic-3.6',
      voice: VOICE,
      socketFactory: factory,
    });
    const opening = rejecting.open(() => undefined, signal());
    factory.sockets[0]!.rejectConnection('Unexpected server response: 401');
    await expect(opening).rejects.toMatchObject({
      error: { code: 'auth_failed', recoverable: false },
    });
  });
});

describe('Cartesia Sonic TTS edges (verifier)', () => {
  it('a chunk that lands in the same tick as cancel is never delivered', async () => {
    const { session, contextOf, chunk, audio } = await openTts();
    session.speak('g1', 'Hello.');
    const first = contextOf(0);
    session.cancel('g1');
    chunk(first, [1, 2]);
    session.cancel('g1'); // a second cancel sends nothing more
    expect(audio()).toEqual([]);
  });

  it('speaking again after cancel, with the same id, opens a fresh context; the old one stays silent', async () => {
    const { session, sent, contextOf, chunk, done, audio, events } = await openTts();
    session.speak('g1', 'First.');
    const old = contextOf(0);
    session.cancel('g1');
    session.speak('g1', 'Again.');
    session.flush('g1');
    const fresh = contextOf(2);
    expect(fresh).not.toBe(old);
    expect(sent().filter((m) => m['cancel'] === true)).toHaveLength(1);
    chunk(old, [9]);
    done(old);
    chunk(fresh, [1]);
    done(fresh);
    expect(audio()).toEqual([['g1', 1]]);
    expect(events.filter((e) => e.type === 'done')).toHaveLength(1);
  });

  it('a new id after cancel gets its own context and the cancel is not repeated', async () => {
    const { session, sent, contextOf } = await openTts();
    session.speak('g1', 'First.');
    session.cancel('g1');
    session.speak('g2', 'Second.');
    expect(sent().map((m) => (m['cancel'] === true ? 'cancel' : m['transcript']))).toEqual([
      'First.',
      'cancel',
      'Second.',
    ]);
    expect(contextOf(2)).not.toBe(contextOf(0));
  });

  it('flush with no text sends nothing and does not poison a later speak', async () => {
    const { session, sent } = await openTts();
    session.flush('g1');
    expect(sent()).toEqual([]);
    session.speak('g1', 'Now.');
    session.flush('g1');
    expect(sent().map((m) => [m['transcript'], m['continue']])).toEqual([
      ['Now.', true],
      ['', false],
    ]);
  });

  it('an error naming an older context does not fail the generation now speaking', async () => {
    const { session, socket, contextOf, chunk, audio, events } = await openTts();
    session.speak('g1', 'One.');
    session.speak('g2', 'Two.');
    socket.receive({ type: 'error', status_code: 500, context_id: contextOf(0) });
    chunk(contextOf(2), [5]);
    expect(events.map((e) => e.type)).toEqual(['audio']);
    expect(audio()).toEqual([['g2', 5]]);
  });

  it('a socket close between generations reports a recoverable error naming no generation', async () => {
    const { session, contextOf, chunk, done, socket, events } = await openTts();
    session.speak('g1', 'One.');
    session.flush('g1');
    chunk(contextOf(0), [1]);
    done(contextOf(0));
    socket.drop(1000); // Cartesia's idle close is a normal close
    expect(events.at(-1)).toEqual({
      type: 'error',
      generationId: undefined,
      error: { code: 'connection_lost', recoverable: true },
    });
    session.speak('g2', 'ignored');
    expect(socket.jsonSent()).toHaveLength(2);
  });

  it('abort while the socket is still connecting rejects and closes the socket', async () => {
    const factory = fakeSocketFactory(false);
    const tts = createCartesiaTts({
      apiKey: KEY,
      model: 'sonic-3.6',
      voice: VOICE,
      socketFactory: factory,
    });
    const controller = new AbortController();
    const opening = tts.open(() => undefined, controller.signal);
    controller.abort();
    await expect(opening).rejects.toMatchObject({
      error: { code: 'connection_lost', recoverable: true },
    });
    expect(factory.sockets[0]!.closedWith).toBeDefined();
  });

  it('a chunk whose data is not base64 is a protocol error, never played as noise', async () => {
    const { session, socket, contextOf, events } = await openTts();
    session.speak('g1', 'Hi.');
    socket.receive({ type: 'chunk', data: 'this is not base64!*', context_id: contextOf(0) });
    expect(events).toEqual([
      { type: 'error', generationId: 'g1', error: { code: 'protocol_error', recoverable: true } },
    ]);
    expect(socket.closedWith).toBe(1011);
  });

  it('accepts unpadded and padded base64 alike', async () => {
    const { session, socket, contextOf, audio } = await openTts();
    session.speak('g1', 'Hi.');
    socket.receive({ type: 'chunk', data: 'AQID', context_id: contextOf(0) }); // [1,2,3]
    socket.receive({ type: 'chunk', data: 'BA==', context_id: contextOf(0) }); // [4]
    socket.receive({ type: 'chunk', data: 'BQ', context_id: contextOf(0) }); // [5], unpadded
    expect(audio()).toEqual([
      ['g1', 1, 2, 3],
      ['g1', 4],
      ['g1', 5],
    ]);
  });

  it('odd-length chunks reach the frame assembler as bytes and realign across chunks', async () => {
    const { session, contextOf, chunk, events } = await openTts();
    session.speak('g1', 'Hi.');
    // Samples 0x0201 and 0x0403 split 3 + 1 bytes across two chunks.
    chunk(contextOf(0), [1, 2, 3]);
    chunk(contextOf(0), [4]);
    const assembler = new FrameAssembler();
    for (const event of events) if (event.type === 'audio') assembler.push(event.bytes);
    const [frame] = assembler.flush();
    expect([...frame!.slice(0, 3)]).toEqual([0x0201, 0x0403, 0]);
  });

  it('the cap never splits a surrogate pair (an emoji at the boundary)', async () => {
    const { session, sent } = await openTts();
    session.speak('g1', 'x'.repeat(MAX_GENERATION_CHARS - 1));
    session.speak('g1', '😀 more');
    session.flush('g1');
    const transcripts = sent().map((m) => m['transcript'] as string);
    // A lone high surrogate is invalid text; the provider would reject the context.
    expect(transcripts.some((t) => /[\uD800-\uDBFF]$/.test(t))).toBe(false);
    expect(transcripts.reduce((n, t) => n + t.length, 0)).toBeLessThanOrEqual(MAX_GENERATION_CHARS);
    expect(transcripts.at(-1)).toBe(''); // the context still ends normally
  });

  it('a new generation while the previous one still streams: only the new audio is heard', async () => {
    const { session, contextOf, chunk, audio } = await openTts();
    session.speak('g1', 'Long answer…');
    chunk(contextOf(0), [1]);
    session.speak('g2', 'Newer.');
    chunk(contextOf(0), [2]);
    chunk(contextOf(2), [3]);
    expect(audio()).toEqual([
      ['g1', 1],
      ['g2', 3],
    ]);
  });
});

describe('Cartesia Sonic TTS under the voice pipeline', () => {
  async function pipelineWithCartesia() {
    const scheduler = new ManualScheduler();
    const ttsFactory = fakeSocketFactory();
    const speech: string[] = [];
    const fatal: string[] = [];
    const queued: { frames: Int16Array[]; onDone?: () => void }[] = [];
    const pipeline = new VoicePipeline({
      callId: 'call_aaaaaaaaaaaaaaaaaaaa',
      stt: new FakeSttProvider(),
      tts: createCartesiaTts({
        apiKey: KEY,
        model: 'sonic-3.6',
        voice: VOICE,
        socketFactory: ttsFactory,
        setInterval: (callback, ms) => scheduler.setInterval(callback, ms),
      }),
      scheduler,
      logger: recordingLogger(),
      onUserSpeechStarted: () => undefined,
      onUserSpeechDiscarded: () => undefined,
      onUserTurn: () => undefined,
      onCaption: () => undefined,
      onSpeech: ({ generationId, state }) => speech.push(`${generationId} ${state}`),
      playFrames: (frames, callbacks) =>
        queued.push({ frames, ...(callbacks.onDone && { onDone: callbacks.onDone }) }),
      stopPlayback: () => 0,
      onFatal: (error) => fatal.push(error.code),
    });
    await pipeline.start();
    const contextOf = (socket: number, index: number) =>
      (ttsFactory.sockets[socket]!.jsonSent()[index] as Record<string, unknown>)[
        'context_id'
      ] as string;
    return { pipeline, scheduler, ttsFactory, speech, fatal, queued, contextOf };
  }

  it('an idle close between turns reopens the socket and the next answer plays', async () => {
    const { pipeline, scheduler, ttsFactory, speech, fatal, queued, contextOf } =
      await pipelineWithCartesia();
    scheduler.advance(5 * 60_000);
    ttsFactory.sockets[0]!.drop(1000);
    expect(speech).toEqual([]); // nothing was speaking: nothing fails
    scheduler.advance(250);
    await flushMicrotasks();
    expect(ttsFactory.sockets).toHaveLength(2);
    const id = pipeline.beginSpeech(scheduler.now());
    pipeline.appendSpeech(id, 'Still here.');
    pipeline.endSpeech(id);
    const fresh = ttsFactory.sockets[1]!;
    const bytes = Buffer.from(new Int16Array(SAMPLES_PER_FRAME).fill(1000).buffer);
    fresh.receive({ type: 'chunk', data: bytes.toString('base64'), context_id: contextOf(1, 0) });
    fresh.receive({ type: 'done', context_id: contextOf(1, 0) });
    for (const q of queued.splice(0)) q.onDone?.();
    expect(speech).toEqual([`${id} finished`]);
    expect(fatal).toEqual([]);
  });

  it('idle closes every five minutes over a long silent call never exhaust the reconnects', async () => {
    const { scheduler, ttsFactory, fatal } = await pipelineWithCartesia();
    for (let i = 0; i < 6; i += 1) {
      scheduler.advance(5 * 60_000);
      ttsFactory.sockets.at(-1)!.drop(1000);
      scheduler.advance(250);
      await flushMicrotasks();
    }
    expect(ttsFactory.sockets).toHaveLength(7);
    expect(fatal).toEqual([]);
  });

  it('a context error fails only that answer: no reconnect, and the next answer plays (ADR-022)', async () => {
    // Cartesia keeps the socket usable after a per-context error, so the pipeline fails just that
    // answer. Repeated context errors never spend the reconnect budget or end the call.
    const { pipeline, scheduler, ttsFactory, speech, fatal, queued, contextOf } =
      await pipelineWithCartesia();
    for (let i = 0; i < 4; i += 1) {
      const id = pipeline.beginSpeech(scheduler.now());
      pipeline.appendSpeech(id, 'Answer.');
      ttsFactory.sockets[0]!.receive({
        type: 'error',
        status_code: 429,
        context_id: contextOf(0, i),
      });
      expect(speech.at(-1)).toBe(`${id} failed`);
      scheduler.advance(1000);
      await flushMicrotasks();
    }
    expect(ttsFactory.sockets).toHaveLength(1);
    expect(ttsFactory.sockets[0]!.closedWith).toBeUndefined();
    expect(fatal).toEqual([]);
    const id = pipeline.beginSpeech(scheduler.now());
    pipeline.appendSpeech(id, 'Works now.');
    pipeline.endSpeech(id);
    const context = contextOf(0, 4);
    const bytes = Buffer.from(new Int16Array(SAMPLES_PER_FRAME).fill(1000).buffer);
    ttsFactory.sockets[0]!.receive({
      type: 'chunk',
      data: bytes.toString('base64'),
      context_id: context,
    });
    ttsFactory.sockets[0]!.receive({ type: 'done', context_id: context });
    for (const q of queued.splice(0)) q.onDone?.();
    expect(speech.at(-1)).toBe(`${id} finished`);
    expect(pipeline.usage().ttsReconnects).toBe(0);
  });

  it('a session-level error still reconnects the socket', async () => {
    const { scheduler, ttsFactory, fatal } = await pipelineWithCartesia();
    ttsFactory.sockets[0]!.receive({ type: 'error', status_code: 500 });
    scheduler.advance(250);
    await flushMicrotasks();
    expect(ttsFactory.sockets).toHaveLength(2);
    expect(fatal).toEqual([]);
  });

  it('a barge-in racing a chunk: the late chunk of the cut answer is never queued', async () => {
    const { pipeline, ttsFactory, queued, contextOf } = await pipelineWithCartesia();
    const id = pipeline.beginSpeech(0);
    pipeline.appendSpeech(id, 'A long answer.');
    pipeline.cancelSpeech('barge_in');
    const bytes = Buffer.from(new Int16Array(SAMPLES_PER_FRAME).fill(1000).buffer);
    ttsFactory.sockets[0]!.receive({
      type: 'chunk',
      data: bytes.toString('base64'),
      context_id: contextOf(0, 0),
    });
    expect(queued).toEqual([]);
  });
});

describe('Cartesia config', () => {
  it('is off without a key and defaults to the current Sonic model', () => {
    expect(cartesiaConfig(loadGatewayEnv(gatewayEnvFixture()))).toBeUndefined();
    const env = loadGatewayEnv({ ...gatewayEnvFixture(), CARTESIA_API_KEY: 'k' });
    expect(cartesiaConfig(env)).toEqual({ apiKey: 'k', ttsModel: 'sonic-3.6', ttsSpeed: 1 });
    expect(() =>
      loadGatewayEnv({ ...gatewayEnvFixture(), CARTESIA_TTS_MODEL: 'flux-haley-en' }),
    ).toThrow();
  });
});
