# Antigravity CLI instructions for Twring

Twring makes an existing agent callable over the internet. The connected agent owns its reasoning, memory, tools, permissions, and actions. Twring owns the call, media, speech, and adapter layers.

Before changing files, read `docs/PRODUCT.md`, `docs/ARCHITECTURE.md`, and the documents for the assigned task. Follow `docs/ORCHESTRATION.md` for worktree ownership.

Use Gemini for small, well-defined tasks that can be completed quickly in its own worktree. Do not edit files assigned to an active Claude Code or Codex task. Do not change architecture contracts without an explicit task and a decision recorded in `docs/DECISIONS.md`.

Keep provider secrets out of the mobile app and repository. Preserve streaming, interruption, reconnect, and iOS compatibility. Run the checks relevant to the files you change, review your diff, and report any checks you could not run.

- Commits carry a DCO sign-off (`git commit -s`).
