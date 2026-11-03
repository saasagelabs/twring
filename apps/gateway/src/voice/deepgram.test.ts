import {
  agentSttKeyterms,
  deepgramConfig,
  loadGatewayEnv,
  MAX_STT_KEYTERMS,
} from '@twring/config/gateway';
import { gatewayEnvFixture } from '@twring/test-fixtures';
import { describe, expect, it } from 'vitest';

import { createDeepgramStt } from './deepgram-stt';
import { INTERRUPT_ACK_TIMEOUT_MS, createDeepgramTts } from './deepgram-tts';
import { fakeSocketFactory } from './testing';
import { VoiceProviderError, type SttEvent, type TtsEvent } from './types';

const KEY = 'fake-deepgram-key';
const signal = () => new AbortController().signal;

function turn(event: string, turnIndex: number, transcript: string) {
  return { type: 'TurnInfo', event, turn_index: turnIndex, transcript, words: [] };
}

async function openStt() {
  const factory = fakeSocketFactory();
  const events: SttEvent[] = [];
  const stt = createDeepgramStt({ apiKey: KEY, model: 'flux-general-en', socketFactory: factory });
  const session = await stt.open((e) => events.push(e), signal());
  return { session, socket: factory.sockets[0]!, events };
}

async function openTts() {
  const factory = fakeSocketFactory();
  const events: TtsEvent[] = [];
  const ticks: (() => void)[] = [];
  const tts = createDeepgramTts({
    apiKey: KEY,
    model: 'flux-haley-en',
    socketFactory: factory,
    setInterval: (callback) => {
      ticks.push(callback);
      return () => ticks.splice(ticks.indexOf(callback), 1);
    },
  });
  const session = await tts.open((e) => events.push(e), signal());
  return { session, socket: factory.sockets[0]!, events, ticks };
}

