// Boots the built gateway (dist/main.js) and verifies both health endpoints over real HTTP.
//
// Guards against false positives and hangs:
// - the port is a free ephemeral port chosen by the OS, not a fixed number;
// - the child gets a random CORD_RELEASE nonce, and /health/ready must echo it, proving the
//   response came from the process we spawned and not something else on that port;
// - if the child exits before answering, the smoke test fails immediately;
// - every probe (connect + headers + body) is aborted at a per-probe deadline that never extends
//   past the overall startup deadline, so a stalled connection cannot hang the run.
//
// SMOKE_ENTRY / SMOKE_STARTUP_TIMEOUT_MS / SMOKE_PROBE_TIMEOUT_MS exist so
// test/smoke.int.test.ts can exercise the failure paths against fixture servers.
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:net';

const ENTRY = process.env.SMOKE_ENTRY ?? 'dist/main.js';
const STARTUP_TIMEOUT_MS = Number(process.env.SMOKE_STARTUP_TIMEOUT_MS ?? 15_000);
const PROBE_TIMEOUT_MS = Number(process.env.SMOKE_PROBE_TIMEOUT_MS ?? 2_000);
const POLL_INTERVAL_MS = 200;

function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

const port = await freePort();
const nonce = `smoke-${randomUUID()}`;
const base = `http://127.0.0.1:${port}`;
const deadline = Date.now() + STARTUP_TIMEOUT_MS;

const child = spawn(process.execPath, [ENTRY], {
  env: {
    ...process.env,
    HOST: '127.0.0.1',
    PORT: String(port),
    LOG_LEVEL: 'warn',
    CORD_ENV: 'development',
    CORD_RELEASE: nonce,
  },
  stdio: ['ignore', 'inherit', 'inherit'],
});

let childExit;
const exited = new Promise((resolve) => {
  child.once('exit', (code, signal) => resolve((childExit = { code, signal })));
  child.once('error', (error) => resolve((childExit = { error: error.message })));
});

/** GET + JSON parse, aborted after the per-probe timeout or the overall deadline, whichever is first. */
async function getJson(path) {
  const budget = Math.min(PROBE_TIMEOUT_MS, deadline - Date.now());
  if (budget <= 0) throw new Error('overall deadline reached');
  const signal = AbortSignal.timeout(budget);
  const res = await fetch(`${base}${path}`, { signal });
  // The same signal aborts a body that stalls after headers.
  const body = await res.json();
  return { res, body };
}

async function waitForOwnGateway() {
  let lastProblem = 'no response yet';
  while (Date.now() < deadline) {
    const early = await Promise.race([
      exited,
      new Promise((resolve) =>
        setTimeout(resolve, Math.min(POLL_INTERVAL_MS, Math.max(0, deadline - Date.now()))),
      ),
    ]);
    if (early !== undefined) {
      throw new Error(`gateway exited before responding: ${JSON.stringify(early)}`);
    }
    let probe;
    try {
      probe = await getJson('/health/ready');
    } catch (error) {
      lastProblem = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      continue; // not listening yet, or this probe stalled and was aborted
    }
    if (probe.body?.release !== nonce) {
      throw new Error(
        `port ${port} answered but not by the spawned gateway (release ${JSON.stringify(probe.body?.release)})`,
      );
    }
    return;
  }
  throw new Error(`gateway did not respond within ${STARTUP_TIMEOUT_MS}ms (last: ${lastProblem})`);
}

let exitCode = 0;
try {
  await waitForOwnGateway();
  for (const path of ['/health/live', '/health/ready']) {
    const { res, body } = await getJson(path);
    console.log(`${path} -> ${res.status} ${JSON.stringify(body)}`);
    if (!res.ok) exitCode = 1;
  }
} catch (error) {
  console.error(`smoke failed: ${error instanceof Error ? error.message : String(error)}`);
  exitCode = 1;
} finally {
  if (childExit === undefined) child.kill('SIGTERM');
}
process.exitCode = exitCode;
