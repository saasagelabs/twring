"""The Twring protocol pieces that need no Hermes: frames, reply streaming, approvals, backoff."""

import json

import pytest

from twring_core import (
    AGENT_ID,
    MAX_DELTA_CHARS,
    ReplyStream,
    TurnState,
    approval_choice,
    approval_required,
    backoff_delays,
    channel_message,
    connector_hello,
    parse_frame,
    session_ready,
)


def test_hello_offers_one_hermes_agent_over_the_relay_protocol():
    hello = connector_hello("0.1.0")
    assert hello == {
        "type": "connector.hello",
        "protocol": "cord-relay/1",
        "agent_protocol": "cord-agent/1",
        "agents": [{"id": AGENT_ID, "label": "Hermes", "kind": "acp"}],
        "version": "0.1.0",
    }


def test_session_ready_declares_streaming_activity_cancel_and_approvals():
    ready = session_ready()
    assert ready["type"] == "session.ready"
    assert ready["protocol"] == "cord-agent/1"
    assert ready["capabilities"] == {
        "streaming_text": True,
        "cancel": True,
        "activity": True,
        "tools": False,
        "approvals": True,
    }


def test_channel_message_wraps_one_agent_frame():
    assert channel_message("ch_1", {"type": "pong", "id": "p1"}) == {
        "type": "channel.message",
        "channel": "ch_1",
        "message": {"type": "pong", "id": "p1"},
    }


class TestTurnState:
    def test_events_carry_the_turn_increasing_seq_and_unique_ids(self):
        turn = TurnState("ch_1", "t1", "call")
        first = turn.event("activity", label="Thinking")
        second = turn.event("activity", label="Searching")
        assert first["turn_id"] == second["turn_id"] == "t1"
        assert (first["seq"], second["seq"]) == (0, 1)
        assert first["event_id"] != second["event_id"]

    def test_text_starts_the_message_once_then_streams_deltas(self):
        turn = TurnState("ch_1", "t1", "call")
        events = turn.text("Hello") + turn.text(" there.")
        assert [e["type"] for e in events] == ["text.start", "text.delta", "text.delta"]
        assert {e["message_id"] for e in events} == {events[0]["message_id"]}
        assert "".join(e["delta"] for e in events if e["type"] == "text.delta") == "Hello there."

    def test_long_text_is_split_under_the_delta_limit(self):
        turn = TurnState("ch_1", "t1", "text")
        deltas = [e for e in turn.text("x" * (MAX_DELTA_CHARS * 2 + 5)) if e["type"] == "text.delta"]
        assert len(deltas) == 3
        assert all(len(e["delta"]) <= MAX_DELTA_CHARS for e in deltas)

    def test_empty_text_sends_nothing(self):
        assert TurnState("ch_1", "t1", "call").text("") == []

    def test_finish_closes_the_message_and_ends_the_turn_once(self):
        turn = TurnState("ch_1", "t1", "call")
        turn.text("Done.")
        events = turn.finish("completed")
        assert [e["type"] for e in events] == ["text.end", "done"]
        assert events[-1]["status"] == "completed"
        assert turn.finish("completed") == []
        assert turn.text("late") == []

    def test_finish_without_text_is_just_done(self):
        assert [e["type"] for e in TurnState("ch_1", "t1", "call").finish("failed")] == ["done"]


class TestReplyStream:
    def test_growing_drafts_give_only_the_new_words(self):
        stream = ReplyStream()
        assert stream.draft(1, "Sure") == "Sure"
        assert stream.draft(1, "Sure, I can") == ", I can"
        assert stream.draft(1, "Sure, I can help.") == " help."

    def test_the_final_answer_after_drafts_adds_only_what_is_new(self):
        stream = ReplyStream()
        stream.draft(1, "The build")
        assert stream.final("The build passed.") == " passed."
        assert stream.final("The build passed.") == ""

    def test_a_final_answer_with_no_drafts_is_said_whole(self):
        assert ReplyStream().final("All done.") == "All done."

    def test_a_new_response_after_a_tool_starts_a_new_paragraph(self):
        stream = ReplyStream()
        stream.draft(1, "Let me check.")
        assert stream.draft(2, "It passed.") == "\n\nIt passed."

    def test_a_final_answer_unlike_what_was_sent_is_still_said(self):
        """Live test: a progress note went out first and the real answer was dropped."""
        stream = ReplyStream()
        stream.draft(1, "Updating memory")
        assert stream.final("Yes, I can hear you.") == "\n\nYes, I can hear you."

    def test_a_final_answer_that_only_tidies_the_draft_is_not_repeated(self):
        stream = ReplyStream()
        stream.draft(1, "The build **passed**")
        assert stream.final("The build passed.") == ""

    def test_a_rewritten_draft_is_not_repeated_while_drafting_and_its_answer_is_never_lost(self):
        stream = ReplyStream()
        stream.draft(1, "Hello wrld")
        assert stream.draft(1, "Hello world") == ""
        assert stream.draft(1, "Hello world, again") == ""
        assert stream.final("Hello world, again") == "\n\nHello world, again"

    def test_a_tidied_final_adds_only_its_new_words(self):
        stream = ReplyStream()
        stream.draft(1, "The build **passed**")
        assert stream.final("The build passed. All 40 tests are green.") == ". All 40 tests are green."


class TestApprovals:
    def test_approval_card_names_the_command_within_twring_limits(self):
        turn = TurnState("ch_1", "t1", "call")
        event = approval_required(turn, "req1", "rm -rf build && npm test", "Deletes files")
        assert event["type"] == "approval.required"
        assert event["approval_id"] == "req1"
        assert event["action"] == "run_command"
        assert len(event["title"]) <= 80
        assert event["title"].startswith("Run: rm -rf build")
        assert event["description"] == "Deletes files"

    def test_long_commands_and_reasons_are_cut_to_fit(self):
        turn = TurnState("ch_1", "t1", "call")
        event = approval_required(turn, "req1", "x" * 500, "y" * 500)
        assert len(event["title"]) <= 80 and event["title"].endswith("…")
        assert len(event["description"]) <= 200

    @pytest.mark.parametrize(("decision", "choice"), [("approve", "once"), ("deny", "deny")])
    def test_a_decision_maps_to_a_hermes_choice(self, decision, choice):
        assert approval_choice(decision) == choice

    def test_an_unknown_decision_is_a_deny(self):
        assert approval_choice("maybe") == "deny"


def test_backoff_follows_the_connector_schedule_with_jitter_and_a_cap():
    delays = backoff_delays()
    seen = [next(delays) for _ in range(8)]
    for base, delay in zip([1, 2, 4, 8, 15, 30, 30, 30], seen):
        assert base <= delay <= base * 1.25


class TestParseFrame:
    def test_a_json_object_is_returned(self):
        assert parse_frame(json.dumps({"type": "connector.ready"})) == {"type": "connector.ready"}

    @pytest.mark.parametrize(
        "raw",
        ["not json", "[1, 2]", '{"no": "type"}', b"\x00\x01", "x" * 80_000],
        ids=["not-json", "array", "no-type", "binary", "oversized"],
    )
    def test_anything_else_is_dropped(self, raw):
        assert parse_frame(raw) is None


def test_an_activity_event_can_carry_its_own_kind():
    """Twring's activity events have a `kind` field; it must not clash with the event's type."""
    turn = TurnState("ch_1", "t1", "call")
    event = turn.event("activity", label="Working…", kind="working")
    assert event["type"] == "activity" and event["kind"] == "working" and event["label"] == "Working…"
