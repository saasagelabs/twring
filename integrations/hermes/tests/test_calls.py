"""Asking the owner on a live Twring call from Hermes's approval worker thread."""

import pytest

import twring_calls


@pytest.fixture(autouse=True)
def no_askers():
    yield
    for fn in list(twring_calls._askers):
        twring_calls.unregister_asker(fn)


def test_with_no_live_call_nobody_is_asked():
    assert twring_calls.ask_in_call("agent:main:twring:dm:owner", "r1", "ls", "", 5) is None


def test_the_first_asker_with_a_live_call_answers():
    seen = []

    def no_call(*args):
        seen.append(("no_call", args))
        return None

    def on_call(session_key, request_id, command, description, timeout_s):
        seen.append(("on_call", (session_key, request_id, command, description, timeout_s)))
        return "approve"

    twring_calls.register_asker(no_call)
    twring_calls.register_asker(on_call)
    assert twring_calls.ask_in_call("sk", "r1", "rm -rf build", "Deletes", 7.5) == "approve"
    assert seen[1] == ("on_call", ("sk", "r1", "rm -rf build", "Deletes", 7.5))


def test_a_broken_asker_is_skipped_and_never_approves():
    def broken(*args):
        raise RuntimeError("boom")

    twring_calls.register_asker(broken)
    assert twring_calls.ask_in_call("sk", "r1", "ls", "", 5) is None


def test_an_unexpected_answer_is_not_an_approval():
    twring_calls.register_asker(lambda *args: "yes please")
    assert twring_calls.ask_in_call("sk", "r1", "ls", "", 5) is None


def test_registering_twice_asks_once_and_unregister_removes():
    calls = []

    def asker(*args):
        calls.append(args)
        return None

    twring_calls.register_asker(asker)
    twring_calls.register_asker(asker)
    twring_calls.ask_in_call("sk", "r1", "ls", "", 5)
    assert len(calls) == 1
    twring_calls.unregister_asker(asker)
    twring_calls.ask_in_call("sk", "r1", "ls", "", 5)
    assert len(calls) == 1