describe('Deepgram Flux STT', () => {
  it('connects to /v2/listen for 16 kHz linear16 with the key in a header, not the URL', async () => {
    const { socket } = await openStt();
    const url = new URL(socket.url);
    expect(url.origin + url.pathname).toBe('wss://api.deepgram.com/v2/listen');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      model: 'flux-general-en',
      encoding: 'linear16',
      sample_rate: '16000',
    });
    expect(socket.headers).toEqual({ Authorization: `Token ${KEY}` });
    expect(socket.url).not.toContain(KEY);
  });

  it('passes language hints for the multilingual model', async () => {
    const factory = fakeSocketFactory();
    const stt = createDeepgramStt({
      apiKey: KEY,
      model: 'flux-general-multi',
      languageHints: ['en', 'hi'],
      socketFactory: factory,
    });
    await stt.open(() => undefined, signal());
    expect(new URL(factory.sockets[0]!.url).searchParams.getAll('language_hint')).toEqual([
      'en',
      'hi',
    ]);
  });

  it('passes Flux end-of-turn settings only when set', async () => {
    const factory = fakeSocketFactory();
    await createDeepgramStt({
      apiKey: KEY,
      model: 'flux-general-en',
      eotThreshold: 0.85,
      eotTimeoutMs: 3000,
      socketFactory: factory,
    }).open(() => undefined, signal());
    await createDeepgramStt({ apiKey: KEY, model: 'flux-general-en', socketFactory: factory }).open(
      () => undefined,
      signal(),
    );
    const [tuned, plain] = factory.sockets.map((s) => new URL(s.url).searchParams);
    expect(tuned!.get('eot_threshold')).toBe('0.85');
    expect(tuned!.get('eot_timeout_ms')).toBe('3000');
    expect(plain!.has('eot_threshold')).toBe(false);
    expect(plain!.has('eot_timeout_ms')).toBe(false);
  });

  it('passes keyterms URL-encoded', async () => {
    const factory = fakeSocketFactory();
    const stt = createDeepgramStt({
      apiKey: KEY,
      model: 'flux-general-en',
      keyterms: ['Chennai', 'St. Mary’s'],
      socketFactory: factory,
    });
    await stt.open(() => undefined, signal());
    expect(new URL(factory.sockets[0]!.url).searchParams.getAll('keyterm')).toEqual([
      'Chennai',
      'St. Mary’s',
    ]);
  });

  it('opens a saved agent’s STT with its terms first, within the keyterm cap', async () => {
    const config = deepgramConfig(
      loadGatewayEnv(
        gatewayEnvFixture({
          DEEPGRAM_API_KEY: KEY,
          DEEPGRAM_STT_KEYTERMS: Array.from({ length: 50 }, (_, i) => `env${i}`).join(','),
        }),
      ),
    )!;
    const factory = fakeSocketFactory();
    const stt = createDeepgramStt({
      apiKey: KEY,
      model: 'flux-general-en',
      keyterms: agentSttKeyterms(config, ['Chennai', 'Thiruvananthapuram']),
      socketFactory: factory,
    });
    await stt.open(() => undefined, signal());
    const terms = new URL(factory.sockets[0]!.url).searchParams.getAll('keyterm');
    expect(terms.slice(0, 3)).toEqual(['Chennai', 'Thiruvananthapuram', 'wait']);
    expect(terms).toContain('one second');
    expect(terms).toHaveLength(MAX_STT_KEYTERMS);
  });

  it('sends audio in 80 ms chunks regardless of input size', async () => {
    const { session, socket } = await openStt();
    session.sendAudio(new Int16Array(320)); // 20 ms
    session.sendAudio(new Int16Array(1000));
    expect(socket.binarySent().map((b) => b.byteLength)).toEqual([2560]);
    session.sendAudio(new Int16Array(1300));
    expect(socket.binarySent().map((b) => b.byteLength)).toEqual([2560, 2560]);
  });

  it('maps the Flux turn lifecycle to Twring events, forwarding only changed partials', async () => {
    const { socket, events } = await openStt();
    socket.receive({ type: 'Connected', request_id: 'r', sequence_id: 0 });
    socket.receive(turn('Update', 0, ''));
    socket.receive(turn('StartOfTurn', 0, 'Hi I'));
    socket.receive(turn('Update', 0, 'Hi I need'));
    socket.receive(turn('Update', 0, 'Hi I need'));
    socket.receive(turn('EagerEndOfTurn', 0, 'Hi I need help.'));
    socket.receive(turn('EndOfTurn', 0, 'Hi I need help.'));
    expect(events).toEqual([
      { type: 'speech_started', turnIndex: 0 },
      { type: 'partial', turnIndex: 0, text: 'Hi I' },
      { type: 'partial', turnIndex: 0, text: 'Hi I need' },
      { type: 'partial', turnIndex: 0, text: 'Hi I need help.' },
      { type: 'turn_ended', turnIndex: 0, text: 'Hi I need help.' },
    ]);
  });

  it('never commits an empty turn; it reports the speech as discarded', async () => {
    const { socket, events } = await openStt();
    socket.receive(turn('EndOfTurn', 3, '  '));
    expect(events).toEqual([{ type: 'speech_discarded', turnIndex: 3 }]);
  });

  it('reports malformed and error messages as Twring codes, not provider text', async () => {
    const { socket, events } = await openStt();
    socket.receive('not json');
    socket.receive({ type: 'Error', description: 'secret provider detail' });
    expect(events).toEqual([
      { type: 'error', error: { code: 'protocol_error', recoverable: true } },
      { type: 'error', error: { code: 'provider_error', recoverable: true } },
    ]);
    expect(JSON.stringify(events)).not.toContain('secret');
  });

  it('classifies an unexpected close as recoverable and a policy close as auth', async () => {
    const lost = await openStt();
    lost.socket.drop(1006);
    expect(lost.events).toEqual([
      { type: 'error', error: { code: 'connection_lost', recoverable: true } },
    ]);
    const denied = await openStt();
    denied.socket.drop(1008);
    expect(denied.events[0]).toEqual({
      type: 'error',
      error: { code: 'auth_failed', recoverable: false },
    });
  });

  it('closes with CloseStream and reports nothing afterwards', async () => {
    const { session, socket, events } = await openStt();
    await session.close();
    await session.close();
    expect(socket.jsonSent()).toEqual([{ type: 'CloseStream' }]);
    expect(socket.closedWith).toBe(1000);
    expect(events).toEqual([]);
  });

  it.each([401, 402, 403])('rejects open() with auth_failed on a %i handshake', async (status) => {
    const factory = fakeSocketFactory(false);
    const stt = createDeepgramStt({
      apiKey: KEY,
      model: 'flux-general-en',
      socketFactory: factory,
    });
    const opening = stt.open(() => undefined, signal());
    factory.sockets[0]!.rejectConnection(`Unexpected server response: ${status}`);
    await expect(opening).rejects.toEqual(
      new VoiceProviderError({ code: 'auth_failed', recoverable: false }),
    );
  });

  it('abandons a pending connect when aborted', async () => {
    const factory = fakeSocketFactory(false);
    const controller = new AbortController();
    const stt = createDeepgramStt({
      apiKey: KEY,
      model: 'flux-general-en',
      socketFactory: factory,
    });
    const opening = stt.open(() => undefined, controller.signal);
    controller.abort();
    await expect(opening).rejects.toBeInstanceOf(VoiceProviderError);
    expect(factory.sockets[0]!.closedWith).toBeDefined();
  });
});

