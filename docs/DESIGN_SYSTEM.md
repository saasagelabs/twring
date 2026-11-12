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
- excessive blur/glass that reduces readability;
- a glow, a gradient fill and a hairline stacked on the same element. Pick one way to lift an element off black. (Audit 2026-11-12: `/connector/` and `/oauth/consent/` carried a glowing logo, haloed gradient buttons and glowing bullets while the home page beside them was flat; they now share the site's stylesheet.)

The website and the app are one product. A screen in either should be recognisable as the other's: black stage, white type, cyan for the user and for the one action on the screen.

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

Radii (the values in `apps/mobile/src/theme/tokens.ts`; this section used to suggest 10/16/24, which the app never used):

```text
xs = 10
sm = 12
md = 14   rows, cards, fields
lg = 18   agent cards, chat bubbles
xl = 22
xxl = 28  sheets, primary buttons
pill = 999
```

Typography roles (family, size):

- display (Manrope ExtraLight 34): one-off hero lines such as sign-in and the call outcome;
- screenTitle (Manrope ExtraLight 30): the title at the top of every screen. Added in the 2026-11-12 audit: Agents and Chats drew their titles at 34 while Settings and Recents drew theirs at 30, so the title jumped when switching tabs;
- title (Manrope Light 24);
- headline (Manrope Regular 19);
- body (Inter 15/22);
- body-emphasis (Inter SemiBold 15/22);
- caption (Inter 13);
- microLabel (Inter SemiBold 11, tracked): group headings;
- diagnostic/mono (JetBrains Mono 13).

Do not hardcode type sizes, radii or colors in feature components. The 2026-11-12 audit counted 14 distinct font sizes, 24 distinct radius values and about 50 raw color literals in screens and components. New and touched code uses the tokens; when a value is missing, add a token here first.

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

Text colors and their contrast on the black background (WCAG AA needs 4.5:1 for text):

```text
textPrimary    #FFFFFF          21:1
textSecondary  white at 62%     7.8:1   supporting copy
textTertiary   white at 54%     6.0:1   the quietest text people must read
textMuted      white at 28%     2.3:1   disabled controls and decoration only
```

`textTertiary` was white at 42% (3.9:1) until the 2026-11-12 audit. It carried the explanation under every Settings row, the time and outcome lines in Recents, field labels and hints, and the live captions on the call screen, all at 11 to 13 px. `textMuted` is never used for text that must be read: the audit moved field placeholders and the Muted call status off it.

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

Text glyphs standing in for icons count too. Known leftovers (audit 2026-11-12, not yet replaced): the file glyph and the multiplication-sign remove button in the chat attachment tray.

## 14. Touch targets

Meet platform accessibility minimums; call controls should exceed them comfortably.

App: 48 by 48 for anything tappable, counting hit slop. Site: 44 px tall for buttons and standalone links; links inside a sentence are exempt.

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

## 21. The website

`apps/site` follows the same system through `assets/site.css`:

- every page uses that one stylesheet and the self-hosted fonts; no page keeps its own copy of the tokens;
- one solid cyan action per page; everything else is a quiet outline or a text link;
- lengths and breakpoints are in rem, so the browser's text size setting reflows the page. Check each change at 1440, 768, 375 and 320 px, and at 188 px (a 375 px phone with text at 200%): no sideways scroll;
- nothing sits on top of the film;
- keyboard order follows what is on screen: opening the phone menu moves to its first link.

## 22. Acceptance principle

If a beautiful animation introduces audio glitches, remove it.

Twring's most premium visual is a conversation that feels instant.
