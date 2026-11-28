# Release test list

Run this on one Android phone and one iPhone before every build that goes to users (wave 1 plan, track 2.1). Use a production-like server and a real agent on a real computer. Write the build numbers, the date and any failure in the log at the end. A failure that loses a call, a ring or a message blocks the build.

"Within 2 s" means from the moment you answer or speak to the moment the other side hears it.

## Calls

- [ ] Start a call from the app. Both sides hear each other within 2 s.
- [ ] Stay on a call for 15 minutes. No drop, no audio gap longer than a second.
- [ ] Switch from Wi-Fi to mobile data during a call. The call carries on (a short gap is fine).
- [ ] Put the app in the background during a call. Audio continues both ways.
- [ ] Turn the screen off during a call. Audio continues both ways.
- [ ] Use Bluetooth headphones during a call. Audio goes through them both ways.
- [ ] Talk over the agent while it speaks (barge-in). It stops within about half a second and answers the new words.
- [ ] Hang up from the phone. The call ends on the agent's side.
- [ ] Let the agent end the call. The phone shows the call ended.

## Rings

- [ ] Ring a locked phone. The phone rings; answering connects.
- [ ] Ring with the app closed. The phone rings; answering connects.
- [ ] Ring with the app open. The ring shows in the app; answering connects.
- [ ] Ring while already on a call. The ring does not cut the call; the agent hears that the owner was busy.
- [ ] Decline a ring. The agent hears it was declined.
- [ ] Let a ring go unanswered. A missed-call notification appears; Recents shows it.
- [ ] Ring, then cancel it from the agent. The phone stops ringing.
- [ ] Ring two phones on one account and answer on one. The other stops ringing.
- [ ] Turn the computer off, then answer a ring for it. The phone says why it couldn't connect (on iPhone, a notification); the agent hears "Couldn't connect: computer offline".

### iPhone answers (review finding 11)

These check that the system call screen and the app's audio start in the right order.

- [ ] **Cold start:** force-quit Twring, ring the iPhone, answer. Both sides hear audio within 2 s.
- [ ] **Lock screen:** lock the iPhone, ring it, answer from the lock screen. Both sides hear audio within 2 s, before and after unlocking.
- [ ] **Bluetooth:** with Bluetooth headphones connected, ring the iPhone and answer. Both sides hear audio within 2 s, through the headphones.

If any of these three fails, the fix is to hold `startAudioSession` until CallKit's `didActivate` (`CordRing.swift`, `call/livekit-transport.ts`).

## Chats

- [ ] Send a text. The agent replies in the chat.
- [ ] Send a voice note. The agent replies to what was said.
- [ ] Tap Listen on an agent message. It reads out.
- [ ] Send a file to the agent, and have the agent send one back. Both open.
- [ ] Have the agent send a message while the app is closed. A notification arrives; tapping it opens the chat.

## Accounts

- [ ] Sign in with Google.
- [ ] Sign in with Apple (iPhone).
- [ ] Sign out. The ring and chats stop for that account on this phone.
- [ ] Delete an account. The confirmation names the account; after it, signing in starts fresh.

## Computers

- [ ] Take the agent's computer offline. The app shows it offline, and a call says the computer is offline.
- [ ] Bring the computer back. The app shows it online again without pairing again, and calls work.

## Hermes plugin 0.2 (when the release includes the Hermes plugin)

Run these on staging first, then once on production. Link Hermes with `hermes twring link`, and run `hermes gateway` for the call checks.

- [ ] In a Hermes chat (Telegram), ask Hermes to message you. The message arrives in Twring's Hermes chat.
- [ ] In a Hermes chat, ask Hermes to ring you. The phone rings.
- [ ] In the terminal (`hermes`), ask Hermes to message you, then to ring you. Both arrive.
- [ ] Turn on Do Not Disturb (or quiet hours) in Twring and ask Hermes to ring you. The phone does not ring; the news is in Twring's Hermes chat, and Hermes does not retry.
- [ ] Make a scheduled job stop on a model error. You get a ring (or, with `TWRING_RING_ON_DELIVERY=false`, a message): "A scheduled Hermes job stopped: <error type>." The error text is not in it.
- [ ] Run `hermes twring link`. It asks "Approve Hermes's commands from your phone? [Y/n]", and pressing Enter turns phone approvals on.
- [ ] Run `hermes twring approvals off`, then `status`, then `on`, then `status`. Each `status` reports the setting just made.
- [ ] With phone approvals on, have Hermes raise an approval in the terminal. A card shows in the app and the phone rings.
- [ ] Do the same from Telegram. The card says it came from Telegram, and the phone rings.
- [ ] Tap Approve on a card. The command runs.
- [ ] Tap Deny on a card. The command does not run.
- [ ] Leave a card unanswered. When Hermes's approval timeout runs out (the plugin gives up 3 s before it), the command is denied and the card closes.
- [ ] With phone approvals off, raise an approval in Telegram and leave it for 60 s. The phone rings once: "Hermes is waiting for your OK in Telegram." The command is not in the ring.
- [ ] Raise four approvals at once. Three show on the phone; the fourth waits at Hermes's own prompt.
- [ ] Raise an approval for a command over 500 characters. It goes to Hermes's own prompt at the computer, not the phone.
- [ ] In the Twring app, set the Hermes chat to private, then raise an approval. It goes to Hermes's own prompt at the computer, not the phone.
- [ ] Block the Twring server from the computer and raise an approval. It goes to Hermes's own prompt at the computer.
- [ ] On a call, have Hermes raise an approval and say "yes". The command runs. Repeat and say "no". It does not run.
- [ ] On a call, have Hermes raise an approval and hang up before answering. The approval is denied; no card for it appears on the phone.

## Server (when the release includes a server deploy)

- [ ] Deploy with a call live. The deploy waits for the call to end before restarting.
- [ ] Start a call during the restart. The app refuses it plainly, and a call a minute later works.

## Log

| Date | Android build | iPhone build | Server release | Result and notes |
| ---- | ------------- | ------------ | -------------- | ---------------- |
| 2026-10-21 | 9 | 9, 10, 11 | 4b496b0, then 7f3d037 | Rings only (owner, iPhone 18 Pro and Android). **Failed on 9:** after answering on the iPhone call screen, Twring's own ring screen got stuck over the call (fixed in PR #118, build 10). **Failed on 10:** Hermes could not cancel a ring (computer tool: `ring --cancel`, stop signals cancel; published 2026-10-21); first words rushed and unclear (1 s pause before the opening line, server 7f3d037); Sentry showed the keychain unreadable when a ring woke Twring on a locked phone (build 11). **Passed on 11 and 7f3d037:** my rings force-quit and locked; Hermes rings force-quit, locked, locked with Twring force-quit, Bluetooth; Hermes cancels; first words clear. Android build 9: locked ring and the rest of the owner's ring checks passed. Not run yet: the 15-minute call, network switch, chats, files, accounts. |
| 2026-10-22 | 10 | 11 | 4ab036a | Short pass after the week's changes (owner). Passed: iPhone sign out and back in with Google (keychain change); a call from the app on each phone; a text, a photo to Hermes and a file back on each phone; a deploy with a call live waited about 75 s, restarted 4 s after the hang-up, and Hermes reconnected by itself. Covered by earlier passes and unchanged since: barge-in, network switch, Google and Apple sign-in, account deletion, computer offline and back. Not run: the 15-minute call. |