describe('Deepgram Flux TTS', () => {
  const audio = (n: number) => new Uint8Array([n, n]);

  it('connects to /v2/speak for 48 kHz linear16', async () => {
    const { socket } = await openTts();
    const url = new URL(socket.url);
    expect(url.origin + url.pathname).toBe('wss://api.deepgram.com/v2/speak');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      model: 'flux-haley-en',
      encoding: 'linear16',
      sample_rate: '48000',
    });
    expect(socket.headers).toEqual({ Authorization: `Token ${KEY}` });
  });

  it('streams one generation: Speak text, Flush, tagged audio, then done', async () => {
    const { session, socket, events } = await openTts();
    session.speak('g1', 'Hello ');
    session.speak('g1', 'there.');
    session.flush('g1');
    session.flush('g1');
    socket.receive({ type: 'SpeechStarted', speech_id: 's1' });
    socket.receive(audio(1));
    socket.receive({ type: 'Flushed', speech_id: 's1' });
    socket.receive(audio(2));
    socket.receive({ type: 'SpeechMetadata', speech_id: 's1', audio_duration_ms: 900 });
    expect(socket.jsonSent()).toEqual([
      { type: 'Speak', text: 'Hello ' },
      { type: 'Speak', text: 'there.' },
      { type: 'Flush' },
    ]);
    expect(events).toEqual([
      { type: 'audio', generationId: 'g1', bytes: audio(1) },
      { type: 'audio', generationId: 'g1', bytes: audio(2) },
      { type: 'done', generationId: 'g1' },
    ]);
  });

  it('never delivers audio from a cancelled generation, even late', async () => {
    const { session, socket, events } = await openTts();
    session.speak('g1', 'A long answer.');
    session.flush('g1');
    socket.receive({ type: 'SpeechStarted', speech_id: 's1' });
    socket.receive(audio(1));
    session.cancel('g1');
    socket.receive(audio(2)); // in flight before the provider saw Interrupt
    session.speak('g2', 'New answer.');
    session.flush('g2');
    socket.receive(audio(3)); // still before SpeechInterrupted: must be dropped
    socket.receive({ type: 'SpeechInterrupted', audio_played_ms: 400 });
    socket.receive({ type: 'SpeechStarted', speech_id: 's2' });
    socket.receive(audio(4));
    socket.receive({ type: 'SpeechMetadata', speech_id: 's2' });
    expect(socket.jsonSent()).toContainEqual({ type: 'Interrupt' });
    expect(events).toEqual([
      { type: 'audio', generationId: 'g1', bytes: audio(1) },
      { type: 'audio', generationId: 'g2', bytes: audio(4) },
      { type: 'done', generationId: 'g2' },
    ]);
  });

  it('starting a new generation cancels the one in progress', async () => {
    const { session, socket } = await openTts();
    session.speak('g1', 'First.');
    session.speak('g2', 'Second.');
    expect(socket.jsonSent()).toEqual([
      { type: 'Speak', text: 'First.' },
      { type: 'Interrupt' },
      { type: 'Speak', text: 'Second.' },
    ]);
  });

  // Routing no longer depends on warnings: an Interrupt Flux cannot honour is one it never
  // acknowledges, and the ack timeout is what drops that session.
  it('drops the connection when the provider cannot honour an interrupt', async () => {
    const timers: (() => void)[] = [];
    const factory = fakeSocketFactory();
    const events: TtsEvent[] = [];
    const tts = createDeepgramTts({
      apiKey: KEY,
      model: 'flux-haley-en',
      socketFactory: factory,
      setInterval: () => () => undefined,
      setTimeout: (callback) => {
        timers.push(callback);
        return () => timers.splice(timers.indexOf(callback), 1);
      },
    });
    const session = await tts.open((e) => events.push(e), signal());
    const socket = factory.sockets[0]!;
    session.speak('g1', 'Hi.');
    session.cancel('g1');
    socket.receive({ type: 'Warning', code: 'NO_AUDIO_GENERATED' });
    expect(socket.closedWith).toBeUndefined();
    expect(timers).toHaveLength(1);
    timers[0]!();
    expect(socket.closedWith).toBe(1011);
    expect(events).toEqual([
      { type: 'error', error: { code: 'provider_error', recoverable: true } },
    ]);
  });

  it('ignores cancel and flush for generations that are not active', async () => {
    const { session, socket } = await openTts();
    session.cancel('nope');
    session.flush('nope');
    expect(socket.sent).toEqual([]);
  });

  it('pings to stay alive and stops on close', async () => {
    const { session, socket, ticks } = await openTts();
    ticks[0]!();
    expect(socket.pings).toBe(1);
    await session.close();
    expect(ticks).toEqual([]);
    expect(socket.closedWith).toBe(1000);
  });

  it('reports an unexpected close with the generation that was cut off', async () => {
    const { session, socket, events } = await openTts();
    session.speak('g1', 'Hi.');
    socket.drop(1006);
    expect(events).toEqual([
      { type: 'error', generationId: 'g1', error: { code: 'connection_lost', recoverable: true } },
    ]);
  });
});

