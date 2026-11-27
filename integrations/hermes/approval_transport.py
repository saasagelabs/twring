"""Hermes's command approvals answered from the Twring app (opt-in: `hermes twring approvals on`).

Hermes calls `present()` on its approval worker thread for every command or code approval once
`security.approval.transport: twring` is set. On a live Twring call the owner is asked on the call;
otherwise a card in the owner's Hermes chat in Twring asks and the phone rings. Only "once" is ever
granted. Anything this transport cannot do raises, and `transport_fallback: builtin` puts Hermes's
own prompt back where it asked. Silence, errors and a server restart never approve.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import threading
import time
from typing import Any, Optional

import httpx

try:  # loaded by Hermes as a package
    from .hooks import session_for_request
    from .twring_calls import ask_in_call
    from .twring_link import LinkError, cancel_approval, create_approval, wait_approval
    from .twring_outbound import USER_AGENT, settings
except ImportError:  # loaded directly (tests)
    from hooks import session_for_request  # type: ignore[no-redef]
    from twring_calls import ask_in_call  # type: ignore[no-redef]
    from twring_link import LinkError, cancel_approval, create_approval, wait_approval  # type: ignore[no-redef]
    from twring_outbound import USER_AGENT, settings  # type: ignore[no-redef]

logger = logging.getLogger(__name__)

TRANSPORT_NAME = "twring"
APPROVAL_TITLE = "Run a command"
MAX_DESCRIPTION = 500
#: Hermes stops waiting at `timeout_seconds`; the plugin stops 3 s earlier so its DELETE and answer land.
DEADLINE_MARGIN_S = 3.0
RETRY_PAUSE_S = 2.0
#: Twring needs at least 10 s to ring and show the card.
MIN_PHONE_S = 10.0
_FAILED_CHOICES = ("transport_",)

_PLACES = {
    "telegram": "Telegram",
    "discord": "Discord",
    "slack": "Slack",
    "whatsapp": "WhatsApp",
    "signal": "Signal",
    "matrix": "Matrix",
    "email": "email",
    "sms": "SMS",
    "cron": "a scheduled job",
    "twring": "Twring",
}
_SKIP_SEGMENTS = {"agent", "main", "dm", "group", "thread", "channel"}

_lock = threading.Lock()
_cancelled: set[str] = set()
_registered_for: set[int] = set()


class TransportDeclined(Exception):
    """This approval goes back to Hermes's own prompt (the plugin cannot ask for it safely)."""


def _now() -> float:
    return time.monotonic()


async def _sleep(seconds: float) -> None:
    await asyncio.sleep(seconds)


def _client() -> httpx.AsyncClient:
    return httpx.AsyncClient(timeout=15.0, follow_redirects=False, headers={"User-Agent": USER_AGENT})


def origin_label(session_key: Optional[str]) -> str:
    """Where Hermes asked, for the card: "from Telegram", "from the terminal"."""
    for part in str(session_key or "").split(":"):
        name = part.strip().lower()
        if not name or name in _SKIP_SEGMENTS:
            continue
        if name in _PLACES:
            return f"from {_PLACES[name]}"
        if name.isalpha():
            return f"from {name.capitalize()}"[:40]
    return "from the terminal"


def _description(request: Any) -> str:
    reason = str(request.description or "").strip()
    text = f"{request.command}\n\n{reason}" if reason else str(request.command)
    return text[:MAX_DESCRIPTION]


def _is_cancelled(request_id: str) -> bool:
    with _lock:
        return request_id in _cancelled


def _on_post_approval_response(**kwargs: Any) -> None:
    """Hermes's post_approval_response hook: Hermes stopped waiting (interrupted, timed out, error),
    so the card must stop asking. Observer only; never raises, never blocks."""
    try:
        choice = str(kwargs.get("choice") or "")
        request_id = str(kwargs.get("request_id") or "")
        if request_id and choice.startswith(_FAILED_CHOICES):
            with _lock:
                _cancelled.add(request_id)
    except Exception:
        pass
    return None


async def present(request: Any):
    """Hermes's approval transport: returns `request.respond('once' | 'deny')` or raises
    `TransportDeclined` so Hermes's own prompt asks instead."""
    if "once" not in tuple(request.allowed_choices):
        raise TransportDeclined("Hermes could not show the whole command.")
    if len(str(request.command)) > MAX_DESCRIPTION:
        raise TransportDeclined("The command is too long to show on the phone.")
    deadline = _now() + float(request.timeout_seconds) - DEADLINE_MARGIN_S
    session_key = session_for_request(request.request_id)
    try:
        if session_key:
            answer = ask_in_call(
                session_key, request.request_id, request.command, request.description, max(deadline - _now(), 0.0)
            )
            if answer == "approve":
                return request.respond("once")
            if answer == "deny":
                return request.respond("deny")
        linked = settings()
        if linked is None:
            raise TransportDeclined("Twring is not linked on this computer.")
        server, token = linked
        if deadline - _now() < MIN_PHONE_S:
            raise TransportDeclined("Too little time left to ask on the phone.")
        async with _client() as client:
            try:
                approval = await create_approval(
                    client,
                    server,
                    token,
                    request_id=request.request_id,
                    title=APPROVAL_TITLE,
                    description=_description(request),
                    origin_label=origin_label(session_key),
                    expires_in_s=int(deadline - _now()),
                )
            except LinkError as error:
                raise TransportDeclined(str(error)) from error
            approval_id = approval["approval_id"]
            status = approval["status"]
            while status == "pending" and not _is_cancelled(request.request_id):
                left = deadline - _now()
                if left <= 0:
                    break
                try:
                    status = (await wait_approval(client, server, token, approval_id, max(1, min(25, int(left)))))["status"]
                except LinkError:
                    await _sleep(min(RETRY_PAUSE_S, max(deadline - _now(), 0.0)))
            if status == "allowed":
                return request.respond("once")
            if status == "pending":
                with contextlib.suppress(LinkError):
                    await cancel_approval(client, server, token, approval_id)
            return request.respond("deny")
    finally:
        with _lock:
            _cancelled.discard(request.request_id)


def register_transport(ctx: Any) -> bool:
    """Registers the `twring` approval transport. It does nothing until the owner turns it on
    (`hermes twring approvals on` sets `security.approval.transport: twring`). False on a Hermes
    without approval transports, which keeps its own prompts. Once per plugin manager: Hermes calls
    both `tools.register_tools` and the plugin's `register`, and a second call returns True."""
    register = getattr(ctx, "register_approval_transport", None)
    if not callable(register):
        return False
    owner = id(getattr(ctx, "_manager", None) or ctx)
    with _lock:
        if owner in _registered_for:
            return True
        _registered_for.add(owner)
    try:
        register(TRANSPORT_NAME, present)
    except Exception:
        with _lock:
            _registered_for.discard(owner)
        logger.debug("Twring: approval transport not registered", exc_info=True)
        return False
    register_hook = getattr(ctx, "register_hook", None)
    if callable(register_hook):
        with contextlib.suppress(Exception):
            register_hook("post_approval_response", _on_post_approval_response)
    return True
