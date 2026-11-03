import { pathToFileURL } from 'node:url';

import { checkSpeechKey } from './voice/key-check';

/**
 * The installer's speech key check: `node dist/check-speech-key.js` with the key in
 * `TWRING_SPEECH_KEY` and `TWRING_SPEECH_PROVIDER` set to `deepgram` or `xai`. The key comes only
 * from the environment (never an argument, so it stays out of process lists) and is never printed.
 *
 * Exit codes: 0 the key works, 2 the provider refused it, 3 the provider could not be reached,
 * 64 the provider or key is missing or unknown.
 */
export const EXIT_OK = 0;
export const EXIT_REFUSED = 2;
export const EXIT_UNAVAILABLE = 3;
export const EXIT_USAGE = 64;

const PROVIDERS = ['deepgram', 'xai'] as const;

export async function runCheckSpeechKey(
  env: Record<string, string | undefined>,
  deps: { fetch?: typeof fetch; out?: (text: string) => void } = {},
): Promise<number> {
  const out = deps.out ?? ((text: string) => process.stdout.write(`${text}\n`));
  const provider = PROVIDERS.find((name) => name === env.TWRING_SPEECH_PROVIDER);
  if (provider === undefined) {
    out('TWRING_SPEECH_PROVIDER must be deepgram or xai.');
    return EXIT_USAGE;
  }
  const key = env.TWRING_SPEECH_KEY?.trim();
  if (key === undefined || key === '') {
    out('TWRING_SPEECH_KEY is not set.');
    return EXIT_USAGE;
  }
  const result = await checkSpeechKey(provider, key, { fetch: deps.fetch });
  switch (result) {
    case 'ok':
      out(`The ${provider} key works.`);
      return EXIT_OK;
    case 'refused':
      out(`${provider} refused this key. Check it and try again.`);
      return EXIT_REFUSED;
    case 'unavailable':
      out(`${provider} could not be reached. Try again in a minute.`);
      return EXIT_UNAVAILABLE;
    default: {
      const unreachable: never = result;
      throw new Error(`unknown key check result: ${String(unreachable)}`);
    }
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await runCheckSpeechKey(process.env);
}
