import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { agentSetupMessage } from '../../mobile/src/agents/agent-message';
import { callPreamble, ringCommand } from './preamble';

describe('public connector name', () => {
  it('uses Twring and twring-connect in the agent message, help, and call preamble', () => {
    const message = agentSetupMessage('ABCD-EFGH', 'https://example.com');
    expect(message).toContain('/downloads/twring-connect.mjs');
    expect(message).toContain('node twring-connect.mjs setup');

    const cli = fileURLToPath(new URL('./cli.ts', import.meta.url));
    const help = spawnSync(process.execPath, ['--import', 'tsx', cli, '--help'], {
      encoding: 'utf8',
    });
    expect(help.status, help.stderr).toBe(0);
    expect(help.stdout).toContain('npx twring-connect');

    const preamble = callPreamble(
      ringCommand({
        execPath: process.execPath,
        script: undefined,
        execArgv: [],
        platform: 'win32',
      }),
    );
    expect(preamble).toContain('through Twring,');
    expect(preamble).toContain('npx twring-connect ring');
  });
});
