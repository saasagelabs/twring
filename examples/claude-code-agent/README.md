# Claude Code agent (dogfood)

A Twring Native (`cord-agent/1`) agent whose brain is the Claude Code already logged in on this
machine. Point Twring at it and you can phone Claude. It is a dogfood tool, not a product feature:
every call runs on the owner's Claude plan and counts against its usage limits.

## Run

```sh
CLAUDE_AGENT_TOKEN=<random secret> pnpm claude-agent
```

It listens on 127.0.0.1:8788 (loopback only) and speaks both Twring protocols on that port:

- `ws://127.0.0.1:8788`: Twring Native (`cord-agent/1`), gateway mode `native`;
- `http://127.0.0.1:8788/cord/turns`: REST + SSE (`cord-rest/1`), gateway mode `rest`.

Use the same token as the bearer token in either case.

Latency probe against a running agent (three turns, including one web search):

```sh
CLAUDE_AGENT_TOKEN=<same secret> pnpm --filter @twring/example-claude-code-agent run probe
```

| Env var              | Default       | Meaning                                                  |
| -------------------- | ------------- | -------------------------------------------------------- |
| `CLAUDE_AGENT_TOKEN` | none          | Required bearer token; the server refuses to start without it. |
| `CLAUDE_AGENT_PORT`  | `8788`        | Port on 127.0.0.1.                                       |
| `CLAUDE_AGENT_MODEL` | `sonnet`      | Passed to `claude --model`.                              |
| `CLAUDE_AGENT_BIN`   | auto-detected | Path to the `claude` executable.                         |

## How it works

- One persistent `claude -p --input-format stream-json --output-format stream-json
--include-partial-messages` process per call, spawned at `session.hello`. `session.ready` is sent
  only after it answers the stream-json `initialize` control request (about 1.4 s), so startup cost
  lands in the call handshake rather than the first turn.
- Each `user.turn` becomes a stream-json user message. Text blocks stream as `text.delta`; thinking
  and tool inputs are never forwarded; tool calls become `tool.start`/`tool.end` with a spoken-safe
  label; the `result` message ends the turn with `done`.
- `turn.cancel` sends the stream-json `interrupt` control request. The process and the conversation
  survive. If Claude does not end the turn within 5 s, the process is killed and a fresh one starts
  for the next turn, which loses the conversation so far.
- Closing the call kills the process tree (`taskkill /T` on Windows).
- Logs hold timings only, never user or model text.

- REST mode keeps one Claude process per `session_id` (one per call) across turns. It is spawned on
  the first turn and killed after 10 minutes without a turn. A turn streams back as SSE with a
  heartbeat comment every 15 s; if Twring closes the request before `done`, that turn is interrupted
  as above and the process is kept. A repeated `turn_id` (Idempotency-Key) is refused with `409`.

## Restrictions and why

A phone call has nobody watching a terminal to approve actions, so the process is locked down:

- tools limited to `WebSearch` and `WebFetch` (`--tools` + `--allowedTools`); no shell, no file edits;
- `--permission-mode dontAsk --permission-prompts none`: anything else is denied, never prompted;
- `--safe-mode`, `--strict-mcp-config` with no servers, `--disable-slash-commands`: no hooks, plugins,
  CLAUDE.md, skills, or MCP servers from the owner's setup;
- runs in an empty temp directory (never this repo), `--no-session-persistence`;
- `--effort low` for latency (measured: 0 thinking tokens per turn);
- a voice system prompt: short spoken sentences, no markdown or URLs, a brief line before a tool.

`--bare` would start faster but only accepts `ANTHROPIC_API_KEY`; with a subscription login it
fails with "Not logged in", so it is not used.

## Known limits

- The `result` message arrives about 1 s after the last text (Claude Code's post-turn work), so `done`
  lags the audible answer slightly.
- Twring's default handshake timeout is 5 s; a cold machine that takes longer to start Claude will fail
  the handshake.
- One turn at a time; a turn sent while another runs is queued until the first ends.
- No `resume`: a dropped connection kills the process and its memory.
