# Python REST agent

A small `cord-rest/1` echo agent using only Python 3.11+ and its standard library.
It makes no model calls and needs no API credits. The wire format matches
[the adapter spec, section 21](../../docs/AGENT_ADAPTER_SPEC.md#21-cord-rest1-wire-protocol-as-built)
and `pnpm fake-rest-agent`.

## Run

From the repository root:

```sh
python3 examples/python-rest-agent/agent.py
```

On Windows, use `python` in place of `python3`. The endpoint is
`http://127.0.0.1:8789/cord/turns`, with the local test bearer token `dev-token`.
Set `PYTHON_AGENT_TOKEN` to your own secret before exposing it beyond this machine;
`--host 0.0.0.0` and `--port 8789` select the listener. Tokens and turn text are not logged.

## Connect in Twring

1. In Twring, choose **Connect Agent** and **Web service**.
2. Enter the endpoint ending in `/cord/turns` and the bearer token.
3. Tap **Continue**. Twring tests the connection. Then call the agent; it streams back
   `Echo: ` and your words.

The production gateway requires a reachable **HTTPS** URL. Put this example behind
a TLS reverse proxy and use that public URL in the app; the phone's `localhost`
does not refer to this computer. For a local self-hosted development gateway,
follow its development URL policy in [ADAPTERS.md](../../docs/ADAPTERS.md).
This is a development example, not a production agent deployment.

## Send one turn directly

With the server running, in another terminal:

```sh
curl -N http://127.0.0.1:8789/cord/turns \
  -H 'Authorization: Bearer dev-token' \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: turn_1' \
  --data '{"protocol":"cord-rest/1","session_id":"call_1","call_id":"call_1","turn_id":"turn_1","text":"Hello from Python","started_at":"2026-11-28T00:00:00Z","committed_at":"2026-11-28T00:00:01Z"}'
```

The response is real SSE: `run.started`, `text.start`, several `text.delta`
events, `text.end`, then `done` with `status: completed`. Each event has a unique
ID, the request's turn ID, and an increasing sequence number. `Ctrl+C` in the
client closes the request and interrupts the stream, including its chunk delay.

The `Idempotency-Key` must equal `turn_id`. A repeated key returns `409`, including
after cancellation. The process remembers up to 10,000 keys; when full it refuses
new turns with `503` rather than evicting old keys. Restarting clears this in-memory
history. A real agent that performs actions needs durable deduplication.
Authentication failures return `401`, malformed turns `400`, oversized bodies
`413`, and unsupported content types `415`. Additive request fields are ignored;
this echo example does not fetch attachments or execute tools.

Replace the echo chunks inside `stream_answer` with your own generation while
preserving the event order, size limits, idempotency, and disconnect handling.
Long-running generation should emit heartbeat comments and stop its own work
when the request closes, rather than only stopping output.

## Check

```sh
python3 -m unittest discover -s examples/python-rest-agent -p 'test_*.py' -v
```

These tests use real loopback HTTP connections for authentication, malformed
requests, SSE ordering and Unicode, duplicate keys, and cancellation during a
ten-second chunk delay. No external service or Twring account is needed.

Licensed under [Apache-2.0](../../LICENSES/Apache-2.0.txt), like the other examples.
