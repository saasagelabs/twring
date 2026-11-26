import { existsSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';

import {
  base64urlDecode,
  base64urlEncode,
  deviceIdFor,
  fileAad,
  generateSealKeyPair,
  newFileKey,
  MAX_FILE_BYTES,
  openFile,
  SEALED_FILE_OVERHEAD,
  SEALED_FILES_FEATURE,
  sealFile,
  TEXT_TURN_TAG,
  type RelayConnectorMessage,
  type SealedPayload,
} from '@twring/contracts';
import { describe, expect, it } from 'vitest';

import type { LocalAgentAdapter, LocalAgentEvent } from '../events';
import { ResultOutbox } from '../outbox';
import type { LocalFile } from '../turn-files';
import { ensureDeviceKey, type E2eConfig, type TrustedDevice } from './keys';
import { openIncoming, ReplayWindow, sealOutgoing, type SealContext } from './sealed';
import { baseConfig } from './test-fixtures';
import { helloFeatures, PrivateChats } from './turn';

const AGENT = 'claude-code';
type Reply = Extract<RelayConnectorMessage, { type: 'sealed.reply' }>;
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);
const aad = fileAad({ accountId: baseConfig.connector_id, agentId: AGENT });

interface Options {
  /** What the agent does with a turn; default says ok. */
  agent?: (files: LocalFile[], signal: AbortSignal) => AsyncIterable<LocalAgentEvent>;
  withFiles?: boolean;
  /** Whether the gateway said sealed_files; default yes. */
  gateway?: boolean;
  /** Answers an upload of the nth blob (0 based); default a fresh id. */
  upload?: (n: number) => Response;
  /** Takes over an upload request (to hold it open). */
  uploadFetch?: (init: RequestInit) => Promise<Response>;
}

function setup(blobs: Record<string, Uint8Array>, options: Options = {}) {
  const phoneKeys = generateSealKeyPair();
  const phone: TrustedDevice = {
    id: deviceIdFor(phoneKeys.publicKey),
    kind: 'phone',
    name: 'Pixel',
    public_key: base64urlEncode(phoneKeys.publicKey),
    verified_at: '2026-11-24T00:00:00.000Z',
  };
  let e2e: E2eConfig = { ...ensureDeviceKey(baseConfig).config.e2e!, devices: [phone] };
  const computer: TrustedDevice = {
    id: e2e.device_id,
    kind: 'computer',
    name: 'Laptop',
    public_key: e2e.public_key,
    verified_at: '2026-11-24T00:00:00.000Z',
  };
  const phoneCtx: SealContext = {
    accountId: baseConfig.connector_id,
    agentId: AGENT,
    myDeviceId: phone.id,
    myPublic: phone.public_key,
    myPrivate: phoneKeys.privateKey,
    trusted: [computer],
    seen: new ReplayWindow(),
  };
  let seq = 0;
  const sent: Reply[] = [];
  const inputs: string[] = [];
  const logs: string[] = [];
  const seenFiles: LocalFile[][] = [];
  const contents: Uint8Array[] = [];
  const adapter: LocalAgentAdapter = {
    async *sendTurn(text, signal, turnOptions) {
      inputs.push(text);
      const files = turnOptions?.files ?? [];
      seenFiles.push(files);
      for (const file of files) contents.push(readFileSync(file.path));
      if (options.agent !== undefined) yield* options.agent(files, signal);
      else yield { type: 'text', text: 'ok' };
      await Promise.resolve();
    },
    close: () => undefined,
  };
  const uploads: { url: URL; body: Uint8Array; type: string | null }[] = [];
  const fetcher = ((input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    if (init?.method === 'POST') {
      const n = uploads.length;
      uploads.push({
        url,
        body: new Uint8Array(init.body as Buffer),
        type: new Headers(init.headers).get('content-type'),
      });
      if (options.uploadFetch !== undefined) return options.uploadFetch(init);
      return Promise.resolve(options.upload?.(n) ?? okUpload(`fil_u${'abcdefgh'[n]}`));
    }
    const blob = blobs[url.pathname.split('/').at(-1)!];
    return Promise.resolve(
      blob === undefined ? new Response('no', { status: 404 }) : new Response(Buffer.from(blob)),
    );
  }) as typeof fetch;
  const chats = new PrivateChats({
    connectorId: baseConfig.connector_id,
    e2e: () => e2e,
    persist: (change) => {
      e2e = change(e2e);
      return Promise.resolve(e2e);
    },
    pool: {
      acquire: (agent) => (agent === AGENT ? adapter : undefined),
      release: () => undefined,
      runExclusive: (_agent, fn) => fn(),
    },
    send: (frame) => {
      if (frame.type === 'sealed.reply') sent.push(frame);
      return true;
    },
    gatewaySupports: (feature) => options.gateway !== false && feature === SEALED_FILES_FEATURE,
    outbox: new ResultOutbox(),
    log: (line) => logs.push(line),
    ...(options.withFiles !== false && {
      files: { server: 'https://api.twring.com', token: 'tok_secret', fetch: fetcher },
    }),
  });
  let n = 0;
  const frame = (payload: SealedPayload) => ({
    type: 'sealed.message' as const,
    agent: AGENT,
    message_id: `msg_${String(++n).padStart(20, 'a').replace(/[0-9]/g, 'b')}`,
    sealed: sealOutgoing(phoneCtx, payload, ++seq),
  });
  const reads = (id: string) =>
    sent
      .filter((f) => f.turn_id === id)
      .map((f) => {
        const opened = openIncoming({ ...phoneCtx, seen: new ReplayWindow() }, f.sealed);
        if (!opened.ok) throw new Error(opened.reason);
        return opened.payload;
      });
  return { chats, frame, reads, inputs, logs, seenFiles, contents, sent, uploads };
}

