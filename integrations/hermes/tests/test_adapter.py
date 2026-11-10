"""The adapter inside real Hermes, against a fake Twring server on a local WebSocket.

Needs Hermes installed (run with Hermes's own Python); skipped elsewhere.
"""

import asyncio
import json

import pytest

pytest.importorskip("gateway.platforms.base")

from gateway.config import PlatformConfig  # noqa: E402
from gateway.platforms.base import ExecApprovalPrompt  # noqa: E402
from gateway.platforms.event import ProcessingOutcome  # noqa: E402
from websockets.asyncio.server import serve  # noqa: E402

import adapter as twring  # noqa: E402

TOKEN = "cct_" + "e" * 43


@pytest.fixture(autouse=True)
def twring_platform_registered(monkeypatch):
    """Hermes accepts `Platform("twring")` once the plugin has registered it; registration itself
    is covered by `hermes plugins validate`, so the adapter tests only need the name known."""
    from gateway.platform_registry import platform_registry

    real = platform_registry.is_registered
    monkeypatch.setattr(platform_registry, "is_registered", lambda name: name == "twring" or real(name))


class FakeTwring:
    """Plays the Twring server's side of `cord-relay/1`."""

    def __init__(self):
        self.received: list[dict] = []
        self.auth: list[str] = []
        self.socket = None
        self.connected = asyncio.Event()
        self.close_with: int | None = None

    async def handler(self, ws):
        self.auth.append(ws.request.headers.get("Authorization"))
        hello = json.loads(await ws.recv())
        self.received.append(hello)
        if self.close_with is not None:
            await ws.close(code=self.close_with)
            return
        await ws.send(json.dumps({"type": "connector.ready", "protocol": "cord-relay/1", "connector_id": "con_1", "name": "vps"}))
        self.socket = ws
        self.connected.set()
        async for raw in ws:
            self.received.append(json.loads(raw))

    async def send(self, frame):
        await self.socket.send(json.dumps(frame))

    async def agent(self, frame):
        await self.send({"type": "channel.message", "channel": "ch_1", "message": frame})

    def agent_frames(self):
        return [f["message"] for f in self.received if f.get("type") == "channel.message"]

    async def wait_for(self, predicate, timeout=3.0):
        async def poll():
            while not any(predicate(m) for m in self.agent_frames()):
                await asyncio.sleep(0.02)

        await asyncio.wait_for(poll(), timeout)


@pytest.fixture
async def linked(monkeypatch):
    fake = FakeTwring()
    async with serve(fake.handler, "127.0.0.1", 0) as server:
        port = server.sockets[0].getsockname()[1]
        monkeypatch.setenv("TWRING_TOKEN", TOKEN)
        monkeypatch.setenv("TWRING_SERVER", f"http://127.0.0.1:{port}")
        adapter = twring.TwringAdapter(PlatformConfig(enabled=True, extra={}))
        events = []

        async def capture(event):
            events.append(event)

        monkeypatch.setattr(adapter, "handle_message", capture)
        monkeypatch.setattr(adapter, "_message_handler", capture)  # the gateway attaches one in real runs
        monkeypatch.setattr(adapter, "_acquire_platform_lock", lambda *a, **k: True)
        monkeypatch.setattr(adapter, "_release_platform_lock", lambda *a, **k: None)
        assert await adapter.connect()
        await fake.connected.wait()
        await fake.send({"type": "channel.open", "channel": "ch_1", "agent": "hermes"})
        await fake.agent({"type": "session.hello", "protocol": "cord-agent/1", "session_id": "s1", "call_id": "c1", "capabilities_requested": []})
        await fake.wait_for(lambda m: m["type"] == "session.ready")
        yield adapter, fake, events
        await adapter.disconnect()


async def turn(fake, events, text="Hello", surface=None, turn_id="t1"):
    frame = {"type": "user.turn", "session_id": "s1", "turn_id": turn_id, "text": text, "started_at": "x", "committed_at": "x"}
    if surface:
        frame["surface"] = surface
    await fake.agent(frame)
    for _ in range(100):
        if any(e.message_id == turn_id for e in events):
            return next(e for e in events if e.message_id == turn_id)
        await asyncio.sleep(0.02)
    raise AssertionError("turn never reached Hermes")


async def test_link_says_hello_with_the_token_in_a_header(linked):
    adapter, fake, _ = linked
    assert fake.auth == [f"Bearer {TOKEN}"]
    assert fake.received[0]["type"] == "connector.hello"
    assert fake.received[0]["agents"][0]["id"] == "hermes"
    assert adapter.is_connected


