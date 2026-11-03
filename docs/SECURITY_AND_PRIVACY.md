# Twring Security and Privacy

## 1. Trust model

Twring sits between a human microphone, speech providers, realtime media infrastructure, a user-controlled external agent, and that agent's tools.

Treat every boundary explicitly.

## 2. Core rule

Twring must never increase the connected agent's authority merely because the user is speaking instead of typing.

The connected agent's own permission/policy model remains authoritative.

## 3. Secrets

Never ship server secrets in mobile.

Server-only examples:

- LiveKit API secret;
- Deepgram server key when using direct provider account;
- Supabase service-role key;
- credential-encryption master key;
- backend signing secrets.

User agent credentials:

- encrypted at rest;
- decrypted only in backend/gateway memory when needed;
- redacted from logs;
- never returned after save.

Speech keys (a person's own voice-provider key, behind `SPEECH_KEYS_ENABLED`): sealed with AES-256-GCM, additional data binds user and provider; never logged and never returned (only the last four characters); checked live only against the fixed provider hosts.

xAI keys follow the same rules, with these specifics: the only host is `api.x.ai` (fixed, never taken from input); a key is checked with `GET /v1/tts/voices`; the key travels only in an `Authorization: Bearer` header; redirects are refused; the check times out after 5 s; keys are never logged.

## 4. Transport security

Production requires HTTPS/WSS and normal certificate validation.

No “accept invalid certificate” fallback.

## 5. SSRF protection

Twring server connects to user-provided agent URLs, so SSRF is a launch-critical risk.

Implement:

- URL parsing;
- HTTPS/WSS-only production scheme;
- DNS resolution checks;
- reject loopback;
- reject link-local;
- reject cloud metadata ranges;
- reject private networks unless a future explicit trusted self-host mode exists;
- revalidate redirects;
- bound redirects;
- mitigate DNS rebinding where practical;
- connection timeout;
- max response/event size.

### 5.1 Local agent connector (ADR-023)

`cord-connect` dials out from the user's computer, so the gateway never connects to a user-supplied address for these agents (no SSRF surface). Its own threats and controls:

- **Pairing-code guessing:** about 40 bits per code, single use, 10-minute life, at most 3 open codes per user, and `POST /v1/connectors/claim` is rate limited per IP (`CONNECTOR_CLAIM_RATE_PER_MINUTE`, default 10). A claim needs no sign-in: the code is the proof.
- **Token theft:** the connector token (256 bits) is stored server-side only as a SHA-256 hash, and on the computer in a config file with mode 600. It is never printed or logged (log lines carry the connector id only). Revoking the computer in the app, or deleting the account's data, closes its socket and the token stops working at once. Socket upgrades are rate limited per IP (`CONNECTOR_SOCKET_RATE_PER_MINUTE`).
- **Cross-user reach:** a relay channel opens only on a connector owned by the calling user; saving a `cord-connector` agent checks the computer belongs to the user and offers that agent. Anything else reads as `agent_offline`.
- **Untrusted frames:** the socket authenticates on the HTTP upgrade, before any frame; the first frame must be a valid hello; frames are size-limited both ways; everything inside a channel passes the same `cord-agent/1` validation and stream guard as a network agent.
- **Computer-first link requests (ADR-025):** creating one needs no sign-in, so it is rate limited per IP (10/hour), capped at 5 open per IP and 1000 in all, and lives 10 minutes. The computer polls with a 256-bit poll token stored only as a hash; a wrong token reads as not found. The connector token is delivered once, on approval, and the request is then gone. Codes are single use; wrong codes on the phone are limited per user (10/hour) and per address (30/hour, so many accounts do not multiply guesses), and another user's used code works for no one. A repeated approval from the same user gets the same answer (its first reply may have been lost); nobody else's does. Codes ride in the phone routes' paths, so request logs and Sentry show them as `[code]`.
- **Code phishing:** someone could send a victim a code from *their own* computer so the victim links it. The phone shows the computer's name and its agents before anything is approved, approval is an explicit tap, and it can be cancelled. A wrongly linked computer would hear what the victim says to agents saved for it, so the name is the main defence; the computer can be removed in the app at any time, which revokes its token at once. It cannot read the victim's other agents, credentials, or history. Names are sanitized (≤ 40, no control, bidi, or invisible characters such as LRM/RLM, zero-width space, or word joiner).
- **Server pinning:** the QR code names its server; the phone refuses one that is not its own API base URL, so a crafted code never makes it talk to another server. Only ASCII case is ignored in that comparison, so look-alikes such as the Kelvin sign never match.
- **Agents set themselves up (ADR-027):** the phone puts a phone-first pairing code in a message the owner forwards to their agent's chat. The code is single use, valid 10 minutes, and links only into the sender's account; anyone who reads the message within those 10 minutes could link **their** machine into the owner's account, so the phone shows the machine's name before any agent is added and the owner can remove it. `cord-connect setup` installs a background service that runs as the user (a root system unit only when setup itself runs as root); no unit, plist, task, or launcher file holds the token, which stays in the mode-600 config. The download URL is built from the app's own API base URL (https).
- **Transport:** the connector refuses a server that is not `https://` (plain `http://` only to localhost for development) and does not follow redirects.
- **Agent authority:** the connector relays words and the agent's own events; it never runs tools. Local agents start with safe defaults (Claude Code read/search tools only; Codex read-only sandbox; ACP permission requests denied unless the user allowlists a tool kind; no MCP servers passed). Agent output never reaches a shell: user text goes to agents on stdin or JSON, never on a command line.

## 6. Input validation

Validate adapter type, endpoint, headers, event schema, text lengths, metadata size, call IDs, and ownership.

Agent-provided labels are untrusted text.

Do not render arbitrary HTML.

## 7. Tool authority

Twring observes tool/activity events. It does not receive the connected agent's MCP/tool credentials.

Approval response is relayed to the connected agent, which remains responsible for execution.

- Agent-provided approval text is shown but never spoken, so the agent cannot phrase its own approval. Approval decisions are owner-scoped and accepted once; no answer before the timeout means deny.

## 8. Speech/transcription privacy

Before launch, document accurately:

- which provider processes audio;
- provider retention/training settings;
- whether transcript is stored;
- deletion controls;
- whether raw audio is stored.

Twring default: do not persist raw audio.

Call ratings and optional notes are stored in `call-feedback.json` and removed by Delete my data.

## 9. Transcript privacy

Voice-note audio is sent to Deepgram for transcription and is not kept by Twring. Its transcript is kept as a chat message until the user clears it.

Calls keep no transcript. Chats (text threads, ADR-031) are the one place Twring stores conversation text:

- disclosed in `docs/PRIVACY.md` (§2, §3, §4, Data safety);
- user-scoped: every store query and route is scoped by the signed-in user; another user's agent or message is 404;
- sealed at rest: AES-256-GCM with a key derived by HKDF from the credential key (`cord-messages-v1`), AAD = user, thread and message ids; ring reasons and decline notes are sealed too;
- never in logs or crash reports: thread logs carry ids, statuses, codes and lengths only;
- deletion: Clear chat, Delete agent, and Delete my data (a running turn is stopped first); SQLite `secure_delete` is on;
- limits: 4,000 characters in, 20,000 stored out, 5 queued, 30 writes a minute, 500 messages a day.

### 9.1 The phone socket

`/v1/me/socket` carries chat updates to the signed-in phone. The Supabase JWT is checked on the HTTP upgrade (401 before any socket exists), upgrades are rate limited per address, a user has at most 3 sockets, frames from the phone are 4 KiB at most and only `focus` is accepted, a socket lives 55 minutes (the phone reconnects with a fresh token), and Delete my data closes it. It is a speed-up only: the phone catches up over REST.

## 10. Analytics

Never send raw transcript to product analytics.

Good analytics:

- call_connected;
- duration;
- latency;
- adapter_type;
- error_code.

Sentry breadcrumbs must avoid secrets/full transcript.

## 11. Authentication

Use proven authentication provider.

Do not build custom password storage.

Status (ADR-021):

- [x] Proven provider: Google sign-in through Supabase Auth; Twring stores no passwords.
- [x] Every `/v1` route requires a Supabase access token, verified on the gateway against the project JWKS (ES256/RS256 only, issuer, audience `authenticated`, exp/nbf, `role` = `authenticated`, not an anonymous sign-in); the user id is `sub`, which must be a lower-case uuid (so never `dev-user`).
- [x] Fails closed: a JWKS outage answers 503 `auth_unavailable`, never lets a request through.
- [x] Staging and production refuse to start without `AUTH_MODE=supabase`.
- [x] Session stored in the platform secure store (Keychain / Android Keystore); tokens are never logged (`authorization`, `access_token`, `refresh_token` are redacted).

## 12. Authorization

Object-level checks on every user resource.

Tests must prove:

- user A cannot fetch B's agent;
- user A cannot call B's agent;
- user A cannot read B's call;
- revoked session cannot mint call tokens.

Status (ADR-021):

- [x] Every store query is scoped by the verified user id; cross-user tests cover agents, calls, call status, history, and deletion.
- [x] Only a verified session can create a call and so mint a LiveKit token; tests cover missing, expired, and forged tokens.
- [ ] Revocation is bounded by the access-token lifetime (Supabase default 1 hour): a token signed out elsewhere works until it expires.

## 13. LiveKit security

Mobile receives short-lived, minimum-grant token.

Room metadata/names contain no secrets.

Gateway validates expected room/call mapping.

## 14. Abuse controls

Initial safeguards:

- concurrent-call limit;
- call-duration cap/config;
- connection-test rate limit;
- event/byte limits;
- account-level usage guardrail.

Future incoming calls need stronger anti-abuse/ringing controls.

### 5.2 The agent rings the owner (ADR-024)

- **Who can ring:** only a paired connector, with its token (`POST /v1/connectors/ring`, rate limited per IP like the socket). It can ring only its own user, and only for an agent that user saved for that computer; anyone else is 401/404. Arbitrary third parties cannot ring a user.
- **Owner control:** Do Not Disturb, quiet hours (IANA time zone), one ringing invite at a time, and at most 6 rings per agent per hour. No microphone before the owner answers.
- **The reason** is 1–140 characters with control and bidi-override characters removed, shown as plain text and never rendered as HTML or markdown. Decline notes are sanitized the same way (≤ 60).
- **Invites** have unguessable ids (`inv_` + 130 bits). Every phone route (`/v1/invites…`, `/v1/me/devices…`, `/v1/me/ring-settings`) is owner-scoped: another user's invite reads as 404. Exactly one answer can win.
- **Push tokens are personal data.** They are stored per user, never logged, sent only to FCM, and deleted when the phone unregisters, when FCM reports them `UNREGISTERED`/invalid, or on Delete my data. The FCM service account key is a server secret read from `FCM_SERVICE_ACCOUNT_FILE`; its contents and access tokens are never logged, and the signed assertion goes only to `https://oauth2.googleapis.com/token`. Pushes are data-only with a 30 s TTL, so a stale ring is not delivered late.
- **Session resume:** the `session_ref` a connector sends is a plain id (`[A-Za-z0-9._:-]`, ≤ 200) and is checked again on the computer before it goes on a command line or into JSON-RPC.
- **Words an agent adds:** a paired connector (`POST /v1/connectors/words`) or a connected app (`add_words`) can add words only to its own saved agent's speech-recognition list, after the owner's own: at most 40, each at most 50 characters, with control and bidi characters refused. It cannot remove or reorder the owner's words; the owner sees and edits all of them on the agent's Words page. The words are never logged.
- **Hooks:** `cord-connect hooks install` edits only `~/.claude/settings.json` (a `Notification` hook) or `~/.codex/config.toml` (`notify`, opt-in), backs the file up first, never replaces someone else's `notify`, and prints every change.

## 15. Incoming call future security

Requirements:

- explicit user opt-in;
- trusted source;
- authenticated/signed initiation;
- reason for call;
- rate limits;
- quiet hours/blocking;
- no microphone before answer;
- arbitrary third parties cannot ring a user by ID.

## 16. Logging redaction

Always redact headers/keys matching sensitive names such as:

```text
authorization
x-api-key
cookie
set-cookie
password
token
secret
api_key
credential
```

Maintain a central sanitizer.

## 17. Errors

Never pass raw upstream body to mobile.

Return:

- stable Twring code;
- safe message;
- correlation ID.

Detailed redacted error remains server-side.

## 18. Dependencies

- commit lockfile;
- run dependency scanning;
- review security advisories;
- do not auto-merge major native upgrades;
- keep dependency count reasonable.

## 19. Mobile security

- no secrets in bundle;
- no secrets in deep links;
- secure storage for Twring auth material (done: expo-secure-store, ADR-021);
- production debug UI hidden/disabled;
- secret inputs masked;
- do not persist clipboard contents.

## 20. Data deletion

Provide deletion for saved agent, call/transcript, chats (Clear chat; Delete agent and Delete my data remove them too), and account.

Agent credential removal must immediately stop future use. The gateway enforces this by ending the agent's live calls when it is deleted or its credential, endpoint, or protocol is edited (the phone sees `agent_unavailable`, so the existing "couldn't reach your agent" copy applies; no new end reason). A call set up before such an edit re-checks the agent's revision when it connects and fails instead of pairing a credential with an address it was not saved with.

## 21. Incident readiness

Before public launch have:

- provider key rotation procedure;
- session revocation;
- disable-new-calls switch;
- correlation logs;
- basic incident ownership/runbook.

## 22. Launch security review

Review:

- threat model;
- SSRF;
- authz;
- secret leakage;
- log redaction;
- provider retention;
- mobile bundle inspection;
- dependency scan;
- abuse/rate limits;
- deletion.

## 23. Privacy principle

Store less.

Twring is a live conversation layer, not a surveillance archive.

## 24. Self-hosted servers (ADR-034)

A self-hosted server is run by its operator; Twring runs only the ring relay and, for servers that
need it, the audio service. The operator guide is https://twring.com/self-hosting/guide/
(`apps/site/self-hosting/guide/index.html`).

### Pairing

- Pairing codes are high entropy, single-use, short-lived, hashed at rest, compared in constant
  time and rate-limited: 5 a minute per address (an IPv6 /64 counts as one address), and 6000 wrong
  well-formed codes an hour for the whole server (codes are 1 of 31^8) (malformed requests count only per address, so
  junk cannot lock pairing). Device tokens are hashed at rest and revocable.
- The QR carries the server id; the app refuses a server that answers with a different id.
  `GET /v1/server?nonce=` also answers the server's public key and a proof signed by it
  (`verifyServerProof` in contracts, which also checks the id the QR named), so a server cannot
  claim another server's id.
- A removed device gets `device_removed` (401); member-only actions return `forbidden` (403); the
  last admin cannot be removed (`last_admin`, 409). Removing a person revokes their connectors,
  rings and devices, ends their live calls and closes their phone socket at once.
- Shared agents are opt-in (`twring link --shared`, or yes at the installer's question, default
  no): a shared agent runs as the linking login, so members can make it read files and use any
  tool that does not ask, as that login. The guide recommends a dedicated login with no SSH or
  cloud keys or personal files, and says the computer's owner can read every member's
  conversations on disk. Members get their own scoped agent session and their approval prompts
  are auto-denied (only the person whose computer runs the agent approves); computer links that do
  not support scoped sessions refuse members.
- A computer link replaced by a connection from another address logs `connector_replaced` (no
  addresses) on every self-hosted server and, with chats on, tells the computer's owner in a chat,
  at most once an hour.
- The beta waitlist route is hosted-only; a self-hosted server answers 404.

### Admin listener

- Admin commands (`twring pair`, `twring people`, `twring link`) reach the gateway on a listener
  bound to `127.0.0.1:8081` inside the container, never published, authenticated with
  `TWRING_ADMIN_TOKEN` (from the root-only `twring.env`).

### Ring relay

- Each install registers with its Ed25519 server key and gets a relay key, stored hashed; its email
  must be verified (7-day grace, then rings pause). Requests carry single-use signed proofs; phones
  get short-lived device tickets.
- Relay handles are bound to one install and one device; a handle held by another device is
  refused. Push tokens must match the hosted token formats; limits apply per install, per handle
  and per token, so a bad install cannot make Apple stop VoIP delivery to the app.
- The relay uses its own email key, never production's, and versioned database migrations.
- `DELETE /v1/installs/self` deletes an install with its phones, usage and audio records
  (`twring uninstall` calls it); per-call audio records are pruned after 90 days. For privacy
  requests the operator uses `DELETE /v1/admin/installs/:id` or
  `POST /v1/admin/installs/delete-by-email` (relay admin token, local only), which delete the same
  way.

### Sealing

- Notification contents are sealed on the server for the receiving device's seal key, with a
  fresh nonce per message (no caller can choose one). The relay forwards ciphertext it cannot
  read; the sealed payload names the device, so a ring for one phone cannot show on another.

### Reachability probe

- The relay probes only the install's registered address (its own public IP from `GET /v1/ip`, or
  the domain or public URL given), HTTPS only on port 443, with a per-resolved-IP cap across
  installs and fixed-time failure replies. Addresses are validated before they are stored. Names
  are resolved with c-ares (2 s, one try, cancelled with the probe), each name has its own budget
  (20 an hour) charged before resolving, and at most 16 probes run at once across the relay.
