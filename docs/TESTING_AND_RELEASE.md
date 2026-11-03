# Twring Testing and Release

## 1. Philosophy

Automate deterministic behavior. Test actual audio behavior on real devices.

High unit-test coverage does not prove a working call product.

## 2. Test layers

### Unit

- state reducer;
- event validation;
- TTS chunking;
- error mapping;
- credential redaction;
- SSRF URL validation;
- event dedupe/order;
- timeout logic.

### Integration

- API + test DB;
- adapter + fake server;
- gateway + fake STT/TTS;
- reconnect;
- cancellation.

### Component/UI

- setup form;
- call states;
- approval;
- errors;
- accessibility labels.

### Device/E2E

- call starts;
- mic/speaker;
- interruption;
- route changes;
- network changes;
- background/foreground.

## 3. Fake providers

Fake STT supports partial/final/delayed endpoint/duplicate final/disconnect.

Fake TTS supports first-byte delay, late audio after cancel, and failure.

Fake agent modes:

- instant;
- streamed;
- delayed tool;
- non-streaming;
- error;
- malformed;
- cancellation;
- reconnect/resume.

## 4. State-machine tests

Required sequences include:

```text
connect → speak → working → speaking → listen
speaking → barge-in → user speaking
working → network loss → reconnect → working
speaking → end call → ended
```

Also test illegal transitions.

## 5. Adapter conformance

Every supported adapter runs the shared suite defined in `AGENT_ADAPTER_SPEC.md`.

## 6. Security tests

- cross-user access;
- SSRF private address;
- redirect to private address;
- credential redaction;
- oversized event;
- malformed event;
- protocol version mismatch;
- expired auth;
- idempotency/replay;
- agent ownership.

## 7. Android device matrix

Before beta, at minimum:

- modern Pixel/reference device;
- Samsung device;
- lower/mid-tier Android device.

Test supported Android versions according to current Expo/Play constraints.

## 8. iOS matrix before iOS launch

- current major iOS;
- previous supported major where practical;
- at least two device form factors.

## 9. Audio matrix

Every RC:

- earpiece/handset;
- speaker;
- Bluetooth;
- wired headset where available;
- low/high volume;
- noisy/quiet environments.

## 10. Network matrix

- strong Wi-Fi;
- weak Wi-Fi;
- mobile data;
- Wi-Fi → mobile;
- mobile → Wi-Fi;
- brief offline;
- high-latency/throttled.

Verify no duplicate agent action from reconnect.

## 11. Long-call test

At least 20–30 minutes.

Watch memory, audio degradation, idle timeouts, listener leaks, CPU/battery, and state drift.

## 12. Root CI commands

Target simple scripts:

```text
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm test:integration
```

Mobile config checks include Expo doctor/current equivalent.

## 13. PR gate

Code PR requires:

- typecheck;
- lint;
- relevant tests;
- secret-scan clean;
- invariant review.

Native dependency PR also requires Android build and iOS build/smoke when feasible.

## 14. Staging separation

Separate staging database/auth, LiveKit, Deepgram credentials, and test agents.

Do not point normal dev builds at production.

## 15. Release channels

Suggested:

```text
development
internal
beta
production
```

## 16. Android launch checklist

- final package identity;
- icon/splash;
- privacy policy;
- microphone disclosure;
- data-safety form based on actual behavior;
- production auth/backend/providers;
- quotas/limits;
- crash reporting;
- alerts;
- setup tested by someone who did not build it;
- reconnect/Bluetooth matrix;
- Play signing;
- internal/beta testing;
- store assets.

Re-check current Google Play policy at release time.

## 17. Continuous iOS readiness

Each meaningful milestone:

- shared TypeScript platform-safe;
- config/plugin path valid;
- no Android-only imports in shared business code.

Periodically produce iOS build/simulator smoke.

## 18. Rollback

Backend: retain previous deploy/kill switch.

Mobile: previous store build remains valid. OTA rollback only for JS-compatible issues; native regression requires a new binary.

## 19. Kill switches

Simple server config can:

- disable new calls;
- disable adapter type;
- disable provider;
- reduce max duration.

Do not build a large feature-flag platform.

## 20. Beta feedback

Ask selectively about:

- call quality;
- realtime feel;
- interruption;
- setup friction;
- device/audio route.

Avoid nagging after every call.

## 21. Release-candidate definition

An RC has no known P0/P1 call blocker, telemetry is live, Android matrix passes, security checklist passes, smoke runs are crash-free, and iOS compatibility has not regressed.
