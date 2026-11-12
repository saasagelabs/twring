# Twring design audit, 2026-11-12

Branch `design/audit-2026-11-12`, draft PR https://github.com/saasagelabs/twring/pull/16. Nothing merged or deployed. The app was not seen on a device (no phone connected during the audit), so app changes are limited to what can be judged from code, and every structural app idea is a proposal.

## 1. Taste baseline

**Intent**

- **Who:** people who already run an AI agent (Hermes, Claude Code, Codex, their own server) and are away from the keyboard.
- **What for:** pick up the phone and talk to that agent, and be rung by it when a job is done or needs a yes.
- **Character:** a phone, not a dashboard. A calm instrument that stays out of the way of a conversation with someone else's intelligence.

**At its best** Twring feels like the phone app of a well-made handset: black, still, typographic, with one lit thing on each screen (the action, or whoever is speaking). The agent is the personality, and Twring says little and says it plainly.

**Yardstick**

1. One lit thing per screen. Cyan belongs to the user and to the one action.
2. Words help the user act and never explain the machinery.
3. One way to lift an element off black: a hairline, a fill, or a glow, never all three.
4. Nothing decorative moves, and nothing covers content.
5. The site and the app are recognisably one product.
6. Readable by everyone: 4.5:1 text, 44 to 48 px targets, keyboard and large text work.

The site's main pages and the app's call screen were already close to this. The gaps were two site pages in an older glowing style, a hero that explained the install too early, grey app text too faint to read, and small drifts in type and naming.

## 2. What was improved (L1)

**Website, commit `0b93ccb`**

- **Sound switch:** it sat on top of the film and covered its captions at every width. It now sits under the film, says "Turn sound on" / "Turn sound off", and no longer announces a pressed state that contradicted its label.
- **Phone menu from the keyboard:** after opening, Tab skipped the menu links. Opening now moves to the first link, and the menu closes when focus leaves the header.
- **Large text:** at 200% text on a 375 px phone the header pushed pages sideways. The header now keeps the logo and menu, and long commands, links and addresses wrap.
- **Sticky header:** it no longer covers anchor targets or focused items.
- **Targets:** header links went from 22 to 42 px tall, footer links from 22 to 34 px. The logo link became 44 px in the L2b commit.
- **Invite form:** the error is tied to the email field, and the field is marked invalid and outlined red.
- **Copy:** two lines trimmed in "Ask on a call. It gets done."
- **Versions:** stylesheet bumped to `?v=4`, script to `?v=2`.

**App, commit `aef7c1e`**

- **Supporting text:** `textTertiary` was white at 42% on black (3.9:1). It carried Settings row descriptions, Recents lines, field labels and hints, and live call captions. It is now white at 54% (6:1), matching the site.
- **Placeholders and the Muted call status:** these used the decoration color (2.3:1) and now use `textTertiary`.
- **One title size:** Agents and Chats drew titles at 34, Settings and Recents at 30. A new `screenTitle` type role serves all tabs and the agent page.
- **Recents:** the tab said Recents and the screen said Call history. The screen is now titled Recents.
- **Agent page:** "Clear chat" and "Start a new conversation" were stacked with no gap, and now have one.
- **Onboarding:** progress was shown twice. The "STEP 1 OF 3" label is gone and the bars stay.
- **Dead code:** removed the unused `BackButton` component.

**Design docs, commit `018db05`** (each change names the page or screen that triggered it)

- `docs/DESIGN_SYSTEM.md`: radius and type tables now match the real tokens; a contrast table for the four text colors; touch target sizes for app and site; a rule against stacking glow, gradient and hairline on one element; a website section.
- `docs/UX_UI_SPEC.md`: a screen's title matches the tab that opened it; onboarding shows progress once; what belongs in the hero.

## 3. Restructures (L2)

**L2a. Hero: one message, one action, commit `694de01`.** The three-row install list left the hero: it explained what happens after the action, and it repeats in the FAQ and on the invite page. One quiet line under the buttons now says an email follows.

| Width | Before | After |
| --- | --- | --- |
| 1440 | `l2a-before-home-hero-1440.jpg` | `l2a-after-home-hero-1440.jpg` |
| 768 | `l2a-before-home-hero-768.jpg` | `l2a-after-home-hero-768.jpg` |
| 375 | `l2a-before-home-hero-375.jpg` | `l2a-after-home-hero-375.jpg` |

`l1-before-home-hero-*.jpg` show the hero before the sound-switch fix.

**L2b. AI app pages join the shared design, commit `7fafdb8`.** `/connector/` and `/oauth/consent/` were the last pages in the older look (page glow, glowing logo, haloed gradient buttons, their own tokens, Google Fonts). Both now use `assets/site.css` and the self-hosted fonts. The connector page gets the standard header, skip link and footer, with Copy as its one cyan action. The consent page gets a logo-only header; every id and its script are kept byte for byte, and its security policy is tightened to `style-src 'self'; font-src 'self'`.

| Page | Before | After |
| --- | --- | --- |
| Connector 1440 / 768 / 375 | `l2b-before-connector-*.jpg` | `l2b-after-connector-*.jpg` |
| Consent, sign in, 1440 / 375 | `l2b-before-consent-signin-*.jpg` | `l2b-after-consent-signin-*.jpg` |
| Consent, allow or deny, 1440 / 375 | `l2b-before-consent-ask-*.jpg` | `l2b-after-consent-ask-*.jpg` |

