/**
 * Compares TTS time to first audio for Deepgram Flux TTS and Cartesia Sonic (ADR-020), through the
 * same provider adapters a call uses:
 *
 *   pnpm --filter @twring/gateway exec tsx --env-file-if-exists=.env scripts/tts-latency-probe.ts [runs]
 *
 * Each provider speaks the same five sentences `runs` times (default 3), streamed in two parts and
 * then flushed, one session per provider. Reports time to first audio byte and total time (p50/p90),
 * then an interrupt test: cancel after 500 ms, start a new generation, and count any audio from the
 * cancelled one (must be 0). Uses a little TTS usage on both accounts. Never prints keys.
 */
import { cartesiaConfig, deepgramConfig, loadGatewayEnv } from '@twring/config/gateway';

import { CARTESIA_VOICES, cartesiaVoice } from '../src/agents/voices';
import { createCartesiaTts } from '../src/voice/cartesia-tts';
import { createDeepgramTts } from '../src/voice/deepgram-tts';
import type { TtsEvent, TtsProvider, TtsSession } from '../src/voice/types';

const env = loadGatewayEnv({ ...process.env, LOG_LEVEL: 'warn' });
const deepgram = deepgramConfig(env);
const cartesia = cartesiaConfig(env);
if (deepgram === undefined) {
  console.error('Set DEEPGRAM_API_KEY in apps/gateway/.env');
  process.exit(2);
}
if (cartesia === undefined) {
  console.error('Set CARTESIA_API_KEY in apps/gateway/.env to compare against Cartesia');
  process.exit(2);
}

const RUNS = Math.max(1, Number(process.argv[2] ?? 3) || 3);
const SENTENCES = [
  'Sure, I can help with that.',
  'Your appointment is booked for Thursday at four thirty in the afternoon.',
  'I found three flights from Bengaluru to Chennai tomorrow morning.',
  'The last payment went through, and the next one is due on the fifteenth.',
  'Give me a second while I check the latest numbers for you.',
];
const LONG =
  'This is a long answer that keeps going so there is plenty of audio to interrupt part way through, and then it keeps going some more, and more.';

const indian = CARTESIA_VOICES.find((v) => v.label.endsWith('· Indian'))!;
const american = CARTESIA_VOICES.find((v) => v.label.endsWith('· American'))!;
const cartesiaFor = (id: string) =>
  createCartesiaTts({
    apiKey: cartesia.apiKey,
    model: cartesia.ttsModel,
    voice: cartesiaVoice(id)!,
  });
const providers: { name: string; tts: TtsProvider }[] = [
  {
    name: `deepgram ${deepgram.ttsModel}`,
    tts: createDeepgramTts({ apiKey: deepgram.apiKey, model: deepgram.ttsModel }),
  },
  { name: `cartesia ${indian.label}`, tts: cartesiaFor(indian.id) },
  { name: `cartesia ${american.label}`, tts: cartesiaFor(american.id) },
];

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** One session whose events are routed to per-generation waiters. */
async function open(tts: TtsProvider) {
  const listeners = new Set<(event: TtsEvent) => void>();
  const session: TtsSession = await tts.open(
    (event) => listeners.forEach((l) => l(event)),
    AbortSignal.timeout(10 * 60_000),
  );
  return { session, listeners };
}

async function measure(
  opened: Awaited<ReturnType<typeof open>>,
  id: string,
  text: string,
): Promise<{ first: number; total: number }> {
  const start = performance.now();
  let first = -1;
  const finished = new Promise<void>((resolve, reject) => {
    const listener = (event: TtsEvent) => {
      if (event.type === 'error') reject(new Error(`tts error ${event.error.code}`));
      if ('generationId' in event && event.generationId !== id) return;
      if (event.type === 'audio' && first < 0) first = performance.now() - start;
      if (event.type === 'done') {
        opened.listeners.delete(listener);
        resolve();
      }
    };
    opened.listeners.add(listener);
  });
  const cut = text.indexOf(' ', Math.floor(text.length / 2));
  opened.session.speak(id, text.slice(0, cut));
  opened.session.speak(id, text.slice(cut));
  opened.session.flush(id);
  await finished;
  return { first, total: performance.now() - start };
}

function pct(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return Math.round(sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]!);
}

async function interruptTest(tts: TtsProvider): Promise<string> {
  const opened = await open(tts);
  let oldAudio = 0;
  let newAudio = 0;
  opened.listeners.add((event) => {
    if (event.type !== 'audio') return;
    if (event.generationId === 'old') oldAudio += event.bytes.byteLength;
    else newAudio += event.bytes.byteLength;
  });
  opened.session.speak('old', LONG);
  opened.session.flush('old');
  await sleep(500);
  const beforeCancel = oldAudio;
  opened.session.cancel('old');
  await measure(opened, 'new', 'Okay, stopping there.');
  await sleep(1500);
  await opened.session.close();
  const leaked = oldAudio - beforeCancel;
  return `old audio after cancel: ${leaked} bytes ${leaked === 0 ? '(ok)' : '(LEAK)'}; new audio ${newAudio} bytes`;
}

console.log(`${RUNS} run(s) x ${SENTENCES.length} sentences per provider\n`);
for (const { name, tts } of providers) {
  const opened = await open(tts);
  const firsts: number[] = [];
  const totals: number[] = [];
  for (let run = 0; run < RUNS; run += 1) {
    for (const [index, sentence] of SENTENCES.entries()) {
      const result = await measure(opened, `r${run}s${index}`, sentence);
      firsts.push(result.first);
      totals.push(result.total);
    }
  }
  await opened.session.close();
  console.log(
    `${name.padEnd(34)} first audio p50 ${pct(firsts, 50)} ms, p90 ${pct(firsts, 90)} ms; ` +
      `total p50 ${pct(totals, 50)} ms, p90 ${pct(totals, 90)} ms`,
  );
  console.log(`${''.padEnd(34)} interrupt: ${await interruptTest(tts)}`);
}
