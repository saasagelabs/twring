/**
 * `pnpm fake-rest-agent`: runs the reference cord-rest/1 agent on
 * http://127.0.0.1:8789/cord/turns.
 *
 *   pnpm fake-rest-agent                  # streamed SSE replies
 *   pnpm fake-rest-agent --mode json      # or FAKE_AGENT_MODE=json
 *
 * Modes: streamed, instant, json, slow-first-byte, malformed, drop-mid-stream, 401, 500. The
 * bearer token comes from FAKE_AGENT_TOKEN and defaults to the test value "dev-token". Port:
 * FAKE_REST_AGENT_PORT (8789).
 */
import { FAKE_REST_MODES, startFakeRestServer, type FakeRestMode } from './fake-rest-server';

function flag(name: string): string | undefined {
  const args = process.argv.slice(2);
  const inline = args.find((a) => a.startsWith(`--${name}=`));
  if (inline !== undefined) return inline.slice(name.length + 3);
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
}

const mode = flag('mode') ?? process.env.FAKE_AGENT_MODE ?? 'streamed';
if (!(FAKE_REST_MODES as readonly string[]).includes(mode)) {
  console.error(`Unknown mode "${mode}". Use one of: ${FAKE_REST_MODES.join(', ')}`);
  process.exit(1);
}
const port = Number(flag('port') ?? process.env.FAKE_REST_AGENT_PORT ?? 8789);
const token = process.env.FAKE_AGENT_TOKEN ?? 'dev-token';

const server = await startFakeRestServer({ port, token, mode: mode as FakeRestMode });
console.log(`Fake cord-rest/1 agent on ${server.url} (mode: ${mode})`);
console.log('Bearer token: FAKE_AGENT_TOKEN (default is the test value "dev-token")');

const shutdown = () => {
  void server.close().then(() => process.exit(0));
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
