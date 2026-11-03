import { loadGatewayEnv } from '@twring/config/gateway';
import {
  errorResponseSchema,
  healthLiveResponseSchema,
  healthReadyResponseSchema,
} from '@twring/contracts';
import { gatewayEnvFixture } from '@twring/test-fixtures';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildApp, type BuildAppOptions } from './app';

const env = loadGatewayEnv(gatewayEnvFixture());
const apps: ReturnType<typeof buildApp>[] = [];

function makeApp(options: Partial<BuildAppOptions> = {}) {
  const app = buildApp({ env, onError: () => undefined, ...options });
  apps.push(app);
  return app;
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe('GET /health/live', () => {
  it('returns ok', async () => {
    const res = await makeApp().inject({ method: 'GET', url: '/health/live' });
    expect(res.statusCode).toBe(200);
    expect(healthLiveResponseSchema.parse(res.json())).toEqual({ status: 'ok' });
  });
});

describe('GET /health/ready', () => {
  it('is ready with no dependency checks and reports env/release', async () => {
    const res = await makeApp().inject({ method: 'GET', url: '/health/ready' });
    expect(res.statusCode).toBe(200);
    expect(healthReadyResponseSchema.parse(res.json())).toEqual({
      status: 'ready',
      environment: 'development',
      release: 'test-release',
      checks: {},
    });
  });

  it('returns 503 when a check rejects', async () => {
    const app = makeApp({
      readinessChecks: [
        { name: 'ok_dep', check: () => Promise.resolve() },
        { name: 'bad_dep', check: () => Promise.reject(new Error('down')) },
      ],
    });
    const res = await app.inject({ method: 'GET', url: '/health/ready' });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({
      status: 'not_ready',
      checks: { ok_dep: 'ok', bad_dep: 'failing' },
    });
  });

  it('treats a hung check as failing after the timeout and aborts it', async () => {
    let aborted = false;
    const app = makeApp({
      readinessTimeoutMs: 20,
      readinessChecks: [
        {
          name: 'hung_dep',
          check: (signal) =>
            new Promise<void>(() => {
              signal.addEventListener('abort', () => {
                aborted = true;
              });
            }),
        },
      ],
    });
    const res = await app.inject({ method: 'GET', url: '/health/ready' });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ checks: { hung_dep: 'failing' } });
    expect(aborted).toBe(true);
  });
});

describe('request correlation', () => {
  it('mints a request id when none is supplied', async () => {
    const res = await makeApp().inject({ method: 'GET', url: '/health/live' });
    expect(res.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('echoes a well-formed upstream request id', async () => {
    const res = await makeApp().inject({
      method: 'GET',
      url: '/health/live',
      headers: { 'x-request-id': 'req_abc-123' },
    });
    expect(res.headers['x-request-id']).toBe('req_abc-123');
  });

  it('replaces a malformed upstream request id', async () => {
    const res = await makeApp().inject({
      method: 'GET',
      url: '/health/live',
      headers: { 'x-request-id': 'bad id with spaces' },
    });
    expect(res.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe('errors', () => {
  it('returns the stable error shape for unknown routes', async () => {
    const res = await makeApp().inject({ method: 'GET', url: '/nope' });
    expect(res.statusCode).toBe(404);
    const body = errorResponseSchema.parse(res.json());
    expect(body.error.code).toBe('not_found');
    expect(body.error.request_id).toBe(res.headers['x-request-id']);
  });

  it('hides internal error details and reports them', async () => {
    const onError = vi.fn();
    const app = makeApp({ onError });
    app.get('/boom', () => {
      throw new Error('database password is hunter2');
    });
    const res = await app.inject({ method: 'GET', url: '/boom' });
    expect(res.statusCode).toBe(500);
    expect(res.body).not.toContain('hunter2');
    expect(errorResponseSchema.parse(res.json()).error.code).toBe('internal_error');
    expect(onError).toHaveBeenCalledOnce();
  });

  it('maps client errors to bad_request without reporting them', async () => {
    const onError = vi.fn();
    const app = makeApp({ onError });
    app.post('/echo', (request) => request.body);
    const res = await app.inject({
      method: 'POST',
      url: '/echo',
      headers: { 'content-type': 'application/json' },
      payload: '{not json',
    });
    expect(res.statusCode).toBe(400);
    expect(errorResponseSchema.parse(res.json()).error.code).toBe('bad_request');
    expect(onError).not.toHaveBeenCalled();
  });
});
