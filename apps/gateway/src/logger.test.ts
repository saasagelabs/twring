import { Writable } from 'node:stream';

import { loadGatewayEnv } from '@twring/config/gateway';
import { gatewayEnvFixture } from '@twring/test-fixtures';
import { pino } from 'pino';
import { describe, expect, it } from 'vitest';

import { REDACTED_LOG_PATHS, createLoggerOptions, setLogTap } from './logger';

describe('log redaction', () => {
  it('censors credentials in structured log fields', () => {
    const lines: string[] = [];
    const sink = new Writable({
      write(chunk: Buffer, _encoding, callback) {
        lines.push(chunk.toString());
        callback();
      },
    });
    const log = pino({ redact: { paths: REDACTED_LOG_PATHS, censor: '[REDACTED]' } }, sink);

    log.info(
      {
        req: { headers: { authorization: 'Bearer fake-bearer-token-123', cookie: 'sid=abc' } },
        agent: { apiKey: 'agent-key-123', name: 'visible' },
      },
      'test',
    );

    const output = lines.join('');
    expect(output).not.toContain('fake-bearer-token-123');
    expect(output).not.toContain('sid=abc');
    expect(output).not.toContain('agent-key-123');
    expect(output).toContain('visible');
  });
});

describe('log redaction edges', () => {
  function capture() {
    const lines: string[] = [];
    const sink = new Writable({
      write(chunk: Buffer, _encoding, callback) {
        lines.push(chunk.toString());
        callback();
      },
    });
    const env = loadGatewayEnv(gatewayEnvFixture({ LOG_LEVEL: 'info' }));
    const log = pino(createLoggerOptions(env), sink);
    return { log, output: () => lines.join('') };
  }

  it('censors header secrets however they are cased, including as Twring spells them', () => {
    const { log, output } = capture();
    // The provider adapters build exactly these header objects (Deepgram, Cartesia).
    log.info({ headers: { Authorization: 'Token dg-secret-1' } }, 'a');
    log.info({ headers: { 'X-API-Key': 'cartesia-secret-2' } }, 'b');
    log.info(
      { request: { headers: { 'X-Api-Key': 'mixed-secret-3', Cookie: 'sid=secret-4' } } },
      'c',
    );
    log.info({ Authorization: 'Bearer top-secret-5' }, 'd');
    const secrets = ['dg-secret-1', 'cartesia-secret-2', 'mixed-secret-3', 'secret-4'];
    expect(secrets.concat('top-secret-5').filter((s) => output().includes(s))).toEqual([]);
  });

  it('censors hyphenated header secrets nested under any object', () => {
    const { log, output } = capture();
    log.info({ socket: { headers: { 'x-api-key': 'nested-secret-6' } } }, 'e');
    log.info({ upstream: { headers: { 'proxy-authorization': 'Basic nested-secret-7' } } }, 'f');
    log.info({ response: { headers: { 'set-cookie': 'nested-secret-8' } } }, 'g');
    const secrets = ['nested-secret-6', 'nested-secret-7', 'nested-secret-8'];
    expect(secrets.filter((s) => output().includes(s))).toEqual([]);
  });

  it('censors secret fields inside arrays', () => {
    const { log, output } = capture();
    log.info({ agents: [{ name: 'shown', token: 'array-secret-8' }] }, 'g');
    expect(output()).not.toContain('array-secret-8');
    expect(output()).toContain('shown');
  });

  it('withholds secrets carried by an error, its properties, and its cause chain', () => {
    const { log, output } = capture();
    const cause = Object.assign(new Error('upstream said password=cause-secret-9'), {
      config: { headers: { Authorization: 'Bearer cause-secret-10' } },
    });
    const error = new Error('failed https://agent.example.com/x?token=url-secret-11', { cause });
    log.warn({ err: error }, 'h');
    for (const secret of ['cause-secret-9', 'cause-secret-10', 'url-secret-11']) {
      expect(output()).not.toContain(secret);
    }
  });

  it('logs URL fields without their query string', () => {
    const { log, output } = capture();
    log.info({ url: 'wss://agent.example.com/cord?token=query-secret-12' }, 'i');
    log.info({ endpoint_url: 'https://agent.example.com/cord?key=query-secret-13#frag' }, 'j');
    expect(output()).not.toContain('query-secret-12');
    expect(output()).not.toContain('query-secret-13');
    expect(output()).toContain('agent.example.com/cord');
  });
});

describe('log tap (owner alerts)', () => {
  it('sees each line with its level and fields, from children too, and can be removed', () => {
    const seen: [number, unknown][] = [];
    setLogTap((level, fields) => seen.push([level, fields]));
    try {
      const env = loadGatewayEnv(gatewayEnvFixture({ LOG_LEVEL: 'info' }));
      const log = pino(
        createLoggerOptions(env),
        new Writable({ write: (_chunk, _encoding, callback) => callback() }),
      );
      log.info({ event: 'call_failed' }, 'call failed');
      log.child({ component: 'ring' }).error('boom');
      expect(seen).toEqual([
        [30, { event: 'call_failed' }],
        [50, {}],
      ]);
    } finally {
      setLogTap(undefined);
    }
  });
});

describe('self-hosted ring relay secrets', () => {
  it('censors the relay key, device tickets, handles, proofs and seal keys', () => {
    const lines: string[] = [];
    const sink = new Writable({
      write(chunk: Buffer, _encoding, callback) {
        lines.push(chunk.toString());
        callback();
      },
    });
    const log = pino(createLoggerOptions(loadGatewayEnv(gatewayEnvFixture())), sink);
    log.info(
      {
        relay_key: 'twr_relaykey1',
        ticket: 'eyJticket2',
        handle: 'hdl_handle3',
        relay_handle: 'hdl_handle4',
        proof: 'eyJproof5',
        seal_key: 'sealkey6',
        nested: { relay_key: 'twr_relaykey7' },
      },
      'relay',
    );
    const output = lines.join('');
    for (const secret of [
      'relaykey1',
      'ticket2',
      'handle3',
      'handle4',
      'proof5',
      'sealkey6',
      'relaykey7',
    ]) {
      expect(output).not.toContain(secret);
    }
  });
});
