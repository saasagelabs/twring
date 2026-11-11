"""Twring's computer-link protocol, without Hermes: frames, streamed replies, approvals, backoff.

Twring (https://twring.com) carries calls and chats to agents on the owner's own machine over one
outbound WebSocket (`cord-relay/1`), with one channel per call or chat carrying `cord-agent/1`
frames. The wire format is specified in the Twring repository, docs/AGENT_ADAPTER_SPEC.md sections
20 and 22. Kept free of Hermes imports so it can be tested on its own.
"""

from __future__ import annotations

import json
import random
from collections.abc import Iterator
from typing import Any

RELAY_PROTOCOL = "cord-relay/1"
AGENT_PROTOCOL = "cord-agent/1"
DEFAULT_SERVER = "https://api.twring.com"

#: The one agent this computer offers Twring. `acp` is the closest connector kind Twring knows.
AGENT_ID = "hermes"
AGENT_LABEL = "Hermes"
AGENT_KIND = "acp"

#: Twring links one owner to one computer token, so the whole link is one direct chat.
CHAT_ID = "owner"
OWNER_ID = "owner"

#: Largest single text delta Twring accepts (MAX_AGENT_DELTA_CHARS).
MAX_DELTA_CHARS = 4096
#: Largest frame Twring sends or accepts on the relay (64 KiB native limit plus envelope).
MAX_FRAME_BYTES = 64 * 1024 + 4096
#: Twring's approval card limits.
MAX_APPROVAL_TITLE = 80
MAX_APPROVAL_DESCRIPTION = 200

#: Reconnect waits, as the Twring connector does it: 1, 2, 4, 8, 15, then 30 s, plus up to 25%.
_BACKOFF_S = (1, 2, 4, 8, 15, 30)


def connector_hello(version: str) -> dict[str, Any]:
    """The first frame on the relay socket."""
    return {
        "type": "connector.hello",
        "protocol": RELAY_PROTOCOL,
        "agent_protocol": AGENT_PROTOCOL,
        "agents": [{"id": AGENT_ID, "label": AGENT_LABEL, "kind": AGENT_KIND}],
        "version": version,
    }


def session_ready() -> dict[str, Any]:
    """The answer to a channel's `session.hello`. Tools stay private to Hermes."""
    return {
        "type": "session.ready",
        "protocol": AGENT_PROTOCOL,
        "capabilities": {
            "streaming_text": True,
            "cancel": True,
            "activity": True,
            "tools": False,
            "approvals": True,
        },
    }


def channel_message(channel: str, message: dict[str, Any]) -> dict[str, Any]:
    return {"type": "channel.message", "channel": channel, "message": message}


def parse_frame(raw: str | bytes) -> dict[str, Any] | None:
    """One relay frame as a dict with a string `type`, or None for anything else."""
    if isinstance(raw, bytes):
        return None
    if len(raw.encode("utf-8")) > MAX_FRAME_BYTES:
        return None
    try:
        frame = json.loads(raw)
    except ValueError:
        return None
    if not isinstance(frame, dict) or not isinstance(frame.get("type"), str):
        return None
    return frame


class TurnState:
    """One user turn Twring is waiting on: the events Hermes's answer becomes, in order."""

    def __init__(self, channel: str, turn_id: str, surface: str) -> None:
        self.channel = channel
        self.turn_id = turn_id
        self.surface = surface
        self.reply = ReplyStream()
        self._seq = 0
        self._message_id: str | None = None
        self.finished = False

    def event(self, kind: str, **fields: Any) -> dict[str, Any]:
        seq = self._seq
        self._seq += 1
        return {"type": kind, "event_id": f"{self.turn_id}-{seq}", "turn_id": self.turn_id, "seq": seq, **fields}

    def text(self, delta: str) -> list[dict[str, Any]]:
        """Events that add `delta` to the spoken or written reply."""
        if self.finished or not delta:
            return []
        events: list[dict[str, Any]] = []
        if self._message_id is None:
            self._message_id = f"{self.turn_id}-m"
            events.append(self.event("text.start", message_id=self._message_id))
        for start in range(0, len(delta), MAX_DELTA_CHARS):
            events.append(
                self.event("text.delta", message_id=self._message_id, delta=delta[start : start + MAX_DELTA_CHARS])
            )
        return events

    @property
    def answered(self) -> bool:
        """Whether any reply text has gone out for this turn."""
        return self._message_id is not None

    def finish(self, status: str) -> list[dict[str, Any]]:
        """Ends the turn (`completed`, `failed` or `cancelled`); later text is dropped."""
        if self.finished:
            return []
        self.finished = True
        events: list[dict[str, Any]] = []
        if self._message_id is not None:
            events.append(self.event("text.end", message_id=self._message_id))
        events.append(self.event("done", status=status))
        return events


