import { apiUrl, checkServerUrl, type ConnectorConfig } from '../config';
import { ensureDeviceKey } from './keys';

/**
 * `private reset` (C3 #11 P4a): this computer gets a new device key for private chats. The old
 * private key is gone once the new config is saved, so every phone must pair again; while this
 * computer is still linked, the old device is also removed on the server, so phones stop sealing
 * to it. Nothing here prints or logs a key.
 */
export interface ResetOutcome {
  config: ConnectorConfig;
  /** `removed`: the server dropped the old device; `none`: there was no old device. */
  server: 'removed' | 'none' | 'not_removed';
}

export async function resetPrivateKey(options: {
  config: ConnectorConfig;
  save: (config: ConnectorConfig) => Promise<void>;
  fetch: typeof fetch;
  signal?: AbortSignal;
}): Promise<ResetOutcome> {
  const old = options.config.e2e;
  const rest = { ...options.config };
  delete rest.e2e;
  const { config } = ensureDeviceKey(rest);
  // Saved first: a crash after this never leaves the old key trusted here.
  await options.save(config);
  if (old === undefined) return { config, server: 'none' };
  try {
    const res = await options.fetch(
      apiUrl(
        checkServerUrl(options.config.server),
        `/v1/e2e/computer/devices/${encodeURIComponent(old.device_id)}`,
      ),
      {
        method: 'DELETE',
        headers: { authorization: `Bearer ${options.config.token}` },
        ...(options.signal !== undefined && { signal: options.signal }),
      },
    );
    // 404: never listed (never paired) or already removed; either way it is gone.
    return { config, server: res.ok || res.status === 404 ? 'removed' : 'not_removed' };
  } catch {
    return { config, server: 'not_removed' };
  }
}

/** What `private reset` prints: plain next steps, no keys. */
export function resetLines(outcome: ResetOutcome['server'], cliName: string): string[] {
  const pair = `Pair your phone again: node ${cliName}.mjs private pair`;
  switch (outcome) {
    case 'removed':
    case 'none':
      return ['This computer has a new key for private chats.', pair];
    case 'not_removed':
      return [
        'This computer has a new key for private chats.',
        "Twring couldn't be reached to remove the old one. In the app, remove the old computer under Devices.",
        pair,
      ];
  }
}
