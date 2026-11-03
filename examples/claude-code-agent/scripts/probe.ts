/**
 * Latency probe: connects to a running `pnpm claude-agent` with the real NativeWsAdapter and times
 * three turns. Env: CLAUDE_AGENT_TOKEN (required), CLAUDE_AGENT_PORT (8788).
 */
import { NativeWsAdapter } from '@twring/agent-adapter';

const token = process.env.CLAUDE_AGENT_TOKEN ?? '';
if (token === '') {
  console.error('CLAUDE_AGENT_TOKEN is required');
  process.exit(1);
}
const url = `ws://127.0.0.1:${process.env.CLAUDE_AGENT_PORT ?? 8788}`;
const prompts = [
  'Say hello in one sentence.',
  'What is 17 times 23?',
  "What's the weather in Chennai right now?",
];

const adapter = new NativeWsAdapter({ url, token, timeouts: { handshakeMs: 30_000 } });
const controller = new AbortController();
const t0 = performance.now();
await adapter.connect({ callId: 'probe_call', sessionId: 'probe_session' }, controller.signal);
console.log(`handshake ${Math.round(performance.now() - t0)} ms`);

for (const [i, text] of prompts.entries()) {
  const start = performance.now();
  const now = new Date().toISOString();
  let firstEvent: number | undefined;
  let firstText: number | undefined;
  const types: string[] = [];
  let chars = 0;
  for await (const event of adapter.sendTurn(
    {
      callId: 'probe_call',
      sessionId: 'probe_session',
      turnId: `probe_turn_${i + 1}`,
      role: 'user',
      text,
      startedAt: now,
      committedAt: now,
    },
    controller.signal,
  )) {
    const ms = Math.round(performance.now() - start);
    firstEvent ??= ms;
    if (event.type === 'text.delta') {
      firstText ??= ms;
      chars += event.delta.length;
    }
    if (types.at(-1) !== event.type) types.push(event.type);
  }
  const done = Math.round(performance.now() - start);
  console.log(
    `turn ${i + 1}: first-event ${firstEvent ?? '-'} ms, first-text ${firstText ?? '-'} ms, done ${done} ms, ${chars} chars`,
  );
  console.log(`  events: ${types.join(' → ')}`);
}
await adapter.close();
