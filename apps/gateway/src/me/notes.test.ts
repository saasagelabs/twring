import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadGatewayEnv } from '@twring/config/gateway';
import { appFeedbackResponseSchema } from '@twring/contracts';
import { gatewayEnvFixture } from '@twring/test-fixtures';
import { afterEach, describe, expect, it } from 'vitest';

import { buildApp } from '../app';
import { AuthError, createRequestAuth } from '../auth';
import { MemoryCollection } from '../store/collection';
import { createMemoryStores } from '../store/repositories';
import { MAX_NOTES_PER_USER, NoteStore, type AppNote } from './notes';

const keys = { currentVersion: 1, keys: new Map([[1, Buffer.alloc(32, 9).toString('base64')]]) };
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const task of cleanup.splice(0)) await task();
});

function note(user: string, at: string, text = 'hello'): AppNote {
  return { id: `note_${'a'.repeat(20)}`, user_id: user, note: text, created_at: at };
}

describe('NoteStore', () => {
  it('keeps each person their newest notes, and deletes theirs only', async () => {
    const rows = new MemoryCollection<AppNote>();
    const store = new NoteStore(rows);
    for (let i = 0; i < MAX_NOTES_PER_USER + 3; i += 1) {
      await store.add(note('alice', new Date(Date.UTC(2026, 9, 23, 0, i)).toISOString(), `n${i}`));
    }
    await store.add(note('bob', '2026-10-23T09:00:00.000Z'));
    const alice = (await rows.read()).filter((r) => r.user_id === 'alice');
    expect(alice).toHaveLength(MAX_NOTES_PER_USER);
    expect(alice.some((r) => r.note === 'n0')).toBe(false);
    expect(await store.deleteAllForUser('alice')).toBe(MAX_NOTES_PER_USER);
    expect(await rows.read()).toHaveLength(1);
  });
});

async function server() {
  const dir = await mkdtemp(join(tmpdir(), 'cord-notes-'));
  const app = buildApp({
    env: loadGatewayEnv(gatewayEnvFixture({ CORD_DATA_DIR: dir })),
    agents: {
      stores: createMemoryStores(keys),
      policy: { env: 'development', lookup: () => Promise.resolve([]) },
      writeRatePerMinute: 100,
    },
    me: { deleteRatePerMinute: 100 },
    auth: createRequestAuth((request) => {
      const token = request.headers.authorization;
      if (!token) throw new AuthError(401, 'auth_required', 'Sign in.');
      const user = token === 'Bearer bob' ? 'bob' : 'alice';
      return Promise.resolve({ id: user, email: `${user}@example.com` });
    }),
    onError: () => undefined,
  });
  cleanup.push(async () => {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  });
  const send = (
    payload: unknown,
    authorization = 'Bearer alice',
    headers: Record<string, string> = {},
  ) =>
    app.inject({
      method: 'POST',
      url: '/v1/me/feedback',
      headers: { authorization, 'x-app-version': '0.1.0 (12) ios', ...headers },
      payload: payload as Record<string, unknown>,
    });
  const stored = async (): Promise<AppNote[]> => {
    try {
      return JSON.parse(await readFile(join(dir, 'app-notes.json'), 'utf8')) as AppNote[];
    } catch {
      return [];
    }
  };
  return { app, send, stored };
}

describe('POST /v1/me/feedback', () => {
  it('keeps the note with the account email (to reply) and the app version', async () => {
    const { send, stored } = await server();
    const res = await send({ note: '  The ring was too quiet on my Pixel.  ' });
    expect(res.statusCode).toBe(200);
    expect(appFeedbackResponseSchema.parse(res.json())).toEqual({ ok: true });
    expect(await stored()).toMatchObject([
      {
        user_id: 'alice',
        email: 'alice@example.com',
        note: 'The ring was too quiet on my Pixel.',
        app_version: '0.1.0 (12) ios',
      },
    ]);
  });

  it('refuses an empty or very long note, and a request without sign-in', async () => {
    const { send } = await server();
    expect((await send({ note: '   ' })).statusCode).toBe(400);
    expect((await send({ note: 'x'.repeat(1001) })).statusCode).toBe(400);
    expect((await send({})).statusCode).toBe(400);
    expect((await send({ note: 'hi' }, '')).statusCode).toBe(401);
  });

  it('takes five notes an hour from one person', async () => {
    const { send } = await server();
    for (let i = 0; i < 5; i += 1) expect((await send({ note: `n${i}` })).statusCode).toBe(200);
    const sixth = await send({ note: 'n5' });
    expect(sixth.statusCode).toBe(429);
    expect((await send({ note: 'from bob' }, 'Bearer bob')).statusCode).toBe(200);
  });

  it('deleting my data deletes my notes', async () => {
    const { app, send, stored } = await server();
    await send({ note: 'mine' });
    await send({ note: 'his' }, 'Bearer bob');
    const deleted = await app.inject({
      method: 'DELETE',
      url: '/v1/me/data',
      headers: { authorization: 'Bearer alice' },
    });
    expect(deleted.statusCode).toBe(200);
    expect((await stored()).map((n) => n.user_id)).toEqual(['bob']);
  });
});
