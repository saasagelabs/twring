# twring-connect

Lets the Twring phone app call the AI agents already on your computer: Claude Code, Codex, Gemini CLI,
Hermes, or any command you name. Your computer dials **out** to your Twring server, so it needs no
public address, open port, or tunnel. Design: ADR-023.

## Use

1. On your computer, in the folder your agent should work in:

   ```sh
   npx twring-connect
   ```

   It finds the agents installed on this computer and shows a QR code and a code like `ABCD-EFGH`
   (10 minutes, single use).

2. In the app: **Add agent → On my computer → Scan the code** (or type the code). The phone shows
   "Link <your computer's name>?" with the agents it found; tap **Link**, then choose which agents
   to add. They are ready to call from Home.

3. Later, just run `npx twring-connect` again to reconnect. Ctrl+C disconnects. Home shows
   "On your computer · Online" while it runs, and "Computer offline" when it does not.

The server defaults to Twring's own (today the staging server); `--server <url>` or the
`CORD_SERVER` variable picks another. The phone refuses a QR code made for a server other than its
own.

**Other way (phone shows the code):** in the app, **On my computer → Other ways to connect** shows
a command with a code; run `npx twring-connect --code ABCD-EFGH` on the computer.

In this repository: `pnpm --filter @twring/connector start -- --code … --server http://localhost:8080`
(see docs/DEVELOPMENT.md). Publishing to npm needs a build step (the bin is TypeScript today).

The pairing is saved in `~/.config/cord-connect/config.json` (Windows: `%APPDATA%\cord-connect`),
readable by you only (mode 600). The token in it is never printed. `--forget` removes it; remove
the computer in the app to revoke it on the server.

## Let your agent set itself up

In the app, **Add agent → On my computer or server** shows a message to forward to your agent (for
example Hermes on Telegram). The agent runs, on its own machine:

```sh
curl -fsSL <server>/downloads/twring-connect.mjs -o twring-connect.mjs && node twring-connect.mjs setup --code ABCD-EFGH --server <server>
```

`setup` (Node.js 20 or newer):

1. pairs with the code, unless this machine is already linked (then the code is not needed);
2. copies itself into the config folder and installs a background service that starts with the
   machine and restarts if it stops, running that copy in the current folder with the current
   `PATH` (so it finds `hermes`, `claude`, `codex`, …):
   - Linux: a systemd unit (`/etc/systemd/system/cord-connect.service` as root, else
     `~/.config/systemd/user/cord-connect.service` plus `loginctl enable-linger`), or without
     systemd a crontab `@reboot` line;
   - macOS: `~/Library/LaunchAgents/ai.cord.connect.plist`;
   - Windows: a "CORD connect" task at logon that runs a hidden launcher
     (`%APPDATA%\cord-connect\cord-connect.vbs`);
3. stops any other copy running with this pairing, starts the service, waits up to 20 s for it to
   connect, and prints one line, e.g. `Twring is ready. Your phone can call: Hermes. It keeps running
   in the background.`

Running `setup` again replaces the service instead of adding another. `node twring-connect.mjs
uninstall` stops and removes the service and keeps the pairing; add `--forget` to unlink too. The
service's output goes to `cord-connect.log` in the config folder (systemd: `journalctl -u
cord-connect`, with `--user` for a user unit), cut back past 5 MB with the previous part kept as
`cord-connect.log.1`. No service file contains the token. Without a usable pairing the service
exits with code 78 and is not started again (systemd `RestartPreventExitStatus=78`; launchd keeps
it alive only while the pairing file exists; the Windows launcher stops on 78).

Build the file with `pnpm --filter ./apps/connector bundle` (writes `dist/twring-connect.mjs`).

## Agents and their safe defaults

The connector only carries your words in and the agent's own answer and activity out. It never runs
an agent's tools itself; each agent runs as you, in the folder you started `twring-connect` in.

| Agent       | How it is driven                                                   | Default                                                                                                                  | Opt in                                              |
| ----------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------- |
| Claude Code | `claude -p` stream-json, one process per call                      | Read, Grep, Glob, WebSearch, WebFetch only; `--permission-mode dontAsk`; no MCP servers; `CLAUDE_CODE_*` env vars unset | `--claude-allow-edits` adds Edit and Write          |
| Codex       | `codex exec --json`, one process per turn, `resume <thread>` after | `--sandbox read-only`                                                                                                    | `--codex-sandbox workspace-write`                   |
| Gemini CLI  | ACP over stdio (`gemini --acp`)                                    | every permission request denied; no file system or terminal offered                                                      | `--acp-allow read,search` allows those kinds once   |
| Hermes      | ACP over stdio (`hermes acp`)                                      | as Gemini CLI                                                                                                            | as Gemini CLI                                       |
| Any command | `--command "<cmd>"`: your words on stdin, stdout spoken            | the command's own behaviour; your words never go on its command line                                                    | `--command-label "Name"`                            |

Barge-in: Claude Code gets its `interrupt` control request, ACP agents get `session/cancel`,
Codex and custom commands are stopped. A turn is never sent twice, even after a reconnect.

Notes:

- Codex replies arrive whole (its JSON stream reports a finished message), so speech starts when
  the answer is complete.
- Gemini CLI and Hermes must already be signed in (run them once in a terminal).
- Hermes: its docs list `hermes acp` as its ACP stdio server (and `hermes acp --setup` for sign-in).

## Security

- The server must be `https://` (plain `http://` only for localhost development).
- The connector token is long-lived and revocable from the app; the server stores only its hash.
- The server only routes the owning account's calls to this computer.
- Frames are size-limited both ways; malformed agent output fails the turn instead of reaching the
  phone.
