"""Hermes reaching its owner through Twring, from plain threads: a chat message or a phone ring.

Hermes runs tool handlers and approval hooks on ordinary threads, sometimes while an event loop is
running there, so each call here runs on its own short event loop with a short timeout. The link
token and server address stay inside this module: callers only ever get delivery words and
Twring's refusal codes back, so the model never sees either.
"""

from __future__ import annotations

import asyncio
import logging
import os
import re
import threading
from typing import Any, Awaitable, Callable, Optional

import httpx

try:  # loaded by Hermes as a package
    from .twring_core import DEFAULT_SERVER, PLUGIN_VERSION
    from .twring_link import LinkError, check_server, post_message, post_ring
except ImportError:  # loaded directly (tests)
    from twring_core import DEFAULT_SERVER, PLUGIN_VERSION  # type: ignore[no-redef]
    from twring_link import LinkError, check_server, post_message, post_ring  # type: ignore[no-redef]

logger = logging.getLogger(__name__)

#: Seconds for one Twring HTTP call. Short: a hook or tool must never hold Hermes for long.
HTTP_TIMEOUT_S = 8.0
#: Twring keeps at most 140 characters of a ring reason (it shows on the lock screen).
RING_REASON_MAX = 140
USER_AGENT = f"twring-hermes/{PLUGIN_VERSION}"

_MD_LINK = re.compile(r"\[([^\]]*)\]\([^)]*\)")
_URL = re.compile(r"(?:https?://|www\.)\S+", re.IGNORECASE)
_MD_MARKS = re.compile(r"[*_`#>~|]")


def setting(name: str) -> str:
    """One Twring setting from the active Hermes profile's secret scope (the process env outside
    Hermes). Never logged."""
    value: Any = None
    try:
        from gateway.platforms._shared import get_scoped_secret

        value = get_scoped_secret(name)
    except Exception:
        value = os.environ.get(name)
    return str(value or "").strip()


def settings() -> Optional[tuple[str, str]]:
    """(server, token) when this Hermes is linked to Twring, else None."""
    token = setting("TWRING_TOKEN")
    if not token:
        return None
    try:
        server = check_server(setting("TWRING_SERVER") or DEFAULT_SERVER)
    except LinkError:
        return None
    return server, token


def clean_reason(text: str) -> str:
    """Plain words for a ring: markdown and links removed, spaces collapsed, at most 140 characters."""
    plain = _MD_LINK.sub(r"\1", str(text or ""))
    plain = _URL.sub("", plain)
    plain = _MD_MARKS.sub("", plain)
    plain = " ".join(plain.split())
    return plain[:RING_REASON_MAX].rstrip()


def _client() -> httpx.AsyncClient:
    return httpx.AsyncClient(timeout=HTTP_TIMEOUT_S, follow_redirects=False, headers={"User-Agent": USER_AGENT})


def _run(call: Callable[[httpx.AsyncClient], Awaitable[Any]]) -> Any:
    """Runs `call` on a fresh event loop; on a helper thread when this thread already runs one."""

    async def main() -> Any:
        async with _client() as http:
            return await call(http)

    try:
        asyncio.get_running_loop()
    except RuntimeError:
        return asyncio.run(main())
    box: dict[str, Any] = {}

    def worker() -> None:
        try:
            box["value"] = asyncio.run(main())
        except BaseException as error:  # handed back to the caller below
            box["error"] = error

    thread = threading.Thread(target=worker, name="twring-outbound-call", daemon=True)
    thread.start()
    thread.join(HTTP_TIMEOUT_S * 3)
    if "error" in box:
        raise box["error"]
    if "value" not in box:
        raise LinkError("Twring did not answer in time.")
    return box["value"]


def _why(error: Exception) -> str:
    return getattr(error, "code", None) or "failed"


def send_message(text: str) -> dict[str, Any]:
    """Posts `text` to the owner's Hermes chat in Twring (a push, no ring). Never raises."""
    body = str(text or "").strip()
    if not body:
        return {"delivered": "none", "why": "empty"}
    found = settings()
    if found is None:
        return {"delivered": "none", "why": "not_linked"}
    server, token = found
    try:
        delivery = _run(lambda http: post_message(http, server, token, body))
    except Exception as error:
        logger.debug("Twring: message not delivered (%s)", _why(error))
        return {"delivered": "none", "why": _why(error)}
    return {"delivered": "chat", "push": delivery}


def ring_owner(reason: str, details: Optional[str] = None) -> dict[str, Any]:
    """Posts `details` (or `reason`) to the owner's Hermes chat, then rings with the clean reason.
    A refused ring still leaves the news in the chat. Never raises."""
    line = clean_reason(reason)
    if not line:
        return {"delivered": "none", "why": "empty"}
    found = settings()
    if found is None:
        return {"delivered": "none", "why": "not_linked"}
    server, token = found
    chat_text = str(details).strip() if details is not None and str(details).strip() else str(reason).strip()

    async def chat_then_ring(http: httpx.AsyncClient) -> Optional[str]:
        await post_message(http, server, token, chat_text)
        try:
            await post_ring(http, server, token, line)
        except LinkError as error:
            return _why(error)
        return None

    try:
        refused = _run(chat_then_ring)
    except Exception as error:
        logger.debug("Twring: ring not delivered (%s)", _why(error))
        return {"delivered": "none", "why": _why(error)}
    if refused is not None:
        return {"delivered": "chat", "ring": "refused", "why": refused}
    return {"delivered": "ring"}


def run_in_background(fn: Callable[[], Any], *, name: str = "twring-outbound") -> threading.Thread:
    """Runs `fn` on a daemon thread so a hook never blocks Hermes; errors are logged, never raised."""

    def guarded() -> None:
        try:
            fn()
        except Exception:
            logger.debug("Twring: background send failed", exc_info=True)

    thread = threading.Thread(target=guarded, name=name, daemon=True)
    thread.start()
    return thread
