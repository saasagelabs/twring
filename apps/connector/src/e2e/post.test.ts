import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  base64urlDecode,
  fileAad,
  openFile,
  SEALED_FILE_OVERHEAD,
  type SealedPayload,
} from '@twring/contracts';
import { afterEach, describe, expect, it } from 'vitest';

import { saveConfig } from '../config';
import { PrivatePostError, sealedPost } from './post';
import { openIncoming } from './sealed';
import { updateE2e } from './store';
import { baseConfig, pairedFixture } from './test-fixtures';

const AGENT = 'claude-code';
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
const tempDir = async () => {
  const dir = await mkdtemp(join(tmpdir(), 'twring-post-'));
  dirs.push(dir);
  return dir;
};

const okUpload = (id: string) =>
  new Response(JSON.stringify({ file: { id, size_bytes: 40 } }), { status: 201 });

describe('sealedPost', () => {
  it('seals the text under one seq the phone opens, and uploads each file sealed', async () => {
    const fixture = pairedFixture();
    const dir = await tempDir();
    const path = join(dir, 'report.txt');
    await writeFile(path, 'file body');
    const uploads: { url: URL; body: Uint8Array }[] = [];
    const fetch = ((input: string | URL, init?: RequestInit) => {
      uploads.push({ url: new URL(input.toString()), body: new Uint8Array(init!.body as Buffer) });
      return Promise.resolve(okUpload(`fil_${'a'.repeat(20)}`));
    }) as typeof globalThis.fetch;
    const post = await sealedPost({
      store: fixture.store,
      config: fixture.config,
      localAgent: AGENT,
      text: 'Done.',
      paths: [path],
      server: 'https://api.twring.com',
      token: baseConfig.token,
      fetch,
    });
    expect(post.fileIds).toEqual([`fil_${'a'.repeat(20)}`]);
    expect(post.sealed).toHaveLength(1);
    expect(new Set(post.sealed.map((envelope) => envelope.sender_seq)).size).toBe(1);
    const opened = openIncoming(fixture.phoneCtx, post.sealed[0]!);
    expect(opened.ok).toBe(true);
    const payload = (opened as { payload: SealedPayload }).payload;
    expect(payload.text).toBe('Done.');
    expect(payload.files).toHaveLength(1);
    const ref = payload.files![0]!;
    expect(ref).toMatchObject({ file_id: post.fileIds[0], name: 'report.txt', mime: 'text/plain' });
    // The uploaded bytes are the sealed blob, sent with no name.
    expect(uploads[0]!.url.searchParams.get('sealed')).toBe('1');
    expect(uploads[0]!.url.searchParams.has('name')).toBe(false);
    expect(uploads[0]!.body.byteLength).toBe('file body'.length + SEALED_FILE_OVERHEAD);
    const plain = openFile(
      base64urlDecode(ref.key),
      uploads[0]!.body,
      fileAad({ accountId: baseConfig.connector_id, agentId: AGENT }),
    );
    expect(Buffer.from(plain).toString('utf8')).toBe('file body');
  });

  it('lists only files that were uploaded and says in one plain line which could not be sent', async () => {
    const fixture = pairedFixture();
    const dir = await tempDir();
    const good = join(dir, 'good.txt');
    const bad = join(dir, 'bad.txt');
    const empty = join(dir, 'empty.txt');
    await writeFile(good, 'ok');
    await writeFile(bad, 'no');
    await writeFile(empty, '');
    let n = 0;
    const fetch = (() =>
      Promise.resolve(
        n++ === 0
          ? okUpload(`fil_${'a'.repeat(20)}`)
          : new Response(JSON.stringify({ error: { code: 'storage_full', message: 'x' } }), {
              status: 507,
            }),
      )) as unknown as typeof globalThis.fetch;
    const post = await sealedPost({
      store: fixture.store,
      config: fixture.config,
      localAgent: AGENT,
      text: '',
      paths: [good, bad, empty],
      server: 'https://api.twring.com',
      token: baseConfig.token,
      fetch,
    });
    expect(post.fileIds).toEqual([`fil_${'a'.repeat(20)}`]);
    const payload = (openIncoming(fixture.phoneCtx, post.sealed[0]!) as { payload: SealedPayload })
      .payload;
    expect(payload.files).toHaveLength(1);
    expect(payload.text).toBe('Could not send bad.txt.\nCould not send empty.txt: it is empty.');
  });

  it('chunks long text under one seq with the files on the last piece', async () => {
    const fixture = pairedFixture();
    const post = await sealedPost({
      store: fixture.store,
      config: fixture.config,
      localAgent: AGENT,
      text: 'x'.repeat(8_001),
      paths: [],
      server: 'https://api.twring.com',
      token: baseConfig.token,
    });
    expect(post.sealed).toHaveLength(2);
    expect(post.sealed.map((envelope) => envelope.sender_seq)).toEqual(
      post.sealed.map(() => post.sealed[0]!.sender_seq),
    );
    expect(post.sealed.map((envelope) => envelope.chunk)).toEqual([
      { index: 0, final: false },
      { index: 1, final: true },
    ]);
  });

  it('the service and the CLI never reuse a seq', async () => {
    const dir = await tempDir();
    const fixture = pairedFixture();
    const path = join(dir, 'config.json');
    await saveConfig(path, fixture.config);
    const run = () =>
      sealedPost({
        store: (change) => updateE2e(path, change),
        config: fixture.config,
        localAgent: AGENT,
        text: 'hi',
        paths: [],
        server: 'https://api.twring.com',
        token: baseConfig.token,
      });
    const posts = await Promise.all([run(), run(), run()]);
    const seqs = posts.map((post) => post.sealed[0]!.sender_seq);
    expect(new Set(seqs).size).toBe(3);
  });

  it('throws not_private when the gateway says a sealed upload is for an ordinary chat', async () => {
    const fixture = pairedFixture();
    const dir = await tempDir();
    const path = join(dir, 'a.txt');
    await writeFile(path, 'x');
    const fetch = (() =>
      Promise.resolve(
        new Response(JSON.stringify({ error: { code: 'not_private', message: 'x' } }), {
          status: 409,
        }),
      )) as unknown as typeof globalThis.fetch;
    await expect(
      sealedPost({
        store: fixture.store,
        config: fixture.config,
        localAgent: AGENT,
        text: '',
        paths: [path],
        server: 'https://api.twring.com',
        token: baseConfig.token,
        fetch,
      }),
    ).rejects.toMatchObject({ code: 'not_private' });
  });

  it('throws private_post_unpaired with no trusted phone and uploads nothing', async () => {
    const fixture = pairedFixture();
    await fixture.store((current) => ({ ...current, devices: [] }));
    let calls = 0;
    const fetch = (() => {
      calls++;
      return Promise.resolve(okUpload(`fil_${'a'.repeat(20)}`));
    }) as unknown as typeof globalThis.fetch;
    const dir = await tempDir();
    const path = join(dir, 'a.txt');
    await writeFile(path, 'x');
    const attempt = sealedPost({
      store: fixture.store,
      config: fixture.config,
      localAgent: AGENT,
      text: 'hi',
      paths: [path],
      server: 'https://api.twring.com',
      token: baseConfig.token,
      fetch,
    });
    await expect(attempt).rejects.toBeInstanceOf(PrivatePostError);
    await expect(attempt).rejects.toMatchObject({ code: 'private_post_unpaired' });
    expect(calls).toBe(0);
  });
});
