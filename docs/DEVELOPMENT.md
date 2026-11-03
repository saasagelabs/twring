# Twring Development Guide

## Prerequisites

- Node.js 24 (`.nvmrc`) and pnpm 11 (`packageManager` in `package.json`; `corepack enable` picks it up).
- Android: Android Studio with an SDK and emulator, or a USB-debuggable device. JDK 17+.
- iOS: macOS with Xcode. Windows can't generate or build the iOS project; CI does both.

## Workspace commands (repo root)

```text
pnpm install
pnpm format:check | pnpm format
pnpm lint
pnpm typecheck
pnpm test
pnpm test:integration
pnpm expo:doctor
pnpm gateway:dev          # gateway on :8080 with watch mode
```

Use `pnpm run expo:doctor`, not `pnpm doctor`. pnpm 11 has a built-in `doctor` command that runs instead of the script.

## Gateway

```text
cp apps/gateway/.env.example apps/gateway/.env
pnpm gateway:dev
curl http://localhost:8080/health/live
curl http://localhost:8080/health/ready
```

`pnpm --filter @twring/gateway run build && pnpm --filter @twring/gateway run smoke` builds `dist/main.js`, boots it, and checks both health endpoints over HTTP.

### Calls and LiveKit

The gateway serves the call API and joins each call as the `cord-gateway` participant, in one process. Without `LIVEKIT_*` in `apps/gateway/.env` it still starts, but `POST /v1/calls` answers 503. With them, `/health/ready` also checks LiveKit.

1. Create a LiveKit Cloud project for staging (never share it with production).
2. From its settings, copy the WebSocket URL, an API key, and its secret into `apps/gateway/.env` as `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`.
3. Check the audio path end to end without a phone:

   ```text
   pnpm --filter @twring/gateway run livekit:smoke
   ```

   It starts the gateway in-process, places a call, joins as a Node "phone" that sends a steady tone, and checks that the gateway hears it, that the phone hears the ready chime and its own echo, and that hang-up deletes the room. It prints timings as JSON and uses about 15 seconds of LiveKit time.

Until users connect their own agents (Milestone 5), `GATEWAY_AUDIO_TEST_MODE` picks what a call talks to:

- `agent` (default when `DEEPGRAM_API_KEY` is set): the built-in fake streaming agent (`packages/agent-adapter/src/fake-agent.ts`). Say "check …" for a pretend tool call ("Looking that up…"), "tell me a story" for a long answer, "format" for markdown, "simulate a failure" or "simulate silence" for the error and timeout paths.
- `repeat`: says back exactly what STT heard, for recognition-accuracy checks.
- `echo` (default without Deepgram): a two-note chime, then the caller's own voice about 0.6 s later.
- `tone`: the chime only. `off`: silence.

Once a second the gateway sends the phone the peak level it hears, which drives the "Twring hears you" meter.

### Speech (Deepgram)

Put a Deepgram API key in `apps/gateway/.env` as `DEEPGRAM_API_KEY`. It is a server secret and never goes in the app. Then check both directions without a phone:

```text
pnpm --filter @twring/gateway run voice:smoke
```

Flux TTS speaks a known sentence. That audio is streamed through the same 48 → 16 kHz downsampler a live call uses into Flux STT, and the transcript must contain the sentence's key words. It prints TTS first-audio and STT end-of-turn timings. Provider details live only in `apps/gateway/src/voice/deepgram-*.ts` (ADR-013).

Optional `DEEPGRAM_STT_EOT_THRESHOLD` (Flux `eot_threshold`, 0.5–1.0, default 0.7) and `DEEPGRAM_STT_EOT_TIMEOUT_MS` (Flux `eot_timeout_ms`, 500–60000, default 5000) tune when Flux ends a turn; unset keeps Flux's defaults. A higher threshold means fewer cut-offs mid-thought, at the cost of slightly later replies. Staging and production use 0.85: at 0.8, 11 of 14 owner resumes came 0.7–1.4 s after a commit and cut a request in two; at 0.85 a following call had none (2026-10-07).

