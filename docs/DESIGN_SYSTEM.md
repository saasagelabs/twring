# Twring Design System

## 1. Goal

Create a premium, calm, modern call interface that can be implemented quickly and consistently.

This system defines behavior and semantic tokens more than final brand art. Brand colors/logo may evolve without changing product architecture.

## 2. Design personality

Twring should feel:

- precise;
- quiet;
- premium;
- technical without looking developer-only;
- alive during a call;
- trustworthy around actions.

Avoid:

- sci-fi HUD clutter;
- neon overload;
- chatbot bubbles as main call surface;
- fake equalizers;
- excessive blur/glass that reduces readability.

## 3. Tokens

Use a 4-point spacing base.

```text
xs  = 4
sm  = 8
md  = 12
lg  = 16
xl  = 24
2xl = 32
3xl = 48
```

Suggested radii:

```text
sm = 10
md = 16
lg = 24
pill = 999
```

Typography roles:

- display;
- title;
- headline;
- body;
- body-emphasis;
- caption;
- diagnostic/mono.

Do not hardcode type sizes in feature components.

## 4. Semantic colors

Define tokens:

- background;
- surface;
- surfaceRaised;
- textPrimary;
- textSecondary;
- border;
- accent;
- success;
- warning;
- danger;
- listening;
- speaking;
- reconnecting.

Brand palette remaps semantic tokens.

## 5. Theme scope

One polished launch theme is acceptable.

Do not delay launch for a theme editor.

System dark/light support is desirable only if design/QA capacity supports it well.

## 6. Motion

Motion communicates state.

Suggested bands:

- tap feedback: 80–140ms;
- small state change: 160–240ms;
- screen transition: platform-default / 220–320ms;
- ambient call presence: continuous but subtle.

Respect reduce-motion.

## 7. Call visualizer

Visualizer must be driven by real audio amplitude or semantic state.

Never animate “speech” while agent is silently working.

Implementation goals:

- few bars/points;
- bounded update frequency;
- native/UI-thread animation where practical;
- no excessive global state updates.

Audio stability beats visual fidelity.

## 8. Buttons

Primary: filled, high contrast, clear label.

Call End: distinct, large circular hit area.

Secondary: surface treatment; icons plus labels if icon meaning is ambiguous.

## 9. Cards

Agent card shows identity, readiness, and call action.

Do not add model badges, tool badges, token counts, or protocol metadata to normal cards.

## 10. Sheets

Use sheets for:

- transcript;
- audio route;
- approval;
- advanced diagnostics.

Critical approvals must remain prominent.

## 11. Loading

No full-screen spinner during active call.

Use semantic state: Connecting, Working, Reconnecting.

Skeletons are for list/history loading, not calls.

## 12. Errors

Error component includes:

- concise title;
- one-sentence explanation;
- next action;
- optional diagnostic reference.

Avoid giant destructive visuals for recoverable conditions.

## 13. Icons

Use one coherent icon family.

Do not mix emoji into primary controls.

## 14. Touch targets

Meet platform accessibility minimums; call controls should exceed them comfortably.

## 15. Safe areas

Honor status bar, cutouts, Android gesture area, and iPhone home indicator.

## 16. Keyboard/forms

Connection forms:

- keep active field visible;
- correct keyboard type;
- paste/password-manager friendly;
- secret field hidden by default;
- no secret echoed after save.

## 17. Accessibility contract

Every component has appropriate label, role, state, and focus behavior.

Waveform exposes a single semantic label such as “Agent speaking,” not decorative nodes.

## 18. Initial component inventory

```text
AppScreen
TopBar
AgentAvatar
AgentCard
PrimaryButton
SecondaryButton
IconButton
CallControl
StatusPill
VoiceOrb (call visualizer)
AgentActivityLabel
FormField
SecretField
ConnectionTestRow
InlineError
EmptyState
BottomSheet
ApprovalCard
DiagnosticReference
```

Do not build dozens of unused components in advance.

## 19. Performance rules

- profile before memoizing everything;
- avoid amplitude updates through app-wide state;
- virtualize lists;
- resize images;
- avoid huge shadows/blur during call;
- profile mid-tier Android hardware.

## 20. Design QA

For core screens verify:

- small phone;
- large phone;
- large text;
- offline/error;
- keyboard open;
- screen reader;
- reduced motion;
- slow device;
- rapid call-state changes.

## 21. Acceptance principle

If a beautiful animation introduces audio glitches, remove it.

Twring's most premium visual is a conversation that feels instant.
