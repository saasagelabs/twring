# Twring Agent Adapter Specification

## 1. Purpose

The adapter is Twring's primary interoperability boundary.

The product promise “Bring any agent brain. Get the voice.” requires connecting an existing agent without forcing a new agent framework or moving tool ownership into Twring.

## 2. Core contract

Conceptual TypeScript:

```ts
export interface TwringAgentAdapter {
  readonly capabilities: AdapterCapabilities;

  connect(
    context: AgentConnectionContext,
    signal: AbortSignal
  ): Promise<void>;

  sendTurn(
    turn: UserTurn,
    signal: AbortSignal
  ): AsyncIterable<AgentEvent>;

  cancelTurn?(
    turnId: string,
    reason: TurnCancelReason
  ): Promise<void>;

  resume?(
    request: ResumeRequest,
    signal: AbortSignal
  ): AsyncIterable<AgentEvent>;

  close(): Promise<void>;
}
```

## 3. Minimum usable integration

An agent integration is usable if it can:

- connect/authenticate;
- receive one text user message;
- stream or return agent text;
- indicate completion;
- return errors.

Everything else is capability-based.

## 4. Capabilities

```ts
type AdapterCapabilities = {
  streamingText: boolean;
  cancellation: boolean;
  resumableStream: boolean;
  activityEvents: boolean;
  toolEvents: boolean;
  approvals: boolean;
  conversationResume: boolean;
  serverInitiatedCalls: boolean;
};
```

UI degrades according to real capability. Never pretend support exists.

## 5. Stable identifiers

Call/session:

```text
call_id
session_id
```

Interaction:

```text
turn_id
```

Event:

```text
event_id
seq (optional but recommended)
```

## 6. User turn

```ts
type UserTurn = {
  callId: string;
  sessionId: string;
  turnId: string;
  role: "user";
  text: string;
  attachments?: TurnAttachment[];
  startedAt: string;
  committedAt: string;
  metadata?: Record<string, JsonValue>;
};
```

Do not send partial STT as a normal committed `UserTurn`.

Typed turns may carry up to five attachments. Agents that ignore them still see `[Attached: …]` lines in the text.

A turn superseded before the caller heard any reply to it is merged into the next turn's `text` (bounded to the most recent 2000 characters), so agents without memory of cancelled turns still get the whole request. The merge is skipped (the new turn goes alone, `turn_merge_skipped` {reason} is logged) when the superseded turn may have acted: the agent finished it (`done`/`error`), it reported any `activity`, `tool.start` or `tool.end`, or the adapter does not declare `toolEvents` (Twring cannot know). A non-idempotent action is never replayed.

## 7. Normalized agent event union

```ts
type AgentEvent =
  | AgentRunStarted
  | AgentTextStart
  | AgentTextDelta
  | AgentTextEnd
  | AgentActivity
  | AgentToolStart
  | AgentToolEnd
  | AgentApprovalRequired
  | AgentApprovalResolved
  | AgentError
  | AgentDone;
```

### Example `text.delta`

```json
{
  "type": "text.delta",
  "event_id": "evt_3",
  "turn_id": "turn_1",
  "message_id": "msg_1",
  "delta": "I found the deployment.",
  "seq": 3
}
```

### Example activity

```json
{
  "type": "activity",
  "event_id": "evt_5",
  "turn_id": "turn_1",
  "label": "Checking deployments",
  "kind": "working",
  "seq": 5
}
```

### Example tool start

```json
{
  "type": "tool.start",
  "event_id": "evt_6",
  "turn_id": "turn_1",
  "tool_call_id": "tool_1",
  "tool_name": "deployments.get",
  "display_label": "Checking deployment",
  "seq": 6
}
```

### Example tool end

```json
{
  "type": "tool.end",
  "event_id": "evt_7",
  "turn_id": "turn_1",
  "tool_call_id": "tool_1",
  "status": "success",
  "seq": 7
}
```

Twring does not require full tool results unless explicitly safe/useful for presentation.

### Example approval

For relay adapters, `approval.required` is answered by a gateway-to-agent `approval.decision`
message with `turn_id`, `approval_id`, and `decision` (`approve` or `deny`). Relay adapters claim
the `approvals` capability; only ACP local agents emit approval requests in v0.01.

