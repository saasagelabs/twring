import { describe, expect, it } from 'vitest';

import { fakeSocketFactory } from './testing';
import { VoiceProviderError, type SttEvent } from './types';
import { createXaiStt, type XaiSttOptions } from './xai-stt';

const KEY = 'xai-secret-key-1234';
const signal = () => new AbortController().signal;

async function openStt(extra: Partial<XaiSttOptions> = {}) {
  const factory = fakeSocketFactory();
  const events: SttEvent[] = [];
  const timers: { ms: number; fire: () => void; cancelled: boolean }[] = [];
  const stt = createXaiStt({
    apiKey: KEY,
    socketFactory: factory,
    setTimeout: (fire, ms) => {
      const timer = { ms, fire, cancelled: false };
      timers.push(timer);
      return () => {
        timer.cancelled = true;
      };
    },
    ...extra,
  });
  const session = await stt.open((e) => events.push(e), signal());
  return { session, socket: factory.sockets[0]!, events, timers };
}

function samplesOf(frames: Uint8Array[]): number[] {
  return frames.flatMap((b) => Array.from(new Int16Array(b.slice().buffer)));
}

function partial(text: string, isFinal: boolean, speechFinal: boolean) {
  return { type: 'transcript.partial', text, is_final: isFinal, speech_final: speechFinal };
}