const fileId = (prefix: string) => prefix.padEnd(24, 'x');
const okUpload = (prefix: string) =>
  new Response(JSON.stringify({ file: { id: fileId(prefix), size_bytes: 1 } }), { status: 201 });

function filed(id: string, bytes = PNG, name = 'photo.png') {
  const key = newFileKey();
  return {
    blob: sealFile(key, bytes, aad),
    entry: {
      file_id: id,
      key: base64urlEncode(key),
      name,
      mime: 'image/png',
      size: bytes.length,
    },
  };
}

describe('private turns with sealed files', () => {
  it('hands a sealed photo to the agent with its path and an Attached line', async () => {
    const a = filed('fil_axxxxxxxxxxxxxxxxxxx');
    const run = setup({ fil_axxxxxxxxxxxxxxxxxxx: a.blob });
    const frame = run.frame({ text: 'what is this?', files: [a.entry] });
    await run.chats.receive(frame);
    expect(run.seenFiles[0]).toHaveLength(1);
    expect([...run.contents[0]!]).toEqual([...PNG]);
    expect(run.inputs[0]).toBe(
      `${TEXT_TURN_TAG}\nwhat is this?\n[Attached: photo.png (PNG image, 8 B)]`,
    );
    expect(
      run
        .reads(frame.message_id)
        .map((p) => p.text)
        .join(''),
    ).toBe('ok');
  });

  it('old files-only notice is gone: a photo with no text reaches the agent', async () => {
    const a = filed('fil_axxxxxxxxxxxxxxxxxxx');
    const run = setup({ fil_axxxxxxxxxxxxxxxxxxx: a.blob });
    const frame = run.frame({ text: '', files: [a.entry] });
    await run.chats.receive(frame);
    expect(run.inputs).toHaveLength(1);
    const text = run
      .reads(frame.message_id)
      .map((p) => p.text)
      .join('');
    expect(text).toBe('ok');
    expect(text).not.toContain("can't open files");
  });

  it('a swapped blob reaches the agent as could not be opened, others still pass', async () => {
    const a = filed('fil_axxxxxxxxxxxxxxxxxxx');
    const b = filed('fil_bxxxxxxxxxxxxxxxxxxx', PNG, 'second.png');
    const other = filed('fil_otherxxxxxxxxxxxxxxx', Uint8Array.from([5, 5, 5, 5, 5, 5, 5, 5]));
    const run = setup({ fil_axxxxxxxxxxxxxxxxxxx: a.blob, fil_bxxxxxxxxxxxxxxxxxxx: other.blob });
    const frame = run.frame({ text: 'look', files: [a.entry, b.entry] });
    await run.chats.receive(frame);
    expect(run.seenFiles[0]).toHaveLength(1);
    expect(run.inputs[0]).toBe(
      `${TEXT_TURN_TAG}\nlook\n[Attached: photo.png (PNG image, 8 B)]\n[Attached: second.png (could not be opened)]`,
    );
    // Never the swapped file's bytes.
    expect(run.contents).toHaveLength(1);
    expect([...run.contents[0]!]).toEqual([...PNG]);
  });

  it('with no way to reach the gateway every file is could not be opened, never a crash', async () => {
    const a = filed('fil_axxxxxxxxxxxxxxxxxxx');
    const run = setup({ fil_axxxxxxxxxxxxxxxxxxx: a.blob }, { withFiles: false });
    const frame = run.frame({ text: 'hi', files: [a.entry] });
    await run.chats.receive(frame);
    expect(run.inputs[0]).toContain('[Attached: photo.png (could not be opened)]');
  });

  it('removes the temp folder after the turn', async () => {
    const a = filed('fil_axxxxxxxxxxxxxxxxxxx');
    const run = setup({ fil_axxxxxxxxxxxxxxxxxxx: a.blob });
    await run.chats.receive(run.frame({ text: 'x', files: [a.entry] }));
    const dir = dirname(run.seenFiles[0]![0]!.path);
    expect(existsSync(dir)).toBe(false);
  });

  it('removes the temp folder also after the agent fails', async () => {
    const a = filed('fil_axxxxxxxxxxxxxxxxxxx');
    const run = setup(
      { fil_axxxxxxxxxxxxxxxxxxx: a.blob },
      {
        // eslint-disable-next-line require-yield, @typescript-eslint/require-await
        agent: async function* () {
          throw new Error('agent crashed');
        },
      },
    );
    await run.chats.receive(run.frame({ text: 'x', files: [a.entry] }));
    expect(existsSync(dirname(run.seenFiles[0]![0]!.path))).toBe(false);
  });

  it('removes the temp folder also after a Stop', async () => {
    const a = filed('fil_axxxxxxxxxxxxxxxxxxx');
    let started!: () => void;
    const running = new Promise<void>((resolve) => (started = resolve));
    const run = setup(
      { fil_axxxxxxxxxxxxxxxxxxx: a.blob },
      {
        async *agent(_files, signal) {
          started();
          await new Promise<void>((resolve) =>
            signal.addEventListener('abort', () => resolve(), { once: true }),
          );
          yield { type: 'text', text: 'partial' };
        },
      },
    );
    const frame = run.frame({ text: 'x', files: [a.entry] });
    const turn = run.chats.receive(frame);
    await running;
    await run.chats.receive({
      type: 'sealed.cancel',
      agent: AGENT,
      turn_id: frame.message_id,
    });
    await turn;
    expect(existsSync(dirname(run.seenFiles[0]![0]!.path))).toBe(false);
  });

  it('logs carry counts only, never names, keys or bytes', async () => {
    const a = filed('fil_axxxxxxxxxxxxxxxxxxx', PNG, 'secret-name.png');
    const run = setup({ fil_axxxxxxxxxxxxxxxxxxx: a.blob });
    await run.chats.receive(run.frame({ text: 'x', files: [a.entry] }));
    const log = run.logs.join('\n');
    expect(log).not.toContain('secret-name');
    expect(log).not.toContain(a.entry.key);
    expect(log).not.toContain('tok_secret');
  });
});

