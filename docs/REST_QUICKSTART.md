# Send one cord-rest/1 turn with curl

With Node 24 and pnpm installed, run `pnpm install` from the repository root.
Start the reference agent in one terminal:

```sh
pnpm fake-rest-agent
```

In a second terminal, send one turn. The local reference agent uses the test
token `dev-token`. The idempotency key matches the body’s `turn_id`.

```sh
curl --fail-with-body -sS -N http://127.0.0.1:8789/cord/turns \
  -H 'Authorization: Bearer dev-token' \
  -H 'Content-Type: application/json' \
  -H 'Accept: text/event-stream, application/json' \
  -H 'Idempotency-Key: turn_1' \
  --data-binary '{"protocol":"cord-rest/1","session_id":"call_demo","call_id":"call_demo","turn_id":"turn_1","text":"Hello","started_at":"2026-09-27T10:00:00.000Z","committed_at":"2026-09-27T10:00:01.200Z"}'
```

The `-N` flag disables curl’s output buffering so each SSE event appears as it
arrives. This excerpt shows the start, the first text fragment, and completion:

```text
event: run.started
id: evt_1
data: {"seq":1}

event: text.delta
id: evt_3
data: {"seq":3,"message_id":"msg_turn_1","delta":"Hi! "}

event: done
id: evt_15
data: {"seq":15,"status":"completed"}
```

Stop the first server with Ctrl+C and restart it in JSON mode:

```sh
pnpm fake-rest-agent --mode json
```

Run the same curl command. The server sends one final JSON response:

```json
{"text":"Hi! I'm Twring's demo agent. Ask me to check your calendar, tell you a story, or show you formatted text."}
```

See [section 21 of the Agent Adapter Spec](AGENT_ADAPTER_SPEC.md#21-cord-rest1-wire-protocol-as-built)
for request fields, event framing, and the JSON fallback.