describe('Deepgram Flux TTS speech_id tracking (verifier, second pass)', () => {
  const audio = (n: number) => new Uint8Array([n, n]);

  it('SpeechStarted with no speech_id, then an interrupt: the next turn completes normally', async () => {
    const { session, socket, events } = await openTts();
    session.speak('g1', 'A.');
    socket.receive({ type: 'SpeechStarted' });
    session.cancel('g1');
    socket.receive({ type: 'SpeechInterrupted' });
    session.speak('g2', 'B.');
    session.flush('g2');
    socket.receive({ type: 'SpeechStarted' });
    socket.receive(audio(2));
    socket.receive({ type: 'SpeechMetadata' });
    expect(events).toEqual([
      { type: 'audio', generationId: 'g2', bytes: audio(2) },
      { type: 'done', generationId: 'g2' },
    ]);
  });

  it('a malformed speech_id is treated as absent, not a protocol error', async () => {
    const { session, socket, events } = await openTts();
    session.speak('g1', 'A.');
    session.flush('g1');
    socket.receive({ type: 'SpeechStarted', speech_id: 42 });
    socket.receive(audio(1));
    socket.receive({ type: 'SpeechMetadata', speech_id: { nested: true } });
    expect(socket.closedWith).toBeUndefined();
    expect(events).toEqual([
      { type: 'audio', generationId: 'g1', bytes: audio(1) },
      { type: 'done', generationId: 'g1' },
    ]);
  });

  it('metadata for the interrupted turn arriving before SpeechInterrupted ends the discard only', async () => {
    const { session, socket, events } = await openTts();
    session.speak('g1', 'Long.');
    socket.receive({ type: 'SpeechStarted', speech_id: 's1' });
    session.cancel('g1');
    session.speak('g2', 'Next.');
    session.flush('g2');
    socket.receive({ type: 'SpeechMetadata', speech_id: 's1' }); // raced the Interrupt
    socket.receive({ type: 'Warning', code: 'NOTHING_TO_INTERRUPT' });
    socket.receive({ type: 'SpeechStarted', speech_id: 's2' });
    socket.receive(audio(2));
    socket.receive({ type: 'SpeechMetadata', speech_id: 's2' });
    expect(socket.closedWith).toBeUndefined();
    expect(events).toEqual([
      { type: 'audio', generationId: 'g2', bytes: audio(2) },
      { type: 'done', generationId: 'g2' },
    ]);
  });

  // Barge-in lands before Flux's SpeechStarted for the cut turn has reached the gateway (within one
  // round trip of the first Speak). That late SpeechStarted is then taken as the NEXT generation's
  // speech_id, so metadata for the interrupted turn completes the next generation early and its
  // real audio is dropped as stray bytes.
  it('interrupt before SpeechStarted: the late SpeechStarted is not adopted by the next turn', async () => {
    const { session, socket, events } = await openTts();
    session.speak('g1', 'A long answer.');
    session.cancel('g1'); // no SpeechStarted seen yet
    session.speak('g2', 'Okay.');
    session.flush('g2');
    socket.receive({ type: 'SpeechStarted', speech_id: 's1' }); // late, for the cut turn
    socket.receive({ type: 'SpeechInterrupted', speech_id: 's1' });
    socket.receive({ type: 'SpeechMetadata', speech_id: 's1' }); // for the cut turn
    socket.receive({ type: 'SpeechStarted', speech_id: 's2' });
    socket.receive(audio(2));
    socket.receive({ type: 'SpeechMetadata', speech_id: 's2' });
    expect(events).toEqual([
      { type: 'audio', generationId: 'g2', bytes: audio(2) },
      { type: 'done', generationId: 'g2' },
    ]);
  });

  // Two cancels before the first SpeechInterrupted arrives (e.g. a supersede, a fast agent's next
  // answer, then a barge-in on it). The first SpeechInterrupted ends the discard while the second
  // Interrupt is still unconfirmed, so the second cut turn's in-flight audio plays as the third's.
  it('two interrupts in a row: audio from the second cut turn is never delivered', async () => {
    const { session, socket, events } = await openTts();
    session.speak('g1', 'First.');
    socket.receive({ type: 'SpeechStarted', speech_id: 's1' });
    session.cancel('g1');
    session.speak('g2', 'Second.');
    session.cancel('g2'); // before Flux answered either Interrupt
    session.speak('g3', 'Third.');
    session.flush('g3');
    socket.receive({ type: 'SpeechInterrupted', speech_id: 's1' });
    socket.receive({ type: 'SpeechStarted', speech_id: 's2' });
    socket.receive(audio(2)); // the second cut turn's audio, in flight
    socket.receive({ type: 'SpeechInterrupted', speech_id: 's2' });
    socket.receive({ type: 'SpeechStarted', speech_id: 's3' });
    socket.receive(audio(3));
    socket.receive({ type: 'SpeechMetadata', speech_id: 's3' });
    expect(events).toEqual([
      { type: 'audio', generationId: 'g3', bytes: audio(3) },
      { type: 'done', generationId: 'g3' },
    ]);
  });
});

describe('Deepgram Flux TTS interrupt acknowledgement', () => {
  async function openWithTimers() {
    const factory = fakeSocketFactory();
    const events: TtsEvent[] = [];
    const timers: { callback: () => void; ms: number; cleared: boolean }[] = [];
    const tts = createDeepgramTts({
      apiKey: KEY,
      model: 'flux-haley-en',
      socketFactory: factory,
      setInterval: () => () => undefined,
      setTimeout: (callback, ms) => {
        const timer = { callback, ms, cleared: false };
        timers.push(timer);
        return () => {
          timer.cleared = true;
        };
      },
    });
    const session = await tts.open((e) => events.push(e), signal());
    const live = () => timers.filter((t) => !t.cleared);
    return { session, socket: factory.sockets[0]!, events, live };
  }

  it('an Interrupt never acknowledged fails the session instead of discarding forever', async () => {
    const { session, socket, events, live } = await openWithTimers();
    session.speak('g1', 'Hi.');
    session.cancel('g1');
    session.speak('g2', 'Next.');
    expect(live().map((t) => t.ms)).toEqual([INTERRUPT_ACK_TIMEOUT_MS]);
    live()[0]!.callback();
    expect(socket.closedWith).toBe(1011);
    expect(events).toEqual([
      { type: 'error', generationId: 'g2', error: { code: 'provider_error', recoverable: true } },
    ]);
  });

  it('an acknowledged Interrupt clears the timer', async () => {
    const { session, socket, live } = await openWithTimers();
    session.speak('g1', 'Hi.');
    session.cancel('g1');
    socket.receive({ type: 'SpeechInterrupted' });
    expect(live()).toEqual([]);
    expect(socket.closedWith).toBeUndefined();
  });
});

