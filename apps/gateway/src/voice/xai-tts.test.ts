import { describe, expect, it } from 'vitest';

import { fakeSocketFactory } from './testing';
import { VoiceProviderError, type TtsEvent } from './types';
import { createXaiTts } from './xai-tts';

const KEY = 'fake-xai-key';

async function openTts(controller = new AbortController()) {
  const factory = fakeSocketFactory();
  const events: TtsEvent[] = [];
  const timers: { ms: number; fire: () => void; cancelled: boolean }[] = [];
  const tts = createXaiTts({
    apiKey: KEY,
    voice: 'eve',
    socketFactory: factory,
    setTimeout: (fire, ms) => {
      const timer = { ms, fire, cancelled: false };
      timers.push(timer);
      return () => {
        timer.cancelled = true;
      };
    },
  });
  const session = await tts.open((e) => events.push(e), controller.signal);
  const socket = factory.sockets[0]!;
  const sent = () => socket.jsonSent();
  const delta = (bytes: number[]) =>
    socket.receive({ type: 'audio.delta', delta: Buffer.from(bytes).toString('base64') });
  const audio = () =>
    events
      .filter((e): e is Extract<TtsEvent, { type: 'audio' }> => e.type === 'audio')
      .map((e) => [e.generationId, ...e.bytes]);
  return { tts, session, socket, events, sent, delta, audio, timers };
}

