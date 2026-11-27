"""Hermes hooks that reach the owner through Twring.

- An approval Hermes asks for at the computer (terminal, Telegram, Discord...) that nobody answers
  for 60 s rings the owner once: "Hermes is waiting for your OK in Telegram." The command is never
  in the ring (it shows on the lock screen). Approvals on a Twring call, or shown by Twring's
  approval transport, are skipped: those already reached the phone.
- Every approval's request_id is remembered with its session for 15 minutes, so the approval
  transport can tell whether it belongs to a live Twring call.
- A scheduled job (platform `cron`) that stops on a model error posts the error type to the owner's
  Twring chat, and rings unless scheduled-job rings are off. Once per job run.

Hooks run on Hermes's agent thread and must never block or raise: all network work runs on daemon
threads with short timeouts.
"""

from __future__ import annotations

import logging
import threading
import time
from collections import OrderedDict
from typing import Any, Callable, Optional

try:  # loaded by Hermes as a package
    from . import twring_outbound
except ImportError:  # loaded directly (tests)
    import twring_outbound  # type: ignore[no-redef]

logger = logging.getLogger(__name__)

#: Seconds an approval at the computer may wait before the owner's phone rings.
DESK_WAIT_S = 60.0
#: How long a request_id stays mapped to its session.
REQUEST_TTL_S = 15 * 60.0
#: Upper bound for every table here, so a busy Hermes cannot grow them without limit.
MAX_TRACKED = 256

_LABELS = {
    "telegram": "Telegram",
    "discord": "Discord",
    "slack": "Slack",
    "whatsapp": "WhatsApp",
    "signal": "Signal",
    "cli": "the terminal",
    "terminal": "the terminal",
}
_OFF = {"0", "false", "no", "off"}


def _thread_timer(delay: float, fn: Callable[[], None]) -> threading.Timer:
    timer = threading.Timer(delay, fn)
    timer.daemon = True
    timer.start()
    return timer


_start_timer: Callable[[float, Callable[[], None]], Any] = _thread_timer
_clock: Callable[[], float] = time.monotonic

_lock = threading.Lock()
_timers: "OrderedDict[str, Any]" = OrderedDict()  # approval key -> timer handle
_requests: "OrderedDict[str, tuple[str, float]]" = OrderedDict()  # request_id -> (session_key, at)
_reported_runs: "OrderedDict[str, None]" = OrderedDict()  # scheduled-job task ids already reported
_registered_for: set[int] = set()


def _reset_for_tests() -> None:
    with _lock:
        for handle in _timers.values():
            cancel = getattr(handle, "cancel", None)
            if callable(cancel):
                cancel()
        _timers.clear()
        _requests.clear()
        _reported_runs.clear()
        _registered_for.clear()


def _platform(session_key: str) -> str:
    """The platform word in a Hermes session key (`agent:main:telegram:dm:42` -> `telegram`)."""
    for part in str(session_key or "").lower().split(":"):
        if part in _LABELS or part == "twring":
            return part
    return ""


def _is_twring_session(session_key: str) -> bool:
    key = str(session_key or "")
    return key.startswith("twring:") or _platform(key) == "twring"


def label_for(session_key: str, surface: str) -> str:
    platform = _platform(session_key)
    if platform in _LABELS:
        return _LABELS[platform]
    if surface == "cli":
        return "the terminal"
    return "Hermes"


def waiting_line(session_key: str, surface: str) -> str:
    return f"Hermes is waiting for your OK in {label_for(session_key, surface)}."


def _approval_key(kwargs: dict[str, Any]) -> str:
    request_id = kwargs.get("request_id")
    if isinstance(request_id, str) and request_id:
        return request_id
    which = kwargs.get("pattern_key") or kwargs.get("command") or ""
    return f"{kwargs.get('session_key') or ''}\x00{which}"


def _prune_requests(now: float) -> None:
    while _requests:
        oldest_id, (_, at) = next(iter(_requests.items()))
        if now - at <= REQUEST_TTL_S and len(_requests) <= MAX_TRACKED:
            break
        _requests.pop(oldest_id, None)


