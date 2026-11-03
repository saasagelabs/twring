/**
 * `pnpm claude-agent`: serves the machine's logged-in Claude Code as a cord-agent/1 agent on
 * ws://127.0.0.1:8788 and as a cord-rest/1 agent on http://127.0.0.1:8788/cord/turns. Env: CLAUDE_AGENT_TOKEN (required), CLAUDE_AGENT_PORT (8788),
 * CLAUDE_AGENT_MODEL (sonnet), CLAUDE_AGENT_BIN (auto-detected).
 */
import { createClaudeSpawner, resolveClaudeBin } from './claude-command';
import { startClaudeAgentServer } from './server';

const token = process.env.CLAUDE_AGENT_TOKEN ?? '';
if (token === '') {
  console.error('CLAUDE_AGENT_TOKEN is required. Set it to a random secret and use it in Twring.');
  process.exit(1);
}
const port = Number(process.env.CLAUDE_AGENT_PORT ?? 8788);
const model = process.env.CLAUDE_AGENT_MODEL ?? 'sonnet';
const bin = resolveClaudeBin(process.env.CLAUDE_AGENT_BIN);

const server = await startClaudeAgentServer({
  port,
  token,
  spawnClaude: createClaudeSpawner({ bin, model }),
  log: (line) => console.log(`[claude-agent] ${line}`),
});
console.log(`Claude Code cord-agent/1 agent on ${server.url} (model: ${model})`);
console.log(`Claude Code cord-rest/1 agent on ${server.restUrl}`);

const shutdown = () => {
  void server.close().then(() => process.exit(0));
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
