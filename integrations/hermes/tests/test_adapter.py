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
        if any(e.message_id == f"ch_1/{turn_id}" for e in events):
            return next(e for e in events if e.message_id == f"ch_1/{turn_id}")
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


async def test_only_a_scheduled_job_rings_other_notices_are_quiet_chat_messages(linked, monkeypatch):
    adapter, _, _ = linked
    calls = []

    async def fake_deliver(http, server, token, content, *, ring):
        calls.append((content, ring))
        return {"success": True, "message_id": "m"}

    monkeypatch.setattr(twring, "deliver", fake_deliver)
    await adapter.send("owner", "Gateway shutting down.")
    await adapter.send("owner", "Backup finished: 3 files.", metadata={"job_id": "job_1", "notify": True})
    await adapter.send("owner", "Nightly report.", metadata={"job_id": "job_2", "notify": False})
    assert calls == [
        ("Gateway shutting down.", False),
        ("Backup finished: 3 files.", True),
        ("Nightly report.", False),
    ]


async def test_turn_numbers_restart_each_call_so_a_second_call_still_reaches_hermes(linked):
    """Twring numbers turns per call (turn_1, turn_2...); Hermes refuses a repeated message id."""
    _, fake, events = linked
    first = await turn(fake, events, "First call", turn_id="turn_1")
    await fake.send({"type": "channel.open", "channel": "ch_2", "agent": "hermes"})
    await fake.send({"type": "channel.message", "channel": "ch_2", "message": {
        "type": "session.hello", "protocol": "cord-agent/1", "session_id": "s2", "call_id": "c2", "capabilities_requested": []}})
    await fake.send({"type": "channel.message", "channel": "ch_2", "message": {
        "type": "user.turn", "session_id": "s2", "turn_id": "turn_1", "text": "Second call",
        "started_at": "x", "committed_at": "x"}})
    for _ in range(100):
        if len(events) == 2:
            break
        await asyncio.sleep(0.02)
    assert [e.text for e in events] == ["First call", "Second call"]
    assert events[0].message_id != events[1].message_id == events[1].message_id
    assert first.message_id != events[1].message_id


async def test_a_typed_chat_approval_falls_back_to_hermes_text_prompt(linked):
    """The Twring app shows approval prompts on calls only; in a typed chat Hermes's own
    `/approve` text prompt is the way to answer, so the card is declined there."""
    adapter, fake, events = linked
    event = await turn(fake, events, "Clean up", surface="text", turn_id="t7")
    await adapter.on_processing_start(event)
    prompt = ExecApprovalPrompt(
        chat_id="owner", session_key="sk1", text="", actions=[("Allow", "once", "primary"), ("Deny", "deny", "danger")],
        command="rm -rf build", description="", smart_denied=False, request_id="req7",
    )
    result = await adapter._send_exec_approval_prompt(prompt)
    assert not result.success
    await asyncio.sleep(0.1)
    assert not any(m["type"] == "approval.required" for m in fake.agent_frames())


async def test_a_typed_slash_command_reaches_hermes_untagged(linked):
    _, fake, events = linked
    event = await turn(fake, events, "/approve", surface="text", turn_id="t8")
    assert event.text == "/approve"


async def test_hanging_up_mid_answer_keeps_hermes_working_and_saves_the_rest(linked, monkeypatch):
    """Twring cancels the running turn as the call ends (`call_ended`); that is a hang-up, not the
    owner saying stop, so Hermes is not stopped and the rest of its answer goes to the chat."""
    adapter, fake, events = linked
    posted, stops = [], []

    async def fake_post(http, server, token, text, *, origin="agent", turn_id=None):
        posted.append((text, origin, turn_id))

    monkeypatch.setattr(twring, "post_message", fake_post)
    event = await turn(fake, events, "Back up the database and tell me", turn_id="t9")
    await adapter.on_processing_start(event)
    await adapter.send_draft("owner", 1, "Starting the backup.")
    await fake.agent({"type": "turn.cancel", "turn_id": "t9", "reason": "call_ended"})
    await fake.send({"type": "channel.close", "channel": "ch_1"})
    await asyncio.sleep(0.1)
    stops = [e for e in events if e.text == "/stop"]
    await adapter.send("owner", "Starting the backup. Done: 2 GB saved.")
    await adapter.on_processing_complete(event, ProcessingOutcome.SUCCESS)
    assert stops == []
    assert posted == [("Done: 2 GB saved.", "call_turn", "t9")]


