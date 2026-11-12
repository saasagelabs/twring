# Privacy notice

**Operator:** {{OPERATOR}}\
**Contact:** {{CONTACT_EMAIL}}\
**Effective:** 1 August 2026

Twring is a voice layer for an AI agent you already use. You connect your agent, then call it or type to it in a chat. Twring handles the audio and the chat; your agent does the thinking.

## 1. What Twring processes during a call

| Data                        | Where it goes                                           | Kept?                                               |
| --------------------------- | ------------------------------------------------------- | --------------------------------------------------- |
| Your voice (call audio)     | Streamed through LiveKit to Deepgram for speech-to-text | **Never stored** by Twring                          |
| Text of what you say        | Sent to **your own agent** (the endpoint you connected) | Not kept by Twring; your agent's own policy applies |
| Your agent's replies (text) | Streamed to the speech provider to become audio         | Not kept by Twring                                  |
| Reply audio                 | Streamed back to your phone                             | Not kept                                            |

Speech providers: **Deepgram** (speech-to-text and text-to-speech). Some deployments may use **Cartesia** for text-to-speech instead; if so, it receives only the reply text. If you add your own voice account key, **xAI** can also do your listening and voice, but only for you and only with your own key: it receives your call audio (for listening), your agent's reply text (for voice), the audio of voice notes you send, and the reply text when you tap Listen. **LiveKit** carries the real-time audio between your phone and the Twring server.

## 2. What Twring stores