Keyterms (names and places Flux should favour) come from three places, merged in this order: a saved agent's own "Words to recognise" (up to 40, set on the agent detail screen or via `keyterms` on `POST`/`PATCH /v1/agents`), the interruption words ("wait", "stop", ...), then `DEEPGRAM_STT_KEYTERMS`. The merge dedupes case-insensitively and stops at 50 terms or an estimated 450 tokens (Deepgram documents a 500-token keyterm budget), so an agent's own words always win. To see the effect without a recording:

```sh
pnpm --filter @twring/gateway exec tsx --env-file-if-exists=.env scripts/keyterm-probe.ts
```

It speaks sentences with Indian place names through Deepgram TTS and transcribes them with and without the names as keyterms. First run (2026-09, flux-general-en): 7/12 names recognised without keyterms, 11/12 with (e.g. "TierraCharpoli" → "Tiruchirappalli"). Synthetic speech is cleaner than a real caller, so treat it as a sanity check.

Cartesia Sonic is an optional second TTS provider (ADR-020). Put `CARTESIA_API_KEY` in `apps/gateway/.env` (server secret, never in `.env.example`) and its voices appear in the voice picker. To compare time to first audio with Deepgram:

```sh
pnpm --filter @twring/gateway exec tsx --env-file-if-exists=.env scripts/tts-latency-probe.ts 5
```

It speaks the same five sentences N times (default 3) with Deepgram and with a Cartesia Indian and American voice, printing first-audio and total time (p50/p90), then cancels a long answer after 500 ms and checks no audio from it arrives afterwards. It exits with code 2 if either key is missing. Run it from the staging server too: the network path matters as much as the provider.

First run (2026-09-29, 3 runs × 5 sentences, from a developer PC in India, sonic-3.6):

| Voice | First audio p50 / p90 | Total p50 / p90 | Old audio after cancel |
| --- | --- | --- | --- |
| Deepgram flux-haley-en | 312 / 360 ms | 2459 / 2617 ms | 0 bytes |
| Cartesia Janvi · Indian | 89 / 97 ms | 499 / 535 ms | 0 bytes |
| Cartesia Skylar · American | 95 / 118 ms | 504 / 551 ms | 0 bytes |

Staging run (2026-09-29, 5 runs × 5 sentences, from the Lightsail staging server in Mumbai, sonic-3.6); this is the evidence for ADR-022:

| Voice | First audio p50 / p90 | Old audio after cancel |
| --- | --- | --- |
| Deepgram flux-haley-en | 339 / 350 ms | 0 bytes |
| Cartesia Janvi · Indian | 66 / 75 ms | 0 bytes |
| Cartesia Skylar · American | 70 / 83 ms | 0 bytes |

To check the whole conversation loop (STT → fake agent → streamed TTS, with real-time playout pacing) over three spoken turns:

```text
pnpm --filter @twring/gateway run conversation:smoke
```

It checks each turn's floor sequence and reply, and that first agent text → first TTS audio is within the p95 budget.

Call API (no user auth until Milestone 7; see ADR-012):

| Endpoint | Purpose |
| --- | --- |
| `POST /v1/calls` with `{}` | Creates the room and returns a caller token scoped to that room |
| `GET /v1/calls/:callId` | Safe status: `connecting`, `active`, `ending`, `ended`, `failed` |
| `POST /v1/calls/:callId/end` | Idempotent hang-up; deletes the room |

`CALLS_ENABLED=false` is the kill switch for new calls. `CALL_MAX_CONCURRENT`, `CALL_MAX_DURATION_S` and `CALL_CREATE_RATE_PER_MINUTE` bound abuse and cost.

### Fake native agent (`cord-agent/1`)

A reference agent that speaks the Twring Native protocol, so adapter and call work doesn't need a real agent:

```text
pnpm fake-agent                           # ws://127.0.0.1:8787, streamed replies
pnpm fake-agent --mode instant            # or FAKE_AGENT_MODE=instant
```

