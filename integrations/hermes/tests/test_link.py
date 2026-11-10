"""Linking Hermes to a Twring account, and Twring calls that use the computer token."""

import json

import httpx
import pytest

from twring_link import (
    LinkError,
    check_server,
    post_message,
    post_ring,
    start_link,
    wait_for_approval,
)

SERVER = "https://api.twring.com"
TOKEN = "cct_" + "a" * 43
POLL = "clp_" + "b" * 43


def client(handler):
    return httpx.Client(transport=httpx.MockTransport(handler), follow_redirects=False)


def link_response():
    return {
        "request_id": "lr_1",
        "code": "ABCD-EFGH",
        "poll_token": POLL,
        "expires_at": "2026-11-10T10:10:00.000Z",
        "server_time": "2026-11-10T10:00:00.000Z",
    }


class TestCheckServer:
    def test_https_is_accepted_without_a_trailing_slash(self):
        assert check_server("https://api.twring.com/") == "https://api.twring.com"

    def test_local_http_is_accepted_for_development(self):
        assert check_server("http://localhost:8080") == "http://localhost:8080"

    @pytest.mark.parametrize("url", ["http://api.twring.com", "ftp://x", "api.twring.com", "https://"])
    def test_anything_else_is_refused(self, url):
        with pytest.raises(LinkError):
            check_server(url)


def test_start_link_offers_hermes_and_returns_the_code():
    seen = {}

    def handler(request):
        seen["url"] = str(request.url)
        seen["body"] = json.loads(request.content)
        seen["auth"] = request.headers.get("authorization")
        return httpx.Response(201, json=link_response())

    with client(handler) as c:
        link = start_link(c, SERVER, "my-vps (Hermes)")
    assert seen["url"] == f"{SERVER}/v1/connectors/link-requests"
    assert seen["body"] == {
        "computer_name": "my-vps (Hermes)",
        "agents": [{"id": "hermes", "label": "Hermes", "kind": "acp"}],
    }
    assert seen["auth"] is None
    assert link.code == "ABCD-EFGH"
    assert link.request_id == "lr_1"


def test_a_long_computer_name_is_cut_to_twrings_limit():
    seen = {}

    def handler(request):
        seen["body"] = json.loads(request.content)
        return httpx.Response(201, json=link_response())

    with client(handler) as c:
        start_link(c, SERVER, "x" * 100)
    assert len(seen["body"]["computer_name"]) <= 40


def test_start_link_explains_a_refusal():
    def handler(request):
        return httpx.Response(429, json={"error": {"code": "rate_limited", "message": "Too many tries."}})

    with client(handler) as c, pytest.raises(LinkError, match="Too many tries."):
        start_link(c, SERVER, "vps")


def test_waiting_polls_with_the_poll_token_until_approved():
    answers = iter([{"status": "pending"}, {"status": "approved", "connector_token": TOKEN, "connector_id": "con_1"}])
    auths = []

    def handler(request):
        auths.append(request.headers.get("authorization"))
        assert request.url.path == "/v1/connectors/link-requests/lr_1"
        assert request.url.params.get("wait") == "25"
        return httpx.Response(200, json=next(answers))

    with client(handler) as c:
        link = start_link(client(lambda r: httpx.Response(201, json=link_response())), SERVER, "vps")
        result = wait_for_approval(c, SERVER, link, now=lambda: 0.0)
    assert auths == [f"Bearer {POLL}", f"Bearer {POLL}"]
    assert result.token == TOKEN
    assert result.connector_id == "con_1"


@pytest.mark.parametrize(("status", "message"), [("expired", "expired"), ("rejected", "declined")])
def test_waiting_stops_when_the_phone_says_no_or_time_runs_out(status, message):
    def handler(request):
        return httpx.Response(200, json={"status": status})

    with client(handler) as c:
        link = start_link(client(lambda r: httpx.Response(201, json=link_response())), SERVER, "vps")
        with pytest.raises(LinkError, match=message):
            wait_for_approval(c, SERVER, link, now=lambda: 0.0)


