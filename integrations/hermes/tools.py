"""Hermes tools that reach the owner through Twring: a quiet chat message, or a phone ring.

Hermes imports this module in every process (CLI, TUI, cron and gateway) because plugin.yaml
declares `provides_tools`, while the Twring platform adapter stays deferred. So nothing here
imports the adapter or the gateway. The model never sees the link token or the server address.
"""

from __future__ import annotations

import importlib
import json
import logging
from typing import Any, Callable

try:  # loaded by Hermes as a package
    from . import twring_outbound
except ImportError:  # loaded directly (tests)
    import twring_outbound  # type: ignore[no-redef]

logger = logging.getLogger(__name__)

TOOLSET = "twring"
REASON_MAX = twring_outbound.RING_REASON_MAX

_NO_SHELL = (
    "Never read TWRING_TOKEN, run twring-connect, or use the shell, curl or a timer to reach Twring: "
    "these tools are the only way."
)

RING_DESCRIPTION = (
    "Ring your owner's phone through Twring. Ring only when the owner must act now (you are blocked "
    "waiting for their decision, or something failed that only they can fix) or when they asked you "
    "to ring them. For everything else (progress, results, anything that can wait) use "
    "twring_message_owner instead. Never ring twice for the same thing. `reason` is what the phone "
    "shows and says: plain words, at most 140 characters, no markdown or links. `details`, if given, "
    "goes to their Twring chat first. If the result says delivered: chat with ring: refused (quiet "
    "hours, Do Not Disturb, the hourly limit), the news is already in their chat: do not retry. "
    "Answering opens a call with you. " + _NO_SHELL
)

MESSAGE_DESCRIPTION = (
    "Send your owner a message in their Twring chat with you (a notification, no ring). Use it for "
    "results, progress and anything that can wait; use twring_ring_owner only when they must act now "
    "or asked to be rung. Send one message per thing, not one per step. " + _NO_SHELL
)

Result = dict[str, Any]


def _reply(result: Result) -> str:
    return json.dumps(result)


def _bad() -> str:
    return _reply({"delivered": "none", "why": "bad_arguments"})


def _guarded(send: Callable[[], Result]) -> str:
    try:
        return _reply(send())
    except Exception:
        logger.debug("Twring: tool failed", exc_info=True)
        return _reply({"delivered": "none", "why": "error"})


def _ring_owner(args: Any, **_: Any) -> str:
    if not isinstance(args, dict):
        return _bad()
    reason = args.get("reason")
    details = args.get("details")
    if not isinstance(reason, str) or not reason.strip():
        return _bad()
    if details is not None and not isinstance(details, str):
        return _bad()
    return _guarded(lambda: twring_outbound.ring_owner(reason, details))


def _message_owner(args: Any, **_: Any) -> str:
    if not isinstance(args, dict):
        return _bad()
    text = args.get("text")
    if not isinstance(text, str) or not text.strip():
        return _bad()
    return _guarded(lambda: twring_outbound.send_message(text))


def _linked() -> bool:
    """Shows the tools only when this Hermes is linked to Twring."""
    try:
        return twring_outbound.settings() is not None
    except Exception:
        return False


_TOOLS: dict[str, tuple[Callable[..., str], str, dict[str, Any], list[str]]] = {
    "twring_ring_owner": (
        _ring_owner,
        RING_DESCRIPTION,
        {
            "reason": {
                "type": "string",
                "maxLength": REASON_MAX,
                "description": "What the phone shows and says when it rings: plain words, at most 140 characters.",
            },
            "details": {
                "type": "string",
                "description": "Optional fuller text, posted to the owner's Twring chat before the ring.",
            },
        },
        ["reason"],
    ),
    "twring_message_owner": (
        _message_owner,
        MESSAGE_DESCRIPTION,
        {"text": {"type": "string", "description": "The message for the owner's Twring chat."}},
        ["text"],
    ),
}


def register_tools(ctx: Any) -> None:
    """Registers the Twring tools in the `twring` toolset (shown only while linked) and the Twring hooks."""
    try:
        _register_twring_tools(ctx)
    except Exception:
        logger.warning("Twring: could not register the Twring tools", exc_info=True)

    # Hermes imports only this module in CLI and cron processes, so the hooks are armed here too.
    # Each piece is optional: one that fails to load or register never stops the others.
    for module, attr, what in (
        ("hooks", "register_hooks", "the Twring hooks"),
        # Registered in every Hermes process; it stays inactive until `hermes twring approvals on`.
        ("approval_transport", "register_transport", "the phone approval transport"),
        ("twring_skill", "register_skill", "the Twring skill"),
    ):
        try:
            getattr(_sibling(module), attr)(ctx)
        except Exception:
            logger.warning("Twring: could not register %s", what, exc_info=True)


def _register_twring_tools(ctx: Any) -> None:
    for name, (handler, description, properties, required) in _TOOLS.items():
        ctx.register_tool(
            name=name,
            toolset=TOOLSET,
            schema={
                "name": name,
                "description": description,
                "parameters": {"type": "object", "properties": properties, "required": required},
            },
            handler=handler,
            check_fn=_linked,
            description=description,
            emoji="📞",
        )


def _sibling(module: str) -> Any:
    if __package__:
        return importlib.import_module(f".{module}", __package__)
    return importlib.import_module(module)