describe('Deepgram Flux TTS interrupt counting, third pass (verifier)', () => {
  const audio = (n: number) => new Uint8Array([n, n]);

  async function openCounted() {
    const factory = fakeSocketFactory();
    const events: TtsEvent[] = [];
    const timers: { callback: () => void; ms: number; cleared: boolean }[] = [];
    let onEvent: (e: TtsEvent) => void = (e) => events.push(e);
    const tts = createDeepgramTts({
      apiKey: KEY,
      model: 'flux-haley-en',
      socketFactory: factory,
      setInterval: () => () => undefined,
      setTimeout: (callback, ms) => {
        const timer = {
          callback: () => {
            timer.cleared = true; // a fired timer is no longer live
            callback();
          },
          ms,
          cleared: false,
        };
        timers.push(timer);
        return () => {
          timer.cleared = true;
        };
      },
    });
    const session = await tts.open((e) => onEvent(e), signal());
    const live = () => timers.filter((t) => !t.cleared);
    const setHandler = (handler: (e: TtsEvent) => void) => {
      onEvent = handler;
    };
    return { session, socket: factory.sockets[0]!, events, live, setHandler };
  }

  // --- Confirmed failures -------------------------------------------------------------------

  // The existing suite models SpeechInterrupted WITHOUT a speech_id, and the session's own comment
  // says Flux may also send SpeechMetadata (with the cut turn's speech_id) after it. Those are two
  // acknowledgements of ONE Interrupt: the id-less one decrements, and the metadata decrements again
  // because its id was never recorded as acknowledged. With a second Interrupt outstanding, the
  // count hits 0 early: the second cut turn is adopted as the third generation, its audio plays as
  // the third answer, and its metadata completes the third generation.
  it('SpeechInterrupted (no id) + SpeechMetadata (id) for one cut turn count once, with two interrupts pending', async () => {
    const { session, socket, events } = await openCounted();
    session.speak('g1', 'First.');
    socket.receive({ type: 'SpeechStarted', speech_id: 's1' });
    session.cancel('g1');
    session.speak('g2', 'Second.');
    session.cancel('g2');
    session.speak('g3', 'Third.');
    session.flush('g3');
    socket.receive({ type: 'SpeechInterrupted' }); // acks Interrupt #1
    socket.receive({ type: 'SpeechMetadata', speech_id: 's1' }); // same cut turn, confirmed again
    socket.receive({ type: 'SpeechStarted', speech_id: 's2' }); // the second cut turn
    socket.receive(audio(2));
    socket.receive({ type: 'SpeechInterrupted' }); // acks Interrupt #2
    socket.receive({ type: 'SpeechMetadata', speech_id: 's2' });
    socket.receive({ type: 'SpeechStarted', speech_id: 's3' });
    socket.receive(audio(3));
    socket.receive({ type: 'SpeechMetadata', speech_id: 's3' });
    expect(events).toEqual([
      { type: 'audio', generationId: 'g3', bytes: audio(3) },
      { type: 'done', generationId: 'g3' },
    ]);
  });

  // Same double count, from the race the second pass already accepted: the cut turn's metadata was
  // in flight when the Interrupt was sent (it settles the Interrupt), and Flux then answers that
  // same Interrupt with NOTHING_TO_INTERRUPT (settling it a second time). If another Interrupt went
  // out in between, that Warning consumes it, and the second cut turn's audio plays as the third's.
  it('metadata racing an Interrupt plus its NOTHING_TO_INTERRUPT settle one Interrupt, not two', async () => {
    const { session, socket, events } = await openCounted();
    session.speak('g1', 'Short.');
    session.flush('g1');
    socket.receive({ type: 'SpeechStarted', speech_id: 's1' });
    session.cancel('g1'); // Flux already finished s1: metadata in flight
    socket.receive({ type: 'SpeechMetadata', speech_id: 's1' }); // settles Interrupt #1
    session.speak('g2', 'Second.');
    session.cancel('g2'); // Interrupt #2
    session.speak('g3', 'Third.');
    session.flush('g3');
    socket.receive({ type: 'Warning', code: 'NOTHING_TO_INTERRUPT' }); // Flux's reply to Interrupt #1
    socket.receive({ type: 'SpeechStarted', speech_id: 's2' });
    socket.receive(audio(2)); // g2's audio, before Flux reaches Interrupt #2
    socket.receive({ type: 'SpeechInterrupted', speech_id: 's2' });
    socket.receive({ type: 'SpeechStarted', speech_id: 's3' });
    socket.receive(audio(3));
    socket.receive({ type: 'SpeechMetadata', speech_id: 's3' });
    expect(events).toEqual([
      { type: 'audio', generationId: 'g3', bytes: audio(3) },
      { type: 'done', generationId: 'g3' },
    ]);
  });

  // No speech_ids at all (the protocol shape the first "no speech_id" test models), and Flux sends
  // both SpeechInterrupted and the cut turn's SpeechMetadata: the metadata completes the NEXT
  // generation before any of its audio, and that audio is then dropped.
  it('without speech_ids, the cut turn metadata after SpeechInterrupted does not complete the next turn', async () => {
    const { session, socket, events } = await openCounted();
    session.speak('g1', 'Long.');
    socket.receive({ type: 'SpeechStarted' });
    session.cancel('g1');
    session.speak('g2', 'Next.');
    session.flush('g2');
    socket.receive({ type: 'SpeechInterrupted' });
    socket.receive({ type: 'SpeechMetadata' }); // for the cut turn
    socket.receive({ type: 'SpeechStarted' });
    socket.receive(audio(2));
    socket.receive({ type: 'SpeechMetadata' });
    expect(events).toEqual([
      { type: 'audio', generationId: 'g2', bytes: audio(2) },
      { type: 'done', generationId: 'g2' },
    ]);
  });

  // INTERRUPT_ACK_TIMEOUT_MS exists for an Interrupt Flux never acknowledges. But while one is
  // unacknowledged, the NEXT generation's own turn is marked interrupted: its audio is dropped and
  // its SpeechMetadata is taken as the missing acknowledgement, which clears the timer. The next
  // answer is silently lost and never reports done or error: the safety net never fires.
  it('an unacknowledged Interrupt does not silently swallow the next answer and disarm its own timer', async () => {
    const { session, socket, events, live } = await openCounted();
    session.speak('g1', 'Hi.');
    socket.receive({ type: 'SpeechStarted', speech_id: 's1' });
    session.cancel('g1'); // Flux never answers this Interrupt
    session.speak('g2', 'Next.');
    session.flush('g2');
    socket.receive({ type: 'SpeechStarted', speech_id: 's2' });
    socket.receive(audio(2));
    socket.receive({ type: 'SpeechMetadata', speech_id: 's2' }); // within 2 s: short answer
    // Either the answer is delivered, or the session is failed (reconnect); never neither.
    const delivered = events.some((e) => e.type === 'done' && e.generationId === 'g2');
    const failed = events.some((e) => e.type === 'error') || live().length > 0;
    expect(delivered || failed).toBe(true);
  });

  // The task's question: a new generation's own SpeechStarted arriving while an older Interrupt is
  // still pending (Flux acknowledging after it had started the next turn). The new turn is marked
  // interrupted; its audio after the late ack plays, but its metadata is then consumed as an ack
  // and it never completes. No timer is left to recover it.
  it("a late ack after the next turn's SpeechStarted: the next turn still completes", async () => {
    const { session, socket, events, live } = await openCounted();
    session.speak('g1', 'Hi.');
    socket.receive({ type: 'SpeechStarted', speech_id: 's1' });
    session.cancel('g1');
    session.speak('g2', 'Next.');
    session.flush('g2');
    socket.receive({ type: 'SpeechStarted', speech_id: 's2' }); // before the ack
    socket.receive({ type: 'SpeechInterrupted', speech_id: 's1' }); // late ack
    socket.receive(audio(2));
    socket.receive({ type: 'SpeechMetadata', speech_id: 's2' });
    expect(live()).toEqual([]);
    expect(events).toEqual([
      { type: 'audio', generationId: 'g2', bytes: audio(2) },
      { type: 'done', generationId: 'g2' },
    ]);
  });

  // After close(), the session still reacts to late socket messages: an Interrupt still pending at
  // close plus a late Warning emits an error event after close.
  it('reports nothing after close, even for a late Warning while an Interrupt was pending', async () => {
    const { session, socket, events, live } = await openCounted();
    session.speak('g1', 'Hi.');
    session.cancel('g1');
    await session.close();
    socket.receive({ type: 'Warning', code: 'SOMETHING_ELSE' });
    socket.receive({ type: 'Error', description: 'late' });
    expect(events).toEqual([]);
    expect(live()).toEqual([]);
  });

  // The socket drops mid-generation; the consumer (the pipeline) reacts to the error by cancelling
  // the generation it names. That re-arms the ack timer on the dead session (cleared just before the
  // event was emitted), and 2 s later a second error is reported for the same dead session.
  it('a cancel from inside the close error handler leaves no ack timer on the dead session', async () => {
    const { session, socket, events, live, setHandler } = await openCounted();
    setHandler((e) => {
      events.push(e);
      if (e.type === 'error' && e.generationId !== undefined) session.cancel(e.generationId);
    });
    session.speak('g1', 'Hi.');
    socket.drop(1006);
    expect.soft(live()).toEqual([]);
    for (const t of live()) t.callback();
    expect(events).toHaveLength(1);
  });

  // --- Cases that hold -------------------------------------------------------------------------

  it('SpeechInterrupted and SpeechMetadata with the same id count once (two interrupts pending)', async () => {
    const { session, socket, events, live } = await openCounted();
    session.speak('g1', 'First.');
    socket.receive({ type: 'SpeechStarted', speech_id: 's1' });
    session.cancel('g1');
    session.speak('g2', 'Second.');
    session.cancel('g2');
    session.speak('g3', 'Third.');
    session.flush('g3');
    socket.receive({ type: 'SpeechInterrupted', speech_id: 's1' });
    socket.receive({ type: 'SpeechMetadata', speech_id: 's1' });
    socket.receive({ type: 'SpeechStarted', speech_id: 's2' });
    socket.receive(audio(2));
    socket.receive({ type: 'SpeechMetadata', speech_id: 's2' }); // ack by metadata only
    socket.receive({ type: 'SpeechInterrupted', speech_id: 's2' }); // and again: not counted
    socket.receive({ type: 'SpeechStarted', speech_id: 's3' });
    socket.receive(audio(3));
    socket.receive({ type: 'SpeechMetadata', speech_id: 's3' });
    expect(live()).toEqual([]);
    expect(events).toEqual([
      { type: 'audio', generationId: 'g3', bytes: audio(3) },
      { type: 'done', generationId: 'g3' },
    ]);
  });

  it('three interrupts in a row, each confirmed by SpeechInterrupted then SpeechMetadata', async () => {
    const { session, socket, events, live } = await openCounted();
    session.speak('g1', 'One.');
    socket.receive({ type: 'SpeechStarted', speech_id: 's1' });
    session.cancel('g1');
    session.speak('g2', 'Two.');
    session.cancel('g2');
    session.speak('g3', 'Three.');
    session.cancel('g3');
    session.speak('g4', 'Four.');
    session.flush('g4');
    expect(live()).toHaveLength(1);
    for (const id of ['s1', 's2', 's3']) {
      if (id !== 's1') socket.receive({ type: 'SpeechStarted', speech_id: id });
      socket.receive(audio(9));
      socket.receive({ type: 'SpeechInterrupted', speech_id: id });
      socket.receive({ type: 'SpeechMetadata', speech_id: id });
    }
    socket.receive({ type: 'SpeechStarted', speech_id: 's4' });
    socket.receive(audio(4));
    socket.receive({ type: 'SpeechMetadata', speech_id: 's4' });
    expect(live()).toEqual([]);
    expect(socket.closedWith).toBeUndefined();
    expect(events).toEqual([
      { type: 'audio', generationId: 'g4', bytes: audio(4) },
      { type: 'done', generationId: 'g4' },
    ]);
  });

  it('three interrupts in a row confirmed by SpeechInterrupted only, no speech_ids', async () => {
    const { session, socket, events, live } = await openCounted();
    session.speak('g1', 'One.');
    session.cancel('g1');
    session.speak('g2', 'Two.');
    session.cancel('g2');
    session.speak('g3', 'Three.');
    session.cancel('g3');
    session.speak('g4', 'Four.');
    session.flush('g4');
    for (let i = 0; i < 3; i += 1) {
      socket.receive({ type: 'SpeechStarted' });
      socket.receive(audio(9));
      socket.receive({ type: 'SpeechInterrupted' });
    }
    socket.receive({ type: 'SpeechStarted' });
    socket.receive(audio(4));
    socket.receive({ type: 'SpeechMetadata' });
    expect(live()).toEqual([]);
    expect(events).toEqual([
      { type: 'audio', generationId: 'g4', bytes: audio(4) },
      { type: 'done', generationId: 'g4' },
    ]);
  });

  it('cancel with nothing active sends no Interrupt and arms no timer', async () => {
    const { session, socket, live } = await openCounted();
    session.cancel('g1');
    session.speak('g1', 'Hi.');
    session.flush('g1');
    socket.receive({ type: 'SpeechStarted', speech_id: 's1' });
    socket.receive({ type: 'SpeechMetadata', speech_id: 's1' }); // done
    session.cancel('g1'); // already done
    expect(socket.jsonSent()).not.toContainEqual({ type: 'Interrupt' });
    expect(live()).toEqual([]);
  });

  it('extra acknowledgements with nothing pending never drive the count negative', async () => {
    const { session, socket, events, live } = await openCounted();
    socket.receive({ type: 'SpeechInterrupted' });
    socket.receive({ type: 'SpeechInterrupted', speech_id: 'x' });
    socket.receive({ type: 'Warning', code: 'NOTHING_TO_INTERRUPT' });
    session.speak('g1', 'Hi.');
    session.cancel('g1');
    session.speak('g2', 'Next.');
    session.flush('g2');
    socket.receive(audio(1)); // still before the ack: must be dropped
    socket.receive({ type: 'SpeechInterrupted' });
    socket.receive({ type: 'SpeechStarted', speech_id: 's2' });
    socket.receive(audio(2));
    socket.receive({ type: 'SpeechMetadata', speech_id: 's2' });
    expect(live()).toEqual([]);
    expect(events).toEqual([
      { type: 'audio', generationId: 'g2', bytes: audio(2) },
      { type: 'done', generationId: 'g2' },
    ]);
  });

  it('a Warning other than NOTHING_TO_INTERRUPT with nothing pending is ignored', async () => {
    const { session, socket, events } = await openCounted();
    session.speak('g1', 'Hi.');
    session.flush('g1');
    socket.receive({ type: 'SpeechStarted', speech_id: 's1' });
    socket.receive({ type: 'Warning', code: 'TEXT_TOO_LONG' });
    socket.receive(audio(1));
    socket.receive({ type: 'SpeechMetadata', speech_id: 's1' });
    expect(socket.closedWith).toBeUndefined();
    expect(events.map((e) => e.type)).toEqual(['audio', 'done']);
  });

  it('the ack timer restarts per acknowledgement and is cleared by close', async () => {
    const { session, socket, live } = await openCounted();
    session.speak('g1', 'A.');
    session.cancel('g1');
    session.speak('g2', 'B.');
    session.cancel('g2');
    expect(live()).toHaveLength(1);
    socket.receive({ type: 'SpeechInterrupted' });
    expect(live()).toHaveLength(1); // one still outstanding, fresh 2 s
    await session.close();
    expect(live()).toEqual([]);
  });

  it('the ack timeout fires once, closes 1011 and reports the active generation', async () => {
    const { session, socket, events, live } = await openCounted();
    session.speak('g1', 'A.');
    session.cancel('g1');
    session.speak('g2', 'B.');
    live()[0]!.callback();
    expect(live()).toEqual([]);
    expect(socket.closedWith).toBe(1011);
    socket.receive({ type: 'SpeechInterrupted' }); // too late
    expect(live()).toEqual([]);
    expect(events).toEqual([
      { type: 'error', generationId: 'g2', error: { code: 'provider_error', recoverable: true } },
    ]);
  });

  it('the interrupted-id list is bounded; an old id falling off does not break the next turn', async () => {
    const { session, socket, events, live } = await openCounted();
    for (let i = 1; i <= 12; i += 1) {
      session.speak(`g${i}`, 'x.');
      socket.receive({ type: 'SpeechStarted', speech_id: `s${i}` });
      session.cancel(`g${i}`);
      socket.receive({ type: 'SpeechInterrupted', speech_id: `s${i}` });
    }
    session.speak('g13', 'Final.');
    session.flush('g13');
    socket.receive({ type: 'SpeechStarted', speech_id: 's13' });
    socket.receive(audio(13));
    socket.receive({ type: 'SpeechMetadata', speech_id: 's13' });
    expect(live()).toEqual([]);
    expect(events).toEqual([
      { type: 'audio', generationId: 'g13', bytes: audio(13) },
      { type: 'done', generationId: 'g13' },
    ]);
  });
});