def test_waiting_gives_up_after_the_code_expires():
    def handler(request):
        return httpx.Response(200, json={"status": "pending"})

    clock = iter([0.0, 0.0, 700.0])
    with client(handler) as c:
        link = start_link(client(lambda r: httpx.Response(201, json=link_response())), SERVER, "vps")
        with pytest.raises(LinkError, match="expired"):
            wait_for_approval(c, SERVER, link, now=lambda: next(clock))


def test_a_malformed_approval_never_yields_a_token():
    def handler(request):
        return httpx.Response(200, json={"status": "approved", "connector_token": "not-a-token", "connector_id": "c"})

    with client(handler) as c:
        link = start_link(client(lambda r: httpx.Response(201, json=link_response())), SERVER, "vps")
        with pytest.raises(LinkError):
            wait_for_approval(c, SERVER, link, now=lambda: 0.0)


@pytest.mark.asyncio
async def test_post_message_sends_hermes_text_to_the_twring_chat_with_the_token():
    seen = {}

    def handler(request):
        seen["url"] = str(request.url)
        seen["auth"] = request.headers.get("authorization")
        seen["key"] = request.headers.get("idempotency-key")
        seen["body"] = json.loads(request.content)
        return httpx.Response(201, json={"message_id": "msg_1", "delivery": "push"})

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as c:
        delivery = await post_message(c, SERVER, TOKEN, "Backup finished.")
    assert seen["url"] == f"{SERVER}/v1/connectors/messages"
    assert seen["auth"] == f"Bearer {TOKEN}"
    assert seen["key"]
    assert seen["body"] == {"local_agent": "hermes", "text": "Backup finished.", "origin": "agent"}
    assert delivery == "push"


@pytest.mark.asyncio
async def test_post_message_refusal_is_an_error_without_the_token():
    def handler(request):
        return httpx.Response(401, json={"error": {"code": "unauthorized", "message": "Sign in."}})

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as c:
        with pytest.raises(LinkError) as caught:
            await post_message(c, SERVER, TOKEN, "hi")
    assert TOKEN not in str(caught.value)


@pytest.mark.asyncio
async def test_a_call_reply_after_hang_up_is_posted_as_that_call_turns_result():
    seen = {}

    def handler(request):
        seen["body"] = json.loads(request.content)
        return httpx.Response(201, json={"message_id": "msg_1", "delivery": "ring"})

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as c:
        delivery = await post_message(c, SERVER, TOKEN, "Tests passed.", origin="call_turn", turn_id="t9")
    assert seen["body"] == {"local_agent": "hermes", "text": "Tests passed.", "origin": "call_turn", "turn_id": "t9"}
    assert delivery == "ring"


@pytest.mark.asyncio
async def test_post_ring_rings_the_owner_with_a_reason_and_the_token():
    seen = {}

    def handler(request):
        seen["url"] = str(request.url)
        seen["auth"] = request.headers.get("authorization")
        seen["body"] = json.loads(request.content)
        return httpx.Response(201, json={"invite_id": "inv_1"})

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as c:
        await post_ring(c, SERVER, TOKEN, "Backup finished.")
    assert seen["url"] == f"{SERVER}/v1/connectors/ring"
    assert seen["auth"] == f"Bearer {TOKEN}"
    assert seen["body"] == {"local_agent": "hermes", "reason": "Backup finished."}


@pytest.mark.asyncio
async def test_a_refused_ring_is_an_error_without_the_token():
    def handler(request):
        return httpx.Response(409, json={"error": {"code": "ring_busy", "message": "Already ringing."}})

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as c:
        with pytest.raises(LinkError, match="Already ringing.") as caught:
            await post_ring(c, SERVER, TOKEN, "hi")
    assert TOKEN not in str(caught.value)