const agentFile = (name: string, data: Uint8Array): LocalAgentEvent => ({
  type: 'file',
  name,
  mimeType: 'image/png',
  data,
});
const replyOf = (run: ReturnType<typeof setup>, id: string) => {
  const frames = run.sent.filter((f) => f.turn_id === id);
  return { frames, payloads: run.reads(id), last: frames.at(-1)! };
};
const linesWith = (text: string, name: string) =>
  text.split('\n').filter((line) => line.includes(name));

describe('private turns that send files back', () => {
  it('an agent file in a private turn is sealed, uploaded and listed in the reply', async () => {
    const run = setup(
      {},
      {
        async *agent() {
          yield { type: 'text', text: 'here' };
          yield agentFile('chart.png', PNG);
          await Promise.resolve();
        },
      },
    );
    const frame = run.frame({ text: 'draw' });
    await run.chats.receive(frame);
    const { payloads, last, frames } = replyOf(run, frame.message_id);
    expect(run.uploads).toHaveLength(1);
    expect(run.uploads[0]!.url.searchParams.get('sealed')).toBe('1');
    expect(run.uploads[0]!.url.searchParams.get('local_agent')).toBe(AGENT);
    expect(run.uploads[0]!.type).toBe('application/octet-stream');
    const final = payloads.at(-1)!;
    expect(final.files).toHaveLength(1);
    const entry = final.files![0]!;
    expect(entry).toMatchObject({
      file_id: fileId('fil_ua'),
      name: 'chart.png',
      mime: 'image/png',
      size: PNG.length,
    });
    expect(last.file_ids).toEqual([entry.file_id]);
    // Only the final frame names files.
    for (const f of frames.slice(0, -1)) expect(f.file_ids).toBeUndefined();
    // The uploaded bytes are not the file, and open with the listed key.
    const blob = run.uploads[0]!.body;
    expect([...blob]).not.toEqual([...PNG]);
    expect(blob.length).toBe(PNG.length + SEALED_FILE_OVERHEAD);
    expect([...openFile(base64urlDecode(entry.key), blob, aad)]).toEqual([...PNG]);
  });

  it('drops agent files when the gateway lacks sealed_files and logs e2e_file_dropped', async () => {
    const run = setup(
      {},
      {
        gateway: false,
        async *agent() {
          yield agentFile('chart.png', PNG);
          await Promise.resolve();
        },
      },
    );
    const frame = run.frame({ text: 'draw' });
    await run.chats.receive(frame);
    const { payloads, last } = replyOf(run, frame.message_id);
    expect(run.uploads).toHaveLength(0);
    expect(payloads.at(-1)!.files).toBeUndefined();
    expect(last.file_ids).toBeUndefined();
    const log = run.logs.filter((l) => l.includes('e2e_file_dropped'));
    expect(log).toHaveLength(1);
    expect(log[0]).not.toContain('chart.png');
  });

  it('a file over 10 MB is not sent and the reply says so in one line', async () => {
    const run = setup(
      {},
      {
        async *agent() {
          yield agentFile('big.png', new Uint8Array(MAX_FILE_BYTES + 1));
          yield agentFile('none.png', new Uint8Array(0));
          await Promise.resolve();
        },
      },
    );
    const frame = run.frame({ text: 'draw' });
    await run.chats.receive(frame);
    const { payloads, last } = replyOf(run, frame.message_id);
    const text = payloads.map((p) => p.text).join('');
    expect(run.uploads).toHaveLength(0);
    expect(last.file_ids).toBeUndefined();
    expect(linesWith(text, 'big.png')).toHaveLength(1);
    expect(linesWith(text, 'none.png')).toHaveLength(1);
  });

  it('a file whose upload fails is left out and the reply says so', async () => {
    const run = setup(
      {},
      {
        upload: (n) =>
          n === 1
            ? new Response(JSON.stringify({ error: { code: 'storage_full', message: 'x' } }), {
                status: 507,
              })
            : okUpload('fil_okxxxxxxxxxxxxxxxxxx'),
        async *agent() {
          yield agentFile('one.png', PNG);
          yield agentFile('two.png', PNG);
          await Promise.resolve();
        },
      },
    );
    const frame = run.frame({ text: 'draw' });
    await run.chats.receive(frame);
    const { payloads, last } = replyOf(run, frame.message_id);
    expect(payloads.at(-1)!.files!.map((f) => f.name)).toEqual(['one.png']);
    expect(last.file_ids).toEqual([fileId('fil_okxxxxxxxxxxxxxxxxxx')]);
    const text = payloads.map((p) => p.text).join('');
    expect(linesWith(text, 'two.png')).toHaveLength(1);
    expect(text).not.toContain('one.png');
  });

  it('files past the fifth get one line each and are not uploaded', async () => {
    const run = setup(
      {},
      {
        async *agent() {
          for (let i = 0; i < 7; i++) yield agentFile(`f${i}.png`, PNG);
          await Promise.resolve();
        },
      },
    );
    const frame = run.frame({ text: 'x' });
    await run.chats.receive(frame);
    const { payloads, last } = replyOf(run, frame.message_id);
    expect(run.uploads).toHaveLength(5);
    expect(last.file_ids).toHaveLength(5);
    const text = payloads.map((p) => p.text).join('');
    expect(linesWith(text, 'f5.png')).toHaveLength(1);
    expect(linesWith(text, 'f6.png')).toHaveLength(1);
  });

  it('a stop during file uploads cancels them and sends no files', async () => {
    let seen: AbortSignal | undefined;
    let started!: () => void;
    const uploading = new Promise<void>((resolve) => (started = resolve));
    const run = setup(
      {},
      {
        async *agent() {
          yield { type: 'text', text: 'partial' };
          yield agentFile('one.png', PNG);
          yield agentFile('two.png', PNG);
          await Promise.resolve();
        },
        uploadFetch: (init) => {
          seen = init.signal ?? undefined;
          started();
          return new Promise<Response>((_resolve, reject) =>
            seen?.addEventListener('abort', () => reject(new Error('aborted')), { once: true }),
          );
        },
      },
    );
    const frame = run.frame({ text: 'draw' });
    const turn = run.chats.receive(frame);
    await uploading;
    await run.chats.receive({ type: 'sealed.cancel', agent: AGENT, turn_id: frame.message_id });
    await turn;
    expect(seen?.aborted).toBe(true);
    expect(run.uploads).toHaveLength(1);
    const { payloads, last } = replyOf(run, frame.message_id);
    expect(last.file_ids).toBeUndefined();
    expect(payloads.at(-1)!.files).toBeUndefined();
    expect(payloads.map((p) => p.text).join('')).not.toContain('Could not send');
  });

  it('logs carry counts only, never names or keys', async () => {
    const run = setup(
      {},
      {
        async *agent() {
          yield agentFile('secret-chart.png', PNG);
          await Promise.resolve();
        },
      },
    );
    const frame = run.frame({ text: 'x' });
    await run.chats.receive(frame);
    const log = run.logs.join('\n');
    expect(log).not.toContain('secret-chart');
    expect(log).not.toContain(replyOf(run, frame.message_id).payloads.at(-1)!.files![0]!.key);
  });
});

describe('hello features', () => {
  it('says sealed_files once a phone is trusted', () => {
    const phoneKeys = generateSealKeyPair();
    const e2e: E2eConfig = {
      ...ensureDeviceKey(baseConfig).config.e2e!,
      devices: [
        {
          id: deviceIdFor(phoneKeys.publicKey),
          kind: 'phone',
          name: 'Pixel',
          public_key: base64urlEncode(phoneKeys.publicKey),
          verified_at: '2026-11-24T00:00:00.000Z',
        },
      ],
    };
    expect(helloFeatures(e2e)).toContain(SEALED_FILES_FEATURE);
    expect(helloFeatures(undefined)).not.toContain(SEALED_FILES_FEATURE);
  });
});
