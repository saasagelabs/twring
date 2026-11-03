import { Writable } from 'node:stream';

import { ConfigError, loadGatewayEnv } from '@twring/config/gateway';
import type { ErrorEvent } from '@sentry/node';
import { gatewayEnvFixture } from '@twring/test-fixtures';
import { afterEach, describe, expect, it } from 'vitest';

import { buildApp } from './app';
import { createLoggerOptions } from './logger';
import {
  SafeMessageError,
  SanitizedErrorCopy,
  redactSecrets,
  safeUrl,
  sanitizeError,
  toSafeError,
} from './redact';
import { scrubBreadcrumb, scrubEvent } from './sentry';

const SECRET = 'fake-provider-secret-0123456789abcdef';

describe('sanitizeError (allowlist policy)', () => {
  it('withholds an arbitrary message even when no secret pattern matches', () => {
    const sanitized = sanitizeError(new Error('database password is hunter2'));
    expect(JSON.stringify(sanitized)).not.toContain('hunter2');
    expect(sanitized).toMatchObject({
      name: 'Error',
      message: 'Error: message withheld by log policy',
      messageWithheld: true,
    });
  });

  it('keeps only stack frames, because V8 repeats the message on the first stack line', () => {
    const error = new Error(`multi-line\nsecret on line two ${SECRET}`);
    const sanitized = sanitizeError(error);
    expect(sanitized.stack).toMatch(/^\s+at /);
    expect(sanitized.stack).not.toContain(SECRET);
  });

  it('keeps safe name/code/statusCode, drops other fields, and sanitizes causes', () => {
    const cause = new Error(`upstream said ${SECRET}`);
    const error = Object.assign(new TypeError(`request failed ${SECRET}`, { cause }), {
      code: 'ECONNRESET',
      statusCode: 502,
      config: { headers: { authorization: SECRET } },
    });

    const sanitized = sanitizeError(error);

    expect(JSON.stringify(sanitized)).not.toContain(SECRET);
    expect(sanitized).toMatchObject({
      name: 'TypeError',
      code: 'ECONNRESET',
      statusCode: 502,
      message: 'TypeError [ECONNRESET]: message withheld by log policy',
    });
    expect(sanitized).not.toHaveProperty('config');
    expect(sanitized.cause?.messageWithheld).toBe(true);
  });

  it('does not trust attacker-shaped name or code values', () => {
    const error = Object.assign(new Error('x'), { code: `bad code ${SECRET}` });
    error.name = `Name with ${SECRET}`;
    const sanitized = sanitizeError(error);
    expect(JSON.stringify(sanitized)).not.toContain(SECRET);
    expect(sanitized.name).toBe('Error');
    expect(sanitized.code).toBeUndefined();
  });

  it('records only the type of non-Error throwables', () => {
    expect(JSON.stringify(sanitizeError(`thrown string ${SECRET}`))).not.toContain(SECRET);
    expect(JSON.stringify(sanitizeError({ apiKey: SECRET }))).not.toContain(SECRET);
  });

  it('keeps Twring-authored safe messages', () => {
    expect(
      sanitizeError(new SafeMessageError('adapter_timeout', 'Agent did not answer in 30s.')),
    ).toMatchObject({
      message: 'Agent did not answer in 30s.',
      code: 'adapter_timeout',
      messageWithheld: false,
    });
    expect(sanitizeError(new ConfigError(['PORT: must be a number'])).message).toContain(
      'PORT: must be a number',
    );
  });

  it('is idempotent across toSafeError round-trips', () => {
    const safe = toSafeError(new SafeMessageError('x', 'safe text'));
    expect(toSafeError(safe)).toBe(safe);
    expect(sanitizeError(safe).message).toBe('safe text');
    const withheld = toSafeError(new Error('database password is hunter2'));
    expect(`${withheld.message}\n${withheld.stack ?? ''}`).not.toContain('hunter2');
  });
});

describe('safeUrl', () => {
  it('drops query strings and fragments', () => {
    expect(safeUrl(`/boom?token=${SECRET}`)).toBe('/boom?[query omitted]');
    expect(safeUrl(`/a#${SECRET}`)).toBe('/a?[query omitted]');
    expect(safeUrl('/health/live')).toBe('/health/live');
  });
});

