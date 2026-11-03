import { createDeepgramTts } from '../../src/voice/deepgram-tts';

/** Voices a caller's line with Deepgram TTS (the gateway's own client); returns 48 kHz samples. */
export async function voiceLine(
  deepgram: { apiKey: string; ttsModel: string },
  text: string,
): Promise<Int16Array> {
  const tts = createDeepgramTts({ apiKey: deepgram.apiKey, model: deepgram.ttsModel });
  const chunks: Uint8Array[] = [];
  let finish!: () => void;
  const done = new Promise<void>((resolve) => (finish = resolve));
  const session = await tts.open((event) => {
    if (event.type === 'audio') chunks.push(event.bytes);
    else finish();
  }, AbortSignal.timeout(15_000));
  session.speak('caller', text);
  session.flush('caller');
  await done;
  await session.close();
  const bytes = Buffer.concat(chunks);
  return new Int16Array(bytes.buffer, bytes.byteOffset, bytes.length / 2);
}