- **Your account:** you sign in with Google. Twring's sign-in service, **Supabase** (Supabase Auth), keeps your email address, your Google account id, and the name and profile picture link Google shares, plus sign-in times. Twring never sees your Google password. Your agents and call summaries are tied to this account so only you can reach them.
- **Agent settings:** name, endpoint address, protocol, chosen voice, and the words to listen for.
- **Agent credential (API key):** encrypted with AES-256-GCM on the Twring server. It is never shown again, never logged, and decrypted only in the server process when a call or connection test connects to your agent.
- **Your own voice account keys (optional):** if you add a Deepgram, Cartesia or xAI key, it is encrypted with AES-256-GCM on the Twring server, never shown again (only its last four characters), never logged, and used only for your own calls, voice notes, replies read aloud and previews of voices Twring doesn't offer itself. Delete it any time in Settings; Delete my data removes it.
- **Chats with your agents:** the messages you type to an agent and its written replies, plus short entries for calls and rings (when, how long, the outcome, an agent's ring reason, and your decline note). They are encrypted on the Twring server (AES-256-GCM), never written to logs, and only your account can read them. A call appears in the chat as a card only: Twring keeps no audio and no transcript of what was said on a call. At most 2,000 messages per agent are kept; older ones are removed. When a new message arrives, the notification shows its first line; it passes through Google's push service (Firebase Cloud Messaging), and the lock screen shows only that a message arrived.
- **Call summaries:** agent, start time, duration, outcome, end reason, and usage counts (seconds of speech, characters spoken, interruptions, reconnects, an optional cost estimate). No audio, no transcript. Only your most recent 200 calls are kept.
- **Call ratings:** if you rate a call, the stars, the issues you picked and your optional note, kept with that call to improve Twring. A note, or a rating of 3 stars or fewer, is also emailed to our support inbox so a person reads it (without your account details). Deleted with your data.
- **Notes you send from Settings (Send feedback):** your note, your account's email address (so we can reply) and the app version. Emailed to our support inbox so a person reads it. Deleted with your data.
- **Files in chats:** photos, PDFs and text files you send to an agent, or an agent sends you (up to 10 MB each). They are stored encrypted on the Twring server (AES-256-GCM) and reach the agent through short-lived links. Photos are re-encoded on your phone first, which removes location data. They are deleted when you clear the chat, delete the agent, or delete your data.
- **Ringing (when an agent rings you):** each phone's push token (from Firebase Cloud Messaging), platform, and app variant, so Twring can make it ring; your Do Not Disturb and quiet-hours settings; and each ring's reason, agent, time, and outcome (answered, declined with your short note, missed, or cancelled). A missed ring also appears in your call summaries. Lock screens show only that an agent is calling; the reason appears once the phone is unlocked or the call is answered.
- **Linked computers (agents on your computer):** each linked computer's name (as it reports it, e.g. its hostname), the agents it found (such as Claude Code or Codex), whether it is online, and a hashed connection token. Remove a computer in the app to delete these.
- **Daily usage counters:** how many calls you started and how many seconds you called today (UTC), to apply the daily calling allowance. Kept for two days at most.
- **Invite requests:** if you ask for an invite on twring.com or in the app, your email address and the time you asked, so we can invite you. It is not linked to an account.
- **Operational logs:** request and call events with ids and error codes, with credentials, tokens, and URL query strings redacted. Crash reports (Sentry) carry the same redacted information: no transcripts, no tokens, no email addresses, and your user id only in hashed form.

The camera is used to scan the code your computer shows when you link it, and to take a photo you choose to send in a chat. A scanned code is read on your phone: the picture is never stored or sent, only the code it contains. A photo you send is handled like any file in a chat (above).

Twring does not sell data, show ads, or use your calls to train models.

When you send a voice note in a chat, its audio goes to Deepgram for transcription. Twring does not keep the audio. The transcript is kept as a chat message until you clear it.

## 3. Connected AI apps (the Twring connector)

When you add the Twring connector to an AI app (such as Claude or ChatGPT) and approve it, that app can ring your phone with a short reason, send messages and files to its own Twring chat, and read the replies you write in that chat. It cannot reach your other chats, agents, calls, or account details.

Twring stores a contact for each connected app, with its name and last-used time. Messages and files in that app's chat are kept and deleted like other chats. If you remove an app, Twring keeps a record that it is blocked so it cannot contact you again until you allow it.

Sign-in is handled by Twring's sign-in provider, Supabase. Twring never sees your password. The app receives a token limited to the connector.

To remove an app, go to Settings, Connected AI apps, Remove. This deletes its chat and blocks the app. Delete my data removes everything, including connected apps and blocked records.

## 4. Retention

| Data                             | Retention                                                                                |
| -------------------------------- | ---------------------------------------------------------------------------------------- |
| Call audio, call transcripts     | Not retained                                                                             |
| Chat messages                    | Until you clear the chat, delete the agent, or delete your data; at most 2,000 per agent |
| Files in chats                   | Until you clear the chat, delete the agent, or delete your data                          |
| Call ratings                     | Until you delete your data                                                               |
| Notes from Settings              | Until you delete your data                                                               |
| Account (email, Google profile)  | Until you ask us to delete your account                                                  |
| Agent settings and encrypted key | Until you delete the agent or your data                                                  |
| Your own voice account keys      | Until you remove them, or delete your data or account                                    |
| Call summaries                   | Last 200 calls per user, or until you delete your data                                   |
| Daily usage counters             | Two days                                                                                 |
| Invite request email             | Until you are invited or ask us to remove it ({{CONTACT_EMAIL}})                         |
| Push tokens, ring settings       | Until you remove the phone (sign out) or delete your data                                |
| Ring history                     | One day for the ring itself; a missed ring stays with your call summaries                |
| Server logs and crash reports    | 30 days                                                                                  |

## 5. Deletion

- **Clear chat** (agent info → Clear chat): removes your messages with that agent from Twring. The agent keeps its own memory, which Twring does not control.
- **Delete an agent** (agent screen → Delete agent): removes its settings, key and chat at once, and ends any call using it.
- **Delete my data** (Settings → Delete my data): removes all your agents, keys, chats, call summaries, push tokens, ring settings, and rings, and ends any call in progress. The app shows what was deleted.
- **Delete account** (Settings → Delete account): removes all of the above and your sign-in account (email and Google profile at Supabase), then signs you out. Signing out alone (Settings → Sign out) removes the session from your phone but keeps the account.
- **Without the app:** the account deletion page (`/account-deletion` on the Twring server) explains how to ask by email; write to {{CONTACT_EMAIL}} from the address you sign in with. We delete within 30 days and reply to confirm.

## 6. Security

TLS for every connection; agent endpoints must be public `https://` or `wss://` addresses; server-side SSRF protection; encrypted credentials; short-lived call tokens; rate limits.

## 7. Children

Twring is not directed at children under 13 (or the minimum age in your country).

## 8. Changes

We will update this notice and its effective date when data handling changes.

## 9. Self-hosted servers

Anyone can run Twring on their own server. On a self-hosted server, the person who runs it is responsible for the data on it; this section covers only what Twring itself receives from such a server.

- **At install:** the email address given at install (to confirm the server and to send notices about it), whether that person agreed to receive news, and the server's address (so Twring can check it can be reached). The server's key for Twring's ring service is kept only as a hash.
- **To ring a phone:** the phone's push token, so Apple or Google can deliver the ring, and daily counts of rings and notifications sent, for fair limits.
- **Notification contents:** sealed on the server for the receiving phone. Twring passes them on and cannot read them.
- **Call audio:** only for servers that use Twring's audio service (common in cloud sandboxes). The audio passes through it, encrypted in transit, and is never stored. Twring keeps daily call minutes and a record of each call (its time and length) for 90 days.
- **Access logs:** the ring service's web server keeps access logs with the IP addresses of servers and phones that contact it, for 30 days, to keep it secure and working.

**How long, and how to delete it:** Twring keeps these while the server is registered; per-call records are deleted after 90 days. Running `twring uninstall` on the server deletes the server's registration, its phones, counts and call records from Twring. You can also write to {{CONTACT_EMAIL}} with the server's address or the email given at install and we delete them within 30 days.

Everything else stays on the self-hosted server: accounts, people and their phones, agents and their keys, chats, files, call summaries and speech account keys. Twring never sees them.

## Google Play Data safety answers

Under Play's definitions, data sent to a service provider that processes it for Twring (Supabase, LiveKit, Deepgram, Cartesia, Firebase Cloud Messaging, Sentry), or sent where the user directs (their own agent, or an AI app they connected), is not "shared". So every row is "Shared: No".

| Data type (Play category) | Collected | Shared | Purpose | Optional | Notes |
| --- | --- | --- | --- | --- | --- |
| Audio → Voice or sound recordings | Yes (processed in transit, not stored) | No | App functionality | Required to make a call; voice notes optional | Call audio and voice notes go to Deepgram (or xAI with the user's own key) for speech-to-text; never stored |
| Personal info → Email address | Yes | No | App functionality, account management | No (sign-in is required) | From Google or Apple sign-in; also on notes sent from Settings |
| Personal info → Name | Yes | No | Account management | No | Profile name from sign-in |
| Personal info → User IDs | Yes | No | App functionality, account management | No | Sign-in account id and Twring user id |
| Personal info → Other info | Yes | No | App functionality | Yes | User-entered agent name and address, linked computer name |
| Device or other IDs | Yes | No | App functionality | No (registered when the user signs in) | Push token per phone, so an agent can ring it; sent at sign-in even if notifications are off |
| Messages → Other in-app messages | Yes (stored, encrypted at rest) | No | App functionality | Yes (chats are optional) | Chats with the user's agents and connected AI apps; deletable (Clear chat, Delete agent, Delete my data) |
| App activity → Other user-generated content | Yes (in transit) | No | App functionality | Required for calls | Text of what the user says, sent to their own agent; not stored by Twring |
| App activity → App interactions | Yes | No | App functionality, analytics (usage counts) | No | Call summaries (last 200 calls), ring history |
| App activity → Other actions | Yes | No | Analytics (improving call quality) | Yes | Call ratings and notes sent from Settings |
| Photos and videos → Photos | Yes (only photos the user sends) | No | App functionality | Yes | Encrypted at rest; location data removed |
| Files and docs → Files and docs | Yes (only files the user sends) | No | App functionality | Yes | Encrypted at rest |
| App info and performance → Crash logs, Diagnostics | Yes | No | App functionality | No | Redacted (no transcripts, tokens or email addresses) |
| Location, contacts, financial, health, calendar, web browsing | No | No | Not applicable | Not applicable | Not collected |

Agent API keys and the user's own speech account keys are stored encrypted, but Play has no category for credentials the user enters for their own services; they are covered by "Personal info → Other info" if the form asks.

- Data encrypted in transit: **Yes**.
- Users can request that data be deleted: **Yes** (in app: Settings → Delete my data or Delete account; on the web: `/account-deletion`; or {{CONTACT_EMAIL}}).
- Independent security review: **No**.
- Account: **Yes**, Google sign-in through Supabase Auth (ADR-021). Account deletion: in the app (Settings → Delete account) and on the web (`/account-deletion`).
