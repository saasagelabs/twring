---
name: twring-connector-distribution
description: How people get and run the Twring connector, and how Twring writes hooks into a user's Claude Code or Codex config. Use when writing install or setup commands, docs, site pages, app copy or code that tells people how to get or run the connector, or when changing the code that installs hooks.
---

# Getting the connector to people

- **The connector is not on npm.** Every user-facing command downloads `twring-connect.mjs` from the Twring server and runs it with Node:

  ```sh
  curl -fsSL <server>/downloads/twring-connect.mjs -o twring-connect.mjs && node twring-connect.mjs ...
  ```

- **Never write `npx twring-connect` or `npx cord-connect`** in code, docs, hooks or the app. Both names are held on npm by placeholder packages (kept in the private repo) that only print how to reinstall a hook. Never publish real code there.
- **Hooks written into a user's Claude Code or Codex config** run the copied connector with an absolute Node path, POSIX-quoted, because Claude Code on Windows runs hooks in Git Bash.
- **Reinstalling replaces an old Twring hook.** It never adds a second one.
