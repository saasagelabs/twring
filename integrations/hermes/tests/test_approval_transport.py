"""Hermes's approvals answered from the Twring app: the plugin's approval transport."""

import json
from dataclasses import dataclass, field

import httpx
import pytest

import approval_transport as transport

SERVER = "https://api.twring.com"
TOKEN = "cct_" + "f" * 43


@dataclass
class FakeRequest:
    request_id: str = "req_1"
    command: str = "rm -rf build"
    description: str = "Deletes the build folder"
    timeout_seconds: float = 60
    allowed_choices: tuple = ("once", "session", "always", "deny")
    digest: str = "d1"

    def respond(self, choice):
        return ("decision", self.request_id, choice)


class Clock:
    def __init__(self):
        self.t = 1000.0

    def now(self):
        return self.t

    async def sleep(self, seconds):
        self.t += seconds


@dataclass
class FakeServer:
    polls: list = field(default_factory=list)
    create_status: int = 201
    create_error: bool = False
    seen: list = field(default_factory=list)

    def handler(self, clock):
        def handle(request):
            self.seen.append((request.method, request.url.path, request))
            if request.method == "POST":
                if self.create_error:
                    raise httpx.ConnectError("down")
                if self.create_status >= 400:
                    return httpx.Response(self.create_status, json={"error": {"code": "x", "message": "refused"}})
                return httpx.Response(self.create_status, json={"approval_id": "ap_1", "status": "pending", "expires_at": "x"})
            if request.method == "DELETE":
                return httpx.Response(204)
            answer = self.polls.pop(0) if self.polls else "pending"
            clock.t += float(request.url.params.get("wait", "0"))
            if answer == "drop":
                raise httpx.ReadError("drop")
            return httpx.Response(200, json={"approval_id": "ap_1", "status": answer, "expires_at": "x"})

        return handle


@pytest.fixture
def env(monkeypatch):
    clock = Clock()
    server = FakeServer()
    asked = []
    monkeypatch.setattr(transport, "_now", clock.now)
    monkeypatch.setattr(transport, "_sleep", clock.sleep)
    monkeypatch.setattr(transport, "settings", lambda: (SERVER, TOKEN))
    monkeypatch.setattr(transport, "session_for_request", lambda request_id: "agent:main:telegram:dm:42")
    monkeypatch.setattr(transport, "ask_in_call", lambda *args: asked.append(args) or None)
    monkeypatch.setattr(
        transport, "_client", lambda: httpx.AsyncClient(transport=httpx.MockTransport(server.handler(clock)))
    )
    transport._cancelled.clear()
    return server, clock, asked


def methods(server):
    return [(method, path) for method, path, _ in server.seen]


async def test_allowed_on_the_phone_runs_it_once(env):
    server, _, _ = env
    server.polls = ["pending", "allowed"]
    assert await transport.present(FakeRequest()) == ("decision", "req_1", "once")
    create = server.seen[0][2]
    body = json.loads(create.content)
    assert create.headers["idempotency-key"] == "req_1"
    assert body["title"] == "Run a command"
    assert body["description"] == "rm -rf build\n\nDeletes the build folder"
    assert body["origin_label"] == "from Telegram"
    assert body["expires_in_s"] == 57


@pytest.mark.parametrize("status", ["denied", "expired"])
async def test_denied_or_expired_on_the_phone_is_a_deny(env, status):
    server, _, _ = env
    server.polls = [status]
    assert await transport.present(FakeRequest()) == ("decision", "req_1", "deny")
    assert ("DELETE", "/v1/connectors/approvals/ap_1") not in methods(server)


async def test_silence_until_the_deadline_cancels_the_card_and_denies(env):
    server, clock, _ = env
    assert await transport.present(FakeRequest(timeout_seconds=60)) == ("decision", "req_1", "deny")
    assert methods(server)[-1] == ("DELETE", "/v1/connectors/approvals/ap_1")
    assert clock.t <= 1000.0 + 60 - 3 + 1


async def test_a_network_drop_while_waiting_is_retried_and_never_approves(env):
    server, _, _ = env
    server.polls = ["drop", "drop", "allowed"]
    assert await transport.present(FakeRequest()) == ("decision", "req_1", "once")


async def test_a_network_that_stays_down_while_waiting_denies_at_the_deadline(env):
    server, _, _ = env
    server.polls = ["drop"] * 100
    assert await transport.present(FakeRequest()) == ("decision", "req_1", "deny")


