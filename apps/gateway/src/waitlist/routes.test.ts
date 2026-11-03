import { Writable } from 'node:stream';

import { loadGatewayEnv } from '@twring/config/gateway';
import { WAITLIST_MAX_ENTRIES } from '@twring/contracts';
import { gatewayEnvFixture } from '@twring/test-fixtures';
import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildApp } from '../app';
import { createRequestAuth } from '../auth';
import { FixedWindowLimiter } from '../rate-limit';
import { MemoryCollection } from '../store/collection';

import { registerWaitlistRoutes, type WaitlistRecord } from './routes';
import type { NewSignup } from './notify';

const apps: ReturnType<typeof buildApp>[] = [];
const origin = 'https://twring.com';

function makeApp(
  options: {
    records?: MemoryCollection<WaitlistRecord>;
    limiter?: FixedWindowLimiter;
    onNewSignup?: (signup: NewSignup) => Promise<void>;
  } = {},
) {
  const records = options.records ?? new MemoryCollection<WaitlistRecord>();
  const app = buildApp({
    env: loadGatewayEnv(gatewayEnvFixture()),
    waitlist: {
      records,
      allowedOrigins: [origin],
      ...(options.limiter && { limiter: options.limiter }),
      ...(options.onNewSignup && { onNewSignup: options.onNewSignup }),
    },
  });
  apps.push(app);
  return { app, records };
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe('POST /v1/waitlist', () => {
  it('notifies once for a new signup with the stored timestamp and total', async () => {
    const onNewSignup = vi.fn((_signup: NewSignup) => Promise.resolve());
    const { app, records } = makeApp({ onNewSignup });
    const response = await app.inject({
      method: 'POST',
      url: '/v1/waitlist',
      payload: { email: 'New@Example.com', source: 'beta' },
    });
    expect(response.statusCode).toBe(202);
    expect(onNewSignup).toHaveBeenCalledExactlyOnceWith({
      email: 'new@example.com',
      source: 'beta',
      createdAt: (await records.read())[0]!.created_at,
      total: 1,
    });
  });

  it('does not notify for a case-insensitive duplicate or invalid email', async () => {
    const onNewSignup = vi.fn((_signup: NewSignup) => Promise.resolve());
    const { app } = makeApp({ onNewSignup });
    const post = (email: string) =>
      app.inject({ method: 'POST', url: '/v1/waitlist', payload: { email } });
    expect((await post('new@example.com')).statusCode).toBe(202);
    expect((await post('NEW@EXAMPLE.COM')).statusCode).toBe(202);
    expect((await post('invalid')).statusCode).toBe(400);
    expect(onNewSignup).toHaveBeenCalledTimes(1);
  });

  it('replies before notification settles and ignores notification rejection', async () => {
    const pending = vi.fn((_signup: NewSignup) => new Promise<void>(() => undefined));
    const { app } = makeApp({ onNewSignup: pending });
    const response = await Promise.race([
      app.inject({ method: 'POST', url: '/v1/waitlist', payload: { email: 'first@example.com' } }),
      new Promise<never>((_resolve, reject) =>
        setTimeout(() => reject(new Error('response waited for notification')), 1000),
      ),
    ]);
    expect(response.statusCode).toBe(202);
    expect(pending).toHaveBeenCalledTimes(1);

    const rejecting = vi.fn((_signup: NewSignup) => Promise.reject(new Error('notify failure')));
    const lines: string[] = [];
    const sink = new Writable({
      write(chunk: Buffer, _encoding, callback) {
        lines.push(chunk.toString());
        callback();
      },
    });
    const second = Fastify({ logger: { level: 'info', stream: sink } });
    apps.push(second);
    registerWaitlistRoutes(second, {
      records: new MemoryCollection(),
      allowedOrigins: [origin],
      onNewSignup: rejecting,
    });
    const rejectedResponse = await second.inject({
      method: 'POST',
      url: '/v1/waitlist',
      payload: { email: 'second@example.com' },
    });
    expect(rejectedResponse.statusCode).toBe(202);
    expect(rejecting).toHaveBeenCalledTimes(1);
    expect(
      lines.map((line) => JSON.parse(line) as { level: number }).some((line) => line.level >= 50),
    ).toBe(false);
  });
  it('accepts a valid email and stores a normalized record', async () => {
    const { app, records } = makeApp();
    const response = await app.inject({
      method: 'POST',
      url: '/v1/waitlist',
      payload: { email: '  Me@Example.com  ' },
    });
    expect(response.statusCode).toBe(202);
    expect(response.json()).toEqual({ status: 'ok' });
    expect(await records.read()).toHaveLength(1);
    expect((await records.read())[0]).toMatchObject({ email: 'me@example.com', source: 'landing' });
    expect(Number.isNaN(Date.parse((await records.read())[0]!.created_at))).toBe(false);
  });

  it('records signups from the beta download page with source beta', async () => {
    const { app, records } = makeApp();
    const response = await app.inject({
      method: 'POST',
      url: '/v1/waitlist',
      payload: { email: 'tester@example.com', source: 'beta' },
    });
    expect(response.statusCode).toBe(202);
    expect((await records.read())[0]).toMatchObject({
      email: 'tester@example.com',
      source: 'beta',
    });
    const unknown = await app.inject({
      method: 'POST',
      url: '/v1/waitlist',
      payload: { email: 'other@example.com', source: 'ads' },
    });
    expect(unknown.statusCode).toBe(400);
  });

  it('gives duplicates, including upper-case duplicates, the same response and stores one record', async () => {
    const { app, records } = makeApp();
    const post = (email: string) =>
      app.inject({ method: 'POST', url: '/v1/waitlist', payload: { email } });
    const first = await post('me@example.com');
    const second = await post('me@example.com');
    const third = await post('ME@EXAMPLE.COM');
    expect([first.statusCode, second.statusCode, third.statusCode]).toEqual([202, 202, 202]);
    expect(second.body).toBe(first.body);
    expect(third.body).toBe(first.body);
    expect(await records.read()).toHaveLength(1);
  });

  it('rejects invalid email and oversized bodies', async () => {
    const onNewSignup = vi.fn((_signup: NewSignup) => Promise.resolve());
    const { app } = makeApp({ onNewSignup });
    const invalid = await app.inject({
      method: 'POST',
      url: '/v1/waitlist',
      payload: { email: 'bad' },
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json()).toMatchObject({
      error: { code: 'invalid_email', message: 'Enter a valid email address.' },
    });
    const large = await app.inject({
      method: 'POST',
      url: '/v1/waitlist',
      payload: { email: 'a@example.com', padding: 'x'.repeat(3_000) },
    });
    expect(large.statusCode).toBe(413);
    expect(onNewSignup).not.toHaveBeenCalled();
  });

  it('uses invalid_email for malformed JSON', async () => {
    const { app } = makeApp();
    const response = await app.inject({
      method: 'POST',
      url: '/v1/waitlist',
      headers: { 'content-type': 'application/json', origin },
      payload: '{',
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: { code: 'invalid_email' } });
    expect(response.headers['access-control-allow-origin']).toBe(origin);
  });

  it('limits the sixth request per IP in an hour', async () => {
    const onNewSignup = vi.fn((_signup: NewSignup) => Promise.resolve());
    const { app } = makeApp({
      limiter: new FixedWindowLimiter(5, 60 * 60_000, () => 0),
      onNewSignup,
    });
    const responses = await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        app.inject({
          method: 'POST',
          url: '/v1/waitlist',
          payload: { email: `person${i}@example.com` },
        }),
      ),
    );
    expect(responses.slice(0, 5).map((response) => response.statusCode)).toEqual([
      202, 202, 202, 202, 202,
    ]);
    expect(responses[5]!.statusCode).toBe(429);
    expect(responses[5]!.json()).toMatchObject({ error: { code: 'rate_limited' } });
    expect(onNewSignup).toHaveBeenCalledTimes(5);
  });

  it('rejects new email at capacity but still accepts an existing one', async () => {
    const records = new MemoryCollection<WaitlistRecord>();
    await records.update(() => ({
      items: Array.from({ length: WAITLIST_MAX_ENTRIES }, (_, i) => ({
        email: `p${i}@example.com`,
        created_at: '2026-01-01T00:00:00.000Z',
        source: 'landing' as const,
      })),
      result: undefined,
    }));
    const onNewSignup = vi.fn((_signup: NewSignup) => Promise.resolve());
    const { app } = makeApp({ records, onNewSignup });
    const fresh = await app.inject({
      method: 'POST',
      url: '/v1/waitlist',
      payload: { email: 'new@example.com' },
    });
    const duplicate = await app.inject({
      method: 'POST',
      url: '/v1/waitlist',
      payload: { email: 'p0@example.com' },
    });
    expect(fresh.statusCode).toBe(503);
    expect(fresh.json()).toMatchObject({ error: { code: 'waitlist_full' } });
    expect(duplicate.statusCode).toBe(202);
    expect(await records.read()).toHaveLength(WAITLIST_MAX_ENTRIES);
    expect(onNewSignup).not.toHaveBeenCalled();
  });

  it('sets CORS headers on allowed preflight and POST', async () => {
    const { app } = makeApp();
    const preflight = await app.inject({
      method: 'OPTIONS',
      url: '/v1/waitlist',
      headers: { origin },
    });
    expect(preflight.statusCode).toBe(204);
    expect(preflight.headers).toMatchObject({
      'access-control-allow-origin': origin,
      'access-control-allow-methods': 'POST',
      'access-control-allow-headers': 'content-type',
      'access-control-max-age': '600',
      vary: 'Origin',
    });
    const post = await app.inject({
      method: 'POST',
      url: '/v1/waitlist',
      headers: { origin },
      payload: { email: 'a@example.com' },
    });
    expect(post.headers).toMatchObject({ 'access-control-allow-origin': origin, vary: 'Origin' });
  });

  it('omits Allow-Origin for a disallowed preflight and rejects its POST without storing', async () => {
    const onNewSignup = vi.fn((_signup: NewSignup) => Promise.resolve());
    const { app, records } = makeApp({ onNewSignup });
    const headers = { origin: 'https://other.example' };
    const preflight = await app.inject({ method: 'OPTIONS', url: '/v1/waitlist', headers });
    expect(preflight.statusCode).toBe(204);
    expect(preflight.headers['access-control-allow-origin']).toBeUndefined();
    const post = await app.inject({
      method: 'POST',
      url: '/v1/waitlist',
      headers,
      payload: { email: 'a@example.com' },
    });
    expect(post.statusCode).toBe(403);
    expect(post.json()).toMatchObject({ error: { code: 'origin_not_allowed' } });
    expect(await records.read()).toEqual([]);
    expect(onNewSignup).not.toHaveBeenCalled();
  });

  it('accepts an Origin-free POST without a user token when authentication is active', async () => {
    const records = new MemoryCollection<WaitlistRecord>();
    const app = buildApp({
      env: loadGatewayEnv(gatewayEnvFixture()),
      auth: createRequestAuth(() => Promise.reject(new Error('no token'))),
      waitlist: { records, allowedOrigins: [origin] },
    });
    apps.push(app);
    const response = await app.inject({
      method: 'POST',
      url: '/v1/waitlist',
      payload: { email: 'a@example.com' },
    });
    expect(response.statusCode).toBe(202);
    expect(await records.read()).toHaveLength(1);
  });

  it('does not put the submitted email in logged lines', async () => {
    const lines: string[] = [];
    const sink = new Writable({
      write(chunk: Buffer, _encoding, callback) {
        lines.push(chunk.toString());
        callback();
      },
    });
    const app = Fastify({ logger: { level: 'info', stream: sink } });
    registerWaitlistRoutes(app, {
      records: new MemoryCollection(),
      allowedOrigins: [origin],
    });
    const response = await app.inject({
      method: 'POST',
      url: '/v1/waitlist',
      payload: { email: 'secret@example.com' },
    });
    await app.close();
    expect(response.statusCode).toBe(202);
    expect(lines.join('')).toContain('waitlist_joined');
    expect(lines.join('')).not.toContain('secret@example.com');
  });

  it('serializes concurrent duplicate submissions', async () => {
    const { app, records } = makeApp();
    const responses = await Promise.all(
      Array.from({ length: 5 }, () =>
        app.inject({ method: 'POST', url: '/v1/waitlist', payload: { email: 'a@example.com' } }),
      ),
    );
    expect(responses.map((response) => response.statusCode)).toEqual([202, 202, 202, 202, 202]);
    expect(await records.read()).toHaveLength(1);
  });
});
