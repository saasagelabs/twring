import { base64urlEncode, deviceIdFor, generateSealKeyPair } from '@twring/contracts';

import type { ConnectorConfig } from '../config';
import { ensureDeviceKey, type E2eConfig, type TrustedDevice } from './keys';
import { ReplayWindow, type SealContext } from './sealed';

/** A paired computer's config, as `saveConfig` writes it, for tests. */
export const baseConfig: ConnectorConfig = {
  server: 'https://api.twring.com',
  connector_id: `con_${'a'.repeat(20)}`,
  token: `cct_${'a'.repeat(43)}`,
  name: 'Laptop',
  agents: [
    {
      id: 'claude-code',
      label: 'Claude Code',
      kind: 'claude-code',
      command: 'claude',
      args: [],
      cwd: '.',
    },
  ],
};

/** A computer paired to one phone (its keys returned), and an in-memory stand-in for the store. */
export function pairedFixture(agentId = 'claude-code'): {
  config: ConnectorConfig;
  phoneCtx: SealContext;
  store: (change: (current: E2eConfig) => E2eConfig) => Promise<E2eConfig | undefined>;
  e2e: () => E2eConfig;
} {
  const keys = generateSealKeyPair();
  const phone: TrustedDevice = {
    id: deviceIdFor(keys.publicKey),
    kind: 'phone',
    name: 'Pixel',
    public_key: base64urlEncode(keys.publicKey),
    verified_at: '2026-11-24T00:00:00.000Z',
  };
  let e2e: E2eConfig = { ...ensureDeviceKey(baseConfig).config.e2e!, devices: [phone] };
  const computer: TrustedDevice = {
    id: e2e.device_id,
    kind: 'computer',
    name: 'Laptop',
    public_key: e2e.public_key,
    verified_at: '2026-11-24T00:00:00.000Z',
  };
  return {
    config: { ...baseConfig, e2e },
    phoneCtx: {
      accountId: baseConfig.connector_id,
      agentId,
      myDeviceId: phone.id,
      myPublic: phone.public_key,
      myPrivate: keys.privateKey,
      trusted: [computer],
      seen: new ReplayWindow(),
    },
    store: (change) => {
      e2e = change(e2e);
      return Promise.resolve(e2e);
    },
    e2e: () => e2e,
  };
}