describe('xAI streaming TTS', () => {
  it('is named xai-tts and connects to the exact URL with the key in a header only', async () => {
    const { tts, socket } = await openTts();
    expect(tts.name).toBe('xai-tts');
    expect(socket.url).toBe(
      'wss://api.x.ai/v1/tts?language=en&voice=eve&codec=pcm&sample_rate=48000',
    );
    expect(socket.url).not.toContain(KEY);
    expect(socket.headers).toEqual({ Authorization: `Bearer ${KEY}` });
  });

  it('asks for lower time to first audio only when configured', async () => {
    const factory = fakeSocketFactory();
    const tts = createXaiTts({
      apiKey: KEY,
      voice: 'eve',
      socketFactory: factory,
      optimizeStreamingLatency: 1,
    });
    await tts.open(() => undefined, new AbortController().signal);
    const url = new URL(factory.sockets[0]!.url);
    expect(url.searchParams.get('optimize_streaming_latency')).toBe('1');
  });

  it('sends text.delta for speak and text.done for flush', async () => {
    const { session, sent } = await openTts();
    session.speak('g1', 'Hello, ');
    session.speak('g1', 'world.');
    session.flush('g1');
    expect(sent()).toEqual([
      { type: 'text.delta', delta: 'Hello, ' },
      { type: 'text.delta', delta: 'world.' },
      { type: 'text.done' },
    ]);
    expect(JSON.stringify(sent())).not.toContain(KEY);
  });

  it('decodes audio.delta to PCM bytes for the active generation and audio.done gives done', async () => {
    const { session, socket, events, delta, audio } = await openTts();
    session.speak('g1', 'Hi');
    session.flush('g1');
    delta([1, 2, 3, 4]);
    socket.receive({ type: 'audio.done' });
    expect(audio()).toEqual([['g1', 1, 2, 3, 4]]);
    expect(events.at(-1)).toEqual({ type: 'done', generationId: 'g1' });
  });

  it('carries a stray odd byte to the next chunk so samples stay aligned', async () => {
    const { session, delta, audio } = await openTts();
    session.speak('g1', 'Hi');
    delta([1, 2, 3]);
    delta([4, 5, 6]);
    expect(audio()).toEqual([
      ['g1', 1, 2],
      ['g1', 3, 4, 5, 6],
    ]);
  });

  it('treats malformed base64 as a protocol error', async () => {
    const { session, socket, events } = await openTts();
    session.speak('g1', 'Hi');
    socket.receive({ type: 'audio.delta', delta: 'not base64!!' });
    expect(events).toEqual([
      { type: 'error', generationId: 'g1', error: { code: 'protocol_error', recoverable: true } },
    ]);
  });

  it('runs two generations in a row on one socket', async () => {
    const { session, socket, events, delta, audio } = await openTts();
    session.speak('g1', 'One');
    session.flush('g1');
    delta([1, 1]);
    socket.receive({ type: 'audio.done' });
    session.speak('g2', 'Two');
    session.flush('g2');
    delta([2, 2]);
    socket.receive({ type: 'audio.done' });
    expect(audio()).toEqual([
      ['g1', 1, 1],
      ['g2', 2, 2],
    ]);
    expect(events.filter((e) => e.type === 'done')).toEqual([
      { type: 'done', generationId: 'g1' },
      { type: 'done', generationId: 'g2' },
    ]);
  });

  it('cancel sends text.clear and drops audio until audio.clear', async () => {
    const { session, socket, events, sent, delta, audio } = await openTts();
    session.speak('g1', 'Long answer');
    delta([1, 1]);
    session.cancel('g1');
    expect(sent().at(-1)).toEqual({ type: 'text.clear' });
    delta([9, 9]);
    socket.receive({ type: 'audio.done' });
    socket.receive({ type: 'audio.clear' });
    session.speak('g2', 'Next');
    session.flush('g2');
    delta([2, 2]);
    socket.receive({ type: 'audio.done' });
    expect(audio()).toEqual([
      ['g1', 1, 1],
      ['g2', 2, 2],
    ]);
    expect(events.filter((e) => e.type === 'done')).toEqual([{ type: 'done', generationId: 'g2' }]);
  });

  it('cancelled audio still in flight is never given to the next generation', async () => {
    const { session, delta, audio, socket } = await openTts();
    session.speak('g1', 'Long answer');
    session.cancel('g1');
    session.speak('g2', 'Next');
    delta([9, 9]); // Late g1 audio, before audio.clear.
    socket.receive({ type: 'audio.clear' });
    delta([2, 2]);
    expect(audio()).toEqual([['g2', 2, 2]]);
  });

  it('counts clears: audio between two clears is never given to a later generation', async () => {
    const { session, socket, delta, audio } = await openTts();
    session.speak('g1', 'One');
    session.cancel('g1');
    session.speak('g2', 'Two');
    session.cancel('g2');
    session.speak('g3', 'Three');
    socket.receive({ type: 'audio.clear' });
    delta([2, 2]); // g2 audio, still cleared.
    socket.receive({ type: 'audio.clear' });
    delta([3, 3]);
    expect(audio()).toEqual([['g3', 3, 3]]);
  });

  it('a generation error while a clear is pending also waits for both clears', async () => {
    const { session, socket, events, delta, audio } = await openTts();
    session.speak('g1', 'One');
    session.cancel('g1');
    session.speak('g2', 'Two');
    socket.receive({ type: 'error', message: 'Something went wrong' });
    session.speak('g3', 'Three');
    socket.receive({ type: 'audio.clear' });
    delta([2, 2]);
    socket.receive({ type: 'audio.done' });
    socket.receive({ type: 'audio.clear' });
    delta([3, 3]);
    expect(audio()).toEqual([['g3', 3, 3]]);
    expect(events.filter((e) => e.type === 'done')).toEqual([]);
  });

  it('audio.done for an unflushed generation is not done', async () => {
    const { session, socket, events } = await openTts();
    session.speak('g1', 'One');
    socket.receive({ type: 'audio.done' });
    expect(events).toEqual([]);
  });

  it('a clear that is never acknowledged within 2 s ends the session as connection_lost', async () => {
    const { session, socket, events, delta, audio, timers } = await openTts();
    session.speak('g1', 'One');
    session.cancel('g1');
    session.speak('g2', 'Two');
    const timer = timers.find((t) => !t.cancelled)!;
    expect(timer.ms).toBe(2000);
    timer.fire();
    expect(events).toEqual([
      { type: 'error', generationId: 'g2', error: { code: 'connection_lost', recoverable: true } },
    ]);
    expect(socket.isOpen).toBe(false);
    delta([2, 2]);
    expect(audio()).toEqual([]);
  });

  it('an acknowledged clear cancels its timer', async () => {
    const { session, socket, timers } = await openTts();
    session.speak('g1', 'One');
    session.cancel('g1');
    socket.receive({ type: 'audio.clear' });
    expect(timers.every((t) => t.cancelled)).toBe(true);
  });

  it('cancelling unknown ids does not grow without bound', async () => {
    const { session, sent } = await openTts();
    for (let i = 0; i < 1000; i += 1) session.cancel(`x${i}`);
    session.speak('x0', 'old ids beyond the window may speak again');
    session.speak('x999', 'recent cancelled id stays silent');
    expect(sent()).toEqual([
      { type: 'text.delta', delta: 'old ids beyond the window may speak again' },
    ]);
  });

  it('ignores text for a cancelled generation and a cancel with nothing sent sends no clear', async () => {
    const { session, sent } = await openTts();
    session.speak('g1', 'Hi');
    session.cancel('g1');
    session.speak('g1', 'more');
    session.flush('g1');
    session.cancel('g2');
    expect(sent()).toEqual([{ type: 'text.delta', delta: 'Hi' }, { type: 'text.clear' }]);
  });

  it('flush with no text completes locally without sending text.done', async () => {
    const { session, events, sent } = await openTts();
    session.flush('g1');
    expect(events).toEqual([{ type: 'done', generationId: 'g1' }]);
    expect(sent()).toEqual([]);
    session.speak('g2', 'Then this');
    expect(sent()).toEqual([{ type: 'text.delta', delta: 'Then this' }]);
  });

  it('an error with the socket open fails only the active generation', async () => {
    const { session, socket, events, delta, audio } = await openTts();
    session.speak('g1', 'Hi');
    socket.receive({ type: 'error', message: 'Something went wrong' });
    expect(events).toEqual([
      {
        type: 'generation_error',
        generationId: 'g1',
        error: { code: 'provider_error', recoverable: true },
      },
    ]);
    expect(socket.isOpen).toBe(true);
    delta([9, 9]);
    session.speak('g2', 'Again');
    socket.receive({ type: 'audio.clear' });
    delta([2, 2]);
    expect(audio()).toEqual([['g2', 2, 2]]);
  });

  it('an error that refuses the key ends the session as auth_failed', async () => {
    const { session, socket, events } = await openTts();
    session.speak('g1', 'Hi');
    socket.receive({ type: 'error', message: 'Invalid API key' });
    expect(events).toEqual([
      { type: 'error', generationId: 'g1', error: { code: 'auth_failed', recoverable: false } },
    ]);
    expect(socket.isOpen).toBe(false);
  });

  it.each(['Forbidden', 'Forbidden: content policy violation', 'Permission denied'])(
    'an error "%s" without key wording ends the session as connection_lost so a reconnect decides',
    async (message) => {
      const { session, socket, events, delta, audio } = await openTts();
      session.speak('g1', 'Hi');
      socket.receive({ type: 'error', message });
      expect(events).toEqual([
        {
          type: 'error',
          generationId: 'g1',
          error: { code: 'connection_lost', recoverable: true },
        },
      ]);
      expect(socket.isOpen).toBe(false);
      delta([2, 2]);
      expect(audio()).toEqual([]);
    },
  );

  it('a socket close gives a recoverable error naming the active generation', async () => {
    const { session, socket, events } = await openTts();
    session.speak('g1', 'Hi');
    socket.drop(1006);
    expect(events).toEqual([
      { type: 'error', generationId: 'g1', error: { code: 'connection_lost', recoverable: true } },
    ]);
  });

  it.each([
    ['401', 'auth_failed', false],
    ['402', 'auth_failed', false],
    ['403', 'auth_failed', false],
    ['400', 'provider_error', false],
    ['404', 'provider_error', false],
    ['500', 'connection_lost', true],
  ])('maps a handshake %s', async (status, code, recoverable) => {
    const factory = fakeSocketFactory(false);
    const tts = createXaiTts({ apiKey: KEY, voice: 'rex', socketFactory: factory });
    const opening = tts.open(() => undefined, new AbortController().signal);
    factory.sockets[0]!.rejectConnection(`Unexpected server response: ${status}`);
    const error = await opening.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(VoiceProviderError);
    expect((error as VoiceProviderError).error).toEqual({ code, recoverable });
    expect(String((error as Error).message)).not.toContain(KEY);
  });

  it('close is idempotent, closes the socket and reports nothing', async () => {
    const { session, socket, events } = await openTts();
    session.speak('g1', 'Hi');
    await session.close();
    await session.close();
    expect(socket.closedWith).toBe(1000);
    expect(events).toEqual([]);
    session.speak('g2', 'late');
    expect(socket.jsonSent()).toEqual([{ type: 'text.delta', delta: 'Hi' }]);
  });

  it('aborting the open signal closes the session', async () => {
    const controller = new AbortController();
    const { socket } = await openTts(controller);
    controller.abort();
    expect(socket.closedWith).toBe(1000);
  });
});