Modes: `streamed` (default), `instant`, `delayed` (3 s think time), `malformed` (a broken frame mid-reply), `drop-mid-turn` (kills the socket mid-reply). It requires `Authorization: Bearer <token>`; the token is `FAKE_AGENT_TOKEN`, defaulting to the test value `dev-token`. `FAKE_AGENT_PORT` changes the port. Replies are the FakeAgentAdapter's scripts ("check …" does a pretend tool call, "tell me a story" is long, and so on).

Adapter conformance (AGENT_ADAPTER_SPEC §18) runs with the normal tests: `pnpm --filter @twring/agent-adapter test`. `src/native-adapter.test.ts` runs `runAdapterConformance` from `@twring/agent-adapter/conformance` against `NativeWsAdapter` and a scripted fake server on a free 127.0.0.1 port. A new adapter passes the same suite by supplying a harness for each scenario.

### Connect a native agent

Calls can talk to any `cord-agent/1` agent instead of the built-in fake one:

1. Start an agent: `pnpm fake-agent`, or your own `cord-agent/1` server.
2. In `apps/gateway/.env` (never the `.example`), set:

   ```text
   GATEWAY_AUDIO_TEST_MODE=native
   AGENT_NATIVE_URL=ws://127.0.0.1:8787
   AGENT_NATIVE_TOKEN=<dev token>        # the fake agent's is FAKE_AGENT_TOKEN, default dev-token
   ```

   Native mode also needs `DEEPGRAM_API_KEY`.
3. Restart the gateway and call. If the agent is down or refuses the token, the call ends and the phone says it couldn't reach your agent; the gateway logs `agent_unavailable` with an error code only.

Outside development the gateway's SSRF guard requires `wss://` and a host that resolves to a public address (no localhost or private networks), and `AGENT_NATIVE_TOKEN` must be at least 16 characters.

### Connect an HTTP agent (`cord-rest/1`)

An agent that already serves HTTP can answer one `POST` per turn with Server-Sent Events, or with one JSON body if it can't stream (AGENT_ADAPTER_SPEC §21).

1. Start an agent:
   - `pnpm fake-rest-agent` serves the fake agent's replies at `http://127.0.0.1:8789/cord/turns` (token `FAKE_AGENT_TOKEN`, default `dev-token`). `--mode json` answers with final JSON, and the phone then shows "This agent doesn't stream, so replies may take longer." once. Other modes: `instant`, `slow-first-byte`, `malformed`, `drop-mid-stream`, `401`, `500`.
   - Or the Claude Code dogfood agent: `CLAUDE_AGENT_TOKEN=<secret> pnpm claude-agent` serves `cord-rest/1` at `http://127.0.0.1:8788/cord/turns` next to its WebSocket endpoint (see `examples/claude-code-agent/README.md`).
2. In `apps/gateway/.env` (never the `.example`), set:

   ```text
   GATEWAY_AUDIO_TEST_MODE=rest
   AGENT_REST_URL=http://127.0.0.1:8789/cord/turns
   AGENT_REST_TOKEN=<dev token>
   ```

   REST mode also needs `DEEPGRAM_API_KEY`.
3. Restart the gateway and call. A REST agent is first contacted on your first turn, so a refused token ends the call then (`agent_unavailable`, with `auth_failed` in the log and never the token or URL).

Outside development `AGENT_REST_URL` must be `https://` on a public host, and `AGENT_REST_TOKEN` must be at least 16 characters. Adapter tests, including the §18 conformance suite, are in `packages/agent-adapter/src/rest-sse-adapter.test.ts`; gateway integration tests are in `apps/gateway/test/rest-agent.int.test.ts`.

### Saved agents (Milestone 7)

The gateway stores saved agents, their credentials (encrypted), and call history as JSON files, keyed by user. With `AUTH_MODE=dev` (the development default) every request acts as one local user, `dev-user`; with `AUTH_MODE=supabase` each signed-in user has their own (see *Sign-in* below).

1. Generate a credentials key once and put it in `apps/gateway/.env` (never the `.example`):

   ```bash
   node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
   ```

   ```text
   CORD_CREDENTIALS_KEY=<the printed value>
   CORD_DATA_DIR=./data          # optional; this is the default in development
   ```

   Without the key the gateway still starts, but `/v1/agents` answers 503. Outside development both `CORD_CREDENTIALS_KEY` and `CORD_DATA_DIR` are required. Losing the key makes saved credentials unreadable (the app asks for them again); it never exposes them.
