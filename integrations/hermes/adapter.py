"""Twring platform adapter for Hermes Agent: call your Hermes from your phone, and let it call you.

Twring (https://twring.com) is a phone app for AI agents. This adapter links the Hermes gateway to
the owner's Twring account as one computer offering one agent, "Hermes", over a single outbound
WebSocket (`cord-relay/1`). Twring does the speech: a live call reaches Hermes as text turns and
Hermes's streamed reply is spoken back; typed chat messages in the Twring app reach the same Hermes
conversation. Dangerous-command approvals become Twring's spoken and tappable approvals, and
scheduled-job results ring the owner's phone.

Setup: `hermes twring link` (or `hermes gateway setup`, then Twring), then `hermes gateway`.
Env: TWRING_TOKEN (the computer token `link` saves), TWRING_SERVER (default https://api.twring.com),
TWRING_ALLOWED_USERS (`owner`, written by `link`), TWRING_HOME_CHANNEL (cron target, `owner`),
TWRING_RING_ON_DELIVERY (ring for scheduled-job results, default true).
"""

from __future__ import annotations

import asyncio
import contextlib
import datetime
import hashlib
import json
import logging
from typing import Any, Optional

from gateway.config import Platform
from gateway.platforms._shared import get_scoped_secret, seed_extra_from_env
from gateway.platforms.base import BasePlatformAdapter, ExecApprovalPrompt, SendResult
from gateway.platforms.event import MessageEvent, MessageType, ProcessingOutcome
from gateway.platforms.helpers import MessageDeduplicator, platform_http_client

try:  # loaded by Hermes as a package
    from .twring_core import (
        AGENT_ID,
        CHAT_ID,
        DEFAULT_SERVER,
        MAX_FRAME_BYTES,
        OWNER_ID,
        TurnState,
        approval_choice,
        approval_required,
        backoff_delays,
        channel_message,
        connector_hello,
        parse_frame,
        session_ready,
    )
    from .twring_link import LinkError, check_server, post_message, post_ring
except ImportError:  # loaded directly (tests)
    from twring_core import (  # type: ignore[no-redef]
        AGENT_ID,
        CHAT_ID,
        DEFAULT_SERVER,
        MAX_FRAME_BYTES,
        OWNER_ID,
        TurnState,
        approval_choice,
        approval_required,
        backoff_delays,
        channel_message,
        connector_hello,
        parse_frame,
        session_ready,
    )
    from twring_link import LinkError, check_server, post_message, post_ring  # type: ignore[no-redef]

logger = logging.getLogger(__name__)

PLUGIN_VERSION = "0.1.0"
TEXT_TURN_TAG = "[Twring message]"
#: Twring ends a quiet turn after 30 s; a working Hermes says so at least this often.
ACTIVITY_EVERY_S = 10.0
#: How long `connect()` waits for Twring to accept the link before reporting a failure.
READY_TIMEOUT_S = 20.0

#: WebSocket close codes the Twring server uses on the relay socket (packages/contracts RELAY_CLOSE).
CLOSE_HELLO_REFUSED = 4400
CLOSE_REVOKED = 4403
CLOSE_REPLACED = 4409

_TRUTHY = {"1", "true", "yes", "on"}

CALL_HINT = (
    "You are connected to your owner through Twring, by live phone calls and by typed messages, "
    "in one conversation. On a call everything you write is spoken aloud: answer in short, plain "
    "spoken sentences, with no markdown, lists, tables or code. Stay on the line until your owner "
    "says goodbye or asks you to hang up; only then end that reply with ⟪hangup⟫. Finishing an "
    "answer or giving your news does not end the call. A turn that starts with "
    f"{TEXT_TURN_TAG} was typed in the Twring chat: answer in normal written text; markdown, lists "
    "and code are fine there, and the call rules do not apply. If a call ends while you are still "
    "working on something your owner asked for, keep going and finish it: your final reply reaches "
    "their Twring chat, and Twring may ring them with it."
)


def _setting(name: str, extra: dict, key: str, default: str = "") -> str:
    """Env (the active profile's secret scope) wins over config.yaml ``extra``."""
    value = get_scoped_secret(name)
    if value is None or str(value).strip() == "":
        value = extra.get(key, default)
    return str(value or "").strip()


def _socket_url(server: str) -> str:
    if server.startswith("https://"):
        return "wss://" + server[len("https://") :] + "/v1/connectors/socket"
    return "ws://" + server[len("http://") :] + "/v1/connectors/socket"


