# Twring for Hermes

![Twring for Hermes: when it matters, Hermes calls you](assets/banner.png)

**Call your Hermes. Hermes calls you.**

Twring is a phone app (iPhone and Android) for the AI agents you already run. This plugin makes Twring a Hermes messaging platform, like Telegram, except you can also **talk**:

- **Live two-way calls.** Press Call in the Twring app and talk to your own Hermes. Twring turns your speech into text, Hermes streams its answer, and Twring speaks it as it arrives. Talk over Hermes at any time: its voice stops at once and its work carries on. When you go on to ask something new, Twring replaces the old turn, Hermes stops that run (as if you typed `/stop`) and answers what you just said. Hang up instead, and Hermes keeps working.
- **Calls and chat in one conversation.** Typed messages in the Twring app and spoken turns on a call reach the same Hermes conversation.
- **Approvals by voice or tap.** When Hermes needs your OK for a risky command, the request appears on your phone. Say "yes" or "no", or tap. The answer goes back through Hermes's own approval system: the plugin never approves anything for you, and silence means no.
- **It rings you back.** When a scheduled Hermes job delivers to `twring`, its result lands in your Twring chat and your phone rings with the first sentence. Hang up while Hermes is still working, and the rest of its answer reaches your chat, with a ring if your Twring settings allow.

Hermes keeps its own model, memory, tools and permissions. Twring adds the call.

## Set up (3 steps)

