import { existsSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname } from 'node:path';

import {
  base64urlEncode,
  fileAad,
  MAX_FILE_BYTES,
  newFileKey,
  openFile,
  SEALED_FILE_OVERHEAD,
  sealFile,
} from '@twring/contracts';
import { describe, expect, it } from 'vitest';

import { downloadSealedFile, openSealedFiles, type SealedFileRef } from './sealed-files';

const ACCOUNT = 'conn_test';
const AGENT = 'claude-code';
const aad = fileAad({ accountId: ACCOUNT, agentId: AGENT });
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);

function seal(bytes: Uint8Array) {
  const key = newFileKey();
  return { key, blob: sealFile(key, bytes, aad) };
}

function ref(
  id: string,
  key: Uint8Array,
  bytes: Uint8Array,
  extra: Partial<SealedFileRef> = {},
): SealedFileRef {
  return {
    file_id: id,
    key: base64urlEncode(key),
    name: 'photo.png',
    mime: 'image/png',
    size: bytes.length,
    ...extra,
  };
}

/** A gateway that answers each file id with the blob given for it. */
function fakeGateway(blobs: Record<string, Uint8Array | number>) {
  const calls: string[] = [];
  const fetcher = ((input: string | URL | Request) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    const id = decodeURIComponent(url.pathname.split('/').at(-1)!);
    calls.push(`${id}?${url.searchParams.get('local_agent')}`);
    const blob = blobs[id];
    if (blob === undefined || typeof blob === 'number')
      return Promise.resolve(new Response('no', { status: typeof blob === 'number' ? blob : 404 }));
    return Promise.resolve(new Response(Buffer.from(blob), { status: 200 }));
  }) as typeof fetch;
  return { fetcher, calls };
}

const ctx = (signal = new AbortController().signal) => ({
  accountId: ACCOUNT,
  agentId: AGENT,
  server: 'https://api.twring.com',
  token: 'tok_secret',
  signal,
});

describe('a sealed file of 1 byte', () => {
  it('seals to 41 bytes and opens', () => {
    const { key, blob } = seal(Uint8Array.from([7]));
    expect(blob.length).toBe(1 + SEALED_FILE_OVERHEAD);
    expect(blob.length).toBe(41);
    expect([...openFile(key, blob, aad)]).toEqual([7]);
  });
});

