/**
 * Speaks sentences with Indian place names through Deepgram TTS, then streams that audio through
 * Flux STT with and without the names as keyterms, printing both transcripts side by side:
 *
 *   pnpm --filter @twring/gateway exec tsx --env-file-if-exists=.env scripts/keyterm-probe.ts
 *
 * Synthetic speech is cleaner than a caller on a phone, so this shows whether keyterms reach Flux
 * and bias it, not how much they help on real calls. Uses Deepgram TTS and STT usage.
 */
import { deepgramConfig, loadGatewayEnv } from '@twring/config/gateway';

import { createDeepgramStt } from '../src/voice/deepgram-stt';

const KEYTERMS = ['Chennai', 'Coimbatore', 'Thiruvananthapuram', 'Madurai', 'Tiruchirappalli'];
const SENTENCES = [
  'Book me a train from Chennai to Coimbatore on Friday.',
  'How far is Thiruvananthapuram from Madurai by road?',
  'Remind me to call my aunt in Tiruchirappalli tomorrow.',
  'Is it raining in Chennai right now?',
];
const TTS_MODELS = (process.env.PROBE_TTS_MODELS ?? 'aura-2-thalia-en,aura-2-arcas-en').split(',');
const SAMPLE_RATE = 16_000;

const deepgram = deepgramConfig(loadGatewayEnv({ ...process.env, LOG_LEVEL: 'warn' }));
if (deepgram === undefined) {
  console.error('needs DEEPGRAM_API_KEY');
  process.exit(2);
}
const apiKey = deepgram.apiKey;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function speak(text: string, model: string): Promise<Int16Array> {
  const url = new URL('https://api.deepgram.com/v1/speak');
  url.searchParams.set('model', model);
  url.searchParams.set('encoding', 'linear16');
  url.searchParams.set('sample_rate', String(SAMPLE_RATE));
  url.searchParams.set('container', 'none');
  const response = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Token ${apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({ text }),
  });
  if (!response.ok) throw new Error(`TTS ${model} answered ${response.status}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  return new Int16Array(bytes.buffer, 0, Math.floor(bytes.byteLength / 2));
}

async function transcribe(audio: Int16Array, keyterms: readonly string[]): Promise<string> {
  const turns: string[] = [];
  const stt = createDeepgramStt({ apiKey, model: deepgram!.sttModel, keyterms });
  const session = await stt.open((event) => {
    if (event.type === 'turn_ended') turns.push(event.text);
    if (event.type === 'error') turns.push(`<error ${event.error.code}>`);
  }, AbortSignal.timeout(10_000));
  const chunk = 320; // 20 ms, streamed in real time: turn detection depends on timing
  const start = performance.now();
  for (let i = 0, n = 0; i < audio.length; i += chunk, n += 1) {
    session.sendAudio(audio.subarray(i, i + chunk));
    const wait = start + (n + 1) * 20 - performance.now();
    if (wait > 0) await sleep(wait);
  }
  for (let n = 0; n < 100 && turns.length === 0; n += 1) {
    session.sendAudio(new Int16Array(chunk));
    await sleep(20);
  }
  await session.close();
  return turns.join(' | ');
}

let without = 0;
let withTerms = 0;
const hits = (text: string, sentence: string) =>
  KEYTERMS.filter((t) => sentence.includes(t) && text.toLowerCase().includes(t.toLowerCase()))
    .length;
const expected = (sentence: string) => KEYTERMS.filter((t) => sentence.includes(t)).length;
let total = 0;

for (const model of TTS_MODELS) {
  for (const sentence of SENTENCES) {
    const audio = await speak(sentence, model);
    const [plain, biased] = await Promise.all([transcribe(audio, []), transcribe(audio, KEYTERMS)]);
    total += expected(sentence);
    without += hits(plain, sentence);
    withTerms += hits(biased, sentence);
    console.log(`\n[${model}] ${sentence}`);
    console.log(`  without keyterms: ${plain}`);
    console.log(`  with keyterms:    ${biased}`);
  }
}
console.log(`\nplace names recognised: without ${without}/${total}, with ${withTerms}/${total}`);
