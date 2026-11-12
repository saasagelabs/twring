# Twring UX/UI Specification

## 1. Experience objective

Twring should feel more like a premium calling application than an AI dashboard.

The interface should communicate presence, immediacy, calm, trust, and understandable agent activity.

Users should not need to understand STT, TTS, WebRTC, LiveKit, SSE, MCP, AG-UI, or A2A.

## 2. UX principles

### One obvious action
Each primary screen has one dominant next action.

### Call first
Agent detail is organized around **Call**.

### Progressive technical complexity
Advanced protocol/config details appear only when needed.

### Never lie
Waveforms/statuses reflect real state.

### Recovery is part of UX
Network failure should not dump raw technical errors.

### Preserve identity
The user should feel they are talking to the same agent they connected, not a separate Twring assistant.

## 3. Information architecture

```text
Auth
└── Tabs
    ├── Agents (home)
    │   ├── Agent Detail
    │   │   ├── Call
    │   │   ├── Connection
    │   │   ├── Voice
    │   │   └── Advanced
    │   └── Connect Agent
    ├── Chats
    ├── Recents (call history)
    └── Settings
```

A screen's title is the name on the tab or row that opened it. (Audit 2026-11-12: the Recents tab opened a screen titled Call history; the screen is now titled Recents.)

## 4. First-run onboarding

Keep to three concise screens maximum before setup.

Show progress once. (Audit 2026-11-12: each page carried a STEP 1 OF 3 label above the headline and the progress bars above the button; the label is gone.)

### Screen 1

Headline:

> Call the agent you already use.

Support:

> Twring adds realtime voice without replacing your agent's brain, tools, or memory.

CTA: `Connect my agent`

### Screen 2: authority/privacy

Explain simply:

- Twring turns your speech into text;
- your connected agent receives the text;
- its actions remain controlled by its own system;
- Twring speaks its response.

CTA: `Continue`

### Screen 3: microphone

Explain why mic permission is required before triggering OS prompt.

## 5. Home / agent list

Agent card:

```text
[Avatar] Operator
         Online

         Call
```

Computer agents show Online or Offline. Server agents show Server agent. Connection details
stay in advanced detail.

Primary empty-state CTA: `Connect Agent`.

## 6. Connect Agent wizard

Suggested steps:

1. identity/name;
2. connection method;
3. endpoint/config;
4. credentials;
5. connection test;
6. voice;
7. ready.

Connection method ordering:

- Twring Native;
- API Endpoint;
- AG-UI in advanced/compatible section.

Use examples inline. Do not write a protocol textbook into the form.

## 7. Connection test

Possible truthful progression:

```text
Checking endpoint…
Authenticating…
Testing response…
Testing streaming…
Connected
```

Only show checks actually performed.

Success:

> Your agent is ready to call.

Failure:

> Twring reached the endpoint, but authentication was rejected. Check the API key and try again.

Never echo the saved secret.

## 8. Agent detail

```text
        [Avatar]

        Operator
   Connected agent

      [ Call ]

Last call · 8 min ago

Voice
Connection
Call history
Advanced
```

Do not turn this into a dense dashboard.

## 9. Outgoing call

After tapping Call:

```text
Operator

Calling…
```

Use subtle connection animation. Allow End/Cancel.

A fake telephone ring sound is optional and should only be added after testing; it must never mask connection problems.

## 10. Active call

Keep the surface calm:

```text
             Operator

             ● Connected

          [live visualizer]

            Listening
               or
        Checking calendar…
               or
             Speaking

              03:14

        Mute    Audio
              End
```

Transcript opens as a sheet rather than dominating by default.

## 11. Voice visualization

States must visually differ:

- listening → calm presence;
- user speaking → microphone-driven waveform/amplitude;
- agent working → quiet progress state, not a fake waveform;
- agent speaking → output-audio-driven waveform;
- reconnecting → explicit reconnect state.

## 12. Agent activity

Map normalized activity to safe concise language.

Examples:

- Searching…
- Checking calendar…
- Reviewing deployment…
- Waiting for approval…

If no specific event exists:

> Working…

Raw tool names belong in diagnostics, not primary call UI.

## 13. Approval

If supported:

```text
Operator needs approval

Send the prepared message to John?

[ Don't send ]  [ Send ]
```

V1 should favor explicit tap approval over loosely interpreted voice approval for consequential actions.

## 14. Interruption UX

When user starts speaking during agent speech:

- audio stops immediately;
- UI switches to user/listening state;
- no unnecessary “Cancelling…” state unless an actual cancellable operation matters to the user.

It should feel normal, not like issuing a system command.

## 15. Reconnecting

Short outage:

```text
Reconnecting…
Your call is still active.
```

Do not keep normal speaking/listening animation while transport is unavailable.

Recovered: subtle haptic, continue.

Failed:

```text
Call lost

We couldn't restore the connection.

[ Call again ]
```

## 16. Call-ended screen

```text
Call ended
8m 42s

Operator

[ Call again ]

Transcript      (if enabled)
Activity
```

Do not auto-generate a separate Twring AI summary in V1 unless product scope explicitly adds it.

## 17. Call history

Show:

- agent;
- date/time;
- duration;
- ended/failed;
- transcript availability.

Avoid sensitive transcript preview on list view by default.

## 18. Settings

V1:

- account;
- transcript retention;
- analytics/privacy;
- diagnostics;
- sign out.

Optional audio preferences only if stable/reliable.

Future:

- incoming call permissions;
- quiet hours;
- ring rules.

## 19. Error writing

Bad:

> WebSocket 1006

Good:

> The agent connection dropped. Twring will try to reconnect.

Advanced details may show:

> AGENT_STREAM_LOST · ref 8DK2

## 20. Empty states

No agents:

> Your agents will appear here. Connect one and Twring will make it callable.

No history:

> Your completed calls will appear here.

## 21. Accessibility

Required:

- screen-reader labels;
- dynamic text;
- contrast;
- non-color cues;
- minimum touch targets;
- reduced motion;
- haptics not required for understanding;
- semantic replacement for waveform.

## 22. Haptics

Use sparingly for:

- connected;
- ended;
- reconnect success;
- approval confirmation;
- important error.

Do not vibrate continuously for speech.

## 23. Sound design

Potential UI sounds:

- connection;
- end;
- failure.

They must not interfere with STT/audio session routing.

## 24. “Buttery smooth” means measurable behavior

- target 60fps for normal UI;
- no JS-heavy visualizer that harms audio;
- no layout jumps on status changes;
- immediate button feedback;
- no blocking network calls on navigation;
- virtualized history;
- stable animations tied to semantic state.

## 25. Website

The home page hero is four things: the headline, one paragraph, one action (Get an invite) with a quiet second link, and the film. What happens after the action (install steps) lives in the FAQ and on the invite page, with one line under the buttons to say an email follows. (Audit 2026-11-12: the hero also carried a three-row install list.)

Pages reached from inside another product's flow (`/connector/`, `/oauth/consent/`) look like the rest of the site. The consent page has a logo-only header: nothing invites leaving in the middle of signing in.

## 26. Product voice

Twring itself speaks very little. The connected agent is the conversational personality.

Twring copy is neutral and operational.