The consent states were forced locally with a sample app name and email, because the real ones need the sign-in service. No app restructure was made, since without a device there are no before and after screenshots.

## 4. Proposals (L3), nothing implemented

| # | Where | Proposal | Cost and risk |
| --- | --- | --- | --- |
| P1 | App `PrimaryButton`, `Toggle`, `Field` focus, header wordmark, onboarding bar glow; the site does not | Flat cyan fill for button and switch; keep glow only for live things (call orb, status pill, ringing Answer) | Four small components; changes the app's signature look, needs an OLED side by side |
| P2 | Agent page: boxed edit icon between avatar and name; ADVANCED always open; call history inside the settings card | Edit to header right, Advanced behind one row, call history in its own group | About half a day with device screenshots; moves where people find Delete agent |
| P3 | `connect.tsx`, `agents/labels.ts`: "speaks the Twring connection over a live socket", "API endpoint", "Agent address" over "Endpoint" | Plain labels (Address, Key), technical term as the example line | Copy only; string-asserting tests may need updating |
| P4 | Home FAQ, invite and support pages say the stores are "coming" and every action is "Get an invite" | Owner decides the wording and whether the main action becomes a store link | Copy on three pages, plus the hero if it changes |
| P5 | Home header has Rings and Self-hosting, other pages drop them; footers differ | Same links everywhere, only the cyan action varies | Small, about six files |
| P6 | App: 14 font sizes, 24 radius values, about 50 raw color literals | Mechanical token pass, screen by screen, with device screenshots | Touches most screens; small visual shifts likely |
| P7 | Consent page line "Requested: openid email" | Drop it or word it plainly | One line; part of a consent disclosure, owner decides |
| P8 | `AttachmentTray.tsx`: remove button hangs 7 px outside its tile; text glyph icons | Keep the button inside the tile; use the icon set | Small; needs a device look |

`MessageText.tsx` and the code-block rendering in `Bubble.tsx` were left to the separate fix in progress.

## 5. Correctness table

| Page or screen | Viewport | Issue | Severity | Status |
| --- | --- | --- | --- | --- |
| App: Settings, Recents, fields, call captions | phone | Supporting text 3.9:1 | High | Fixed |
| App: fields, call status | phone | Placeholder and Muted status 2.3:1 | Medium | Fixed |
| App: agent page | phone | Two stacked buttons with no gap | Medium | Fixed, needs a device look |
| Site: home | all | Sound switch covers the film | Medium | Fixed |
| Site: home, support, terms, self-hosting | 375 at 200% text | Sideways scroll from the header | Medium | Fixed |
| Site: every page with the menu | 375, 768 | Keyboard skips the opened menu; it stays open after focus leaves | Medium | Fixed |
| Site: connector, consent | all | Third-party fonts; different look; 21 to 22 px targets | Medium | Fixed (L2b) |
| Site: connector | all | No skip link or shared header | Low | Fixed (L2b) |
| Site: all | all | Sticky header can cover anchors and focused items | Low | Fixed |
| Site: home | all | Sound label contradicts its pressed state | Low | Fixed |
| Site: home | 375, 768 | Footer links 22 px tall | Low | Fixed |
| Site: all | 1440 | Header links 22 px tall | Low | Fixed |
| Site: all | 360 and under | Logo link 21 px tall | Low | Fixed |
| Site: invite | all | Error not tied to the field; no invalid state | Low | Fixed |
| Site: self-hosting, guide | 375 at 200% text | Inline commands and long links overflow | Low | Fixed |
| App: tabs | phone | Title 34 on two tabs, 30 on two | Low | Fixed |
| App: Recents | phone | Tab and screen title disagree | Low | Fixed |
| App: onboarding | phone | Progress shown twice | Low | Fixed |
| App: chat attachment tray | phone | Remove button partly outside its tile; glyph icons | Low | Proposed (P8) |
| App: agent page | phone | Edit button placement; always-open technical rows | Low | Proposed (P2) |
| App: connect | phone | Technical words on the web-address path | Low | Proposed (P3) |
| Site: consent | all | Raw permission names shown | Low | Owner decision (P7) |
| Site: home, invite, support | all | Store availability wording may be out of date | Unknown | Owner decision (P4) |

Checked and found sound: no sideways scroll on any site page at 1440, 768, 375 or 320; site text contrast 6:1 or better; a focus ring on every keyboard stop; the film reserves its space (no layout shift); reduced motion stops the film and ring animation; app controls are 48 px with labels and roles; sheets use the system modal. Site and app are dark only by design.

## 6. Verification

| Command or check | Result |
| --- | --- |
| `pnpm --filter mobile typecheck` | Pass |
| `pnpm lint` (eslint, then the em dash check) | Pass |
| `pnpm --filter @twring/mobile test` | 108 files, 999 tests pass |
| `prettier --check` on changed files | Pass |
| Site layout, 8 pages at 1440 / 768 / 375 | No sideways scroll, no undersized standalone targets |
| Site reflow, 8 pages at 320 and 188 px (375 at 200% text) | 16 of 16 pass |
| Keyboard walk (home, invite, support, connector) | Ring on every stop, none under the header |
| Consent page under its new policy | Stylesheet and fonts load |

Could not check: the app on a phone (look at Settings descriptions and Recents lines, Agents and Chats titles, the agent page's stacked buttons, onboarding without the STEP label); iOS (no platform code changed); the consent page's real sign-in round trip; `/privacy`, `/account-deletion` and `/downloads` (served by the gateway).
