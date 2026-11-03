# Twring Backend and Voice Gateway Specification

## 1. Backend goal

Start with one simple TypeScript backend deployment plus the voice gateway runtime needed for active calls.

Split services only when measured scaling/isolation needs appear.

## 2. Responsibilities

Backend/control plane:

- auth/session validation;
- users;
- agent profiles;
- encrypted credentials;
- connection tests;
- call creation;
- LiveKit token issuance;
- call metadata/history;
- settings;
- rate limits;
- health;
- correlation IDs.

Voice gateway:

- LiveKit participation;
- STT/TTS sessions;
- call controller;
- agent adapter;
- realtime status;
- cleanup.

## 3. Suggested API

### `POST /v1/calls`

```json
{ "agent_id": "agt_123" }
```

Response:

```json
{
  "call_id": "call_123",
  "session_id": "sess_123",
  "livekit": {
    "url": "wss://...",
    "token": "short-lived-token",
    "room": "cord-call-..."
  },
  "expires_at": "..."
}
```

### `POST /v1/calls/:callId/end`

Idempotent end request.

### `GET /v1/calls/:callId`

Safe metadata/state.

### `GET /v1/calls`

Paginated history.

### `POST /v1/agents`

Create profile.

### `PATCH /v1/agents/:id`

Update non-secret configuration.

### `POST /v1/agents/:id/test`

Server-side connection test.

### `DELETE /v1/agents/:id`

Delete profile + credential material.

## 4. Authentication

Use Supabase Auth initially if it remains the shortest reliable path.

Backend validates user token/session.

Never trust a client-provided `user_id` in request body.

## 5. Authorization

Every user-owned resource query is scoped to authenticated user.

Gateway verifies call, user, agent ownership, and token validity.

## 6. Credential storage

Store secrets separately from ordinary agent metadata:

```text
agents.credential_ref
        ↓
agent_credentials
  ciphertext
  encryption metadata
  key version
```

Encryption key lives in backend secret manager/env.

No plaintext secrets in logs or API responses.

## 7. Connection test security

Run server-side.

Protect against:

- SSRF;
- private/link-local/metadata addresses;
- malicious redirects;
- huge responses;
- endless streams;
- slow endpoints.

Return safe diagnostics only.

## 8. LiveKit token issuance

Use short expiry and minimum grants.

Mobile never gets LiveKit API secret/admin grants.

Gateway uses its own appropriately scoped identity.

## 9. Call/session ownership

Durable call states:

```text
created
connecting
active
ending
ended
failed
```

Do not persist every transient voice state.

## 10. Gateway assignment

Use the simplest deployment mechanism compatible with LiveKit/hosting.

Requirements:

- one active logical gateway owner per call;
- duplicate worker detection;
- stable correlation ID;
- cleanup on timeout.

No custom distributed scheduler without need.

## 11. Gateway modules

```text
CallRuntime
LiveKitTransport
SttProvider
ConversationController
AgentAdapter
TtsProvider
EventPublisher
CallTelemetry
```

`CallRuntime` composes them.

## 12. Resource lifecycle

Start:

- connect transport;
- initialize STT;
- initialize TTS;
- connect adapter;
- register cancellation tree.

End:

1. stop accepting turns;
2. cancel active speech;
3. close provider streams;
4. close adapter;
5. leave LiveKit;
6. flush telemetry;
7. finalize call record.

Cleanup is idempotent.

## 13. Cancellation tree

One top-level `AbortController` per call.

Child cancellation for:

- active turn;
- adapter generation;
- TTS generation.

Call end aborts all. Barge-in aborts speech and optionally current generation, not whole call.

## 14. Rate limits

Initial configurable guards:

- call creation/user;
- connection test/user;
- concurrent calls/user;
- event/byte limits;
- total call duration;
- agent CRUD abuse.

## 15. Cost controls

Capture:

- call duration;
- STT seconds;
- TTS usage;
- LiveKit usage;
- adapter timing.

Keep provider billing specifics behind usage abstraction.

## 16. Health

`/health/live`: process alive.

`/health/ready`: dependencies ready enough to accept new work.

Never expose account/secret details.

## 17. Migrations

Use one migration mechanism.

Every schema change is versioned/tested and applied in staging before production.

## 18. Future incoming call endpoint

Must require authenticated/signed source and explicit user permission.

Never expose an unauthenticated “ring this user” API.

## 19. Deployment requirements

Runtime must support:

- persistent WebSockets;
- outbound provider sockets;
- graceful shutdown;
- health checks;
- horizontal scaling if needed;
- secure secrets.

Avoid runtimes that unexpectedly terminate long-lived call workers.

## 20. Graceful shutdown

Stop accepting new calls, drain active calls within a bounded period when possible, and never leave sessions marked active forever.

## 21. Backend definition of done

A backend feature is complete when auth/authz, validation, secret safety, idempotency, timeout/cancellation, telemetry, and contract tests are addressed.