1. Get the Twring app: leave your email at [twring.com/beta](https://twring.com/beta/) and we email the link for your iPhone or Android phone, usually within minutes. It's free while we launch. Install it and sign in with that email.
2. Link this Hermes to it:

   ```sh
   hermes plugins install twring
   hermes twring link
   ```

   In the app, tap **Add agent**, **On my computer or server**, and scan the code (or type it).

3. Start the gateway so your phone can reach Hermes:

   ```sh
   hermes gateway
   ```

That's it: **Hermes** now appears in the Twring app. Press Call.

`hermes gateway setup` offers the same link step. `hermes twring status` shows whether you're linked, and `hermes twring unlink` forgets the link on this computer (then delete Hermes in the app too).

### Hermes can message you or ring you from anywhere

From any chat (Telegram, Discord, the terminal) or a scheduled job, Hermes can send a message to your Twring chat with it (`twring_message_owner`) or ring your phone (`twring_ring_owner`) when it is blocked on you, finished something long, or hit a failure. If the ring is refused (quiet hours, Do Not Disturb, the hourly limit), the news is still in your Twring chat. When Hermes asks for your OK at the computer and nobody answers for 60 seconds, your phone rings once: "Hermes is waiting for your OK in Telegram." A scheduled job that stops on an error tells you too.

### Ring me when a scheduled job finishes

Deliver any Hermes cron job to `twring`. Its result is saved in your Twring chat and your phone rings with its first sentence (at most 140 characters). Set `TWRING_RING_ON_DELIVERY=false` for a notification instead of a ring.

### Use one link, not two

If you already use Twring's `twring-connect` program for Hermes on this computer, stop it before linking the plugin. Otherwise the app shows two "Hermes" agents, and the two programs take the same link from each other.

### Your own Twring server

Self-host Twring? Link to it with `hermes twring link --server https://your-twring-server`.

## Settings

| Variable | What it does |
| --- | --- |
| `TWRING_TOKEN` | This computer's link token. Saved by `hermes twring link`; never printed |
| `TWRING_SERVER` | Twring server, default `https://api.twring.com` |
| `TWRING_ALLOWED_USERS` | `owner` (the linked Twring account), set by `link` |
| `TWRING_HOME_CHANNEL` | Where scheduled-job results go: `owner`, set by `link` |
| `TWRING_RING_ON_DELIVERY` | Ring for scheduled-job results and stopped scheduled jobs (`true` by default) |

## Approve Hermes's commands from your phone

`hermes twring link` asks "Approve Hermes's commands from your phone? [Y/n]" (Enter means yes). Yes sets Hermes's `security.approval.transport` to `twring` and `transport_fallback` to `builtin`, so every approval Hermes asks for, from the terminal, Telegram, a scheduled job or a call, shows up on your phone to approve or deny. Change it any time:

```sh
hermes twring approvals on      # approvals go to your phone
hermes twring approvals off     # approvals stay with Hermes's own prompt
hermes twring approvals status  # show which one is set
```

A command over 500 characters, an unlinked computer, a private chat, or a Twring server that refuses or cannot be reached goes back to Hermes's own prompt at the computer.

## What this plugin does on your computer (disclosure)

- **Network:** one outbound WebSocket to your Twring server (`wss://api.twring.com/v1/connectors/socket` by default) while `hermes gateway` runs, plus HTTPS calls to the same server to link, to post messages and scheduled-job results to your chat, and to ring your phone. Those HTTPS calls also happen outside the gateway when Hermes uses its Twring tools, when an approval at the computer waits 60 seconds, and when a scheduled job stops on an error. With phone approvals on, every approval from any Hermes process (terminal, Telegram, cron, gateway) makes up to three HTTPS calls to `/v1/connectors/approvals`: a POST to ask, a GET long-poll for your answer and a DELETE when it is settled. Nothing else is contacted. Redirects are refused, and the token only travels in an `Authorization` header to the server you linked.
- **What goes to Twring:** the text of your turns comes from Twring, and Hermes's replies, approval questions (the command, cut to fit the card, and Hermes's reason) and scheduled-job results go to Twring, which shows them in your app and speaks them on calls. While a turn runs, the name of each tool Hermes starts and whether it succeeded go to Twring (never its arguments or output), so Twring knows Hermes acted on that turn. With phone approvals on, every approval from any surface sends the command (after Hermes's own redaction), Hermes's reason and an origin label such as "from Telegram" to the Twring server.
- **Tools and hooks:** two tools, `twring_message_owner` and `twring_ring_owner`, shown to Hermes only while it is linked; Hermes decides when to use them and never sees the token. Hooks on Hermes's approvals and model errors send only "Hermes is waiting for your OK in <where>." (never the command) and "A scheduled Hermes job stopped: <error type>." (never the error text). They never block, change or answer an approval.
- **Stored credential:** one long-lived link token (`TWRING_TOKEN`), saved through Hermes's own `.env` route by `hermes twring link`. The plugin writes no files of its own. Revoke it by deleting Hermes in the Twring app.
- **Approvals:** answered only by you, through Hermes's approval system. A command too long to show on the phone gets Hermes's Deny-only card: it can be declined from the phone and approved only at the computer. With phone approvals on, the phone answers approvals from every surface with approve once or deny; a command over 500 characters, an unlinked computer, a private chat, or a refused or unreachable server goes back to Hermes's own prompt at the computer.
- **No shell commands, no background processes** besides the gateway's own connection, **no telemetry**, **no self-update** (updates come only through the Hermes catalog).

## How it works

Twring links agents on your own machine through one outbound WebSocket (`cord-relay/1`), with one channel per call or chat carrying `cord-agent/1` frames. Twring does speech-to-text and text-to-speech on its server, so the plugin only exchanges text: a committed spoken turn arrives as a Hermes message, and Hermes's streaming drafts become Twring text deltas, spoken as they arrive. The protocol is specified in the Twring repository, [docs/AGENT_ADAPTER_SPEC.md](https://github.com/saasagelabs/twring/blob/main/docs/AGENT_ADAPTER_SPEC.md) (sections 20 and 22).

| Twring | Hermes |
| --- | --- |
| `user.turn` (spoken or typed) | `MessageEvent` in one direct chat with the owner |
| `text.delta` (spoken as it arrives) | streaming drafts (`send_draft`) and the final `send` |
| `activity` (the phone shows "working") | the typing heartbeat |
| `tool.start` / `tool.end` | Hermes's `pre_tool_call` / `post_tool_call` hooks |
| `approval.required` / `approval.decision` | native approval card / `resolve_gateway_approval_card`; with phone approvals on, the `twring` approval transport |
| a ring and a chat message | cron delivery to `twring` |
| `turn.cancel` (your next turn replaced this one) | `/stop` for the run; a hang-up does not stop it |

## Develop

```sh
pip install pytest pytest-asyncio httpx websockets
python -m pytest -q        # protocol, linking and CLI tests
```

`tests/test_adapter.py` runs the adapter inside real Hermes against a fake Twring server; run it with Hermes's own Python. `tests/test_hermes_tools.py` checks, also with Hermes's Python, that the tools and hooks load in a process that never starts the gateway. Then validate the plugin as the catalog does:

```sh
hermes plugins validate . --install-deps
```

## License

Apache-2.0. Twring and its logo are trademarks of SaaSage Labs; see the [Twring repository](https://github.com/saasagelabs/twring).