async def test_a_spoken_turn_streams_hermes_reply_and_ends_the_turn(linked):
    adapter, fake, events = linked
    event = await turn(fake, events, "How's the build?")
    assert event.text == "How's the build?"
    await adapter.on_processing_start(event)
    await adapter.send_draft("owner", 1, "It passed")
    await adapter.send_draft("owner", 1, "It passed, all green.")
    await adapter.send("owner", "It passed, all green.")
    await adapter.on_processing_complete(event, ProcessingOutcome.SUCCESS)
    await fake.wait_for(lambda m: m["type"] == "done")
    frames = [m for m in fake.agent_frames() if m.get("turn_id") == "t1"]
    assert [m["type"] for m in frames] == ["text.start", "text.delta", "text.delta", "text.end", "done"]
    assert "".join(m.get("delta", "") for m in frames) == "It passed, all green."
    assert frames[-1]["status"] == "completed"


async def test_a_typed_turn_is_tagged_so_hermes_answers_in_writing(linked):
    _, fake, events = linked
    event = await turn(fake, events, "List my repos", surface="text", turn_id="t2")
    assert event.text == "[Twring message]\nList my repos"


async def test_a_ping_gets_a_pong(linked):
    _, fake, _ = linked
    await fake.agent({"type": "ping", "id": "p1"})
    await fake.wait_for(lambda m: m == {"type": "pong", "id": "p1"})


async def test_an_approval_goes_to_the_phone_and_the_answer_back_to_hermes(linked, monkeypatch):
    adapter, fake, events = linked
    resolved = []
    import tools.approval

    monkeypatch.setattr(
        tools.approval,
        "resolve_gateway_approval_card",
        lambda session_key, choice, request_id, **kw: resolved.append((session_key, choice, request_id)) or 1,
    )
    event = await turn(fake, events, "Clean the build folder", turn_id="t3")
    await adapter.on_processing_start(event)
    prompt = ExecApprovalPrompt(
        chat_id="owner", session_key="sk1", text="", actions=[("Allow", "once", "primary"), ("Deny", "deny", "danger")],
        command="rm -rf build", description="Deletes files", smart_denied=False, request_id="req1",
    )
    result = await adapter._send_exec_approval_prompt(prompt)
    assert result.success
    await fake.wait_for(lambda m: m["type"] == "approval.required")
    card = next(m for m in fake.agent_frames() if m["type"] == "approval.required")
    assert card["approval_id"] == "req1" and card["title"] == "Run: rm -rf build"
    await fake.agent({"type": "approval.decision", "turn_id": "t3", "approval_id": "req1", "decision": "approve"})
    await fake.wait_for(lambda m: m["type"] == "approval.resolved")
    assert resolved == [("sk1", "once", "req1")]


async def test_a_deny_only_card_is_never_shown_as_approvable(linked):
    adapter, fake, events = linked
    event = await turn(fake, events, "Run it", turn_id="t4")
    await adapter.on_processing_start(event)
    prompt = ExecApprovalPrompt(
        chat_id="owner", session_key="sk1", text="", actions=[("Deny", "deny", "danger")],
        command="x" * 900, description="", smart_denied=False, request_id="req2",
    )
    await adapter._send_exec_approval_prompt(prompt)
    await asyncio.sleep(0.2)
    assert not any(m["type"] == "approval.required" for m in fake.agent_frames())


async def test_a_reply_that_finishes_after_hang_up_goes_to_the_chat_as_the_calls_result(linked, monkeypatch):
    adapter, fake, events = linked
    posted = []

    async def fake_post(http, server, token, text, *, origin="agent", turn_id=None):
        posted.append((text, origin, turn_id))
        return "ring"

    monkeypatch.setattr(twring, "post_message", fake_post)
    event = await turn(fake, events, "Run the tests and tell me", turn_id="t5")
    await adapter.on_processing_start(event)
    await adapter.send_draft("owner", 1, "Running them now.")
    await fake.send({"type": "channel.close", "channel": "ch_1"})
    await asyncio.sleep(0.1)
    await adapter.send("owner", "Running them now. All 40 passed.")
    await adapter.on_processing_complete(event, ProcessingOutcome.SUCCESS)
    assert posted == [(" All 40 passed.".strip(), "call_turn", "t5")]


async def test_a_revoked_link_stops_without_retrying(monkeypatch):
    fake = FakeTwring()
    fake.close_with = 4403
    async with serve(fake.handler, "127.0.0.1", 0) as server:
        port = server.sockets[0].getsockname()[1]
        monkeypatch.setenv("TWRING_TOKEN", TOKEN)
        monkeypatch.setenv("TWRING_SERVER", f"http://127.0.0.1:{port}")
        adapter = twring.TwringAdapter(PlatformConfig(enabled=True, extra={}))
        monkeypatch.setattr(adapter, "_acquire_platform_lock", lambda *a, **k: True)
        monkeypatch.setattr(adapter, "_release_platform_lock", lambda *a, **k: None)
        assert not await adapter.connect()
        await asyncio.sleep(1.5)
        assert len(fake.auth) == 1
