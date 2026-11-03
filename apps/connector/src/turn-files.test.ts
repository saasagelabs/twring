import { access, readFile, stat } from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';
import type { TurnAttachment } from '@twring/contracts';
import { MAX_FILE_BYTES } from '@twring/contracts';
import { downloadTurnFiles } from './turn-files';

const attachment = (
  name: string,
  url = 'https://server.example/file',
  size_bytes = 3,
): TurnAttachment => ({
  id: 'fil_aaaaaaaaaaaaaaaaaaaa',
  name,
  mime_type: 'text/plain',
  size_bytes,
  url,
  expires_at: '2026-10-14T00:15:00.000Z',
});

describe('turn files', () => {
  it('downloads private files, cleans names and clashes, then removes the directory', async () => {
    const fetcher = vi.fn(() => Promise.resolve(new Response('abc')));
    const result = await downloadTurnFiles(
      [attachment('../a'), attachment('..\\a'), attachment('a\u0001')],
      {
        server: 'https://server.example',
        turnId: 't',
        signal: new AbortController().signal,
        fetch: fetcher,
      },
    );
    expect(result.files).toHaveLength(3);
    expect(new Set(result.files.map((file) => file.name)).size).toBe(3);
    for (const file of result.files) {
      expect(await readFile(file.path, 'utf8')).toBe('abc');
      // eslint-disable-next-line no-control-regex -- verify the name was cleaned
      expect(file.name).not.toMatch(/[\\/\x00-\x1f]/u);
    }
    if (process.platform !== 'win32') {
      expect((await stat(result.files[0]!.path)).mode & 0o777).toBe(0o600);
    }
    await result.cleanup();
    await expect(access(result.files[0]!.path)).rejects.toThrow();
  });

  it('makes names Windows can write: reserved names, refused characters, trailing dots', async () => {
    const fetcher = vi.fn(() => Promise.resolve(new Response('abc')));
    const result = await downloadTurnFiles(
      [attachment('CON.txt'), attachment('a:b?*.txt'), attachment('notes. . ')],
      {
        server: 'https://server.example',
        turnId: 't',
        signal: new AbortController().signal,
        fetch: fetcher,
      },
    );
    expect(result.files.map((file) => file.name)).toEqual(['_CON.txt', 'a_b__.txt', 'notes']);
    for (const file of result.files) expect(await readFile(file.path, 'utf8')).toBe('abc');
    await result.cleanup();
  });

  it('skips another origin, bad status, size and redirect', async () => {
    const fetcher = vi.fn((url: URL, init: RequestInit) => {
      expect(init.redirect).toBe('error');
      if (url.pathname === '/status') return Promise.resolve(new Response('', { status: 404 }));
      if (url.pathname === '/redirect') return Promise.reject(new TypeError('redirect'));
      return Promise.resolve(new Response('abcd'));
    });
    const result = await downloadTurnFiles(
      [
        attachment('other', 'https://other.example/file'),
        attachment('bad', 'https://server.example/status'),
        attachment('large', 'https://server.example/large'),
        attachment('wrong', 'https://server.example/wrong', 5),
        attachment('redirect', 'https://server.example/redirect'),
      ],
      {
        server: 'https://server.example',
        turnId: 't',
        signal: new AbortController().signal,
        fetch: fetcher as typeof fetch,
      },
    );
    expect(result.files).toEqual([]);
    expect(fetcher).toHaveBeenCalledTimes(4);
    await result.cleanup();
  });

  it('stops when aborted', async () => {
    const controller = new AbortController();
    const fetcher = vi.fn(() => {
      controller.abort();
      return Promise.reject(new Error('aborted'));
    });
    const result = await downloadTurnFiles([attachment('one'), attachment('two')], {
      server: 'https://server.example',
      turnId: 't',
      signal: controller.signal,
      fetch: fetcher,
    });
    expect(result.files).toEqual([]);
    expect(fetcher).toHaveBeenCalledTimes(1);
    await result.cleanup();
  });

  it('stops reading a body larger than the file limit', async () => {
    const fetcher = vi.fn(() => Promise.resolve(new Response(new Uint8Array(MAX_FILE_BYTES + 1))));
    const result = await downloadTurnFiles(
      [attachment('huge', 'https://server.example/file', MAX_FILE_BYTES)],
      {
        server: 'https://server.example',
        turnId: 't',
        signal: new AbortController().signal,
        fetch: fetcher,
      },
    );
    expect(result.files).toEqual([]);
    await result.cleanup();
  });
});