def _turn_key(channel: str, turn_id: str) -> str:
    """Twring numbers turns per call (turn_1, turn_2...), so a turn is unique only within its channel;
    Hermes refuses a repeated message id, so the key names both."""
    return f"{channel}/{turn_id}"


def _first_sentence(text: str, limit: int = 140) -> str:
    clean = " ".join(text.replace("⟪hangup⟫", " ").split())
    for index, char in enumerate(clean):
        if char in ".!?" and (index + 1 == len(clean) or clean[index + 1] == " "):
            clean = clean[: index + 1]
            break
    return clean if len(clean) <= limit else clean[: limit - 1].rstrip() + "…"


class TwringAdapter(BasePlatformAdapter):
    """Twring as a Hermes messaging platform: one owner, one direct chat, calls and typed turns."""

    # Twring's approval card holds a short preview; longer commands get Hermes's Deny-only card.
    _EA_CMD_BUDGET = 160

    def __init__(self, config, **kwargs):
        super().__init__(config=config, platform=Platform("twring"))
        extra = getattr(config, "extra", {}) or {}
        self._token = _setting("TWRING_TOKEN", extra, "token")
        raw_server = _setting("TWRING_SERVER", extra, "server", DEFAULT_SERVER) or DEFAULT_SERVER
        try:
            self._server: Optional[str] = check_server(raw_server)
        except LinkError:
            self._server = None
        self._ring_on_delivery = _setting("TWRING_RING_ON_DELIVERY", extra, "ring_on_delivery", "true").lower() in _TRUTHY
        self._ws: Any = None
        self._send_lock = asyncio.Lock()
        self._task: Optional[asyncio.Task] = None
        self._ready = asyncio.Event()
        self._stopping = False
        self._fatal: Optional[tuple[str, str]] = None
        self._channels: dict[str, str] = {}  # channel -> agent session id (once hello'd)
        self._turns: dict[str, TurnState] = {}  # turn key -> turn still owed an answer
        self._current: Optional[TurnState] = None  # the turn Hermes is answering now
        self._last_activity: dict[str, float] = {}
        self._approvals: dict[str, tuple[str, str]] = {}  # approval id -> (session key, turn key)
        self._orphan_text: dict[str, str] = {}  # turn key -> reply text after its call hung up
        self._dedup = MessageDeduplicator(ttl_seconds=600)
        self._http: Any = None

    @property
    def name(self) -> str:
        return "Twring"

    # ── Connection ────────────────────────────────────────────────────────────────────────────

    def _fail(self, code: str, message: str, *, retryable: bool) -> bool:
        self._set_fatal_error(code, message, retryable=retryable)
        return False

    async def connect(self, *, is_reconnect: bool = False) -> bool:
        if not self._token:
            return self._fail("config_missing", "Twring is not linked: run `hermes twring link`.", retryable=False)
        if self._server is None:
            return self._fail("config_invalid", "TWRING_SERVER must be an https:// address.", retryable=False)
        fingerprint = hashlib.sha256(self._token.encode()).hexdigest()[:16]
        if not self._acquire_platform_lock("twring", fingerprint, "Twring link"):
            return False
        self._stopping = False
        self._fatal = None
        self._ready.clear()
        self._http = platform_http_client(headers={"User-Agent": f"twring-hermes/{PLUGIN_VERSION}"}, follow_redirects=False)
        self._task = asyncio.create_task(self._run())
        try:
            await asyncio.wait_for(self._ready.wait(), timeout=READY_TIMEOUT_S)
        except asyncio.TimeoutError:
            pass
        if self._fatal is not None:
            code, message = self._fatal
            await self.disconnect()
            return self._fail(code, message, retryable=False)
        if not self._ready.is_set():
            await self.disconnect()
            return self._fail("connect_timeout", "Could not reach the Twring server.", retryable=True)
        self._mark_connected()
        logger.info("Twring: linked to %s", self._server)
        return True

    async def disconnect(self) -> None:
        self._stopping = True
        with contextlib.suppress(Exception):
            self._release_platform_lock()
        self._mark_disconnected()
        if self._ws is not None:
            with contextlib.suppress(Exception):
                await self._ws.close(code=1000)
        if self._task is not None:
            self._task.cancel()
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await self._task
        self._task = None
        if self._http is not None:
            with contextlib.suppress(Exception):
                await self._http.aclose()
            self._http = None

    async def _run(self) -> None:
        """Keeps the link up: connect, hello, read; on a drop, wait and connect again."""
        from websockets.asyncio.client import connect as ws_connect
        from websockets.exceptions import ConnectionClosed, InvalidStatus

        delays = backoff_delays()
        while not self._stopping:
            close_code: Optional[int] = None
            try:
                async with ws_connect(
                    _socket_url(self._server or DEFAULT_SERVER),
                    additional_headers={"Authorization": f"Bearer {self._token}"},
                    user_agent_header=f"twring-hermes/{PLUGIN_VERSION}",
                    max_size=MAX_FRAME_BYTES,
                    ping_interval=20,
                    ping_timeout=20,
                    open_timeout=15,
                ) as ws:
                    self._ws = ws
                    await self._send({**connector_hello(PLUGIN_VERSION)})
                    async for raw in ws:
                        frame = parse_frame(raw)
                        if frame is None:
                            continue
                        if frame["type"] == "connector.ready":
                            delays = backoff_delays()
                            self._ready.set()
                            self._mark_connected()
                            continue
                        await self._on_frame(frame)
            except InvalidStatus as error:
                status = getattr(getattr(error, "response", None), "status_code", 0)
                if status in (401, 403):
                    self._fatal = ("auth_failed", "Twring refused this link. Run `hermes twring link` again.")
            except ConnectionClosed as error:
                close_code = getattr(getattr(error, "rcvd", None), "code", None)
            except asyncio.CancelledError:
                raise
            except Exception:
                logger.debug("Twring: link dropped", exc_info=True)
            finally:
                self._ws = None
            if close_code == CLOSE_REVOKED:
                self._fatal = ("revoked", "This computer was removed in the Twring app. Run `hermes twring link` again.")
            elif close_code == CLOSE_REPLACED:
                self._fatal = ("replaced", "Another program took over this Twring link (is twring-connect running too?).")
            elif close_code == CLOSE_HELLO_REFUSED:
                self._fatal = ("protocol", "The Twring server refused this plugin version.")
            self._drop_open_turns()
            if self._fatal is not None:
                code, message = self._fatal
                logger.warning("Twring: %s", message)
                self._set_fatal_error(code, message, retryable=False)
                self._mark_disconnected()
                self._ready.set()
                return
            self._mark_disconnected()
            if self._stopping:
                return
            await asyncio.sleep(next(delays))

    async def _send(self, frame: dict[str, Any]) -> bool:
        ws = self._ws
        if ws is None:
            return False
        text = json.dumps(frame, ensure_ascii=False, separators=(",", ":"))
        if len(text.encode("utf-8")) > MAX_FRAME_BYTES:
            logger.warning("Twring: dropped an oversized frame")
            return False
        async with self._send_lock:
            try:
                await ws.send(text)
                return True
            except Exception:
                logger.debug("Twring: send failed", exc_info=True)
                return False

    async def _emit(self, turn: TurnState, events: list[dict[str, Any]]) -> None:
        if turn.channel not in self._channels:
            logger.info("Twring: channel %s is closed; %d event(s) for turn %s not sent", turn.channel, len(events), turn.turn_id)
            return
        for event in events:
            await self._send(channel_message(turn.channel, event))

    def _drop_open_turns(self) -> None:
        """A dropped link fails Twring's running turn there; Hermes's answer goes to the chat instead."""
        for key, turn in list(self._turns.items()):
            if not turn.finished:
                self._orphan_text.setdefault(key, "")
        self._channels.clear()

    # ── Twring → Hermes ───────────────────────────────────────────────────────────────────────

    async def _on_frame(self, frame: dict[str, Any]) -> None:
        kind = frame["type"]
        channel = frame.get("channel")
        if not isinstance(channel, str):
            return
        if kind == "channel.open":
            if frame.get("agent") != AGENT_ID:
                await self._send(channel_message(channel, {"type": "session.error", "code": "agent_error"}))
                await self._send({"type": "channel.close", "channel": channel})
                return
            self._channels[channel] = ""
            return
        if kind == "channel.close":
            self._channels.pop(channel, None)
            for key, turn in self._turns.items():
                if turn.channel == channel and not turn.finished:
                    # Hung up mid-answer: the rest of the reply goes to the chat (and may ring).
                    self._orphan_text.setdefault(key, "")
            return
        if kind != "channel.message" or channel not in self._channels:
            return
        message = frame.get("message")
        if not isinstance(message, dict):
            return
        await self._on_agent_message(channel, message)

    async def _on_agent_message(self, channel: str, message: dict[str, Any]) -> None:
        kind = message.get("type")
        if kind == "session.hello":
            self._channels[channel] = str(message.get("session_id") or "")
            await self._send(channel_message(channel, session_ready()))
        elif kind == "ping":
            await self._send(channel_message(channel, {"type": "pong", "id": message.get("id")}))
        elif kind == "user.turn":
            await self._on_user_turn(channel, message)
        elif kind == "turn.cancel":
            turn = self._turns.get(_turn_key(channel, str(message.get("turn_id"))))
            if turn is not None and not turn.finished:
                await self._emit(turn, turn.finish("cancelled"))
        elif kind == "approval.decision":
            await self._on_approval_decision(message)

    async def _on_user_turn(self, channel: str, message: dict[str, Any]) -> None:
        turn_id = message.get("turn_id")
        text = message.get("text")
        if not isinstance(turn_id, str) or not isinstance(text, str):
            return
        key = _turn_key(channel, turn_id)
        if self._dedup.is_duplicate(key):
            return
        surface = "text" if message.get("surface") == "text" else "call"
        turn = TurnState(channel, turn_id, surface)
        self._turns[key] = turn
        logger.info("Twring: %s turn %s on %s", surface, turn_id, channel)
        if not self._message_handler:
            await self._emit(turn, turn.finish("failed"))
            return
        source = self.build_source(chat_id=CHAT_ID, chat_name="Twring", chat_type="dm", user_id=OWNER_ID, user_name="Owner")
        body = f"{TEXT_TURN_TAG}\n{text}" if surface == "text" else text
        await self.handle_message(
            MessageEvent(
                text=body,
                message_type=MessageType.TEXT,
                source=source,
                message_id=key,
                timestamp=datetime.datetime.now(),
            )
        )

    async def _on_approval_decision(self, message: dict[str, Any]) -> None:
        approval_id = str(message.get("approval_id") or "")
        entry = self._approvals.pop(approval_id, None)
        if entry is None:
            return
        session_key, turn_key = entry
        decision = "approve" if message.get("decision") == "approve" else "deny"
        from tools.approval import resolve_gateway_approval_card

        resolved = resolve_gateway_approval_card(
            session_key,
            approval_choice(decision),
            approval_id,
            actor_id=OWNER_ID,
            extra=getattr(self.config, "extra", None),
        )
        turn = self._turns.get(turn_key)
        if turn is not None and not turn.finished:
            by = "owner" if resolved else "timeout"
            final = decision if resolved else "deny"
            await self._emit(turn, [turn.event("approval.resolved", approval_id=approval_id, decision=final, by=by)])

    # ── Hermes → Twring ───────────────────────────────────────────────────────────────────────

    def _turn_for(self, event: Optional[MessageEvent] = None) -> Optional[TurnState]:
        if event is not None and event.message_id in self._turns:
            return self._turns[event.message_id]
        if self._current is not None and not self._current.finished:
            return self._current
        open_turns = [t for t in self._turns.values() if not t.finished]
        return open_turns[-1] if open_turns else None

    async def on_processing_start(self, event: MessageEvent) -> None:
        turn = self._turns.get(event.message_id or "")
        logger.info("Twring: Hermes started on %s (known turn: %s)", event.message_id, turn is not None)
        if turn is not None:
            self._current = turn

    async def on_processing_complete(self, event: MessageEvent, outcome: ProcessingOutcome) -> None:
        turn = self._turns.pop(event.message_id or "", None)
        logger.info("Twring: Hermes finished %s (%s, known turn: %s)", event.message_id, outcome, turn is not None)
        if turn is None:
            return
        if self._current is turn:
            self._current = None
        key = event.message_id or ""
        self._last_activity.pop(key, None)
        status = {ProcessingOutcome.SUCCESS: "completed", ProcessingOutcome.CANCELLED: "cancelled"}.get(outcome, "failed")
        if key in self._orphan_text:
            text = self._orphan_text.pop(key).strip()
            if text and status == "completed":
                await self._post_result(turn, text)
            return
        await self._emit(turn, turn.finish(status))

    async def _deliver_text(self, turn: TurnState, delta: str) -> None:
        if not delta:
            return
        key = _turn_key(turn.channel, turn.turn_id)
        if key in self._orphan_text or turn.channel not in self._channels:
            self._orphan_text[key] = self._orphan_text.get(key, "") + delta
            return
        await self._emit(turn, turn.text(delta))

    async def _post_result(self, turn: TurnState, text: str) -> None:
        """A reply finished after its call hung up: Twring saves it in the chat and may ring with it."""
        if self._http is None or self._server is None:
            return
        try:
            await post_message(
                self._http,
                self._server,
                self._token,
                text,
                origin="call_turn" if turn.surface == "call" else "text_turn",
                turn_id=turn.turn_id,
            )
        except LinkError as error:
            logger.warning("Twring: could not save a reply in the chat: %s", error)

    def supports_draft_streaming(self, chat_type=None, metadata=None, chat_id=None) -> bool:
        return True

    async def send_draft(self, chat_id: str, draft_id: int, content: str, metadata=None) -> SendResult:
        turn = self._turn_for()
        if turn is None or turn.finished:
            return SendResult(success=False, error="No Twring turn is waiting for this draft")
        await self._deliver_text(turn, turn.reply.draft(draft_id, content))
        return SendResult(success=True)

    async def send(self, chat_id: str, content: str, reply_to: Optional[str] = None, metadata=None) -> SendResult:
        turn = self._turn_for()
        logger.info("Twring: reply of %d chars for %s", len(content), turn.turn_id if turn else "no open turn")
        if turn is not None and not turn.finished:
            await self._deliver_text(turn, turn.reply.final(content))
            return SendResult(success=True, message_id=f"{turn.turn_id}-m")
        return await self._deliver_proactive(content, metadata)

    async def _deliver_proactive(self, content: str, metadata: Optional[dict] = None) -> SendResult:
        """Text with no call or chat turn waiting: post it to the Twring chat. Only a scheduled job's
        result (Hermes marks it with `job_id`, and `notify` not off) also rings the phone with its
        first sentence; gateway notices such as a restart arrive as a quiet chat message."""
        if self._http is None or self._server is None:
            return SendResult(success=False, error="Twring is not connected")
        meta = metadata or {}
        ring = self._ring_on_delivery and bool(meta.get("job_id")) and meta.get("notify", True) is not False
        result = await deliver(self._http, self._server, self._token, content, ring=ring)
        if not result.get("success"):
            return SendResult(success=False, error=str(result.get("error", "Twring refused the message")))
        return SendResult(success=True, message_id=str(result.get("message_id", "")))

    async def edit_message(self, chat_id: str, message_id: str, content: str, *args, **kwargs) -> SendResult:
        return SendResult(success=False, error="Twring does not edit sent messages")

    async def send_typing(self, chat_id: str, metadata=None) -> None:
        """Hermes's typing heartbeat keeps Twring's turn alive and the phone showing 'working'."""
        turn = self._turn_for()
        key = _turn_key(turn.channel, turn.turn_id) if turn is not None else ""
        if turn is None or turn.finished or key in self._orphan_text:
            return
        now = asyncio.get_running_loop().time()
        if now - self._last_activity.get(key, 0.0) < ACTIVITY_EVERY_S:
            return
        self._last_activity[key] = now
        await self._emit(turn, [turn.event("activity", label="Working…", kind="working")])

    def format_tool_event(self, event: Any, *, mode: str = "all", preview_max_len: int = 40) -> Optional[str]:
        """Tool progress is not spoken on a call; the typing heartbeat shows Hermes is working."""
        return None

    async def _send_exec_approval_prompt(self, prompt: ExecApprovalPrompt) -> SendResult:
        turn = self._turn_for()
        if turn is None or turn.finished or _turn_key(turn.channel, turn.turn_id) in self._orphan_text:
            return SendResult(success=False, error="No Twring call or chat is open for this approval")
        if "once" not in prompt.choices or not prompt.request_id:
            # Hermes could not show the whole command on the card: nobody approves what they cannot read.
            await self._deliver_text(
                turn,
                "\n\nHermes wants to run a command that is too long to show here, so it can only be "
                "declined from the phone. Approve it at the computer if you want it to run.",
            )
            return SendResult(success=True)
        self._approvals[prompt.request_id] = (prompt.session_key, _turn_key(turn.channel, turn.turn_id))
        await self._emit(turn, [approval_required(turn, prompt.request_id, prompt.command, prompt.description)])
        return SendResult(success=True, message_id=prompt.request_id)

    async def get_chat_info(self, chat_id: str) -> dict[str, Any]:
        return {"name": "Twring", "type": "dm", "chat_id": chat_id}