async def test_a_replaced_turn_stops_hermes_and_its_stop_note_is_not_spoken(linked):
    """Twring cancels a running turn when the owner's next turn replaces it; Hermes's run stops
    too, as with Twring's own connector, and Hermes's "stopped" note is not read out."""
    adapter, fake, events = linked
    event = await turn(fake, events, "Clean up the logs", turn_id="t10")
    await adapter.on_processing_start(event)
    await adapter.send_draft("owner", 1, "Cleaning up")
    await fake.agent({"type": "turn.cancel", "turn_id": "t10", "reason": "barge_in"})
    for _ in range(100):
        if any(e.text == "/stop" for e in events):
            break
        await asyncio.sleep(0.02)
    stop = next(e for e in events if e.text == "/stop")
    await fake.wait_for(lambda m: m["type"] == "done" and m["turn_id"] == "t10")
    assert next(m for m in fake.agent_frames() if m["type"] == "done")["status"] == "cancelled"
    nxt = await turn(fake, events, "Actually, leave them", turn_id="t11")
    await adapter.send("owner", "⚡ Stopped.", reply_to=stop.message_id)
    await adapter.on_processing_start(nxt)
    await adapter.send("owner", "Okay, I left them alone.", reply_to=nxt.message_id)
    await adapter.on_processing_complete(nxt, ProcessingOutcome.SUCCESS)
    await fake.wait_for(lambda m: m["type"] == "done" and m["turn_id"] == "t11")
    spoken = "".join(m.get("delta", "") for m in fake.agent_frames() if m.get("turn_id") == "t11")
    assert spoken == "Okay, I left them alone."


async def test_a_cancelled_turn_hermes_has_not_started_does_not_stop_the_running_one(linked):
    adapter, fake, events = linked
    running = await turn(fake, events, "Run the report", turn_id="t12")
    await adapter.on_processing_start(running)
    await turn(fake, events, "and email it", turn_id="t13")
    await fake.agent({"type": "turn.cancel", "turn_id": "t13", "reason": "superseded"})
    await fake.wait_for(lambda m: m["type"] == "done" and m["turn_id"] == "t13")
    assert not any(e.text == "/stop" for e in events)


async def test_hermes_busy_notes_about_a_waiting_turn_are_not_spoken(linked):
    """Speaking while Hermes works makes Hermes note it ("Redirected current run..."), anchored to
    the new turn; on a phone call that note is noise, so it is dropped."""
    adapter, fake, events = linked
    running = await turn(fake, events, "What's using the disk?", turn_id="t14")
    await adapter.on_processing_start(running)
    later = await turn(fake, events, "only the big ones", turn_id="t15")
    result = await adapter.send("owner", "↪ Redirected current run. I'll adjust.", reply_to=later.message_id)
    assert result.success
    await asyncio.sleep(0.1)
    assert not any("Redirected" in m.get("delta", "") for m in fake.agent_frames())


async def test_a_message_hermes_folded_into_the_running_turn_is_closed_when_it_ends(linked):
    """A message typed while Hermes works is folded into that run (Hermes's default); Hermes never
    starts it on its own, so it is closed when the run it joined ends, not left waiting."""
    adapter, fake, events = linked
    running = await turn(fake, events, "What's using the disk?", surface="text", turn_id="t16")
    await adapter.on_processing_start(running)
    await turn(fake, events, "only the big ones", surface="text", turn_id="t17")
    await adapter.send("owner", "The logs folder, at 4 GB.", reply_to=running.message_id)
    await adapter.on_processing_complete(running, ProcessingOutcome.SUCCESS)
    await fake.wait_for(lambda m: m["type"] == "done" and m["turn_id"] == "t17")
    first = [m for m in fake.agent_frames() if m.get("turn_id") == "t16"]
    assert "".join(m.get("delta", "") for m in first) == "The logs folder, at 4 GB."
    folded = [m for m in fake.agent_frames() if m.get("turn_id") == "t17"]
    assert [m["type"] for m in folded] == ["done"] and folded[0]["status"] == "completed"


async def test_text_left_over_from_a_stopped_turn_is_not_spoken_in_the_next(linked):
    adapter, fake, events = linked
    stopped = await turn(fake, events, "Count the files", turn_id="t18")
    await adapter.on_processing_start(stopped)
    await fake.agent({"type": "turn.cancel", "turn_id": "t18", "reason": "barge_in"})
    await fake.wait_for(lambda m: m["type"] == "done" and m["turn_id"] == "t18")
    await turn(fake, events, "Never mind", turn_id="t19")
    await adapter.send("owner", "There are 120 files.", reply_to=stopped.message_id)
    await adapter.on_processing_complete(stopped, ProcessingOutcome.CANCELLED)
    await asyncio.sleep(0.1)
    assert not any("120" in m.get("delta", "") for m in fake.agent_frames())


def test_call_instructions_keep_answers_short_and_keep_hermes_off_the_token():
    hint = twring.CALL_HINT
    assert "one to three short sentences" in hint
    assert "TWRING_TOKEN" in hint and "cron" in hint
    assert "\u2014" not in hint


