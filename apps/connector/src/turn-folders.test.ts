import { existsSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { MAX_FILE_NAME_CHARS, type TurnAttachment } from '@twring/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  downloadTurnFiles,
  makeTurnFolder,
  sweepTurnFolders,
  turnFoldersRoot,
  uniqueName,
} from './turn-files';

const TEMP_VARS = ['TMPDIR', 'TMP', 'TEMP'] as const;
let saved: Record<string, string | undefined> = {};
let fake = '';

beforeEach(async () => {
  fake = await mkdtemp(join(tmpdir(), 'twring-test-'));
  saved = Object.fromEntries(TEMP_VARS.map((name) => [name, process.env[name]]));
  for (const name of TEMP_VARS) process.env[name] = fake;
});
afterEach(async () => {
  for (const name of TEMP_VARS)
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
  await rm(fake, { recursive: true, force: true });
});

describe('turn folders', () => {
  it('lives under one connector folder in the temp folder', async () => {
    const turn = await makeTurnFolder();
    expect(dirname(turn.directory)).toBe(turnFoldersRoot());
    expect(turnFoldersRoot().startsWith(fake)).toBe(true);
    await turn.cleanup();
    expect(existsSync(turn.directory)).toBe(false);
  });

  it('a start removes what a killed copy left and keeps the folders of a running one', async () => {
    const mine = await makeTurnFolder();
    writeFileSync(join(mine.directory, 'a.txt'), 'x');
    // A copy that was killed mid-turn: its cleanup never ran. No process has pid 2^31 - 2.
    const left = join(turnFoldersRoot(), `${2 ** 31 - 2}-abc`);
    mkdirSync(left);
    writeFileSync(join(left, 'secret.pdf'), 'x');
    const stray = join(turnFoldersRoot(), 'other');
    mkdirSync(stray);
    expect(await sweepTurnFolders()).toBe(2);
    expect(existsSync(left)).toBe(false);
    expect(existsSync(stray)).toBe(false);
    expect(existsSync(join(mine.directory, 'a.txt'))).toBe(true);
    await mine.cleanup();
  });

  it('leaves a linked root alone and does not follow it', async () => {
    const target = join(fake, 'precious');
    mkdirSync(target);
    writeFileSync(join(target, 'precious.txt'), 'x');
    symlinkSync(target, turnFoldersRoot(), 'junction');
    expect(await sweepTurnFolders()).toBe(0);
    expect(existsSync(join(target, 'precious.txt'))).toBe(true);
  });

  it('removes the folders still open when the process exits', async () => {
    const turn = await makeTurnFolder();
    process.emit('exit', 0);
    expect(existsSync(turn.directory)).toBe(false);
  });
});

describe('uniqueName', () => {
  it('keeps the extension of a long duplicate name and never ends in a dot or space', () => {
    const base = `${'a'.repeat(MAX_FILE_NAME_CHARS - 4)}.pdf`;
    const used = new Set<string>([base.toLowerCase()]);
    for (let i = 0; i < 12; i++) {
      const name = uniqueName(base, used);
      expect(name.endsWith('.pdf')).toBe(true);
      expect(Array.from(name).length).toBeLessThanOrEqual(MAX_FILE_NAME_CHARS);
      expect(used.has(name.toLowerCase())).toBe(false);
      used.add(name.toLowerCase());
    }
    const dotted = `${'b'.repeat(MAX_FILE_NAME_CHARS - 7)}. ..txt`.slice(0, MAX_FILE_NAME_CHARS);
    const name = uniqueName(dotted, new Set([dotted.toLowerCase()]));
    expect(name.slice(0, -4)).not.toMatch(/[. ]$/u);
  });

  it('downloadTurnFiles keeps .txt on duplicate long names', async () => {
    const long = `${'c'.repeat(MAX_FILE_NAME_CHARS - 4)}.txt`;
    const attachment: TurnAttachment = {
      id: 'fil_aaaaaaaaaaaaaaaaaaaa',
      name: long,
      mime_type: 'text/plain',
      size_bytes: 3,
      url: 'https://server.example/file',
      expires_at: '2026-10-14T00:15:00.000Z',
    };
    const fetcher = vi.fn(() => Promise.resolve(new Response('abc')));
    const result = await downloadTurnFiles(
      Array.from({ length: 11 }, () => attachment),
      {
        server: 'https://server.example',
        turnId: 't',
        signal: new AbortController().signal,
        fetch: fetcher,
      },
    );
    expect(result.files).toHaveLength(11);
    for (const file of result.files) {
      expect(file.name.endsWith('.txt')).toBe(true);
      expect(existsSync(file.path)).toBe(true);
    }
    await result.cleanup();
  });
});
