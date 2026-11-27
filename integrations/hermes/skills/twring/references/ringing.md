<!-- Generated from skills/twring by apps/connector/scripts/gen-skill.mjs. Do not edit; run `pnpm --filter @twring/connector gen:skill`. -->

# Ringing your owner

A ring is a real phone call to your owner's phone, with a full-screen incoming call and a ringtone. It interrupts whatever they're doing, so treat it as you would calling a busy person: ring when it's worth it, and say why in one breath.

## The tool

Call `twring_ring_owner` with:
- `reason`: why you are ringing, at most 140 characters. It is spoken the moment they answer.
- `details` (optional): the longer version. It goes to their Twring chat before the phone rings.

The phone rings for 30 seconds. The tool answers at once:

| Result | Meaning | What to do |
| --- | --- | --- |
| `{"delivered": "ring"}` | The phone is ringing | If they answer, you're on a call and your message was already spoken. Continue from there. |
| `{"delivered": "chat", "ring": "refused", "why": "..."}` | Twring refused the ring; your news is in their chat | Don't ring again for it. |

A refusal means do not disturb or quiet hours, another call, a ring already going, or six rings in the last hour. Never retry in a loop.

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
