# Twring Data Model

## 1. Principles

Persist only what the product needs.

Realtime provider/session objects remain ephemeral.

Use opaque IDs. All user-owned data carries `user_id`.

## 2. Core entities

```text
users
agents
agent_credentials
calls
call_turns       optional based on transcript policy
call_events      compact product events only
user_settings
usage_records
```

### V1 store (until Supabase)

Auth is deferred (ADR-018). Until Supabase Postgres + Auth land, the gateway keeps `agents`, `agent_credentials`, and a call-history summary as JSON files under `CORD_DATA_DIR`, one file per collection, written atomically (temp file + rename) under a per-process lock. Every row carries `user_id` (today always `dev-user`) and every query is scoped by it, behind the `AgentRepository`, `CredentialVault`, and `CallHistoryRepository` interfaces in `apps/gateway/src/store/`. The Supabase move replaces those implementations, not the routes. Credentials are sealed in the gateway (AES-256-GCM, random 12-byte IV, `key_version`, AAD = user + agent) before they are written; the file holds no plaintext. Call history keeps only call id, agent id/name, start, duration, outcome, and the public end reason: no transcript, no audio.

Chats (ADR-031) live in a separate SQLite file, `threads.db` beside the JSON files (`node:sqlite`, WAL), behind `SqliteThreadStore`: one thread per user and saved agent, messages with a per-thread `seq` (order) and `rev` (change cursor for the phone's catch-up), bodies sealed with AES-256-GCM. Calls appear as cards with no text.

## 3. Agents

```text
agents
- id
- user_id
- name
- avatar_url nullable
- adapter_type
- adapter_config json/jsonb
- credential_ref nullable
- voice_provider
- voice_id
- capabilities nullable
- last_connection_test_at nullable
- last_connection_status nullable
- created_at
- updated_at
```

`adapter_config` contains non-secret data such as endpoint URL/protocol settings.

Never store raw API secret inside it.

## 4. Credentials

```text
agent_credentials
- id
- user_id
- agent_id
- ciphertext
- encryption_metadata
- key_version
- created_at
- updated_at
```

API never returns ciphertext/plaintext secret.

## 5. Calls

```text
calls
- id
- user_id
- agent_id
- session_id
- status
- started_at nullable
- connected_at nullable
- ended_at nullable
- duration_ms nullable
- failure_code nullable
- transcript_policy
- created_at
- updated_at
```

Do not persist LiveKit access token.

## 6. Turns

Only when transcript storage is enabled:

```text
call_turns
- id
- call_id
- user_id
- turn_id
- role
- text
- started_at nullable
- committed_at nullable
- completed_at nullable
- interrupted boolean
- created_at
```

Roles: `user`, `agent`.

Never persist chain-of-thought/private reasoning.

## 7. Product events

Optional user-visible timeline:

```text
call_events
- id
- call_id
- user_id
- turn_id nullable
- type
- label nullable
- status nullable
- metadata nullable
- occurred_at
```

Examples: connected, tool activity, approval, reconnect, ended.

Do not dump all raw provider events into product DB.

## 8. Usage

```text
usage_records
- id
- user_id
- call_id
- provider
- metric
- quantity
- unit
- recorded_at
```

Possible metrics: livekit_minutes, stt_audio_seconds, tts_characters, call_seconds.

As built (Milestone 8): until this table exists, each call's usage summary is stored on its call-history row as `usage` (see `callUsageSchema` in `packages/contracts` and OBSERVABILITY_AND_SLOS §16), and `CallHistoryRepository.usageRollup` sums it per UTC day and agent. It holds counts and durations only, no transcript, and ages out with the history (200 calls per user).

## 9. User settings

```text
user_settings
- user_id
- retain_transcripts boolean
- analytics_opt_in nullable
- default_audio_preference nullable
- created_at
- updated_at
```

Future: incoming calls, quiet hours, ring rules.

## 10. Durable statuses

Agent health:

```text
unknown
healthy
failed
```

Call:

```text
created
connecting
active
ending
ended
failed
```

Do not mirror every transient state-machine state into database.

## 11. Retention

Suggested baseline:

- raw audio not retained by Twring by default;
- transcript retention explicitly disclosed/configured;
- call metadata retained per product account policy;
- diagnostics bounded;
- provider retention settings reviewed before launch.

## 12. Deletion

Deleting agent removes credential material immediately.

Deleting call removes transcript/events associated with it, subject only to legitimate accounting/legal retention for non-content metadata.

Account deletion revokes sessions and removes/anonymizes user-owned records according to published policy.

## 13. Indexes

Likely initial indexes:

- agents(user_id, updated_at)
- calls(user_id, created_at desc)
- calls(agent_id, created_at desc)
- call_turns(call_id, created_at)

Measure before exotic indexing.

## 14. RLS

If mobile accesses Supabase tables directly, enforce/test RLS.

Prefer backend API for secret-bearing resources.

## 15. API models are not DB rows

Map persistence models into DTOs so secret/internal fields never leak accidentally.

## 16. No raw event lake in V1

Do not store STT partials, audio frames, LiveKit packets, or TTS chunks in product database.
