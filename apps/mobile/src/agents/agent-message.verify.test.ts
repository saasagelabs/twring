import { describe, expect, it } from 'vitest';

import { agentSetupCommand, agentSetupMessage, connectorDownloadUrl } from './agent-message';

/** Verifier edge cases for the message the owner forwards to their agent (ADR-027). */

const CODE = 'ABCD-EFGH';

/** The words a POSIX shell would split the command into (no quoting is used, so spaces split). */
const words = (command: string | undefined) => command?.split(' ') ?? [];

describe('the server in the setup command', () => {
  it('tells setup which server to claim the code on (the bundle defaults to staging)', () => {
    expect(words(agentSetupCommand(CODE, 'https://cord.example.com'))).toEqual([
      'curl',
      '-fsSL',
      'https://cord.example.com/downloads/twring-connect.mjs',
      '-o',
      'twring-connect.mjs',
      '&&',
      'node',
      'twring-connect.mjs',
      'setup',
      '--code',
      CODE,
      '--server',
      'https://cord.example.com',
    ]);
  });

  it('keeps a base path and drops trailing slashes, a query, and a fragment', () => {
    expect(connectorDownloadUrl('https://cord.example.com/api//?x=1&y=2#top')).toBe(
      'https://cord.example.com/api/downloads/twring-connect.mjs',
    );
    expect(words(agentSetupCommand(CODE, ' https://cord.example.com/api/ ')).at(-1)).toBe(
      'https://cord.example.com/api',
    );
  });

  it('never splits the URL on a space', () => {
    const command = agentSetupCommand(CODE, 'https://cord.example.com/my path');
    expect(words(command)[2]).toBe(
      'https://cord.example.com/my%20path/downloads/twring-connect.mjs',
    );
  });

  it.each([
    ['empty', ''],
    ['not a URL', 'cord.example.com'],
    ['another scheme', 'ftp://cord.example.com'],
    ['a user name', 'https://me:pw@cord.example.com'],
    ['shell syntax', 'https://cord.example.com/$(id)'],
    ['a command separator', "https://cord.example.com/a;b'c"],
  ])('makes no command from an unusable server (%s)', (_name, server) => {
    expect(agentSetupCommand(CODE, server)).toBeUndefined();
    expect(agentSetupMessage(CODE, server)).toBeUndefined();
  });

  it('makes no command from a code that is not a pairing code', () => {
    expect(agentSetupCommand('ABCD-EFGH; rm -rf ~', 'https://cord.example.com')).toBeUndefined();
    expect(agentSetupCommand('', 'https://cord.example.com')).toBeUndefined();
  });

  it('tells a Windows PowerShell agent to use curl.exe (curl is Invoke-WebRequest there)', () => {
    expect(agentSetupMessage(CODE, 'https://cord.example.com')).toContain('curl.exe');
  });
});
