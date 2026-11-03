import { loadGatewayEnv } from '@twring/config/gateway';
import { healthLiveResponseSchema, healthReadyResponseSchema } from '@twring/contracts';
import { gatewayEnvFixture } from '@twring/test-fixtures';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from '../src/app';

// Exercises the real network stack (listen on an ephemeral port + fetch), not inject().
describe('gateway over HTTP', () => {
  const app = buildApp({ env: loadGatewayEnv(gatewayEnvFixture()), onError: () => undefined });
  let base = '';

  beforeAll(async () => {
    base = await app.listen({ host: '127.0.0.1', port: 0 });
  });

  afterAll(async () => {
    await app.close();
  });

  it('serves /health/live', async () => {
    const res = await fetch(`${base}/health/live`);
    expect(res.status).toBe(200);
    expect(healthLiveResponseSchema.parse(await res.json()).status).toBe('ok');
  });

  it('serves /health/ready', async () => {
    const res = await fetch(`${base}/health/ready`);
    expect(res.status).toBe(200);
    expect(healthReadyResponseSchema.parse(await res.json()).status).toBe('ready');
  });
});