```json
{
  "type": "approval.required",
  "event_id": "evt_8",
  "turn_id": "turn_1",
  "approval_id": "approval_1",
  "title": "Send email?",
  "description": "Send the prepared message to John.",
  "options": [
    { "id": "approve", "label": "Send" },
    { "id": "deny", "label": "Don't send" }
  ],
  "seq": 8
}
```

### Example done

```json
{
  "type": "done",
  "event_id": "evt_10",
  "turn_id": "turn_1",
  "status": "completed",
  "seq": 10
}
```

## 8. Ordering/deduplication

Within a turn:

- `seq` increases when supplied;
- duplicate `(turn_id,event_id)` is ignored;
- small bounded out-of-order buffering is allowed;
- unrecoverable protocol corruption fails the turn instead of inventing order;
- text delta order is authoritative.

## 9. Exactly-once intent

Twring cannot guarantee globally exactly-once side effects inside arbitrary agents.

Twring does guarantee:

- one generated `turn_id`;
- no intentional duplicate committed send;
- retries reuse idempotency identity where supported;
- reconnect does not imply a new turn.

## 10. Conversation identity

External agent thread/conversation ID is stored as opaque metadata.

Twring does not parse provider-specific semantics from it.

## 11. Cancellation

`cancelTurn` means stop producing/continuing the current agent turn if safely supported.

It does **not** mean undo external side effects.

## 12. Resume

```ts
type ResumeRequest = {
  sessionId: string;
  turnId: string;
  lastEventId?: string;
  lastSeq?: number;
};
```

If resume is supported, return events after cursor.

If not, fail the interrupted agent stream honestly rather than replaying the turn.

## 13. Authentication

Potential adapter credentials:

- bearer token;
- API key header;
- signed request;
- future OAuth.

Credentials are server-side encrypted.

Reject dangerous configurable headers such as `Host`, `Content-Length`, proxy headers, etc.

## 14. Endpoint security

Server-side outbound adapter connections require:

- HTTPS/WSS in production;
- SSRF protection;
- redirect validation;
- bounded event/response size;
- connection timeout;
- idle timeout;
- total turn timeout.

## 15. Protocol versioning

Native protocol negotiates explicit major version.

```json
{
  "type": "session.hello",
  "cord_protocol": "1.0",
  "supported_features": ["streaming_text", "cancel"]
}
```

Breaking changes require new major version. Additive fields should remain compatible.

## 16. Connection test

Every adapter provides a test result:

```ts
type ConnectionTestResult = {
  reachable: boolean;
  authenticated: boolean;
  protocolValid: boolean;
  streamingObserved?: boolean;
  latencyMs?: number;
  capabilities?: AdapterCapabilities;
  safeMessage: string;
};
```

Never return raw secret in error text.

## 17. Non-streaming agents

REST adapter may support final-only response.

UI warns:

> This agent does not stream. Calls may respond more slowly.

Do not fake streaming.

## 18. Conformance tests

Every adapter passes:

- valid streamed answer;
- single final answer;
- empty answer;
- auth failure;
- timeout;
- malformed event;
- oversized event;
- duplicate event;
- out-of-order event;
- cancellation;
- late event after done;
- disconnect;
- resume when declared.

## 19. Developer experience goal

A developer with an existing streaming chat agent should wrap its existing input/output boundary rather than rebuilding internal tools.

## 20. `cord-agent/1` wire protocol (as built)

Schemas: `packages/contracts/src/native-protocol.ts`. Adapter: `NativeWsAdapter` in `packages/agent-adapter`.

Transport: one WebSocket per call, JSON text frames only, at most `MAX_NATIVE_MESSAGE_BYTES` (64 KiB) per frame. Credentials go in `Authorization: Bearer <token>` on the upgrade request, never in the URL. Twring does not follow redirects. `wss://` is required outside development, and the endpoint passes the SSRF guard (`assertSafeAgentEndpoint`) first.

Twring → agent:

| `type` | Fields | When |
| --- | --- | --- |
| `session.hello` | `protocol` (`cord-agent/1`), `session_id`, `call_id`, `capabilities_requested[]` | First frame after the upgrade |
| `user.turn` | `session_id`, `turn_id`, `text`, `started_at`, `committed_at`, optional `surface` (`call` or `text`; absent means `call`), optional `attachments` | Once per committed turn. It is never resent, even after a reconnect |
| `turn.cancel` | `turn_id`, `reason` (`superseded`, `barge_in`, `call_ended`, `timeout`) | Twring stopped listening to a turn, and only when the agent declared `cancel` |
| `ping` | `id` | Every 20 s when idle |

Agent → Twring:

| `type` | Fields | When |
| --- | --- | --- |
| `session.ready` | `protocol`, `capabilities { streaming_text, cancel, activity, tools, resume }` | Reply to `session.hello`, within 5 s |
| `session.error` | `code`, `message?` | Refuses or ends the session. `message` is never shown or logged |
| `pong` | `id` | Reply to `ping`, within 10 s |
| any §7 `AgentEvent` | as §7 | Events for the current `turn_id`, ending with `done` or `error` |

Rules:

- On typed turns, `attachments` is an optional array of `{ id, name, mime_type, size_bytes, url, expires_at }`. Each URL is a signed download link that needs no other credentials, expires after 15 minutes, and should be downloaded promptly.

- Versioning: `cord-agent/1` and `cord-agent/1.x` are accepted. Any other version fails the handshake with `protocol_unsupported`.
- Capabilities that are omitted count as `false`. `resume` is recorded but not yet used, so the adapter reports `resumableStream: false`.
- Events for other turns, and events after `done`, are dropped. Duplicates are dropped. A `seq` that goes backwards, a malformed or oversized frame, or a binary frame fails the turn with `protocol_violation`.
- Reconnect happens only between turns, on the next turn: up to 3 attempts, after waits of 250 ms, 1 s and 3 s. A drop mid-turn fails that turn with retryable `connection_lost`, and Twring does not replay it.
- Close: Twring closes with code 1000.