describe('openSealedFiles', () => {
  it('opens a sealed photo and gives the agent its path and an Attached line', async () => {
    const { key, blob } = seal(PNG);
    const { fetcher, calls } = fakeGateway({ fil_a: blob });
    const out = await openSealedFiles([ref('fil_a', key, PNG)], ctx(), { fetch: fetcher });
    try {
      expect(out.failed).toEqual([]);
      expect(out.files).toHaveLength(1);
      const file = out.files[0]!;
      expect(file).toMatchObject({ name: 'photo.png', mimeType: 'image/png', sizeBytes: 8 });
      expect([...readFileSync(file.path)]).toEqual([...PNG]);
      if (process.platform !== 'win32') expect(statSync(file.path).mode & 0o777).toBe(0o600);
      expect(out.lines).toEqual(['[Attached: photo.png (PNG image, 8 B)]']);
      expect(calls).toEqual([`fil_a?${AGENT}`]);
    } finally {
      await out.cleanup();
    }
  });

  it('a swapped blob reaches the agent as could not be opened, and the others still pass', async () => {
    const good = seal(PNG);
    const mine = seal(PNG);
    const other = seal(Uint8Array.from([9, 9, 9, 9, 9, 9, 9, 9]));
    // fil_b holds another file's blob under this file's key: it must not open.
    const { fetcher } = fakeGateway({ fil_a: good.blob, fil_b: other.blob });
    const out = await openSealedFiles(
      [ref('fil_a', good.key, PNG), ref('fil_b', mine.key, PNG, { name: 'swapped.png' })],
      ctx(),
      { fetch: fetcher },
    );
    try {
      expect(out.files.map((f) => f.name)).toEqual(['photo.png']);
      expect(out.failed).toEqual(['swapped.png']);
      expect(out.lines).toEqual([
        '[Attached: photo.png (PNG image, 8 B)]',
        '[Attached: swapped.png (could not be opened)]',
      ]);
    } finally {
      await out.cleanup();
    }
  });

  it('a blob cut or flipped, or from another chat, is refused the same way', async () => {
    const { key, blob } = seal(PNG);
    const flipped = Uint8Array.from(blob);
    flipped[flipped.length - 1]! ^= 1;
    const elsewhere = sealFile(key, PNG, fileAad({ accountId: ACCOUNT, agentId: 'codex' }));
    const { fetcher } = fakeGateway({
      fil_cut: blob.subarray(0, blob.length - 3),
      fil_flip: flipped,
      fil_else: elsewhere,
    });
    const out = await openSealedFiles(
      ['fil_cut', 'fil_flip', 'fil_else', 'fil_gone'].map((id) => ref(id, key, PNG)),
      ctx(),
      { fetch: fetcher },
    );
    try {
      expect(out.files).toEqual([]);
      expect(out.failed).toHaveLength(4);
    } finally {
      await out.cleanup();
    }
  });

  it('a blob whose opened length differs from the size is refused', async () => {
    const { key, blob } = seal(PNG);
    const { fetcher } = fakeGateway({ fil_a: blob });
    const out = await openSealedFiles([ref('fil_a', key, PNG, { size: PNG.length + 1 })], ctx(), {
      fetch: fetcher,
    });
    try {
      expect(out.files).toEqual([]);
      expect(out.lines).toEqual(['[Attached: photo.png (could not be opened)]']);
    } finally {
      await out.cleanup();
    }
  });

  it('refuses a 0-byte size, a bad key and a type that is not allowed, without downloading', async () => {
    const { key, blob } = seal(PNG);
    const { fetcher, calls } = fakeGateway({ fil_a: blob });
    const out = await openSealedFiles(
      [
        ref('fil_a', key, PNG, { size: 0 }),
        ref('fil_a', key, PNG, { key: 'short' }),
        ref('fil_a', key, PNG, { mime: 'application/x-sh' }),
      ],
      ctx(),
      { fetch: fetcher },
    );
    try {
      expect(out.files).toEqual([]);
      expect(out.failed).toHaveLength(3);
      expect(calls).toEqual([]);
    } finally {
      await out.cleanup();
    }
  });

  it('names are made safe', async () => {
    const a = seal(PNG);
    const b = seal(PNG);
    const c = seal(PNG);
    const { fetcher } = fakeGateway({ fil_a: a.blob, fil_b: b.blob, fil_c: c.blob });
    const out = await openSealedFiles(
      [
        ref('fil_a', a.key, PNG, { name: '..\\..//evil\u0000\n.sh' }),
        ref('fil_b', b.key, PNG, { name: 'photo.png' }),
        ref('fil_c', c.key, PNG, { name: 'photo.png' }),
      ],
      ctx(),
      { fetch: fetcher },
    );
    try {
      expect(out.files).toHaveLength(3);
      const dir = dirname(out.files[0]!.path);
      for (const file of out.files) {
        expect(dirname(file.path)).toBe(dir);
        expect(basename(file.path)).toBe(file.name);
        // eslint-disable-next-line no-control-regex -- the point of the test
        expect(file.name).not.toMatch(/[\\/\u0000-\u001f]/u);
        expect(file.name.endsWith('.png')).toBe(true);
      }
      // Two files may share a name: they never overwrite each other.
      expect(new Set(out.files.map((f) => f.name.toLowerCase())).size).toBe(3);
      // One line per file, none broken by a newline or control character in a name.
      expect(out.lines).toHaveLength(3);
      for (const line of out.lines)
        expect([...line].every((c) => c.charCodeAt(0) >= 0x20)).toBe(true);
    } finally {
      await out.cleanup();
    }
  });

  it('removes the temp folder on cleanup', async () => {
    const { key, blob } = seal(PNG);
    const { fetcher } = fakeGateway({ fil_a: blob });
    const out = await openSealedFiles([ref('fil_a', key, PNG)], ctx(), { fetch: fetcher });
    const dir = dirname(out.files[0]!.path);
    expect(existsSync(dir)).toBe(true);
    await out.cleanup();
    expect(existsSync(dir)).toBe(false);
  });
});

describe('downloadSealedFile', () => {
  it('refuses a download over the cap without reading it all', async () => {
    let pulled = 0;
    const cap = MAX_FILE_BYTES + SEALED_FILE_OVERHEAD;
    const chunk = new Uint8Array(1024 * 1024);
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += chunk.length;
        controller.enqueue(chunk);
        if (pulled > cap * 3) controller.close();
      },
    });
    const fetcher = (() => Promise.resolve(new Response(body, { status: 200 }))) as typeof fetch;
    await expect(
      downloadSealedFile({
        server: 'https://api.twring.com',
        token: 't',
        fileId: 'fil_a',
        localAgent: AGENT,
        signal: new AbortController().signal,
        fetch: fetcher,
      }),
    ).rejects.toThrow();
    expect(pulled).toBeLessThan(cap + 4 * chunk.length);
  });

  it('sends the computer token and the agent, and nothing else identifying', async () => {
    let seen: { url: string; auth: string | null } | undefined;
    const fetcher = ((input: string | URL | Request, init?: RequestInit) => {
      seen = {
        url: input as string,
        auth: new Headers(init?.headers).get('authorization'),
      };
      return Promise.resolve(new Response(Buffer.from([1, 2, 3]), { status: 200 }));
    }) as typeof fetch;
    const bytes = await downloadSealedFile({
      server: 'https://api.twring.com',
      token: 'tok_secret',
      fileId: 'fil_a',
      localAgent: AGENT,
      signal: new AbortController().signal,
      fetch: fetcher,
    });
    expect([...bytes]).toEqual([1, 2, 3]);
    expect(seen?.url).toBe(`https://api.twring.com/v1/connectors/files/fil_a?local_agent=${AGENT}`);
    expect(seen?.auth).toBe('Bearer tok_secret');
  });
});
