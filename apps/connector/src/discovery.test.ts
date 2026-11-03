import { describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { localAgentConfigSchema } from './agents';
import { loadConfig, saveConfig } from './config';
import { fetchRegistry, registryAgent, splitCommandLine } from './discovery';

const body = JSON.stringify({
  agents: [
    {
      id: 'goose',
      name: 'Goose',
      version: '1.2.3',
      description: 'A coding agent',
      distribution: {
        npx: { package: '@example/goose', args: ['acp'], env: { GOOSE_MODE: 'local' } },
        uvx: { package: 'goose', args: ['acp'] },
      },
    },
    {
      id: 'download',
      name: 'Download',
      version: '2.0',
      description: '',
      distribution: { binary: {} },
    },
  ],
});

describe('ACP discovery', () => {
  it('splits quotes and escapes without a shell', () => {
    expect(splitCommandLine('goose "two words" one\\ two \'three four\'')).toEqual([
      'goose',
      'two words',
      'one two',
      'three four',
    ]);
    expect(() => splitCommandLine('  ')).toThrow();
    expect(() => splitCommandLine('goose "unfinished')).toThrow();
    expect(() => splitCommandLine('goose \\')).toThrow();
    expect(splitCommandLine('"C:\\Program Files\\goose.exe" acp')).toEqual([
      'C:\\Program Files\\goose.exe',
      'acp',
    ]);
  });

  it('validates fetched registry and chooses npx then uvx', async () => {
    const registry = await fetchRegistry(() => Promise.resolve(new Response(body)));
    const npx = registryAgent(registry, 'goose', '.', [], (name) => name === 'npx');
    expect(npx.agent).toMatchObject({
      id: 'goose',
      kind: 'acp',
      command: 'npx',
      args: ['-y', '@example/goose', 'acp'],
      env: { GOOSE_MODE: 'local' },
    });
    expect(npx.version).toBe('1.2.3');
    expect(localAgentConfigSchema.parse(JSON.parse(JSON.stringify(npx.agent)))).toMatchObject(
      npx.agent,
    );
    expect(registryAgent(registry, 'goose', '.', [], (name) => name === 'uvx').agent.args).toEqual([
      'goose',
      'acp',
    ]);
    expect(() => registryAgent(registry, 'download', '.', [], () => false)).toThrow(
      'installed as a download',
    );
    expect(() => registryAgent(registry, 'missing', '.', [], () => true)).toThrow(
      'No ACP registry agent',
    );
  });

  it('saves and reloads a custom ACP command in local config', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'twring-acp-'));
    const path = join(dir, 'config.json');
    try {
      await saveConfig(path, {
        server: 'https://example.com',
        connector_id: `con_${'a'.repeat(20)}`,
        token: `cct_${'t'.repeat(43)}`,
        name: 'Computer',
        agents: [
          {
            id: 'goose',
            label: 'Goose',
            kind: 'acp',
            command: 'goose',
            args: ['acp'],
            cwd: dir,
            allowKinds: ['read'],
          },
        ],
      });
      expect((await loadConfig(path))?.agents[0]).toMatchObject({
        id: 'goose',
        kind: 'acp',
        command: 'goose',
        args: ['acp'],
        allowKinds: ['read'],
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('rejects oversized and invalid bodies', async () => {
    await expect(
      fetchRegistry(() => Promise.resolve(new Response('x'.repeat(2_000_001)))),
    ).rejects.toThrow('too large');
    await expect(fetchRegistry(() => Promise.resolve(new Response('{')))).rejects.toThrow(
      'invalid',
    );
    await expect(
      fetchRegistry(() => Promise.resolve(new Response('{"agents":[{}]}'))),
    ).rejects.toThrow('invalid');
  });
});