async def deliver(http: Any, server: str, token: str, content: str, *, ring: bool) -> dict[str, Any]:
    """Posts `content` to the owner's Twring chat with Hermes, then rings with its first sentence."""
    text = content.strip()
    if not text:
        return {"success": False, "error": "empty message"}
    try:
        await post_message(http, server, token, text, origin="agent")
    except LinkError as error:
        return {"success": False, "error": str(error)}
    if ring:
        reason = _first_sentence(text)
        if reason:
            try:
                await post_ring(http, server, token, reason)
            except LinkError as error:
                logger.info("Twring: saved in the chat, but could not ring: %s", error)
    return {"success": True, "message_id": "twring"}


# ── Registration ──────────────────────────────────────────────────────────────────────────────


def check_requirements() -> bool:
    try:
        import httpx  # noqa: F401
        import websockets  # noqa: F401
    except ImportError:
        return False
    return bool(get_scoped_secret("TWRING_TOKEN", ""))


def validate_config(config) -> bool:
    extra = getattr(config, "extra", {}) or {}
    return bool(_setting("TWRING_TOKEN", extra, "token"))


def is_connected(config) -> bool:
    return validate_config(config)


def _env_enablement() -> dict | None:
    if not str(get_scoped_secret("TWRING_TOKEN", "") or "").strip():
        return None
    seed = seed_extra_from_env(
        (("TWRING_SERVER", "server", None), ("TWRING_RING_ON_DELIVERY", "ring_on_delivery", None)),
        home_env="TWRING_HOME_CHANNEL",
        home_default=CHAT_ID,
    )
    return seed


