"""Sync Twring calls used by Hermes tools and hooks: message the owner, ring the owner."""

import json
import threading
from types import SimpleNamespace

import httpx
import pytest

import twring_outbound
from twring_outbound import clean_reason, ring_owner, run_in_background, send_message, settings

SERVER = "https://api.twring.com"
TOKEN = "cct_" + "a" * 43


@pytest.fixture
def fake(monkeypatch):
    """A fake Twring server behind httpx.MockTransport; records every request in order."""
    state = SimpleNamespace(calls=[], ring=lambda: httpx.Response(201, json={"invite_id": "inv_1"}),
                            message=lambda: httpx.Response(201, json={"delivery": "push"}))

    def handler(request):
        state.calls.append(
            {
                "path": request.url.path,
                "body": json.loads(request.content),
                "auth": request.headers.get("authorization"),
            }
        )
        return state.ring() if request.url.path == "/v1/connectors/ring" else state.message()

    monkeypatch.setattr(
        twring_outbound,
        "_client",
        lambda: httpx.AsyncClient(transport=httpx.MockTransport(handler), follow_redirects=False),
    )
    monkeypatch.setenv("TWRING_TOKEN", TOKEN)
    monkeypatch.delenv("TWRING_SERVER", raising=False)
    return state


def refused(code, status=409):
    return lambda: httpx.Response(status, json={"error": {"code": code, "message": "No.", "request_id": "r"}})


class TestSettings:
    def test_not_linked_without_a_token(self, monkeypatch):
        monkeypatch.delenv("TWRING_TOKEN", raising=False)
        assert settings() is None

    def test_default_server_when_none_is_set(self, fake):
        assert settings() == (SERVER, TOKEN)

    def test_own_server_is_used_without_a_trailing_slash(self, fake, monkeypatch):
        monkeypatch.setenv("TWRING_SERVER", "https://twring.example.com/")
        assert settings() == ("https://twring.example.com", TOKEN)

    def test_a_plain_http_server_counts_as_not_linked(self, fake, monkeypatch):
        monkeypatch.setenv("TWRING_SERVER", "http://twring.example.com")
        assert settings() is None


class TestCleanReason:
    def test_markdown_and_links_are_stripped(self):
        assert clean_reason("**Build** failed, see [the log](https://x.io/1) at https://x.io/2 `now`") == (
            "Build failed, see the log at now"
        )

    def test_cut_to_140_characters(self):
        assert len(clean_reason("word " * 100)) <= 140


def test_send_message_posts_to_the_hermes_chat_with_the_token_in_a_header(fake):
    assert send_message("Backup finished.") == {"delivered": "chat", "push": "push"}
    assert fake.calls == [
        {
            "path": "/v1/connectors/messages",
            "body": {"local_agent": "hermes", "text": "Backup finished.", "origin": "agent"},
            "auth": f"Bearer {TOKEN}",
        }
    ]


def test_send_message_without_a_link_sends_nothing(fake, monkeypatch):
    monkeypatch.delenv("TWRING_TOKEN")
    assert send_message("hi") == {"delivered": "none", "why": "not_linked"}
    assert fake.calls == []


def test_an_empty_message_is_not_sent(fake):
    assert send_message("   ") == {"delivered": "none", "why": "empty"}
    assert fake.calls == []


def test_send_message_reports_twrings_refusal_code(fake):
    fake.message = refused("agent_not_saved", 404)
    assert send_message("hi") == {"delivered": "none", "why": "agent_not_saved"}


def test_ring_posts_details_to_the_chat_first_then_rings_with_the_clean_reason(fake):
    result = ring_owner("**Deploy** blocked: https://x.io", details="The deploy needs your OK to drop table users.")
    assert result == {"delivered": "ring"}
    assert [c["path"] for c in fake.calls] == ["/v1/connectors/messages", "/v1/connectors/ring"]
    assert fake.calls[0]["body"]["text"] == "The deploy needs your OK to drop table users."
    assert fake.calls[1]["body"] == {"local_agent": "hermes", "reason": "Deploy blocked:"}


def test_ring_without_details_puts_the_reason_in_the_chat(fake):
    ring_owner("Build failed")
    assert fake.calls[0]["body"]["text"] == "Build failed"


def test_a_refused_ring_says_the_news_is_in_the_chat(fake):
    fake.ring = refused("owner_unavailable")
    assert ring_owner("Build failed") == {"delivered": "chat", "ring": "refused", "why": "owner_unavailable"}


def test_a_failed_chat_post_does_not_ring(fake):
    fake.message = lambda: httpx.Response(500, text="boom")
    assert ring_owner("Build failed") == {"delivered": "none", "why": "failed"}
    assert [c["path"] for c in fake.calls] == ["/v1/connectors/messages"]


def test_an_unreachable_server_never_raises(fake, monkeypatch):
    def down(request):
        raise httpx.ConnectError("down", request=request)

    monkeypatch.setattr(
        twring_outbound, "_client", lambda: httpx.AsyncClient(transport=httpx.MockTransport(down))
    )
    assert ring_owner("Build failed") == {"delivered": "none", "why": "failed"}


async def test_works_when_called_from_inside_a_running_event_loop(fake):
    assert send_message("from a loop") == {"delivered": "chat", "push": "push"}


def test_run_in_background_uses_a_daemon_thread_and_swallows_errors():
    done = threading.Event()

    def boom():
        done.set()
        raise RuntimeError("never reaches Hermes")

    thread = run_in_background(boom)
    assert thread.daemon is True
    assert done.wait(2)
    thread.join(2)
    assert not thread.is_alive()
