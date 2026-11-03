# Twring Adapter Strategy

## 1. Adapter hierarchy

Twring supports multiple ways to connect an existing agent.

Priority:

1. **Twring Native WebSocket**
2. **REST + SSE**
3. **AG-UI compatibility**
4. **A2A later**

MCP is generally not the Twring-to-agent transport. It normally remains agent-to-tool.

## 2. Why multiple adapter types

Twring needs:

- a best-performance path;
- a universal simple path;
- compatibility with emerging agent UI standards;
- future cross-agent interoperability.

Trying to force all needs into one protocol would overcomplicate launch.

## 3. Twring Native WebSocket

Purpose: best realtime integration/full feature support.

Handshake concept:

```json
{
  "type": "session.hello",
  "protocol": "cord-agent/1",
  "session_id": "sess_...",
  "capabilities_requested": ["streaming_text", "cancel", "activity"]
}
```

Agent:

```json
{
  "type": "session.ready",
  "protocol": "cord-agent/1",
  "capabilities": {
    "streaming_text": true,
    "cancel": true,
    "activity": true,
    "resume": false
  }
}
```

User turn:

```json
{
  "type": "user.turn",
  "session_id": "sess_...",
  "turn_id": "turn_...",
  "text": "Check production deployment."
}
```

Benefits:

- persistent connection;
- low overhead;
- natural cancellation;
- bidirectional control;
- resumability possible.

Do not require internal chain-of-thought.

## 4. REST + SSE

Purpose: universal/easy integration.

```http
POST /cord/turns
Authorization: Bearer ...
Content-Type: application/json
Accept: text/event-stream
Idempotency-Key: turn_...
```

```json
{
  "session_id": "sess_...",
  "turn_id": "turn_...",
  "text": "Check production deployment."
}
```

Response:

```text
event: text.start
data: {"message_id":"msg_1"}

event: text.delta
data: {"message_id":"msg_1","delta":"I checked "}

event: text.delta
data: {"message_id":"msg_1","delta":"production."}

event: done
data: {"status":"completed"}
```

Optional final JSON fallback is allowed for non-streaming agents.

As built: AGENT_ADAPTER_SPEC §21 (`cord-rest/1`), which adds `protocol`, `call_id`, and timestamps to the body.

### OpenAI-compatible server agents

The `openai-chat` option accepts an HTTPS API base URL such as `/v1`, or a full
`/chat/completions` URL. Plain HTTP is allowed only under the existing development
endpoint policy. The gateway sends one streamed chat completion per user turn with
an optional bearer key and model, defaulting to `default`. It sends a surface-specific
system instruction and the current user turn, including attachment links. The agent
server owns conversation history using the saved agent's `twring-` user key. Starting
a new conversation replaces that key. The gateway reads `choices[0].delta.content`
from SSE and applies the same endpoint guard and stream limits as REST.

## 5. AG-UI compatibility

Map AG-UI at an adapter boundary.

Examples:

```text
TEXT_MESSAGE_CONTENT → text.delta
TOOL_CALL_START → tool.start
TOOL_CALL_RESULT → tool.end
ACTIVITY_DELTA → activity
```

Rules:

- no AG-UI types inside product UI;
- mapping is versioned/tested;
- no private reasoning exposure.

Official reference:
https://github.com/ag-ui-protocol/ag-ui/blob/main/docs/concepts/events.mdx

## 6. A2A future adapter

Potential later use:

- discover an agent;
- inspect capabilities;
- send task/messages;
- receive progress/artifacts.

Do not add to V1 unless a real integration needs it.

Official reference:
https://a2a-protocol.org/

## 7. MCP role

Correct:

```text
Twring → connected agent → MCP → tools/data
```

Avoid:

```text
Twring → MCP → arbitrary tools on behalf of agent
```

This preserves the agent's existing authority and avoids duplicating tool logic/security.

## 8. Adapter selection UX

Normal setup:

```text
Connect Agent

Recommended
[ Twring Native ]

Easy setup
[ API Endpoint ]

Compatible protocols
[ AG-UI ]
```

Keep A2A/MCP jargon in advanced UI only.

## 9. Native adapter SDK direction

After protocol stabilizes, target simple DX:

```ts
import { cordAdapter } from "@twring/agent";

cordAdapter({
  async *onTurn({ text, signal }) {
    for await (const event of myAgent.stream({ text, signal })) {
      yield mapMyAgentEvent(event);
    }
  }
}).listen();
```

SDK polish must not block MVP.

## 10. Local fake agent

Provide:

```bash
pnpm fake-agent
```

Modes:

- instant echo;
- streamed text;
- delayed text;
- fake tool;
- cancellation;
- malformed;
- reconnect/resume.

This decouples product development from external agent availability.

## 11. Reliability rules

- heartbeat for persistent WS;
- bounded reconnect;
- explicit close reason;
- max event size;
- total turn timeout;
- idle timeout;
- TLS in production;
- stable error mapping;
- no automatic duplicate turn submission.

## 12. Capability degradation

If no cancellation: stop TTS, let agent finish silently if necessary.

If no tool events: generic `Working…`.

If no resume: fail interrupted stream safely.

If no streaming: warn about slower response.

If no approvals: do not show approval UI.

## 13. Launch recommendation

Launch core with Native WebSocket + REST/SSE + fake adapter harness.

Add AG-UI compatibility once validated without delaying call quality.
