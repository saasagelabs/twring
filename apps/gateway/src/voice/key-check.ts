import type { SpeechProvider } from '@twring/contracts';
import { CARTESIA_API_VERSION } from './cartesia-tts.js';
import { isKeyRefusal } from './key-refusal.js';

export type KeyCheckResult = 'ok' | 'refused' | 'unavailable';

const DEFAULT_TIMEOUT_MS = 5000;

function requestFor(
  provider: SpeechProvider,
  key: string,
): { url: string; headers: Record<string, string> } {
  switch (provider) {
    case 'deepgram':
      return {
        url: 'https://api.deepgram.com/v1/projects',
        headers: { Authorization: `Token ${key}` },
      };
    case 'cartesia':
      return {
        url: 'https://api.cartesia.ai/voices?limit=1',
        headers: { 'X-API-Key': key, 'Cartesia-Version': CARTESIA_API_VERSION },
      };
    case 'xai':
      return {
        url: 'https://api.x.ai/v1/tts/voices',
        headers: { Authorization: `Bearer ${key}` },
      };
    default: {
      // A new provider must fail to compile here, never fall into another provider's host.
      const unreachable: never = provider;
      throw new Error(`unknown speech provider: ${String(unreachable)}`);
    }
  }
}

/**
 * Asks the provider whether a person's own key works. Only the fixed provider hosts are
 * contacted and redirects are refused, so the key cannot be sent anywhere else. Never throws
 * and never carries the key in its result.
 */
export async function checkSpeechKey(
  provider: SpeechProvider,
  key: string,
  options: { fetch?: typeof fetch; timeoutMs?: number } = {},
): Promise<KeyCheckResult> {
  const doFetch = options.fetch ?? fetch;
  const request = requestFor(provider, key);
  try {
    const response = await doFetch(request.url, {
      method: 'GET',
      headers: request.headers,
      redirect: 'error',
      signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });
    if (response.ok) return 'ok';
    if (isKeyRefusal(response.status)) return 'refused';
    return 'unavailable';
  } catch {
    return 'unavailable';
  }
}