2. Restart the gateway. `POST /v1/agents` saves an agent, `POST /v1/agents/:id/test` checks it from the gateway, and `POST /v1/calls` with `{"agent_id": "..."}` calls it in its voice. Without `agent_id`, calls keep using `GATEWAY_AUDIO_TEST_MODE`.
3. To rotate the key: set the new key with `CORD_CREDENTIALS_KEY_VERSION` one higher, and keep the old one readable as `CORD_CREDENTIALS_OLD_KEYS=<old version>:<old key>`. New and re-entered credentials use the new key.

`apps/gateway/data/` is git-ignored. Delete it to start over. On a server, point `CORD_DATA_DIR` at a folder on a persistent disk that only the gateway user can read, and back it up with the key stored separately.

### Sign-in (ADR-021)

Local development works with or without sign-in.

**Without sign-in.** Gateway `.env`: `AUTH_MODE=dev` (the default). Mobile `.env.local`: empty `EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID` (the `.env.example` fills it in). The app skips the Sign-in screen and every request is `dev-user`. The Claude Code dogfood agent and `curl` against `/v1` work unchanged, with no token.

**With sign-in.** Needs the Google OAuth clients (below) and a development build that includes Google Sign-In.

1. Gateway `.env`: `AUTH_MODE=supabase` and `SUPABASE_URL=https://gifdayffysmzskxdgmgp.supabase.co`. Every `/v1` request then needs `Authorization: Bearer <Supabase access token>`: 401 `auth_required` without one, 401 `auth_invalid` for a bad or expired one, 503 `auth_unavailable` if Supabase's key set can't be fetched.
2. Mobile `.env.local`: `EXPO_PUBLIC_SUPABASE_URL`, `EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY`, and `EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID` (all three are in `.env.example`). For iOS also `EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID` (it sets the URL scheme at build time, so rebuild after setting it).
3. Restart Metro with `pnpm start --clear`. The app opens on **Sign in** → **Continue with Google**.

Google Cloud OAuth clients (project `cord-510116`; the consent screen is in Testing, so only its listed test users can sign in):

- **Web application** client (`605371988164-rtamegb6…`): its id is `EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID` (`webClientId`), the audience of the ID tokens, and it is listed in Supabase → Authentication → Providers → Google → *Client IDs*.
- **Android** client per installable package: `com.twring.app.dev` with the SHA-1 of the debug keystore (`cd apps/mobile/android && ./gradlew signingReport`, or `keytool -list -v -keystore ~/.android/debug.keystore -alias androiddebugkey -storepass android`), and `com.twring.app.staging` (not created yet) with the SHA-1 of the key that signs staging APKs (and the Play signing key later). The previous development client's ID is `605371988164-ctlt6fjf…` (old package; a new client is needed for com.twring.app). The Android client's ID is not used in code, but Google refuses sign-in (`DEVELOPER_ERROR`) without it.
- Created 2026-10-07: "Twring Dev (Android)" `605371988164-t5ol…` and "Twring Staging (Android)" `605371988164-5l94…`, both with the debug keystore SHA-1 `5E:8F:16:06:2E:A3:CD:2C:4A:0D:54:78:76:BA:A6:F3:8C:AB:F6:25`. The production client (`com.twring.app`) needs the Play app-signing SHA-1, so it is created after the Play Console is set up. Firebase `cord-push` has Android apps for all three Twring packages; the combined `google-services.json` lives at `~/.cord/google-services.json`.
- **iOS** client for bundle id `com.twring.app.dev` (and `.staging`) when iOS sign-in is needed.
- Nonce: Supabase's nonce check stays on. On Android the free Google Sign-In API issues ID tokens without a nonce and Twring sends none, which Supabase accepts ("both exist or neither"). The iOS SDK always adds its own nonce, so iOS sign-in needs either *Skip nonce checks* in Supabase or the library's paid Universal Sign-In (which lets Twring pass the nonce); decide before iOS testing.