Adapter error codes (`AdapterError.code`; the `message` is always Twring's own safe text):

| Code | Retryable | Meaning |
| --- | --- | --- |
| `auth_failed` | no | HTTP 401/403 on the upgrade, or `session.error` with this code |
| `timeout` | yes | Connect (10 s) or handshake (5 s) budget exceeded |
| `protocol_unsupported` | no | Agent answered with another major version |
| `protocol_violation` | no | Malformed, oversized, out-of-order, or unexpected frame |
| `connection_failed` | yes | Could not connect, or a non-auth HTTP status on the upgrade |
| `connection_lost` | yes | Socket closed or the heartbeat failed after the handshake |
| `endpoint_rejected` | no | The SSRF guard refused the URL |
| `not_connected` | no | Used after `close()` or before `connect()` |
| `agent_error` | no | `session.error` with a code Twring doesn't define. The agent's code is kept as `agentCode` |

## 21. `cord-rest/1` wire protocol (as built)

Schemas: `packages/contracts/src/rest-protocol.ts`. Adapter: `RestSseAdapter` in `packages/agent-adapter` (SSE parsing: `SseParser`, WHATWG event-stream rules).

Request: one `POST {url}` per committed turn. There is no session handshake; `connect()` only checks configuration and makes no request.

The JSON request may include `surface: "call" | "text"`; absent means `call`.
Typed requests may also include `attachments` with the same shape and 15-minute signed links as `user.turn` in §20. Download them promptly; no other credentials are needed.

```http
POST /cord/turns
Authorization: Bearer <token>
Content-Type: application/json
Accept: text/event-stream, application/json
Idempotency-Key: <turn_id>
```

```json
{
  "protocol": "cord-rest/1",
  "session_id": "call_...",
  "call_id": "call_...",
  "turn_id": "turn_1",
  "text": "Check production deployment.",
  "started_at": "2026-09-27T10:00:00.000Z",
  "committed_at": "2026-09-27T10:00:01.200Z"
}
```

Streaming response (`200`, `Content-Type: text/event-stream`): each event's `event:` is the §7 `type` and `data:` is the event body as JSON. `turn_id`, `event_id`, and `seq` may be left out: Twring fills `turn_id` from the request, and `event_id` from that block's `id:` field, or else `cord-auto-<n>` (a per-response sequence under a prefix chosen not to collide with an agent's own ids). If `data` has a `type`, it must match `event:`; a block without `event:` is read by the `type` in its data. Comment lines (`: hb`) keep the stream alive. The stream must end with `done` (or `error`); a stream that ends without one fails the turn with `connection_lost`, or with `protocol_violation` when it was cut inside an event (an unterminated line or event is discarded, never parsed).

```text
event: text.delta
id: evt_3
data: {"message_id":"msg_1","delta":"I checked "}

event: done
data: {"status":"completed"}
```

Final JSON fallback (`200`, `Content-Type: application/json`): `{"text": "...", "status": "completed" | "failed"}` (`status` optional). Twring turns it into `text.start`, `text.delta` (split at 4096 characters), `text.end`, and `done`, and, once such a body has validated, reports `streamingText: false` for the rest of the call. The phone shows a one-time notice (`agent_not_streaming`, §17) on the first answered turn of any `cord-native` or `cord-rest` agent that doesn't stream (declared at connect or found through this fallback); built-in test lines such as the repeat agent never get it. Streaming is never faked.

Capabilities: `streamingText` is true until a JSON reply is seen; `cancellation` is true (closing the request is the cancel; there is no separate cancel call); `toolEvents` and `activityEvents` are true because they can't be known in advance (the UI shows nothing extra if none arrive); `resumableStream` is false.

Idempotency and retry:

- `Idempotency-Key` is always the `turn_id`. An agent should refuse (for example with `409`) or replay a key it has already accepted, and never run it twice.
- Twring retries at most once, after 250 ms, with the same key, and only when the connection failed before any request bytes could have been sent (`ECONNREFUSED`, `ENOTFOUND`, `EAI_AGAIN`, `EHOSTUNREACH`, `ENETUNREACH`). Once connected, a failure is never retried.

Limits and timeouts:

| Limit | Value |
| --- | --- |
| One SSE event's `data` | 64 KiB (`MAX_SSE_EVENT_BYTES`), UTF-8 bytes |
| One line still arriving (unterminated) | 64 KiB + 64 bytes of headroom for the field prefix, UTF-8 bytes |
| Whole response body, SSE or JSON | 1 MiB (`MAX_REST_RESPONSE_BYTES`) |
| Connect (TCP + TLS) | 10 s |
| Idle between response bytes | 30 s (heartbeat comments reset it) |
| Request to first event | the gateway's first-event budget |

Redirects are not followed. The request connects to the address the SSRF guard validated (no re-resolution), `https://` is required outside development, and events pass the §8 stream guard like any adapter's.

Errors (`AdapterError.code`; never the response body, URL, or token):

| Condition | Code | Retryable |
| --- | --- | --- |
| HTTP 401 | `auth_failed` (the gateway ends the call as `agent_unavailable`, on any turn) | no |
| HTTP 403 | `auth_failed` (on the call's first turn the gateway ends the call as `agent_unavailable`; later it fails only that turn with the `agent_failed` notice) | no |
| Any other non-2xx, including 3xx | `agent_error`, with the status code only | no |
| Could not connect (after the one retry) | `connection_failed` (on the first turn the gateway ends the call as `agent_unavailable`; later it fails only that turn with the `agent_unreachable` notice) | yes |
| Connect over 10 s, or 30 s idle | `timeout` | yes |
| Dropped, or ended without `done` | `connection_lost` | yes |
| Bad content type, invalid JSON, unknown or mismatched event type, oversized event or body, `seq` going backwards | `protocol_violation` | no |

"First turn" means no earlier turn of the call has received an event from the agent yet. The gateway also caps the text of any user turn it sends at 8000 characters (`MAX_USER_TURN_CHARS`), keeping the most recent speech.

## 22. `cord-relay/1`: agents on the user's computer (as built, ADR-023)

For typed turns, the connector checks that signed file links come from its linked server, downloads them into a private per-turn folder, and removes the folder after the turn. Claude Code receives images and PDFs inline and other files as paths. Codex receives images through `--image` and other files as paths. ACP uses image or resource blocks when the agent declares support, and paths otherwise. Generic commands receive paths. Call turns ignore attachments.

A `cord-connector` agent runs on the user's own computer behind `cord-connect` (`apps/connector`), which dials **out** to the gateway. The relay carries unchanged `cord-agent/1` frames (§20), with the connector as the agent end, so every §20 rule, the §8 stream guard, and §18 conformance apply (the conformance suite runs against the relayed adapter in `apps/gateway/src/connectors/conformance.test.ts`).

Pairing (`packages/contracts/src/connectors.ts`):

| Step | Call |
| --- | --- |
| App asks for a code | `POST /v1/connectors/pairings` (signed in) → `{ pairing_id, code: "XXXX-XXXX", expires_at }`, 10 minutes, single use |
| Connector claims it | `POST /v1/connectors/claim` `{ code, name, agents: [{ id, label, kind }] }` (no sign-in; rate limited per IP) → `{ connector_id, token }`, shown once |
| App waits | `GET /v1/connectors/pairings/:id` → `pending` / `claimed` (with the connector) / `expired` |
| List, revoke | `GET /v1/connectors`, `DELETE /v1/connectors/:id` (also `DELETE /v1/me/data`) |

Socket: `wss://<gateway>/v1/connectors/socket` with `Authorization: Bearer <token>` on the upgrade (401 without a valid, unrevoked token). One JSON object per text frame, at most `MAX_RELAY_MESSAGE_BYTES` (the native limit plus 4 KiB of envelope).

| Direction | Frame |
| --- | --- |
| connector → gateway, first | `{ type: "connector.hello", protocol: "cord-relay/1", agent_protocol: "cord-agent/1", agents, version? }` (within 10 s, or close 4400) |
| gateway → connector | `{ type: "connector.ready", protocol, connector_id, name }` |
| gateway → connector | `{ type: "channel.open", channel, agent }`: one call to local agent `agent` |
| both | `{ type: "channel.message", channel, message }`: one `cord-agent/1` frame |
| both | `{ type: "channel.close", channel }` |

Rules: one socket per connector (a newer socket closes the older with 4409); revocation closes with 4403 (the connector stops and does not reconnect); the gateway pings every 20 s and drops a socket that misses a pong; the connector reconnects with backoff (1, 2, 4, 8, 15, 30 s plus jitter) and drops a link silent for 60 s. At most 8 channels per connector. A dropped socket fails the running turn with `connection_lost`; the turn is never resent. A saved agent's endpoint is `cord-connector://<connector id>/<local agent id>`; the gateway opens a channel only on a connector owned by the calling user. When the computer is not connected (or the connector is someone else's), connect fails with `agent_offline` (not retryable), the call ends with end reason `agent_offline`, and the phone says "Your computer isn't connected. Start cord-connect on it." A local agent the connector does not offer answers `session.error agent_error`.

Reliability rules (v0.01). A repeated `connector.hello` replaces the stored agent list; a channel for an agent missing from the latest hello fails with `agent_not_on_computer` (not retryable; end reason `agent_not_on_computer`, phone copy "This agent isn't set up on your computer anymore."). While a turn is open and its local agent process is alive, the connector sends an `activity` event (the running tool's label, else "Working…") after every 10 s without any other event, so the gateway's 30 s idle budget does not end a quiet tool run; it adds no speech and the phone keeps showing the working state. `AGENT_TURN_MAX_S` (default 600) is the hard cap on any turn, however busy. Activity labels are coalesced on the connector to at most one per 500 ms, latest wins; a label still waiting when the turn ends is dropped. A single stdout line from a local agent is capped at 1 MB; a longer line fails the turn with `line_too_long`. The gateway holds at most 2000 unread events per turn (`MAX_TURN_BACKLOG`); past that the turn fails with `protocol_violation`. Revoking a computer ends its live calls with end reason `agent_offline`; its saved agents report `connector_removed: true` ("Computer removed. Pair it again.") and new calls to them answer 409 `connector_invalid`. `POST /v1/calls` answers 409 `agent_offline` for an offline computer before the daily allowance is counted. Pairing answers carry `server_time`, so the phone's countdown uses the server's clock, and the claim poll decides expiry (the phone gives up on its own only 15 s after its countdown ends).
