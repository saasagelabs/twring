# Twring Mobile Platform Specification

## 1. Strategy

Launch Android first while keeping iOS compatibility from the first commit.

Use React Native + Expo development builds + TypeScript + Expo Router + LiveKit native integration.

Do not use Expo Go for the actual Twring runtime.

## 2. Continuous Native Generation

Prefer Expo config plugins/CNG where supported.

Rules:

- do not directly edit generated native files for persistent config when a config plugin is appropriate;
- isolate/document true native code;
- periodically verify `prebuild --clean` reproducibility.

## 3. Platform interfaces

Hide platform divergence behind interfaces such as:

```text
AudioRouteService
CallPresentationService
PushService
PermissionsService
BackgroundSessionService
HapticsService
```

Shared feature code consumes interfaces, not platform imports.

## 4. Android V1 device behavior

Test:

- microphone permission;
- Bluetooth;
- wired headset where available;
- speaker/earpiece;
- phone-call interruption;
- notification interruption;
- background/foreground;
- lock-screen behavior;
- Wi-Fi/mobile transitions;
- battery optimization effects;
- low-memory/process recreation;
- permission revoked after install.

Re-check current Play target/API/policy requirements at release time.

## 5. iOS from day one

Before iOS launch work officially begins:

- bundle identifier config exists;
- microphone permission string exists;
- LiveKit path compiles;
- shared code avoids Android-only APIs;
- EAS/local iOS build path remains viable;
- simulator smoke tests cover non-audio UI;
- real-device audio testing begins before submission work.

## 6. Audio session

Use a two-way voice-compatible audio session.

Goals:

- mic + output simultaneously;
- echo cancellation;
- Bluetooth;
- route changes;
- OS interruption behavior.

Prefer LiveKit/platform-recommended configuration over custom low-level audio code.

## 7. Background behavior

For V1 outgoing calls:

- active audio may continue according to platform support/config;
- do not promise background behavior until tested on production builds;
- returning to app restores truthful call state.

Incoming-call background infrastructure is later work.

### As built (Milestone 8, ADR-019)

- **Background:** Android runs a `microphone` foreground service (`modules/cord-call-service`) from call connected to call end, with an ongoing "Twring call in progress · agent" notification. Tapping it reopens the live call screen; its End action hangs up. `POST_NOTIFICATIONS` is asked once, just before connecting. iOS uses `UIBackgroundModes: ['audio']` only. The screen is no longer kept awake. Seam: `CallBackgroundService` (`src/call/transport.ts`, implemented in `src/platform/call-service*.ts`).
- **Lifecycle:** the controller lives outside React, and nothing ends or mutes a call on background. Returning to the app shows the same call screen with its current state.
- **Audio routes:** `AudioRoutes` (`src/call/audio-routes.ts`) on Android lists outputs through LiveKit `AudioSession.getAudioOutputs()` every 2 s while connected, and again on returning to the foreground. Speaker is the default when no headset is connected. A newly connected Bluetooth or wired headset takes over, even from a manual choice. If the current output disappears, the best remaining one is used. The caller picks from the call screen's Audio control. On iOS, the Audio control opens the system route picker (`showAudioRoutePicker`). Route changes only move audio output; they never reconnect the call.
- **Mute:** `CallController.setMuted()` mutes the published mic track in place (`setMicrophoneEnabled(false)`, no unpublish), so the gateway receives silence and cannot hear barge-in. The Mute control is a screen-reader switch. The meter reads "You are muted" while muted. Mute stays through reconnects and resets for each new call.
- **Haptics:** `expo-haptics` fires on connected, reconnected, ended, and failed (`src/call/feedback.ts`), never on speech.

## 8. Permissions

Ask contextually.

Microphone flow:

1. explain why;
2. user initiates action;
3. system prompt;
4. denied state explains Settings path.

No endless reprompt loops.

## 9. Secure local storage

Use secure storage for Twring auth/session material as appropriate.

Do not store raw connected-agent API secrets in AsyncStorage.

Prefer encrypted server-side credentials.

## 10. Navigation

Primary surfaces:

- agents/home;
- history;
- settings.

Agent detail/call are stack/modal flows.

Active call resists accidental back navigation.

Android back during a call must not silently destroy the session.

## 11. App lifecycle

Track foreground/inactive/background/terminated events.

Call controller receives lifecycle events.

Do not let a UI unmount accidentally destroy call state without explicit policy.

## 12. Push notifications

Not required for outgoing launch.

Future incoming calls:

- push contains opaque call ID and safe metadata;
- no secret credentials;
- app fetches details securely;
- microphone only after answer.

## 13. Deep links

Future-safe examples:

```text
cord://agents/{id}
cord://calls/{id}
```

Never put secrets in deep-link query strings.

## 14. Build profiles

Use EAS profiles:

- development;
- preview/internal;
- production.

Separate development/staging/production backend configuration.

## 15. Mobile environment variables

Examples:

```text
CORD_ENV
API_BASE_URL
SENTRY_DSN
LIVEKIT_PUBLIC_URL
```

Only public/non-secret config goes to mobile.

## 16. OTA updates

Expo Updates may ship JS/assets.

Never ship JS requiring native module changes to an incompatible binary.

Voice-critical OTA changes still require appropriate testing.

## 17. Performance baseline

Profile on at least one modest Android device.

Measure:

- cold start;
- navigation;
- active-call JS thread;
- visualizer;
- memory over 20+ minute call;
- reconnect.

Emulator-only confidence is insufficient.

## 18. Crash handling

Sentry includes release, environment, safe call correlation ID, and non-sensitive breadcrumbs.

No raw transcript/secret content by default.

## 19. Platform-specific exception template

```text
Feature:
Platform:
Reason:
Shared interface:
Implementation location:
Counterpart plan:
Test plan:
```

Material exceptions go into `DECISIONS.md`.

## 20. Mobile definition of done

Runtime-touching changes are done only when:

- Android runtime path tested;
- iOS compatibility considered;
- permission/error path tested;
- no secret added to bundle;
- expected lifecycle/navigation behavior verified.