async def test_a_turn_cancelled_before_hermes_reached_it_is_stopped_when_it_starts(linked):
    """Twring merges a superseded, unheard turn into the next one; if Hermes reaches the old one
    later anyway, it is stopped at once and nothing from it is spoken."""
    adapter, fake, events = linked
    old = await turn(fake, events, "Check the", turn_id="t20")
    await fake.agent({"type": "turn.cancel", "turn_id": "t20", "reason": "superseded"})
    await fake.wait_for(lambda m: m["type"] == "done" and m["turn_id"] == "t20")
    await turn(fake, events, "Check the backups", turn_id="t21")
    await adapter.on_processing_start(old)
    for _ in range(100):
        if any(e.text == "/stop" for e in events):
            break
        await asyncio.sleep(0.02)
    assert any(e.text == "/stop" for e in events)
    await adapter.send_draft("owner", 1, "Checking the")
    await asyncio.sleep(0.1)
    assert not any(m.get("turn_id") == "t21" for m in fake.agent_frames())


async def test_an_unanchored_leftover_from_a_stopped_run_is_not_posted_to_the_chat(linked, monkeypatch):
    adapter, fake, events = linked
    posted = []

    async def fake_deliver(http, server, token, content, *, ring):
        posted.append(content)
        return {"success": True, "message_id": "m"}

    monkeypatch.setattr(twring, "deliver", fake_deliver)
    stopped = await turn(fake, events, "Count the files", turn_id="t22")
    await adapter.on_processing_start(stopped)
    await fake.agent({"type": "turn.cancel", "turn_id": "t22", "reason": "barge_in"})
    await fake.wait_for(lambda m: m["type"] == "done" and m["turn_id"] == "t22")
    await adapter.send("owner", "There are 120 files.")
    await adapter.send("owner", "Backup done.", metadata={"job_id": "job_9"})
    assert posted == ["Backup done."]


async def test_a_turn_hermes_queued_behind_other_work_still_gets_its_answer_spoken(linked):
    """Busy with other work (a background delegation's result), Hermes takes a spoken turn and
    returns at once, answering it a few seconds later; the answer is spoken on the call, not
    posted to the chat (seen live on 2026-11-11)."""
    adapter, fake, events = linked
    event = await turn(fake, events, "Are you there?", turn_id="t23")
    await adapter.on_processing_start(event)
    await adapter.on_processing_complete(event, ProcessingOutcome.SUCCESS)
    await asyncio.sleep(0.1)
    assert not any(m["type"] == "done" and m["turn_id"] == "t23" for m in fake.agent_frames())
    await adapter.send("owner", "Yes, I'm here.")
    await fake.wait_for(lambda m: m["type"] == "done" and m["turn_id"] == "t23")
    frames = [m for m in fake.agent_frames() if m.get("turn_id") == "t23"]
    assert "".join(m.get("delta", "") for m in frames) == "Yes, I'm here."
    assert frames[-1]["status"] == "completed"


async def test_a_late_answer_to_a_replaced_waiting_turn_is_not_spoken_in_the_next(linked):
    adapter, fake, events = linked
    first = await turn(fake, events, "Are you there?", turn_id="t24")
    await adapter.on_processing_start(first)
    await adapter.on_processing_complete(first, ProcessingOutcome.SUCCESS)
    await fake.agent({"type": "turn.cancel", "turn_id": "t24", "reason": "superseded"})
    await fake.wait_for(lambda m: m["type"] == "done" and m["turn_id"] == "t24")
    second = await turn(fake, events, "What time is it?", turn_id="t25")
    await adapter.on_processing_start(second)
    await adapter.send("owner", "Yes, I'm here.", reply_to=first.message_id)
    await adapter.send("owner", "It's noon.", reply_to=second.message_id)
    await adapter.on_processing_complete(second, ProcessingOutcome.SUCCESS)
    await fake.wait_for(lambda m: m["type"] == "done" and m["turn_id"] == "t25")
    spoken = "".join(m.get("delta", "") for m in fake.agent_frames() if m.get("turn_id") == "t25")
    assert spoken == "It's noon."


async def test_a_scheduled_job_result_rings_even_while_a_turn_is_open(linked, monkeypatch):
    """A cron job's result is its own message that rings the phone; it is never folded into the
    reply of whatever call or chat turn happens to be open (seen live on 2026-11-11)."""
    adapter, fake, events = linked
    calls = []

    async def fake_deliver(http, server, token, content, *, ring):
        calls.append((content, ring))
        return {"success": True, "message_id": "m"}

    monkeypatch.setattr(twring, "deliver", fake_deliver)
    event = await turn(fake, events, "Hello?", surface="text", turn_id="t26")
    await adapter.on_processing_start(event)
    await adapter.send("owner", "There are 11 GB free.", metadata={"job_id": "job_3"})
    await asyncio.sleep(0.1)
    assert calls == [("There are 11 GB free.", True)]
    assert not any("11 GB" in m.get("delta", "") for m in fake.agent_frames())