async def _standalone_send(pconfig, chat_id: str, message: str, *, thread_id: Optional[str] = None,
                           media_files: Optional[list[str]] = None, force_document: bool = False) -> dict[str, Any]:
    """Scheduled-job delivery when the gateway is not running: post to the chat, then ring."""
    extra = getattr(pconfig, "extra", {}) or {}
    token = _setting("TWRING_TOKEN", extra, "token")
    if not token:
        return {"success": False, "error": "Twring is not linked: run `hermes twring link`."}
    try:
        server = check_server(_setting("TWRING_SERVER", extra, "server", DEFAULT_SERVER) or DEFAULT_SERVER)
    except LinkError as error:
        return {"success": False, "error": str(error)}
    ring = _setting("TWRING_RING_ON_DELIVERY", extra, "ring_on_delivery", "true").lower() in _TRUTHY
    async with platform_http_client(headers={"User-Agent": f"twring-hermes/{PLUGIN_VERSION}"}, follow_redirects=False) as http:
        return await deliver(http, server, token, message, ring=ring)


def register(ctx) -> None:
    """Plugin entry point: Twring as a messaging platform, plus `hermes twring` for linking."""
    try:
        from .cli import interactive_setup, register_cli
    except ImportError:  # loaded directly (tests)
        from cli import interactive_setup, register_cli  # type: ignore[no-redef]

    ctx.register_platform(
        name="twring",
        label="Twring",
        dashboard_description="Call Hermes from your phone and let it call you back, through the Twring app.",
        docs_url="https://github.com/saasagelabs/twring/tree/main/integrations/hermes",
        adapter_factory=TwringAdapter,
        check_fn=check_requirements,
        validate_config=validate_config,
        is_connected=is_connected,
        required_env=["TWRING_TOKEN"],
        install_hint="No extra packages needed (httpx and websockets ship with Hermes)",
        setup_fn=interactive_setup,
        env_enablement_fn=_env_enablement,
        cron_deliver_env_var="TWRING_HOME_CHANNEL",
        standalone_sender_fn=_standalone_send,
        allowed_users_env="TWRING_ALLOWED_USERS",
        allow_all_env="TWRING_ALLOW_ALL_USERS",
        max_message_length=0,
        # A phone call: no tool-progress notes, interim chatter or long-run notices are spoken or
        # posted (they arrived as the "answer" in the first live test); answers still stream.
        display_tier="low",
        display_overrides={"streaming": True},
        emoji="📞",
        pii_safe=True,
        platform_hint=CALL_HINT,
    )
    register_cli(ctx)
