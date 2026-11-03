/**
 * `pnpm fake-agent`: runs the reference cord-agent/1 agent on ws://127.0.0.1:8787.
 *
 *   pnpm fake-agent                      # streamed replies
 *   pnpm fake-agent --mode instant       # or FAKE_AGENT_MODE=instant
 *
 * Modes: streamed, instant, delayed, malformed, drop-mid-turn. The bearer token comes from
 * FAKE_AGENT_TOKEN and defaults to the test value "dev-token". Port: FAKE_AGENT_PORT (8787).
 */
import {
  FAKE_NATIVE_MODES,
  startFakeNativeServer,
  type FakeNativeMode,
} from './fake-native-server';

function flag(name: string): string | undefined {
  const args = process.argv.slice(2);
  const inline = args.find((a) => a.startsWith(`--${name}=`));
  if (inline !== undefined) return inline.slice(name.length + 3);
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
}

const mode = flag('mode') ?? process.env.FAKE_AGENT_MODE ?? 'streamed';
if (!(FAKE_NATIVE_MODES as readonly string[]).includes(mode)) {
  console.error(`Unknown mode "${mode}". Use one of: ${FAKE_NATIVE_MODES.join(', ')}`);
  process.exit(1);
}
const port = Number(flag('port') ?? process.env.FAKE_AGENT_PORT ?? 8787);
const token = process.env.FAKE_AGENT_TOKEN ?? 'dev-token';

const server = await startFakeNativeServer({ port, token, mode: mode as FakeNativeMode });
console.log(`Fake cord-agent/1 agent on ${server.url} (mode: ${mode})`);
console.log('Bearer token: FAKE_AGENT_TOKEN (default is the test value "dev-token")');

const shutdown = () => {
  void server.close().then(() => process.exit(0));
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
