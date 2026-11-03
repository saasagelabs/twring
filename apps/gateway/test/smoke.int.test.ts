import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

// Runs scripts/smoke.mjs against fixture servers to prove it fails fast and never hangs.
const gatewayDir = fileURLToPath(new URL('..', import.meta.url));
const STARTUP_TIMEOUT_MS = 2_000;
const PROBE_TIMEOUT_MS = 500;
// Upper bound on a failing run: startup deadline plus process spawn/teardown slack.
const MAX_RUN_MS = STARTUP_TIMEOUT_MS + 3_000;

interface SmokeResult {
  code: number | null;
  output: string;
  elapsedMs: number;
}

function runSmoke(fixture: string): Promise<SmokeResult> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['scripts/smoke.mjs'], {
      cwd: gatewayDir,
      env: {
        ...process.env,
        SMOKE_ENTRY: `test/fixtures/smoke/${fixture}`,
        SMOKE_STARTUP_TIMEOUT_MS: String(STARTUP_TIMEOUT_MS),
        SMOKE_PROBE_TIMEOUT_MS: String(PROBE_TIMEOUT_MS),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (output += chunk.toString()));
    child.once('error', reject);
    child.once('exit', (code) => resolve({ code, output, elapsedMs: Date.now() - started }));
  });
}

describe('gateway smoke script', { timeout: 20_000 }, () => {
  it('passes against a gateway that echoes its release nonce (positive control)', async () => {
    const result = await runSmoke('good.mjs');
    expect(result.output).toContain('/health/ready -> 200');
    expect(result.code).toBe(0);
  });

  it.each([
    ['stall-headers.mjs', /did not respond within 2000ms \(last: (TimeoutError|AbortError)/],
    ['stall-body.mjs', /did not respond within 2000ms \(last: (TimeoutError|AbortError)/],
  ])('fails within the deadline when a probe stalls (%s)', async (fixture, message) => {
    const result = await runSmoke(fixture);
    expect(result.code).toBe(1);
    expect(result.output).toMatch(message);
    expect(result.elapsedMs).toBeLessThan(MAX_RUN_MS);
  });

  it('fails immediately when the gateway exits before responding', async () => {
    const result = await runSmoke('exit-early.mjs');
    expect(result.code).toBe(1);
    expect(result.output).toContain('gateway exited before responding: {"code":3');
    expect(result.elapsedMs).toBeLessThan(MAX_RUN_MS);
  });

  it('fails when the port is answered by something other than the spawned gateway', async () => {
    const result = await runSmoke('impostor.mjs');
    expect(result.code).toBe(1);
    expect(result.output).toContain('answered but not by the spawned gateway');
  });
});