describe('redactSecrets (defense in depth for allowlisted text)', () => {
  it.each([
    [`Authorization failed: Bearer ${SECRET}`, 'Bearer [REDACTED]'],
    [`connect wss://user:${SECRET}@host.example/ws`, 'wss://[REDACTED]@host.example'],
    [`{"api_key":"${SECRET}"}`, '"api_key":"[REDACTED]"'],
    [`key sk-proj-${SECRET} rejected`, 'key [REDACTED] rejected'],
  ])('redacts %s', (input, expected) => {
    const output = redactSecrets(input);
    expect(output).toContain(expected);
    expect(output).not.toContain(SECRET);
  });
});

describe('Sentry scrubbing', () => {
  function eventWith(value: string): ErrorEvent {
    return {
      type: undefined,
      message: `free text ${SECRET}`,
      exception: { values: [{ type: 'Error', value }] },
      breadcrumbs: [{ category: 'console', message: `log ${SECRET}`, data: { url: SECRET } }],
      request: {
        url: `https://gw.example/x?token=${SECRET}`,
        headers: { authorization: SECRET },
        data: SECRET,
      },
    };
  }

  it('withholds exception text from events the SDK captured on its own', () => {
    const scrubbed = scrubEvent(eventWith('database password is hunter2'), {
      originalException: new Error('database password is hunter2'),
    });
    const json = JSON.stringify(scrubbed);
    expect(json).not.toContain('hunter2');
    expect(json).not.toContain(SECRET);
    expect(scrubbed.request?.url).toBe('https://gw.example/x?[query omitted]');
    expect(scrubbed.breadcrumbs?.[0]).toEqual({ category: 'console' });
  });

  it('keeps the controlled text of a sanitized copy from captureError', () => {
    const safe = toSafeError(new SafeMessageError('adapter_timeout', 'Agent did not answer.'));
    const scrubbed = scrubEvent(eventWith(safe.message), { originalException: safe });
    expect(scrubbed.exception?.values?.[0]?.value).toBe('Agent did not answer.');
    expect(safe).toBeInstanceOf(SanitizedErrorCopy);
  });

  it('drops any user and extras an integration attached', () => {
    const event = {
      ...eventWith('x'),
      user: { email: 'someone@example.com', ip_address: '203.0.113.9' },
      extra: { transcript: 'what the caller said' },
    };
    const json = JSON.stringify(scrubEvent(event));
    expect(json).not.toContain('someone@example.com');
    expect(json).not.toContain('what the caller said');
  });

  it('strips breadcrumb message and data', () => {
    expect(scrubBreadcrumb({ category: 'http', message: SECRET, data: { url: SECRET } })).toEqual({
      category: 'http',
    });
  });
});

describe('gateway error handler', () => {
  const apps: ReturnType<typeof buildApp>[] = [];
  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });

  function appWithCapture() {
    const lines: string[] = [];
    const stream = new Writable({
      write(chunk: Buffer, _encoding, callback) {
        lines.push(chunk.toString());
        callback();
      },
    });
    const reported: Error[] = [];
    const env = loadGatewayEnv(gatewayEnvFixture({ LOG_LEVEL: 'info' }));
    const app = buildApp({
      env,
      logger: { ...createLoggerOptions(env), stream },
      onError: (error) => reported.push(error),
    });
    apps.push(app);
    return { app, lines, reported };
  }

  it('regression: "database password is hunter2" never reaches logs, reports, or the response', async () => {
    const { app, lines, reported } = appWithCapture();
    app.get('/boom', () => {
      throw new Error('database password is hunter2');
    });

    const res = await app.inject({ method: 'GET', url: `/boom?token=${SECRET}` });

    expect(res.statusCode).toBe(500);
    expect(res.body).not.toContain('hunter2');
    const logOutput = lines.join('');
    expect(logOutput).toContain('unhandled error');
    expect(logOutput).toContain('message withheld by log policy');
    expect(logOutput).not.toContain('hunter2');
    expect(logOutput).not.toContain(SECRET);
    expect(reported).toHaveLength(1);
    const [report] = reported;
    expect(`${report?.message}\n${report?.stack ?? ''}`).not.toContain('hunter2');
    // What Sentry would send for this report:
    const event = scrubEvent(
      { type: undefined, exception: { values: [{ type: 'Error', value: report?.message }] } },
      { originalException: report },
    );
    expect(JSON.stringify(event)).not.toContain('hunter2');
  });

  it('logs Twring-authored safe messages in full', async () => {
    const { app, lines } = appWithCapture();
    app.get('/timeout', () => {
      throw new SafeMessageError('adapter_timeout', 'Agent did not answer in 30s.');
    });

    await app.inject({ method: 'GET', url: '/timeout' });

    expect(lines.join('')).toContain('Agent did not answer in 30s.');
  });
});