class ReplyStream:
    """Turns Hermes's streaming drafts (the whole reply so far) into only the words not yet sent.

    Hermes animates one draft id per response and sends the final answer as a normal message; a
    response after a tool call gets a new draft id. Words already spoken cannot be taken back, so a
    draft that rewrites earlier text adds nothing until it grows past what was sent.
    """

    def __init__(self) -> None:
        self._sent = ""
        self._draft_id: int | None = None
        self._spoke = False

    def draft(self, draft_id: int, content: str) -> str:
        if self._draft_id is not None and draft_id != self._draft_id:
            self._sent = ""
        self._draft_id = draft_id
        return self._advance(content)

    def final(self, content: str) -> str:
        """The finished answer. Words already sent are not repeated: when only the formatting
        changed (markdown removed, punctuation added), just the new words are added. An answer
        unlike what was sent (a progress note went first) is said whole as a new paragraph: losing
        an answer is worse than repeating a few words."""
        self._draft_id = None
        if self._sent == "" or content.startswith(self._sent):
            return self._advance(content)
        sent, said = _words(self._sent), _words(content)
        if sent and said.startswith(sent):
            rest = _after_words(content, len(sent))
            self._sent = content
            return rest if _words(rest) else ""
        self._sent = content
        return "\n\n" + content if content else ""

    def _advance(self, content: str) -> str:
        if self._sent == "":
            if not content:
                return ""
            self._sent = content
            prefix = "\n\n" if self._spoke else ""
            self._spoke = True
            return prefix + content
        if content.startswith(self._sent):
            delta = content[len(self._sent) :]
            self._sent = content
            return delta
        return ""


def _words(text: str) -> str:
    """Letters and digits only, lower case: the words, without formatting."""
    return "".join(c.lower() for c in text if c.isalnum())


def _after_words(text: str, count: int) -> str:
    """What follows the first `count` letters and digits of `text`."""
    seen = 0
    for index, char in enumerate(text):
        if char.isalnum():
            seen += 1
            if seen == count:
                return text[index + 1 :]
    return ""


def _cut(text: str, limit: int) -> str:
    text = " ".join(str(text or "").split())
    return text if len(text) <= limit else text[: limit - 1].rstrip() + "…"


def approval_required(turn: TurnState, approval_id: str, command: str, description: str) -> dict[str, Any]:
    """Hermes's dangerous-command card as Twring's spoken and tappable approval."""
    fields: dict[str, Any] = {
        "approval_id": approval_id,
        "action": "run_command",
        "title": _cut(f"Run: {command}", MAX_APPROVAL_TITLE),
    }
    reason = _cut(description, MAX_APPROVAL_DESCRIPTION)
    if reason:
        fields["description"] = reason
    return turn.event("approval.required", **fields)


def approval_choice(decision: str) -> str:
    """Twring's yes or no as a Hermes approval choice: yes approves this one command only."""
    return "once" if decision == "approve" else "deny"


def backoff_delays() -> Iterator[float]:
    for step in range(10_000):
        base = _BACKOFF_S[min(step, len(_BACKOFF_S) - 1)]
        yield base * (1 + random.random() * 0.25)
