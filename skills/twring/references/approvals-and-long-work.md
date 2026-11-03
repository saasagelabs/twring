# Approvals and long work on a call

## Approvals

Agents connected over ACP (Hermes, for example) can ask the owner for a permission during a call. Twring handles the asking, as follows.

- It speaks one fixed line: "<your name> wants to change files", "delete files", "read files", "run a command", "open a web page", or "do something that needs your OK", followed by "Say yes or no, or tap on your phone."
- It shows your permission's title and description on the phone card. These are never spoken.
- It accepts a short spoken yes ("yes", "okay", "go ahead") or no ("no", "don't", "not now"), or a tap on the card. If the reply isn't clear, it asks once more.
- It answers "no" for the owner after two minutes of silence, when the call ends, or when the turn is cancelled. You get a denial in each case.

What that means for you:

1. **Explain, then ask.** The spoken line names a category, not your action. Say what and why in one sentence first: "To fix the build I need to delete the cached packages folder. It's safe; it rebuilds itself."
2. **Give the request a clear title**, such as "Delete the cached packages folder". The owner may glance at the card.
3. **One request at a time.** Twring handles one pending approval at a time.
4. **Read back costly targets.** For deleting data, spending money, messaging other people or touching production, confirm the exact target by voice before you request the permission.
5. **A denial is an answer.** Say briefly what you'll do instead, or ask what they'd prefer. Don't ask again for the same thing straight away.
6. **Work that continues after the call can't be approved.** Pending approvals are denied when the call ends. If the rest of the job needs permission, stop there, then ring and ask.

You still carry out what's approved, with your own tools and safeguards. Twring never runs your tools.

## Long work

Calls feel broken when there's silence. Twring prevents dead air without faking anything:
- About 0.7 s after the owner finishes speaking, if you haven't started replying, it plays a soft "heard you" tone.
- About 1.5 s in, still with nothing from you, it says one short line in your voice: "Okay, one moment.", "Sure, let me see." or "Right, let me think." Once per request. If your first words come while the line is almost over, the line finishes first; otherwise your words cut it off. So don't open your own reply with the same kind of line.
- After 4 s without your text, while a tool or activity with a plain-words title runs, it says "Still working: <your activity>." (or as soon as such an activity starts). With nothing named, it waits for 12 s of silence and says "Still working on it." It repeats at most every 15 s and at most four times a turn.
- A single turn is cut off after 10 minutes. A call lasts at most 30 minutes, and the owner has a daily allowance (60 minutes and 50 calls a day by default).

How to work with that:

1. **Say what's coming before a long step,** and roughly how long it takes: "Running the full tests now. About three minutes."
2. **If it takes more than a couple of minutes, offer to follow up:** "This will take about twenty minutes. Hang up if you like and I'll let you know when it's done." Then do it. With the connector, hanging up doesn't stop your work, and your final reply is saved in their Twring chat. They may get a call or notification, depending on their settings.
3. **Don't stretch a turn to fill time.** Finish the turn, say where things stand, and let them choose: wait, do something else, or hang up.
4. **While your tools run, the owner's words wait for your turn to end.** If you need their input, end the turn with the question.
5. **"Stop" ends the turn at once.** Twring cancels your run and says "Okay, stopped." You never receive the word. Leave things in a safe state, and don't pick the task back up unless they ask.