Data saved as `dev-user` is not moved to a signed-in account.

### Local agent connector (`cord-connect`, ADR-023)

Call an agent on your own computer (Claude Code, Codex, Gemini CLI, Hermes, or a command) through the dev gateway. Saved agents must be on (`CORD_CREDENTIALS_KEY` set).

1. Start the gateway (`pnpm gateway:dev`). With `AUTH_MODE=dev` you can get a code with curl:

   ```text
   curl -X POST http://localhost:8080/v1/connectors/pairings
   ```

   or from the app: Add agent, On my computer.
2. In the folder the agent should work in:

   ```text
   pnpm --filter @twring/connector start -- --code ABCD-EFGH --server http://localhost:8080
   ```

   `http://` is accepted only for localhost. The pairing is saved under `~/.config/cord-connect` (Windows `%APPDATA%\cord-connect`); set `CORD_CONNECT_CONFIG_DIR` to keep a separate dev pairing. Later runs need no flags. When you start it from inside Claude Code, the connector already drops `CLAUDE_CODE_*` from the agent's environment.
3. Finish in the app (pick the agent, name it, choose a voice) and call. Stopping the connector makes calls end with "Your computer isn't connected".

Per-agent setup and safety defaults: `apps/connector/README.md`.

## Mobile (development build, not Expo Go)

```text
cp apps/mobile/.env.example apps/mobile/.env.local
cd apps/mobile
pnpm android              # expo run:android: prebuild, compile, install, launch
pnpm start                # Metro for an already-installed dev build
```

### Pointing the app at your gateway

Development builds load their JS from your Metro server. Metro inlines `EXPO_PUBLIC_*` from `apps/mobile/.env.local` when it bundles, so that file sets the API address, not `eas.json`. `.env.local` is git-ignored. Keep device-specific addresses there, never in a committed file. After changing it, restart Metro with `pnpm start --clear`.

| Where the app runs | `EXPO_PUBLIC_API_BASE_URL` in `.env.local` |
| --- | --- |
| Android emulator | `http://10.0.2.2:8080` |
| Android phone over USB | Run `pnpm android:usb-reverse`, then use `http://localhost:8080` |
| Any phone on the same Wi-Fi | `http://<your-lan-ip>:8080` |
| iOS device, or any network | An HTTPS tunnel to port 8080, e.g. `https://<your-tunnel-host>` |

`adb reverse` lasts until the phone is unplugged or adb restarts. Re-run the script after reconnecting.

### Test call on a phone

With the gateway running with LiveKit configured, `pnpm android:usb-reverse` done, and Metro running, tap **Call test line**. Allow the microphone. You should see *Connecting…*, then *Listening* with a call clock, hear a chime, then hear yourself a moment later. The meter reads *Twring hears you* while you talk. **End** hangs up. The phone reaches LiveKit over its own internet connection; only the API goes through `adb reverse`.

Adding or upgrading a native dependency (LiveKit, WebRTC, Google Sign-In, secure store) needs a fresh development build: `pnpm android` again, not only a Metro restart.

If Gradle fails with `java.io.IOException: Unable to establish loopback connection` (seen inside sandboxed shells on Windows), Java cannot create its Unix-domain wake-up socket in `%TEMP%`. Point it at a writable folder **outside the repo** (Metro watches the repo and crashes on socket files) and rebuild:

```text
JAVA_TOOL_OPTIONS=-Djdk.net.unixdomain.tmpdir=<writable folder outside the repo>
```

If another project's Metro already holds port 8081, start this one with `pnpm start --port 8082`, run `adb reverse tcp:8082 tcp:8082`, and open `cord-dev://expo-development-client/?url=http%3A%2F%2Flocalhost%3A8082` on the phone.

If `EXPO_PUBLIC_API_BASE_URL` is missing, the app shows its "missing configuration" screen. It never silently falls back to an emulator-only address.

`android/` and `ios/` are generated by prebuild (CNG) and git-ignored. Configure native behavior in `app.config.ts` and config plugins. Never edit the generated folders.

Cloud builds: `npx eas-cli@latest build --profile development --platform android`. This requires an Expo account and `eas init` to write the project ID first.