async def test_a_delayed_answer_after_hang_up_reaches_the_chat(linked, monkeypatch):
    adapter, fake, events = linked
    posted = []

    async def fake_post(http, server, token, text, *, origin="agent", turn_id=None):
        posted.append((text, origin, turn_id))

    monkeypatch.setattr(twring, "post_message", fake_post)
    event = await turn(fake, events, "How much disk is free?", turn_id="t27")
    await adapter.on_processing_start(event)
    await adapter.on_processing_complete(event, ProcessingOutcome.SUCCESS)
    await fake.agent({"type": "turn.cancel", "turn_id": "t27", "reason": "call_ended"})
    await fake.send({"type": "channel.close", "channel": "ch_1"})
    await asyncio.sleep(0.1)
    await adapter.send("owner", "11 GB are free.")
    assert posted == [("11 GB are free.", "call_turn", "t27")]


async def test_hanging_up_before_hermes_returns_still_saves_the_late_answer_as_the_calls_result(linked, monkeypatch):
    adapter, fake, events = linked
    posted = []

    async def fake_post(http, server, token, text, *, origin="agent", turn_id=None):
        posted.append((text, origin, turn_id))

    monkeypatch.setattr(twring, "post_message", fake_post)
    event = await turn(fake, events, "How much disk is free?", turn_id="t28")
    await adapter.on_processing_start(event)
    await fake.agent({"type": "turn.cancel", "turn_id": "t28", "reason": "call_ended"})
    await fake.send({"type": "channel.close", "channel": "ch_1"})
    await asyncio.sleep(0.1)
    await adapter.on_processing_complete(event, ProcessingOutcome.SUCCESS)
    await adapter.send("owner", "11 GB are free.")
    assert posted == [("11 GB are free.", "call_turn", "t28")]


async def test_a_late_answer_goes_to_the_turn_that_waits_for_it_not_a_newer_one(linked):
    adapter, fake, events = linked
    owed = await turn(fake, events, "Are you there?", turn_id="t29")
    await adapter.on_processing_start(owed)
    await turn(fake, events, "Hello?", turn_id="t30")
    await adapter.on_processing_complete(owed, ProcessingOutcome.SUCCESS)
    await adapter.send("owner", "Yes, I'm here.")
    await fake.wait_for(lambda m: m["type"] == "done" and m["turn_id"] == "t29")
    await fake.wait_for(lambda m: m["type"] == "done" and m["turn_id"] == "t30")
    first = "".join(m.get("delta", "") for m in fake.agent_frames() if m.get("turn_id") == "t29")
    assert first == "Yes, I'm here."
    assert not any(m.get("delta") for m in fake.agent_frames() if m.get("turn_id") == "t30")


async def test_a_turn_waiting_for_its_late_answer_keeps_telling_twring_hermes_is_working(linked, monkeypatch):
    """Twring ends a quiet turn after 30 s, so a turn waiting for Hermes's late answer sends
    activity while it waits."""
    adapter, fake, events = linked
    monkeypatch.setattr(twring, "ACTIVITY_EVERY_S", 0.05)
    event = await turn(fake, events, "Are you there?", turn_id="t31")
    await adapter.on_processing_start(event)
    await adapter.on_processing_complete(event, ProcessingOutcome.SUCCESS)
    await asyncio.sleep(0.3)
    beats = [m for m in fake.agent_frames() if m["type"] == "activity" and m["turn_id"] == "t31"]
    assert len(beats) >= 2
    await adapter.send("owner", "Yes, I'm here.")
    await fake.wait_for(lambda m: m["type"] == "done" and m["turn_id"] == "t31")
    count = len([m for m in fake.agent_frames() if m["type"] == "activity" and m["turn_id"] == "t31"])
    await asyncio.sleep(0.2)
    assert len([m for m in fake.agent_frames() if m["type"] == "activity" and m["turn_id"] == "t31"]) == count


async def test_hermes_typing_tells_twring_it_is_working(linked):
    """The typing heartbeat keeps a long turn alive on Twring (it ends a quiet turn after 30 s)."""
    adapter, fake, events = linked
    event = await turn(fake, events, "Run the backups", turn_id="t32")
    await adapter.on_processing_start(event)
    await adapter.send_typing("owner")
    await fake.wait_for(lambda m: m["type"] == "activity" and m["turn_id"] == "t32")
