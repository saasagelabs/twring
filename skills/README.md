# Twring skill pack for agents

`twring/` is a skill in the open [Agent Skills](https://agentskills.io) format: a folder with a `SKILL.md` plus reference files. It teaches any agent:
- how to behave on a Twring call: speak briefly, take turns, stay on the line, hang up only after goodbye;
- how to handle voice approvals and long work;
- when and how to ring its owner;
- where voice works well, and what to do where it doesn't.

The skill adds to the short call instructions the Twring connector already gives each agent; it doesn't replace them. If the two ever differ, the call instructions win.

## Install

Copy the whole `twring` folder (not just `SKILL.md`) into your agent's skills folder:

| Agent | Folder |
| --- | --- |
| Claude Code | `~/.claude/skills/twring/` (all projects) or `<project>/.claude/skills/twring/` |
| Codex CLI | `~/.codex/skills/twring/` |
| Hermes Agent | `~/.hermes/skills/twring/`, or inside a category such as `~/.hermes/skills/communication/twring/` |
| OpenClaw | `<workspace>/skills/twring/`, or `~/.openclaw/skills/twring/` for all agents |
| Other Agent Skills tools | Their user skills folder; many also read `~/.agents/skills/` |

The pack is published as `https://twring.com/downloads/twring-skill.tar.gz`, built by `scripts/package-skill.sh`. On macOS or Linux, for example for Hermes:

```bash
mkdir -p ~/.hermes/skills
curl -fsSL https://twring.com/downloads/twring-skill.tar.gz | tar -xz -C ~/.hermes/skills
```

Change the folder for other agents. An agent can also run this itself: send it the two lines and ask it to install the Twring skill.

Restart the agent, or start a new session, so it picks up the skill. Agents load the skill when its description matches: on a Twring call, or when they're deciding whether to ring you.

**Agents without skill support:** paste the body of `SKILL.md` (everything below the `---` header) into the agent's system prompt or `AGENTS.md`. The reference files are optional extra reading.

## What's in it

| File | What it covers |
| --- | --- |
| `twring/SKILL.md` | The essentials: how to behave on a call, approvals, ringing, when voice is the wrong tool |
| `twring/references/voice.md` | Writing for the ear, with before-and-after examples |
| `twring/references/ringing.md` | The ring command, exit codes, good ring messages, declines |
| `twring/references/approvals-and-long-work.md` | Voice approvals, progress lines, time limits, working after hang-up |
| `twring/references/limits.md` | Where Twring shines, where it goes dark, and what to do instead |

## Keeping it true

The skill describes how Twring actually behaves (ADR-024 and ADR-026 to ADR-030 in `docs/DECISIONS.md`). `apps/connector/src/skill.test.ts` checks its key facts against the shared contracts: the hang-up marker, the ring exit codes and the ring message length. When call behaviour changes, update the skill in the same pull request and raise `metadata.version`.