// Sequences replayed as Flux sent them (flux-haley-en, /v2/speak, 2026-09-26, captured with
// scripts/flux-tts-probe.ts): one SpeechStarted per turn in order, one SpeechInterrupted per
// Interrupt with the cut turn's id under `metadata`, and no SpeechMetadata for a cut turn.
describe('Deepgram Flux TTS observed interrupt protocol', () => {
  const audio = (n: number) => new Uint8Array([n, n]);
  const started = (id: string) => ({ type: 'SpeechStarted', speech_id: id });
  const flushed = (id: string) => ({ type: 'Flushed', speech_id: id });
  const cut = (id: string, playedMs: number) => ({
    type: 'SpeechInterrupted',
    audio_played_ms: playedMs,
    metadata: { speech_id: id, model_name: 'flux-haley-en' },
  });
  const finished = (id: string) => ({
    type: 'SpeechMetadata',
    speech_id: id,
    model_name: 'flux-haley-en',
    audio_duration_ms: 1200,
  });

  async function openTimed() {
    const factory = fakeSocketFactory();
    const events: TtsEvent[] = [];
    const timers: { callback: () => void; cleared: boolean }[] = [];
    const tts = createDeepgramTts({
      apiKey: KEY,
      model: 'flux-haley-en',
      socketFactory: factory,
      setInterval: () => () => undefined,
      setTimeout: (callback) => {
        const timer = { callback, cleared: false };
        timers.push(timer);
        return () => {
          timer.cleared = true;
        };
      },
    });
    const session = await tts.open((e) => events.push(e), signal());
    const live = () => timers.filter((t) => !t.cleared);
    return { session, socket: factory.sockets[0]!, events, live };
  }

  it('interrupt mid-audio, then a new turn', async () => {
    const { session, socket, events, live } = await openTimed();
    session.speak('g1', 'A long answer.');
    session.flush('g1');
    socket.receive(started('a1'));
    socket.receive(flushed('a1'));
    socket.receive(audio(1));
    session.cancel('g1');
    socket.receive(audio(2)); // the cut turn's, before its SpeechInterrupted
    session.speak('g2', 'Okay.');
    session.flush('g2');
    socket.receive(cut('a1', 180));
    socket.receive(started('a2'));
    socket.receive(flushed('a2'));
    socket.receive(audio(3));
    socket.receive(finished('a2'));
    expect(live()).toEqual([]);
    expect(events).toEqual([
      { type: 'audio', generationId: 'g1', bytes: audio(1) },
      { type: 'audio', generationId: 'g2', bytes: audio(3) },
      { type: 'done', generationId: 'g2' },
    ]);
  });

  it('interrupt before any audio: the cut turn still gets its SpeechStarted', async () => {
    const { session, socket, events, live } = await openTimed();
    session.speak('g1', 'Never heard.');
    session.cancel('g1'); // never flushed
    session.speak('g2', 'Heard.');
    session.flush('g2');
    socket.receive(started('b1'));
    socket.receive(flushed('b1'));
    socket.receive(cut('b1', 0));
    socket.receive(started('b2'));
    socket.receive(flushed('b2'));
    socket.receive(audio(2));
    socket.receive(finished('b2'));
    expect(live()).toEqual([]);
    expect(events).toEqual([
      { type: 'audio', generationId: 'g2', bytes: audio(2) },
      { type: 'done', generationId: 'g2' },
    ]);
  });

  it('two interrupts in a row', async () => {
    const { session, socket, events, live } = await openTimed();
    session.speak('g1', 'First.');
    session.flush('g1');
    socket.receive(started('c1'));
    socket.receive(flushed('c1'));
    socket.receive(audio(1));
    session.cancel('g1');
    session.speak('g2', 'Second.');
    session.flush('g2');
    session.cancel('g2');
    session.speak('g3', 'Third.');
    session.flush('g3');
    socket.receive(audio(9));
    socket.receive(cut('c1', 60));
    socket.receive(started('c2'));
    socket.receive(flushed('c2'));
    socket.receive(audio(9));
    socket.receive(cut('c2', 0));
    socket.receive(started('c3'));
    socket.receive(flushed('c3'));
    socket.receive(audio(3));
    socket.receive(finished('c3'));
    expect(live()).toEqual([]);
    expect(events).toEqual([
      { type: 'audio', generationId: 'g1', bytes: audio(1) },
      { type: 'audio', generationId: 'g3', bytes: audio(3) },
      { type: 'done', generationId: 'g3' },
    ]);
  });

  it('interrupt when nothing is playing: an ack naming the completed turn changes nothing', async () => {
    const { session, socket, events, live } = await openTimed();
    session.speak('g1', 'Done.');
    session.flush('g1');
    socket.receive(started('d1'));
    socket.receive(flushed('d1'));
    socket.receive(audio(1));
    socket.receive(finished('d1'));
    session.cancel('g1'); // already done: Twring sends no Interrupt
    expect(socket.jsonSent()).not.toContainEqual({ type: 'Interrupt' });
    socket.receive(cut('d1', 1200)); // what Flux answers to an Interrupt with nothing playing
    session.speak('g2', 'Next.');
    session.flush('g2');
    socket.receive(started('d2'));
    socket.receive(flushed('d2'));
    socket.receive(audio(2));
    socket.receive(finished('d2'));
    expect(live()).toEqual([]);
    expect(socket.closedWith).toBeUndefined();
    expect(events).toEqual([
      { type: 'audio', generationId: 'g1', bytes: audio(1) },
      { type: 'done', generationId: 'g1' },
      { type: 'audio', generationId: 'g2', bytes: audio(2) },
      { type: 'done', generationId: 'g2' },
    ]);
  });
});