- `GET /v1/ip` answers 503 `relay_misconfigured` when the address it sees is not public (a proxy
  setting mistake), and the installer refuses a private, loopback or CGNAT address.

### Twring audio

- Call audio is encrypted in transit (not end to end: it passes through Twring's LiveKit) and
  never stored. Per-call, per-room tokens of 10 minutes; the LiveKit secret never leaves Twring. Minutes and
  lines are settled by verified LiveKit webhooks, not by the server's report.
- Limits per install (calls at once, minutes a day) and for the whole relay
  (`RELAY_AUDIO_MAX_CONCURRENT_TOTAL`, default 50; `RELAY_AUDIO_DAILY_MINUTES_TOTAL`, default 3000).
  An install gets no Twring audio until its email is confirmed (`audio_paused`). A dedicated
  LiveKit project for the relay is recommended (see Twring's operations notes, private).

### Installer

- The Twring image is pinned by digest. Caddy and LiveKit are pinned by tag until the first VPS
  smoke test records their digests.
- `install.sh` never installs Docker and never pipes another remote script; it uses
  `curl --proto '=https' --tlsv1.2`, digest-pinned images and a kit checked against
  `selfhost/versions.json`, and is safe under `curl | sh` (everything runs from `main`).
- Secrets stay out of the terminal and command lines: settings come from exported variables
  (`sudo -E`, never `sudo VAR=... sh`), the speech key is unset after its check, `twring.env` is
  root-only (600), and keys in the data volume belong to uid 10001.
- Agents are linked as the invoking user (`$SUDO_USER` or `TWRING_AGENT_USER`), never as root
  silently. The kit is always downloaded and checked, unless `--local-kit` is given; then the
  folder and every kit file must be root-owned with no group or other write.
- A run that registered with the ring service but did not finish deletes that registration again
  on exit (best effort, and says so). An existing data volume stops the installer before any
  question.
- The compose templates turn chats and files on (`THREADS_ENABLED`, `FILES_ENABLED`).
- In sandboxes `TRUST_PROXY` stays unset unless the operator sets `TWRING_TRUSTED_PROXIES`.
- Caddy access logs on both hosts drop the Authorization and Cookie headers and the `sig`, `exp`
  and `access_token` query parameters; container logs are size-capped.
- `scripts/deploy-site.sh` records the connector's checksum from the release build
  (`DEPLOY_SITE_CONNECTOR`, required), never from the live download, and checks the live file
  matches it after publishing.