async def test_a_server_restart_that_forgot_the_approval_denies(env, monkeypatch):
    server, clock, _ = env
    base = server.handler(clock)

    def gone(request):
        if request.method == "GET":
            return httpx.Response(404, json={"error": {"code": "not_found", "message": "gone"}})
        return base(request)

    monkeypatch.setattr(transport, "_client", lambda: httpx.AsyncClient(transport=httpx.MockTransport(gone)))
    assert await transport.present(FakeRequest()) == ("decision", "req_1", "deny")


@pytest.mark.parametrize("status", [404, 409, 403, 500])
async def test_a_refused_create_hands_the_approval_to_the_desk_prompt(env, status):
    server, _, _ = env
    server.create_status = status
    with pytest.raises(transport.TransportDeclined):
        await transport.present(FakeRequest())


async def test_an_unreachable_server_hands_the_approval_to_the_desk_prompt(env):
    server, _, _ = env
    server.create_error = True
    with pytest.raises(transport.TransportDeclined):
        await transport.present(FakeRequest())


async def test_a_command_hermes_could_not_show_whole_goes_to_the_desk_prompt(env):
    server, _, _ = env
    with pytest.raises(transport.TransportDeclined):
        await transport.present(FakeRequest(allowed_choices=("deny",)))
    with pytest.raises(transport.TransportDeclined):
        await transport.present(FakeRequest(command="x" * 501))
    assert server.seen == []


async def test_not_linked_goes_to_the_desk_prompt(env, monkeypatch):
    monkeypatch.setattr(transport, "settings", lambda: None)
    with pytest.raises(transport.TransportDeclined):
        await transport.present(FakeRequest())


@pytest.mark.parametrize("answer,choice", [("approve", "once"), ("deny", "deny")])
async def test_on_a_live_call_the_owner_is_asked_on_the_call(env, monkeypatch, answer, choice):
    server, _, _ = env
    asked = []
    monkeypatch.setattr(transport, "session_for_request", lambda request_id: "agent:main:twring:dm:owner")
    monkeypatch.setattr(transport, "ask_in_call", lambda *args: asked.append(args) or answer)
    assert await transport.present(FakeRequest()) == ("decision", "req_1", choice)
    assert asked == [("agent:main:twring:dm:owner", "req_1", "rm -rf build", "Deletes the build folder", 57.0)]
    assert server.seen == []


async def test_hermes_interrupted_cancels_the_card(env):
    server, _, _ = env
    server.polls = ["pending"]
    transport._on_post_approval_response(request_id="req_1", choice="transport_interrupted")
    assert await transport.present(FakeRequest()) == ("decision", "req_1", "deny")
    assert methods(server)[-1] == ("DELETE", "/v1/connectors/approvals/ap_1")


def test_a_plain_answer_from_hermes_does_not_cancel_anything():
    transport._cancelled.clear()
    transport._on_post_approval_response(request_id="req_2", choice="once")
    assert "req_2" not in transport._cancelled


@pytest.mark.parametrize(
    "session,label",
    [
        ("agent:main:telegram:dm:42", "from Telegram"),
        ("agent:main:discord:thread:1:2", "from Discord"),
        ("agent:main:cron:job_7", "from a scheduled job"),
        (None, "from the terminal"),
        ("", "from the terminal"),
        ("agent:main:mattermost:dm:9", "from Mattermost"),
    ],
)
def test_origin_label_names_where_hermes_asked(session, label):
    assert transport.origin_label(session) == label


def test_register_transport_names_it_twring_and_watches_hermes_answers():
    registered = {}

    class Ctx:
        def register_approval_transport(self, name, fn):
            registered["transport"] = (name, fn)

        def register_hook(self, name, fn):
            registered.setdefault("hooks", []).append((name, fn))

    assert transport.register_transport(Ctx()) is True
    assert registered["transport"] == ("twring", transport.present)
    assert registered["hooks"] == [("post_approval_response", transport._on_post_approval_response)]


def test_an_older_hermes_without_transports_is_left_alone():
    assert transport.register_transport(object()) is False


def test_registering_twice_through_register_tools_registers_the_transport_once():
    import tools

    transport._registered_for.clear()
    calls = []

    class Ctx:
        def register_tool(self, **kwargs):
            pass

        def register_hook(self, name, fn):
            pass

        def register_approval_transport(self, name, fn):
            calls.append(name)

    ctx = Ctx()
    tools.register_tools(ctx)
    tools.register_tools(ctx)
    assert calls == ["twring"]
    transport._registered_for.clear()
