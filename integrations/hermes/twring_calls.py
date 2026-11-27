"""Asking the owner on a live Twring call, from any thread in this Hermes process.

The phone-approval transport runs on Hermes's approval worker thread; the Twring adapter (gateway
process only) owns the call. The adapter registers an asker here when it connects. An asker returns
'approve' or 'deny' once the owner answered on the call (silence is 'deny'), or None when it has no
live call for that session, so the transport goes on to the phone card instead.
"""

from __future__ import annotations

import logging
import threading
from typing import Callable, Optional

logger = logging.getLogger(__name__)

Asker = Callable[[str, str, str, str, float], Optional[str]]

_lock = threading.Lock()
_askers: list[Asker] = []


def register_asker(fn: Asker) -> None:
    with _lock:
        if fn not in _askers:
            _askers.append(fn)


def unregister_asker(fn: Asker) -> None:
    with _lock:
        if fn in _askers:
            _askers.remove(fn)


def ask_in_call(session_key: str, request_id: str, command: str, description: str, timeout_s: float) -> Optional[str]:
    """'approve' or 'deny' from a live Twring call for `session_key`; None when there is none."""
    with _lock:
        askers = list(_askers)
    for asker in askers:
        try:
            answer = asker(session_key, request_id, command, description, timeout_s)
        except Exception:
            logger.debug("Twring: asking on the call failed", exc_info=True)
            continue
        if answer in ("approve", "deny"):
            return answer
    return None