describe('xAI streaming STT', () => {
  it('connects with the exact URL and query, key only in the auth header', async () => {
    const { socket } = await openStt();
    expect(socket.url).toBe(
      'wss://api.x.ai/v1/stt?model=grok-voice-transcribe-2.0&sample_rate=16000&encoding=pcm&language=en&interim_results=true&endpointing=400',
    );
    expect(socket.headers).toEqual({ Authorization: `Bearer ${KEY}` });
    expect(socket.url).not.toContain(KEY);
  });

  it('adds endpointing, smart turn options and cleaned keyterms', async () => {
    const terms = ['  Twring ', 'Twring', '', '   ', 'a b&c', 'x'.repeat(80)];
    for (let i = 0; i < 150; i += 1) terms.push(`term${i}`);
    const { socket } = await openStt({
      keyterms: terms,
      endpointingMs: 250,
      smartTurn: 0.6,
      smartTurnTimeoutMs: 1500,
    });
    const url = new URL(socket.url);
    expect(url.searchParams.get('endpointing')).toBe('250');
    expect(url.searchParams.get('smart_turn')).toBe('0.6');
    expect(url.searchParams.get('smart_turn_timeout')).toBe('1500');
    const sent = url.searchParams.getAll('keyterm');
    expect(sent).toHaveLength(100);
    expect(sent.slice(0, 3)).toEqual(['Twring', 'a b&c', 'x'.repeat(50)]);
    expect(sent.every((t) => t.length > 0 && t.length <= 50)).toBe(true);
    expect(socket.url).toContain('keyterm=a+b%26c');
  });

  it('buffers audio until transcript.created, then flushes in order', async () => {
    const { session, socket } = await openStt();
    session.sendAudio(new Int16Array([1, 2]));
    session.sendAudio(new Int16Array([3]));
    expect(socket.binarySent()).toHaveLength(0);
    socket.receive({ type: 'transcript.created' });
    session.sendAudio(new Int16Array([4]));
    void session.close();
    expect(samplesOf(socket.binarySent())).toEqual([1, 2, 3, 4]);
  });

  it('bounds the pre-start buffer to 2 s, dropping the oldest audio', async () => {
    const { session, socket } = await openStt();
    session.sendAudio(new Int16Array(16_000).fill(1));
    session.sendAudio(new Int16Array(16_000).fill(2));
    session.sendAudio(new Int16Array(16_000).fill(3));
    socket.receive({ type: 'transcript.created' });
    const samples = socket
      .binarySent()
      .flatMap((b) => Array.from(new Int16Array(b.slice().buffer)));
    expect(samples.length).toBe(32_000);
    expect(samples[samples.length - 1]).toBe(3);
    expect(samples).not.toContain(1);
  });

  it('batches audio into 100 ms frames and flushes the rest before audio.done', async () => {
    const { session, socket } = await openStt();
    socket.receive({ type: 'transcript.created' });
    session.sendAudio(new Int16Array(1000).fill(1));
    expect(socket.binarySent()).toHaveLength(0);
    session.sendAudio(new Int16Array(1000).fill(2));
    expect(socket.binarySent().map((b) => b.byteLength)).toEqual([3200]);
    void session.close();
    expect(socket.sent.map((d) => (typeof d === 'string' ? d : d.byteLength))).toEqual([
      3200,
      800,
      JSON.stringify({ type: 'audio.done' }),
    ]);
  });

  it('handles cumulative interims and a stitched speech_final without repeating words', async () => {
    const { socket, events } = await openStt();
    socket.receive({ type: 'transcript.created' });
    socket.receive(partial('I will', false, false));
    socket.receive(partial('I will buy', true, false));
    socket.receive(partial('I will buy two', false, false));
    socket.receive(partial('I  will buy two of those, please.', true, true));
    expect(events).toEqual([
      { type: 'speech_started', turnIndex: 0 },
      { type: 'partial', turnIndex: 0, text: 'I will' },
      { type: 'partial', turnIndex: 0, text: 'I will buy' },
      { type: 'partial', turnIndex: 0, text: 'I will buy two' },
      { type: 'turn_ended', turnIndex: 0, text: 'I  will buy two of those, please.' },
    ]);
  });

  it.each([
    ['re-punctuated', ['I will buy.'], 'I will buy two of those, please.'],
    ['corrected word', ['I will by'], 'I will buy two of those, please.'],
    ['non-word-boundary prefix', ['I go'], 'I gotta leave'],
  ])('a non-empty speech_final wins outright (%s)', async (_name, finals, last) => {
    const { socket, events } = await openStt();
    socket.receive({ type: 'transcript.created' });
    for (const text of finals) socket.receive(partial(text, true, false));
    socket.receive(partial(last, true, true));
    expect(events.at(-1)).toEqual({ type: 'turn_ended', turnIndex: 0, text: last });
  });

  it('treats re-punctuated cumulative interims as cumulative', async () => {
    const { socket, events } = await openStt();
    socket.receive({ type: 'transcript.created' });
    socket.receive(partial('I will buy.', true, false));
    socket.receive(partial('I will buy two', false, false));
    expect(events.at(-1)).toEqual({ type: 'partial', turnIndex: 0, text: 'I will buy two' });
  });

  it('joins a per-chunk interim that only shares a partial word', async () => {
    const { socket, events } = await openStt();
    socket.receive({ type: 'transcript.created' });
    socket.receive(partial('I go', true, false));
    socket.receive(partial('gotta leave', false, false));
    expect(events.at(-1)).toEqual({ type: 'partial', turnIndex: 0, text: 'I go gotta leave' });
    socket.receive(partial('I gotta', false, false));
    expect(events.at(-1)).toEqual({ type: 'partial', turnIndex: 0, text: 'I go I gotta' });
  });

  it('joins per-chunk "no no" then "no no no" only when not word-aligned', async () => {
    const { socket, events } = await openStt();
    socket.receive({ type: 'transcript.created' });
    socket.receive(partial('no no', true, false));
    socket.receive(partial('no no no', false, false));
    expect(events.at(-1)).toEqual({ type: 'partial', turnIndex: 0, text: 'no no no' });
  });

  it('close before transcript.created sends no audio and no audio.done', async () => {
    const { session, socket } = await openStt();
    session.sendAudio(new Int16Array(4000).fill(1));
    await session.close();
    expect(socket.binarySent()).toHaveLength(0);
    expect(socket.jsonSent()).toEqual([]);
    expect(socket.isOpen).toBe(false);
  });

  it('uses committed text when speech_final is empty', async () => {
    const { socket, events } = await openStt();
    socket.receive({ type: 'transcript.created' });
    socket.receive(partial('hello there', true, false));
    socket.receive(partial('', true, true));
    expect(events.at(-1)).toEqual({ type: 'turn_ended', turnIndex: 0, text: 'hello there' });
  });

  it('emits connection_lost and closes when transcript.created never comes', async () => {
    const { socket, events, timers } = await openStt();
    timers.find((t) => t.ms === 5000)!.fire();
    expect(events).toEqual([
      { type: 'error', error: { code: 'connection_lost', recoverable: true } },
    ]);
    expect(socket.isOpen).toBe(false);
  });

  it('cancels the ready timer once transcript.created arrives', async () => {
    const { socket, timers } = await openStt();
    socket.receive({ type: 'transcript.created' });
    expect(timers.find((t) => t.ms === 5000)!.cancelled).toBe(true);
  });

  it('keeps surrogate pairs whole and dedupes keyterms case-insensitively', async () => {
    const emoji = String.fromCodePoint(0x1f600);
    const { socket } = await openStt({
      keyterms: ['Twring', 'twring', 'a'.repeat(49) + emoji + 'b'],
    });
    const sent = new URL(socket.url).searchParams.getAll('keyterm');
    expect(sent).toEqual(['Twring', 'a'.repeat(49) + emoji]);
  });

  it.each([
    ['Incorrect API key provided', 'auth_failed', false],
    ['Forbidden: key not allowed', 'auth_failed', false],
    ['insufficient credit', 'auth_failed', false],
    ['rate limit exceeded', 'connection_lost', true],
    ['quota reached for this minute', 'connection_lost', true],
    ['API key rate limit exceeded, retry later', 'connection_lost', true],
    ['Insufficient audio data received', 'connection_lost', true],
    ['Insufficient credits', 'auth_failed', false],
    ['Payment required', 'auth_failed', false],
  ])('error %s maps to %s', async (message, code, recoverable) => {
    const { socket, events } = await openStt();
    socket.receive({ type: 'error', message });
    expect(events).toEqual([{ type: 'error', error: { code, recoverable } }]);
  });

  it('still reports an error whose message is null or oversized', async () => {
    for (const message of [null, 'x'.repeat(10_000)]) {
      const { socket, events } = await openStt();
      socket.receive({ type: 'error', message });
      expect(events).toEqual([
        { type: 'error', error: { code: 'connection_lost', recoverable: true } },
      ]);
    }
  });

  it('maps partials, chunk finals and speech_final into one turn', async () => {
    const { socket, events } = await openStt();
    socket.receive({ type: 'transcript.created' });
    socket.receive(partial('', false, false));
    socket.receive(partial('hello', false, false));
    socket.receive(partial('hello there', true, false));
    socket.receive(partial('how', false, false));
    socket.receive(partial('hello there how are you', true, true));
    socket.receive(partial('next', false, false));
    expect(events).toEqual([
      { type: 'speech_started', turnIndex: 0 },
      { type: 'partial', turnIndex: 0, text: 'hello' },
      { type: 'partial', turnIndex: 0, text: 'hello there' },
      { type: 'partial', turnIndex: 0, text: 'hello there how' },
      { type: 'turn_ended', turnIndex: 0, text: 'hello there how are you' },
      { type: 'speech_started', turnIndex: 1 },
      { type: 'partial', turnIndex: 1, text: 'next' },
    ]);
  });

  it('discards a started turn that ends empty; ignores an empty final with no turn', async () => {
    const { socket, events } = await openStt();
    socket.receive({ type: 'transcript.created' });
    socket.receive(partial('', true, true));
    expect(events).toEqual([]);
    socket.receive(partial('um', false, false));
    socket.receive(partial('', true, true));
    expect(events).toEqual([
      { type: 'speech_started', turnIndex: 0 },
      { type: 'partial', turnIndex: 0, text: 'um' },
      { type: 'speech_discarded', turnIndex: 0 },
    ]);
  });

  it('maps an auth-worded error to auth_failed and does not double-report the close', async () => {
    const { socket, events } = await openStt();
    socket.receive({ type: 'error', message: 'Unauthorized: invalid API key' });
    socket.drop(1011);
    expect(events).toEqual([{ type: 'error', error: { code: 'auth_failed', recoverable: false } }]);
  });

  it('maps other errors to recoverable connection_lost', async () => {
    const { socket, events } = await openStt();
    socket.receive({ type: 'error', message: 'internal hiccup' });
    socket.drop(1011);
    expect(events).toEqual([
      { type: 'error', error: { code: 'connection_lost', recoverable: true } },
    ]);
  });

  it('reports an unexpected close', async () => {
    const { socket, events } = await openStt();
    socket.drop(1006);
    expect(events).toEqual([
      { type: 'error', error: { code: 'connection_lost', recoverable: true } },
    ]);
  });

  it.each([
    ['401', 'auth_failed', false],
    ['402', 'auth_failed', false],
    ['403', 'auth_failed', false],
    ['400', 'provider_error', false],
    ['404', 'provider_error', false],
    ['500', 'connection_lost', true],
  ])('handshake %s maps to %s', async (status, code, recoverable) => {
    const factory = fakeSocketFactory(false);
    const stt = createXaiStt({ apiKey: KEY, socketFactory: factory });
    const opening = stt.open(() => {}, signal());
    factory.sockets[0]!.rejectConnection(`Unexpected server response: ${status}`);
    const error = await opening.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(VoiceProviderError);
    expect((error as VoiceProviderError).error).toEqual({ code, recoverable });
    expect((error as Error).message).not.toContain(KEY);
  });

  it.each([
    ['Invalid API key. Please generate a new key.', 'auth_failed', false],
    ['Forbidden: content policy violation', 'connection_lost', true],
    ['API key rate limit exceeded', 'connection_lost', true],
  ])('error message %j maps to %s', async (message, code, recoverable) => {
    const { socket, events } = await openStt();
    socket.receive({ type: 'error', message });
    expect(events).toEqual([{ type: 'error', error: { code, recoverable } }]);
  });

  it('close before ready reports no error', async () => {
    const { session, socket, events } = await openStt();
    await session.close();
    expect(socket.closedWith).toBe(1000);
    expect(events).toEqual([]);
  });

  it('close sends audio.done once and is idempotent', async () => {
    const { session, socket, events } = await openStt();
    socket.receive({ type: 'transcript.created' });
    const closing = session.close();
    const again = session.close();
    socket.receive({ type: 'transcript.done' });
    await Promise.all([closing, again, session.close()]);
    expect(socket.jsonSent()).toEqual([{ type: 'audio.done' }]);
    expect(socket.isOpen).toBe(false);
    expect(events).toEqual([]);
    session.sendAudio(new Int16Array([1]));
    expect(socket.binarySent()).toHaveLength(0);
  });

  it('close resolves even if the provider never answers', async () => {
    const { session, socket, timers } = await openStt();
    socket.receive({ type: 'transcript.created' });
    const closing = session.close();
    timers.at(-1)!.fire();
    await closing;
    expect(socket.isOpen).toBe(false);
  });

  it('ignores malformed and unknown messages without leaking text', async () => {
    const { socket, events } = await openStt();
    socket.receive('not json');
    socket.receive({ type: 'transcript.done' });
    socket.receive({ type: 'something.new' });
    expect(events).toEqual([
      { type: 'error', error: { code: 'protocol_error', recoverable: true } },
    ]);
  });
});