## Environments

| Variant | `APP_VARIANT` | App ID suffix | `EXPO_PUBLIC_CORD_ENV` | Gateway `CORD_ENV` |
| --- | --- | --- | --- | --- |
| Development | `development` | `.dev` | `development` | `development` |
| Staging | `staging` | `.staging` | `staging` | `staging` |
| Production | `production` | none | `production` | `production` |

The rules are validated by `@twring/config`:

- Staging and production mobile builds require `https://` API URLs and `wss://` LiveKit URLs, and the sign-in values (`EXPO_PUBLIC_SUPABASE_*`, `EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID`).
- Staging and production gateways require `AUTH_MODE=supabase` and an `https://` `SUPABASE_URL`.
- A production gateway refuses to start without `SENTRY_DSN`.
- Invalid config fails fast. Error messages name the variable but never print its value.
- Mobile config holds public values only. Provider secrets belong in the gateway's host secret store.

### Staging placeholders (to fill when accounts exist)

- `apps/mobile/eas.json`: the `staging` profile points at `https://api.staging.cord.invalid`. Replace it with the real staging API.
- `apps/gateway/.env.staging.example` lists the staging variables, including those added in Milestones 1–2.
- Sentry: `EXPO_PUBLIC_SENTRY_DSN` / `SENTRY_DSN` are empty, so Sentry is a no-op. To enable source-map upload, set `SENTRY_ORG` and `SENTRY_PROJECT`, add the EAS secret `SENTRY_AUTH_TOKEN`, and drop `SENTRY_DISABLE_AUTO_UPLOAD` from that EAS profile.
- Separate staging LiveKit and Deepgram projects arrive with the milestones that use them. Supabase (sign-in) uses one project for now; its URL and publishable key are in `eas.json` for staging and production. Add `EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID` to those profiles once the Google client exists: staging and production builds refuse to start without it.

## CI

GitHub Actions runs everything. Public repositories get the Linux and macOS runners free.

| Workflow | Runs on | What it does | Output |
| --- | --- | --- | --- |
| `verify.yml` | every pull request to `main` | frozen install, audit, format, lint, typecheck, unit and integration tests, gateway build plus HTTP smoke test, expo-doctor | None |
| `android.yml` | pull requests that can change the app binary | Android prebuild, `assembleRelease`, signature check | `cord-staging-apk` artifact |
| `ios-build-check.yml` | pull requests that change native inputs (`apps/mobile/package.json`, `app.config.ts`, `plugins/`, `modules/`, root `package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`), and by hand | iOS prebuild with pods, then an unsigned simulator `xcodebuild` | None |
| `ios-testflight.yml` | by hand from `main` only; the maintainer approves each run | signed App Store build uploaded to App Store Connect (TestFlight); `upload: false` signs and exports only | logs and dSYMs (never the IPA) |

`main` is protected: changes arrive through pull requests, `verify` and `DCO` must pass, and every commit carries a sign-off (`git commit -s`).

The TestFlight build reads its signing certificate, profile and App Store Connect key from the `testflight` environment's secrets, which only runs from `main` can use. The build number is one higher than the highest build App Store Connect already has.

**The APK** from `android.yml` is a standalone release build with its JS bundle embedded, signed with the Expo template's debug keystore. It installs on any phone or emulator (`adb install <apk>`), but Google Play won't accept it. It uses the staging identity (`com.twring.app.staging`, "Twring Staging"), so it installs alongside a local `.dev` development build. For a Metro-connected development build, use `pnpm android`.

## Names you will still see

Twring was built under the codename **CORD**. Code, docs and package names say Twring now. Some live names keep "cord" because changing them would break installed apps, paired computers or running servers. Renaming them needs a coordinated server, app and computer-tool update, so they stay:

- the `cord://` link and sign-in scheme;
- the agent protocols `cord-agent/1` and `cord-rest/1`, and event names like `cord.ring`;
- server settings (`CORD_*`);
- the app's native call module (`cord-call-service`) and stored keys on the phone;
- the "CORD connect" task that `twring-connect` installs on Windows.
