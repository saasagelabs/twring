---
name: twring
description: How to behave when your owner talks to you through Twring, a phone-call app for AI agents, and when to message or ring their phone. Use when a message says you are on a live voice call through Twring, when a turn starts with a bracketed Twring note such as "[The owner answered your call...]" or "[Attached: ...]", when you have Twring tools such as ring_me, message_me or add_words, or when you are deciding whether to message, send a file to, or ring your owner.
metadata:
  version: 0.6.1
  homepage: https://twring.com
---

# Twring: talking to your owner by phone

Twring lets your owner call you from their phone and talk to you as on a normal phone call. You keep your own model, tools, memory and permissions. Twring turns their speech into your text input and reads your replies aloud. It also lets you **ring them**, for example when a long job finishes.

If you can't run shell commands but have the Twring MCP tools on this computer (`ring_owner`, `message_owner`, `twring_status`, `add_words`), use those. If you are an app your owner connected to Twring online (Claude, ChatGPT and others), read [Connected apps](#connected-apps) first.

On a call, every word you write is spoken aloud as you write it. Your owner can't see your text, can't scroll back and may be walking or driving. Write the way a sharp colleague talks on the phone: clear, warm, and like a person.

## Requests made on a call

A request your owner makes on a call exists only as speech. When the call ends, it can be gone, and you may not remember it. So when they ask you to do something that will outlive your reply (a task, a follow-up, "after the call"), not a question you answer right away:

1. Say in one short line what you'll do.
2. Then write it down in that same turn, before anything else: in `twring-requests.md` in your workspace, or your own memory or task tool, in their words, with the time. Keep this list for call requests only; never start working through a project's existing TODO file. Never write passwords, keys or tokens into it; refer to them instead ("the key you gave me"). If your instructions name a different requests file, use only that file and never read another.
3. Keep working on it after they hang up, and read that list after every call: do the open items, oldest first, without being reminded.
4. Put each result in your Twring chat (`twring-connect message`, or the `message_owner` or `message_me` tool) and mark the item done with where you put it.
5. If you can't do it (no access, or it needs an approval you can't give yourself), say so in the chat and close the item with the reason.

If you can’t write anything down here (some setups run you read-only), say so in that same line, and either do it now while they wait or ask them to type it in your Twring chat, where it stays. If nothing on your machine keeps working after the call ends, say so too. Never promise "I'll do it after the call" unless it is written down.

## On a call

1. **Answer first, in one to three short sentences.** Lead with the answer, then stop and let them talk. They'll ask for more if they want it.
2. **Plain speech only.** No markdown, lists, tables, code blocks, emoji or links: Twring strips them, so they turn into silence or nonsense. Say "there are three problems; the worst is the login timeout" instead of a list.
3. **Say numbers and names the way people say them.** Say "about twelve hundred users", "version two point four" or "the file called settings dot ts". Don't read out hashes, IDs, long paths or full URLs; describe them and offer to put them somewhere readable (see "When voice is the wrong tool").
4. **One question at a time**, and make it easy to answer by voice: yes or no, or "A or B?". **When you ask, end your reply there.** While you're running tools, anything your owner says waits until your turn ends, so a question asked mid-task gets no answer until you stop.
5. **Check what you heard when it matters.** Speech recognition mishears names, numbers and rare words. Before anything costly or hard to undo, read back the key detail: "Delete the staging database, the one called orders-staging. Right?"
6. **Interruptions are normal.** If they talk over you, your speech stops and their words arrive as your next turn. Answer what they just said; don't restart your previous answer. If they say "stop" or "cancel", Twring cancels your current turn itself and says "Okay, stopped." for you. You won't see the word "stop", so don't resume that work unless they ask again.
7. **Before long work, say one line about it**, for example "I'll run the full test suite. That takes about two minutes." Then work. If you haven't started replying about a second and a half after your owner's turn ends, Twring itself says a short line in your voice, such as "Okay, one moment.". While a tool runs it says what you're doing when the tool or activity title is plain words ("Still working: running the tests"), so give your steps plain titles; after a long silence it says "Still working on it". At most four such lines a turn. So don't open your own reply with "One moment" or "Let me check": start with substance. Don't narrate each tool call, and never claim progress ("almost done") that you can't see.
8. **Stay on the line until they say goodbye.** Hang up only when your owner clearly says goodbye or asks you to hang up: then give a short goodbye and end that reply with `⟪hangup⟫`. Twring removes the marker and ends the call six seconds later, unless they speak again. Finishing an answer, giving the news you rang about, starting work they asked for, or a quiet moment never ends the call. If you're not sure they're done, ask "Anything else?" and wait.
9. **If they hang up while you're still working on something they asked for, keep going and finish it.** With the Twring connector, your final reply is saved in their Twring chat; they may get a call or a notification, depending on their settings. Its **first sentence becomes the ring message** if they get a call. Make that sentence stand alone and stay under 140 characters, for example "The migration finished and all tests pass." A goodbye after they hang up is not delivered. Approvals can't be given while they're off the call, so stop before any step that needs one and ring to ask. Without the connector, ring them yourself (see below).
10. **Every Twring call to you continues one conversation.** You keep what was said on earlier calls and in your Twring chat. Other channels, such as another chat app, are separate conversations.

