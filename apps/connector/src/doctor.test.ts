import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import type { LocalAgentConfig } from './agents';
import { doctor } from './doctor';
import type { LocalAgentAdapter, LocalAgentEvent } from './events';

const agent: LocalAgentConfig = {
  id: 'fake',
  label: 'Fake',
  kind: 'command',
  command: 'fake',
  args: [],
  cwd: '.',
};

describe('doctor', () => {
  it('reports first text, streaming, resume support, failure hints, and saves no session', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'twring-doctor-'));
    try {
      const lines: string[] = [];
      const success = (): LocalAgentAdapter => ({
        async *sendTurn(): AsyncIterable<LocalAgentEvent> {
          await Promise.resolve();
          yield { type: 'text', text: 'rea' };
          yield { type: 'text', text: 'dy' };
        },
        sessionRef: () => 'session-123',
        close: () => undefined,
      });
      expect(await doctor([agent], (line) => lines.push(line), success)).toBe(0);
      expect(lines[0]).toContain('ready yes; streamed yes; resumes yes');
      expect(await readdir(dir)).not.toContain('sessions.json');
      const failure: LocalAgentAdapter = {
        async *sendTurn(): AsyncIterable<LocalAgentEvent> {
          await Promise.resolve();
          yield* [];
          throw new Error('missing');
        },
        close: () => undefined,
      };
      expect(
        await doctor(
          [agent],
          (line) => lines.push(line),
          () => failure,
        ),
      ).toBe(1);
      expect(lines.at(-1)).toContain("didn't start: is fake on PATH");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
