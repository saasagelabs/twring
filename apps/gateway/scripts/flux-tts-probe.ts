/**
 * Records the exact message sequence Deepgram Flux TTS sends around interrupts, so the TTS session
 * logic is built on observed behaviour rather than guesses:
 *
 *   pnpm --filter @twring/gateway exec tsx --env-file-if-exists=.env scripts/flux-tts-probe.ts
 *
 * Scenarios: interrupt mid-audio; interrupt before any audio; two interrupts in a row; interrupt
 * with nothing playing. Prints one line per message (audio aggregated). Uses a little TTS usage.
 */
import WebSocket from 'ws';

import { deepgramConfig, loadGatewayEnv } from '@twring/config/gateway';

const deepgram = deepgramConfig(loadGatewayEnv({ ...process.env, LOG_LEVEL: 'warn' }));
if (deepgram === undefined) {
  console.error('Set DEEPGRAM_API_KEY in apps/gateway/.env');
  process.exit(2);
}

const LONG =
  'This is a long sentence that keeps going so there is plenty of audio to interrupt part way through, and then it keeps going some more.';
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function scenario(name: string, steps: (send: (m: object) => void) => Promise<void>) {
  const url = `wss://api.deepgram.com/v2/speak?model=${deepgram!.ttsModel}&encoding=linear16&sample_rate=48000`;
  const ws = new WebSocket(url, { headers: { Authorization: `Token ${deepgram!.apiKey}` } });
  const start = performance.now();
  const t = () => String(Math.round(performance.now() - start)).padStart(5);
  let audioBytes = 0;
  const flushAudio = () => {
    if (audioBytes > 0) console.log(`${t()}  <- audio ${audioBytes} bytes`);
    audioBytes = 0;
  };
  ws.on('message', (data, isBinary) => {
    if (isBinary) {
      audioBytes += (data as Buffer).length;
      return;
    }
    flushAudio();
    console.log(`${t()}  <- ${(data as Buffer).toString('utf8')}`);
  });
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', reject);
  });
  console.log(`\n=== ${name}`);
  const send = (message: object) => {
    flushAudio();
    console.log(`${t()}  -> ${JSON.stringify(message)}`);
    ws.send(JSON.stringify(message));
  };
  await steps(send);
  await sleep(2500);
  flushAudio();
  ws.close(1000);
  await sleep(200);
}

await scenario('interrupt mid-audio, then a new turn', async (send) => {
  send({ type: 'Speak', text: LONG });
  send({ type: 'Flush' });
  await sleep(900);
  send({ type: 'Interrupt' });
  send({ type: 'Speak', text: 'Second answer.' });
  send({ type: 'Flush' });
});

await scenario('interrupt before any audio, then a new turn', (send) => {
  send({ type: 'Speak', text: LONG });
  send({ type: 'Flush' });
  send({ type: 'Interrupt' });
  send({ type: 'Speak', text: 'Second answer.' });
  send({ type: 'Flush' });
  return Promise.resolve();
});

await scenario('two interrupts in a row', async (send) => {
  send({ type: 'Speak', text: LONG });
  send({ type: 'Flush' });
  await sleep(700);
  send({ type: 'Interrupt' });
  send({ type: 'Speak', text: 'Second answer that will also be cut short before it finishes.' });
  send({ type: 'Flush' });
  await sleep(150);
  send({ type: 'Interrupt' });
  send({ type: 'Speak', text: 'Third answer.' });
  send({ type: 'Flush' });
});

await scenario('interrupt with nothing playing', async (send) => {
  send({ type: 'Speak', text: 'Short.' });
  send({ type: 'Flush' });
  await sleep(1500);
  send({ type: 'Interrupt' });
  send({ type: 'Speak', text: 'After.' });
  send({ type: 'Flush' });
});

await scenario('interrupt with no Flush (streaming text, unflushed)', async (send) => {
  send({ type: 'Speak', text: LONG });
  await sleep(1200);
  send({ type: 'Interrupt' });
  send({ type: 'Speak', text: 'Second answer.' });
  send({ type: 'Flush' });
});
