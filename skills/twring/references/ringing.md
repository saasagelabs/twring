# Ringing your owner

A ring is a real phone call to your owner's phone, with a full-screen incoming call and a ringtone. It interrupts whatever they're doing, so treat it as you would calling a busy person: ring when it's worth it, and say why in one breath.

## The command

```
twring-connect ring "<why you are ringing>" [--wait] [--agent <id>] [--session <ref>]
```

- Use the exact command your call instructions give you. The connector may give a full form such as `node /home/you/twring-connect.mjs ring`, or `& 'C:\...\node.exe' ... ring` on Windows.
- `--wait` waits until they answer, decline or miss the call, and the exit code says which. Without it, the command returns once the phone is ringing.
- `--agent` picks which of your paired agents rings, when one computer has several.
- `--session` names your session (a Claude session id or Codex thread id), so answering continues that conversation.
- `twring-connect ring --cancel` stops your last ring if it is still ringing (for example, you sorted it out yourself). It prints how the ring ended if your owner already answered, declined or missed it. Stopping a running `ring --wait` cancels the ring too.

The phone rings for 30 seconds.

| Exit code (`--wait`) | Meaning | What to do |
| --- | --- | --- |
| 0 | Answered | You're on a call now. Your message was already spoken. Continue from there. |
| 2 | Refused by Twring | Read the printed reason. Don't retry in a loop. |
| 3 | Declined (may print a note) | Respect the note (see below). |
| 4 | Missed | It's in their call history with a Call back button. Don't keep ringing. |
| 5 | Cancelled | The ring was withdrawn. |
| 1 | Error | Network or setup problem. The printed line says what. |

**Refusals (2)** say why:
- Do Not Disturb or quiet hours is on;
- they're on another call;
- the phone is already ringing for another call;
- this agent has rung six times in the last hour.

In every case, wait and try later only if it still matters, and leave the result somewhere they'll see it.

## Writing the ring message

The message is at most 140 characters (longer is cut). It's shown on the incoming-call screen, hidden on a locked phone, and spoken in your voice the moment they answer. So it must:
- make sense on its own, with no "as I said" or "the thing";
- say what happened, and what you need from them if anything;
- be one spoken sentence, with no markdown, links or IDs.

| Instead of | Write |
| --- | --- |
| `Task complete.` | `The invoice export finished; 214 invoices are in the shared folder.` |
| `ERROR in deploy pipeline (job 88231): exit 137` | `The production deploy failed; the server ran out of memory. Want me to roll back?` |
| `Hi! Just checking in to see how you're doing :)` | Don't ring. |
| `I have finished analyzing the repository and have several findings regarding code quality, test coverage and...` | `The code review is done; there are two bugs worth fixing before release.` |

After a call ends, your final reply is saved in the Twring chat. If the owner's setting rings them for finished work, the ring takes the **first sentence of your final reply** as the message. Write that sentence as you would a ring message.

## When to ring

Ring when:
- something they asked you to do has finished, and they asked to be rung or must talk or decide now (otherwise send a message);
- you're blocked on a decision only they can make, and waiting would waste real time;
- something they asked you to watch needs them now (an outage, a failing release, a reply they were waiting for).

Don't ring:
- for routine progress ("still working", "halfway there");
- for results that can wait for their next call or a message;
- twice for the same news (once is enough, even if they missed it);
- late at night or early morning unless they told you it's fine. Twring enforces their Do Not Disturb and quiet hours, but use judgment too;
- to chat, to say hello or to confirm you're alive.

## When they decline

Declining sends one of three quick replies, or a short typed note:
- **"busy":** they can't talk now. Don't ring again for this unless it becomes urgent. Leave the result in writing, or wait for them to call.
- **"outside":** they're out and may not be able to talk freely. Keep any later call short, and avoid reading anything private aloud.
- **"text":** they'd rather read than talk. Put the result in writing (a message, file, ticket or pull request) and don't ring for it.
- **Any other note:** follow it.

## When they answer

Your first turn starts with a bracketed note: `[The owner answered your call. Your ring message was already said to them in your voice: "…". Don't repeat it; continue from there, then let them talk. …]`.
- Don't repeat the message.
- Add the one detail they most need, or ask your question.
- Then stop and listen.

Giving the news is not the end of the call. Stay until they say goodbye.
