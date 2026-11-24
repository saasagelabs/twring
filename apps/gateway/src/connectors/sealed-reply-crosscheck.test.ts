/* eslint-disable @typescript-eslint/no-unsafe-member-access -- Fastify inject JSON is untyped. */
/** A private reply from the real connector splitter, stored by the gateway and opened by the phone. */
import { randomUUID } from 'node:crypto';

import {
  base64urlEncode,
  deviceIdFor,
  generateSealKeyPair,
  messagePageResponseSchema,
  SEALED_CHAT_FEATURE,
  type ThreadMessage,
} from '@twring/contracts';
import { afterEach, describe, expect, it } from 'vitest';

import {
  ensureDeviceKey,
  type E2eConfig,
  type TrustedDevice,
} from '../../../connector/src/e2e/keys';
import { openIncoming, ReplayWindow, sealOutgoing } from '../../../connector/src/e2e/sealed';
import { baseConfig } from '../../../connector/src/e2e/test-fixtures';
import { PrivateChats } from '../../../connector/src/e2e/turn';
import { ResultOutbox } from '../../../connector/src/outbox';

import { startConnectorGateway, type ConnectorGateway } from './harness';

const gateways: ConnectorGateway[] = [];
afterEach(async () => {
  await Promise.all(gateways.splice(0).map((g) => g.close()));
});
async function waitFor(check: () => boolean | Promise<boolean>, ms = 10_000) {
  const until = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > until) throw new Error('condition not met in time');
    await new Promise((r) => setTimeout(r, 10));
  }
}

async function run(pieces: string[], tick = 0) {
  const g = await startConnectorGateway({
    threads: {},
    ring: {},
    env: { PRIVATE_CHATS_ENABLED: 'true', THREADS_ENABLED: 'true' },
  });
  gateways.push(g);
  const { connectorId, connector } = await g.connect('u1', { features: [SEALED_CHAT_FEATURE] });
  const agentId = await g.createAgent('u1', connectorId);
  await g.send('PUT', `/v1/agents/${agentId}/private`, {
    user: 'u1',
    body: { on: true },
    headers: { 'x-twring-features': SEALED_CHAT_FEATURE },
  });
  const AGENT = 'claude-code';
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
  const phoneCtx = {
    accountId: baseConfig.connector_id,
    agentId: AGENT,
    myDeviceId: phone.id,
    myPublic: phone.public_key,
    myPrivate: phoneKeys.privateKey,
    trusted: [computer],
    seen: new ReplayWindow(),
  };
  let clock = 0;
  let frames = 0;
  let maxBytes = 0;
  const chats = new PrivateChats({
    connectorId: baseConfig.connector_id,
    e2e: () => e2e,
    persist: (change) => {
      e2e = change(e2e);
      return Promise.resolve(e2e);
    },
    pool: {
      acquire: () => ({
        // eslint-disable-next-line @typescript-eslint/require-await
        async *sendTurn() {
          for (const text of pieces) yield { type: 'text' as const, text };
        },
        close: () => undefined,
      }),
      release: () => undefined,
      runExclusive: (_a, fn) => fn(),
    },
    send: (frame) => {
      frames++;
      maxBytes = Math.max(maxBytes, Buffer.byteLength(JSON.stringify(frame)));
      connector.send(frame);
      return true;
    },
    outbox: new ResultOutbox(),
    now: () => (clock += tick),
  });
  const posted = await g.send('POST', `/v1/agents/${agentId}/messages`, {
    user: 'u1',
    body: { client_id: randomUUID(), sealed: sealOutgoing(phoneCtx, { text: 'hi' }, 1) },
  });
  const turnId = posted.json().message.id as string;
  await waitFor(() => connector.sealed.length === 1);
  await chats.receive(connector.sealed[0]!);
  const list = async () =>
    messagePageResponseSchema.parse(
      (await g.send('GET', `/v1/agents/${agentId}/messages`, { user: 'u1' })).json(),
    ).messages;
  const reply = async () =>
    (await list()).find(
      (m): m is Extract<ThreadMessage, { kind: 'sealed' }> =>
        m.kind === 'sealed' && m.author === 'agent',
    );
  await waitFor(
    async () =>
      (await reply())?.sealed.length === frames || g.threads!.service.sealedRepliesRejected > 0,
  );
  await new Promise((r) => setTimeout(r, 200));
  const stored = await reply();
  const text = (stored?.sealed ?? [])
    .map((env) => {
      const opened = openIncoming({ ...phoneCtx, seen: new ReplayWindow() }, env);
      if (!opened.ok) throw new Error(opened.reason);
      return opened.payload.text;
    })
    .join('');
  const user = (await list()).find((m) => m.id === turnId);
  return {
    frames,
    maxBytes,
    storedChunks: stored?.sealed.length ?? 0,
    totalBody: (stored?.sealed ?? []).reduce((s, e) => s + e.body.length, 0),
    rejected: g.threads!.service.sealedRepliesRejected,
    text,
    status: user?.kind === 'sealed' ? user.status : undefined,
  };
}

describe('a long private reply, split by the connector', () => {
  const cases: [string, string[], number][] = [
    ['20,000 units of 4-byte characters', ['\u{1F600}'.repeat(10_000)], 0],
    ['20,000 escaped control characters', ['\u0001'.repeat(20_000)], 0],
    ['mixed text near the cap', [('a\u0001\u{1F600}"\\é中' + 'x'.repeat(9)).repeat(1_250)], 0],
  ];
  for (const [name, pieces, tick] of cases) {
    it(
      name,
      async () => {
        const r = await run(pieces, tick);
        const expected = pieces.join('').slice(0, 20_000);
        expect(r.rejected).toBe(0);
        expect(r.storedChunks).toBe(r.frames);
        expect(r.text).toBe(expected);
        expect(r.status).toBe('answered');
      },
      30_000,
    );
  }
});