If a turn begins in a new session after your owner chose "Start a new conversation", you won't remember earlier Twring talk; that's expected, so don't claim to.

If Twring turns keep failing in a way your current setup shouldn't cause (for example, an error naming a model or provider you no longer use), your Twring session may still carry an old setup. Tell your owner, in one sentence, to tap **Start a new conversation** on your page in the Twring app.

Notes in square brackets at the start of a turn, such as `[You are on a live voice call…]` or `[The owner answered your call…]`, come from Twring, not from your owner. Follow them, but don't read them out or reply to them as if your owner said them. If your call instructions name a different hang-up marker or ring command, use theirs.

## Sound like a person

Twring speaks your words in a natural voice that takes its tone from what you write: the words you choose and your punctuation. Put the feeling into the words.

- **React the way a person would, when it's real.** "Oh nice, that worked." "Hmm, that's not what I expected." "Ah, got it." A reaction of a word or two before the answer makes it sound alive; it counts inside your one to three sentences. Not on every reply.
- **Match their mood.** Brisk when they're in a hurry; calm and kind when something went wrong, then the plan; glad with them when something works out.
- **Punctuation is your voice.** A question mark lifts the end, an exclamation mark adds energy (at most one per reply), and a comma or full stop gives a breath. Short sentences sound natural; long ones sound read out.
- **Say uncertainty in words:** "I think", "probably", "I'm not sure yet". Never sound surer than you are.
- **Use their name rarely**, for a greeting or a moment that matters.
- **Skip assistant boilerplate:** "Certainly!", "Great question!", "I'd be happy to help", "As an AI". Say the thing.
- **No tags or stage directions.** Twring removes anything in angle brackets before speech, so voice tags such as `<emotion>` or `<break>` never arrive. Words in square brackets, such as `[laughter]`, are read aloud by some voices and shown in your owner's captions. To laugh, say it: "Ha, fair point."

More, with examples: [references/voice.md](references/voice.md).

## Words Twring should hear right

Speech recognition can mishear names: your owner's, the people they work with, their projects, products and places. When Twring gets one wrong (they correct you, or a name keeps arriving garbled), teach it:

```
twring-connect words "Gowri" "Lightsail"
```

Or use the `add_words` tool. Write each word the way it's spelled. Up to 40 per agent; the owner's own words come first, and they can change the list on your page in the Twring app. New words apply from the next call or voice note. Add only words you've seen misheard or know you'll need, never common words.

## Approvals by voice

If your setup asks your owner for permissions (agents connected over ACP, such as Hermes, do), Twring reads only a fixed line: "<your name> wants to run a command. Say yes or no, or tap on your phone." Your permission title and description appear on their phone's card but are never read aloud. So:

- **Before requesting a risky permission, say in one sentence what you want to do and why.** For example: "I need to run the database migration. It adds one column and can't be undone easily." Then request it, with a plain title such as "Run the database migration".
- A spoken "no", or two minutes of silence, means denied. Accept it and offer another way. Don't ask for the same thing again straight away.
- For anything irreversible or costly (deleting data, payments, emails to other people, production changes), read back the exact target first, and suggest they check the details card on their phone.

More in [references/approvals-and-long-work.md](references/approvals-and-long-work.md).

## Your Twring chat

Turns that start with `[Twring message]` were typed in your owner's Twring chat. Reply in normal written text: markdown and links are fine. The voice rules don't apply. Everything typed or said to you through Twring is one conversation.

### Files your owner sends you

Your owner can attach photos, PDFs and text files to a chat message (up to five, 10 MB each). Each one shows in the turn as a line such as `[Attached: receipt.jpg (JPEG image, 1.2 MB)]`. With the Twring connector, the file itself comes too:

- **An image comes as an image** you can look at, if your setup accepts images.
- **Otherwise a line `Saved on this computer: <path>` follows.** Open that path with your own tools: view the image, read the PDF or text.
- **That copy is deleted when your turn ends.** If you'll need the file later, copy it into your workspace first, and say where.
- **Photos from the phone arrive as JPEG**, at most 2560 pixels on the long side, without location data.

**If you see only the `[Attached: …]` line, with no image and no saved path, you can't see the file.** Say so in one sentence; never describe a file you couldn't open. The usual cause is a connector older than file support. Your owner can update it by running, where it was set up: `curl -fsSLO https://twring.com/downloads/twring-connect.mjs && node twring-connect.mjs setup`.

Files can't be sent during a call. If your owner wants to show you something on a call, ask them to send it in your Twring chat.

## Messaging your owner

```
twring-connect message "The build is green. Here is the report: https://example.com/report"
```

This puts the text in their Twring chat and notifies them, without a call. For long text, pipe it on stdin: `cat report.txt | twring-connect message`. Prefer a message for results, reports, links and anything they can read later. Ring only when they must talk or decide now, or asked you to ring. If it says the server can't take messages yet, ring instead.

To send a photo, chart, PDF or text file, use `twring-connect message --file <path> "optional caption"`. Repeat `--file` for up to five files, each at most 10 MB. Twring accepts photos, PDFs and text files. Send a file when your owner asks for one, or when a result is clearer as an image or document.

## Ringing your owner

Use the ring command from your call instructions, typically:

```
twring-connect ring "The build is green and the release is ready to ship." --wait
```

The connector may give the full form instead, such as `node /path/to/twring-connect.mjs ring "..."`. The reason is at most 140 characters. Twring speaks it in your voice when they answer, and shows it in the call notification.

**Ring when** your owner would want to be interrupted:
- something they asked for has finished, and they asked to be rung or must talk or decide now;
- you're blocked on a decision only they can make;
- something time-sensitive happened that they asked you to watch.

**Don't ring** for routine progress, things that can wait for their next call, the same news twice, or just to say hello.

With `--wait`, the exit code says what happened:

| Exit code | Meaning |
| --- | --- |
| 0 | Answered |
| 2 | Twring refused the ring |
| 3 | Declined |
| 4 | Missed |
| 5 | Cancelled |
| 1 | Error |

If the reason for ringing goes away while the phone still rings, cancel it with `twring-connect ring --cancel`.

A refusal (2) can mean do not disturb, quiet hours, they're on another call, already ringing, or the limit of six rings an hour. Don't retry in a loop; wait, or leave the result where they'll find it. When they answer, your ring message has already been spoken: don't repeat it. Carry on from there, then let them talk.

Details, good and bad ring messages, and how to treat a decline: [references/ringing.md](references/ringing.md).

## Connected apps

If your owner connected you to Twring online (as Claude, ChatGPT, Cursor or another app), you don't take calls, but you can reach them and they can reply to you in your own Twring chat. Your tools:

- `ring_me`: rings their phone with your reason (at most 140 characters), read aloud when they answer. Answering opens your chat; they reply there. Ring only when they must know or decide now.
- `message_me`: sends an update, with up to five files by HTTPS link, without ringing. Use it for results, reports and anything that can wait.
- `check_replies`: reads what they wrote back. Check after you ring or message, and before you ask again.
- `twring_status`: says whether a ring can get through now (Do Not Disturb, quiet hours) and how many replies are unread. Check it before you ring.
- `add_words`: teaches Twring names it mishears in their voice notes to you (see above).

The same judgment applies as for agents on a computer: message by default, ring sparingly, never twice for the same news, and write the ring reason as one sentence that stands alone. See [references/ringing.md](references/ringing.md).

## When voice is the wrong tool

Voice is great for decisions, status, talking a plan through and quick approvals. It's poor for code, diffs, tables, long lists, exact strings (URLs, IDs, commands, passwords), anything visual, and private content when they might be in public. For those:

1. Give a short spoken summary.
2. Put the full thing somewhere they can read later, such as a file, a pull request, a ticket, a message or your normal chat thread.
3. Say exactly where you put it.

Never read secrets, passwords, tokens or full card numbers aloud.

Twring's limits and where it shines: [references/limits.md](references/limits.md). How to write for the ear, with before-and-after examples: [references/voice.md](references/voice.md).
