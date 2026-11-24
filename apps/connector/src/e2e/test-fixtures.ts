import type { ConnectorConfig } from '../config';

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
