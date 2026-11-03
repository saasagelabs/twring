import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { MAX_FILE_BYTES } from '@twring/contracts';
import { describe, expect, it, vi } from 'vitest';

import { uploadFile } from './upload';

const file = {
  server: 'http://localhost:3000',
  token: 'secret',
  localAgent: 'echo',
  clientId: '00000000-0000-4000-8000-000000000001',
};
const response = () =>
  new Response(
    JSON.stringify({
      file: {
        id: `fil_${'a'.repeat(20)}`,
        name: 'photo.jpg',
        mime_type: 'image/jpeg',
        size_bytes: 2,
      },
    }),
    { status: 201 },
  );

describe('connector file upload', () => {
  it.each([
    ['photo.jpg', 'image/jpeg'],
    ['photo.jpeg', 'image/jpeg'],
    ['photo.png', 'image/png'],
    ['photo.webp', 'image/webp'],
    ['report.pdf', 'application/pdf'],
    ['notes.txt', 'text/plain'],
    ['notes.md', 'text/markdown'],
    ['table.csv', 'text/csv'],
    ['data.json', 'application/json'],
  ])('infers %s and sends the connector token', async (name, mimeType) => {
    const fetch = vi.fn((_url: string | URL | Request, _init?: RequestInit) =>
      Promise.resolve(response()),
    );
    await expect(uploadFile({ ...file, name, bytes: Buffer.from('ok'), fetch })).resolves.toBe(
      `fil_${'a'.repeat(20)}`,
    );
    const [url, init] = fetch.mock.calls[0]!;
    expect(new URL(url).searchParams.get('client_id')).toBe(file.clientId);
    expect(init?.headers).toMatchObject({
      authorization: 'Bearer secret',
      'content-type': mimeType,
    });
  });

  it("sends the person's session scope with the file", async () => {
    const fetch = vi.fn((_url: string | URL | Request, _init?: RequestInit) =>
      Promise.resolve(response()),
    );
    const scope = 'c'.repeat(32);
    await uploadFile({
      ...file,
      sessionScope: scope,
      name: 'a.txt',
      bytes: Buffer.from('ok'),
      fetch,
    });
    await uploadFile({ ...file, name: 'a.txt', bytes: Buffer.from('ok'), fetch });
    expect(new URL(fetch.mock.calls[0]![0] as string).searchParams.get('session_scope')).toBe(
      scope,
    );
    expect(new URL(fetch.mock.calls[1]![0] as string).searchParams.has('session_scope')).toBe(
      false,
    );
  });

  it('refuses an oversized path before calling fetch', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cord-upload-'));
    try {
      const path = join(dir, 'large.pdf');
      await writeFile(path, Buffer.alloc(MAX_FILE_BYTES + 1));
      const fetch = vi.fn(() => Promise.resolve(response()));
      await expect(uploadFile({ ...file, path, name: 'large.pdf', fetch })).rejects.toMatchObject({
        code: 'file_too_large',
      });
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('refuses unsupported extensions locally', async () => {
    const fetch = vi.fn(() => Promise.resolve(response()));
    await expect(
      uploadFile({ ...file, name: 'archive.zip', bytes: Buffer.from('ok'), fetch }),
    ).rejects.toMatchObject({
      code: 'unsupported_file_type',
      message: 'Twring can send photos, PDFs and text files.',
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('maps gateway refusal codes without exposing the name', async () => {
    for (const code of [
      'file_too_large',
      'unsupported_file_type',
      'storage_full',
      'files_daily_limit',
      'rate_limited',
    ]) {
      const fetch = vi.fn(() =>
        Promise.resolve(
          new Response(JSON.stringify({ error: { code, message: 'server detail' } }), {
            status: 413,
          }),
        ),
      );
      await expect(
        uploadFile({ ...file, name: 'secret.pdf', bytes: Buffer.from('ok'), fetch }),
      ).rejects.toMatchObject({ code });
    }
  });
});