def _remember(request_id: str, session_key: str) -> None:
    with _lock:
        now = _clock()
        _requests[request_id] = (session_key, now)
        _requests.move_to_end(request_id)
        _prune_requests(now)


def session_for_request(request_id: str) -> Optional[str]:
    """The Hermes session that raised approval `request_id`, while it is pending (at most 15 min)."""
    with _lock:
        _prune_requests(_clock())
        found = _requests.get(str(request_id or ""))
    return found[0] if found else None


def _desk_timer_fired(key: str, line: str) -> None:
    with _lock:
        if key not in _timers:
            return  # answered (or cancelled) meanwhile
        _timers.pop(key, None)
    twring_outbound.run_in_background(lambda: twring_outbound.ring_owner(line), name="twring-approval-ring")


def _on_pre_approval_request(**kwargs: Any) -> None:
    """Observer only: Hermes ignores the return value. Never raises, never blocks."""
    try:
        session_key = str(kwargs.get("session_key") or "")
        surface = str(kwargs.get("surface") or "")
        request_id = kwargs.get("request_id")
        if isinstance(request_id, str) and request_id:
            _remember(request_id, session_key)
        if surface.startswith("transport:") or _is_twring_session(session_key):
            return None
        if twring_outbound.settings() is None:
            return None
        key = _approval_key(kwargs)
        line = waiting_line(session_key, surface)
        with _lock:
            if key in _timers or len(_timers) >= MAX_TRACKED:
                return None
            _timers[key] = _start_timer(DESK_WAIT_S, lambda: _desk_timer_fired(key, line))
    except Exception:
        logger.debug("Twring: approval hook failed", exc_info=True)
    return None


def _on_post_approval_response(**kwargs: Any) -> None:
    try:
        key = _approval_key(kwargs)
        with _lock:
            handle = _timers.pop(key, None)
            request_id = kwargs.get("request_id")
            if isinstance(request_id, str):
                _requests.pop(request_id, None)
        cancel = getattr(handle, "cancel", None)
        if callable(cancel):
            cancel()
    except Exception:
        logger.debug("Twring: approval hook failed", exc_info=True)
    return None


def _on_api_request_error(**kwargs: Any) -> None:
    """A scheduled job that stopped on a model error tells the owner. Interactive sessions are left
    alone: the owner sees the error where they are."""
    try:
        if str(kwargs.get("platform") or "") != "cron":
            return None
        retry_count, max_retries = kwargs.get("retry_count"), kwargs.get("max_retries")
        used_up = isinstance(retry_count, int) and isinstance(max_retries, int) and retry_count >= max_retries
        if kwargs.get("retryable") is True and not used_up:
            return None
        if twring_outbound.settings() is None:
            return None
        run = str(kwargs.get("task_id") or kwargs.get("session_id") or "")
        with _lock:
            if run in _reported_runs:
                return None
            _reported_runs[run] = None
            while len(_reported_runs) > MAX_TRACKED:
                _reported_runs.popitem(last=False)
        error = kwargs.get("error")
        kind = error.get("type") if isinstance(error, dict) else None
        line = f"A scheduled Hermes job stopped: {kind if isinstance(kind, str) and kind else 'an error'}."
        ring = twring_outbound.setting("TWRING_RING_ON_DELIVERY").lower() not in _OFF
        if ring:
            twring_outbound.run_in_background(lambda: twring_outbound.ring_owner(line), name="twring-cron-report")
        else:
            twring_outbound.run_in_background(lambda: twring_outbound.send_message(line), name="twring-cron-report")
    except Exception:
        logger.debug("Twring: scheduled-job hook failed", exc_info=True)
    return None


def register_hooks(ctx: Any) -> None:
    """Registers the approval and scheduled-job hooks, once per Hermes plugin manager (Hermes calls
    both `tools.register_tools` and the plugin's `register` in a gateway process)."""
    owner = id(getattr(ctx, "_manager", None) or ctx)
    with _lock:
        if owner in _registered_for:
            return
        _registered_for.add(owner)
    ctx.register_hook("pre_approval_request", _on_pre_approval_request)
    ctx.register_hook("post_approval_response", _on_post_approval_response)
    ctx.register_hook("api_request_error", _on_api_request_error)
