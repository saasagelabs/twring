"""Hermes tools that reach the owner through Twring, registered the way Hermes registers them."""

import json

import pytest

import tools
import twring_outbound


class FakeCtx:
    def __init__(self):
        self.tools = {}
        self.hooks = []

    def register_tool(self, **kwargs):
        self.tools[kwargs["name"]] = kwargs

    def register_hook(self, name, callback):
        self.hooks.append((name, callback))


@pytest.fixture
def ctx():
    c = FakeCtx()
    tools.register_tools(c)
    return c


def test_both_tools_register_in_the_twring_toolset(ctx):
    assert set(ctx.tools) == {"twring_ring_owner", "twring_message_owner"}
    for name, entry in ctx.tools.items():
        assert entry["toolset"] == "twring"
        assert entry["schema"]["name"] == name
        assert entry["schema"]["parameters"]["type"] == "object"


def test_ring_schema_keeps_the_reason_short_and_details_optional(ctx):
    params = ctx.tools["twring_ring_owner"]["schema"]["parameters"]
    assert params["properties"]["reason"]["maxLength"] == 140
    assert params["required"] == ["reason"]
    assert "details" in params["properties"]
    assert ctx.tools["twring_message_owner"]["schema"]["parameters"]["required"] == ["text"]


def test_descriptions_carry_the_judgment_and_keep_hermes_off_the_token_and_shell(ctx):
    ring = ctx.tools["twring_ring_owner"]["description"]
    message = ctx.tools["twring_message_owner"]["description"]
    assert "twring_message_owner" in ring
    assert "twice" in ring
    for text in (ring, message):
        assert "TWRING_TOKEN" in text
        assert "shell" in text
        assert "twring-connect" in text


def test_tools_are_hidden_until_this_hermes_is_linked(ctx, monkeypatch):
    check = ctx.tools["twring_ring_owner"]["check_fn"]
    monkeypatch.delenv("TWRING_TOKEN", raising=False)
    assert check() is False
    monkeypatch.setenv("TWRING_TOKEN", "cct_" + "a" * 43)
    assert check() is True


def test_ring_hands_reason_and_details_to_twring(ctx, monkeypatch):
    seen = {}

    def fake_ring(reason, details=None):
        seen.update(reason=reason, details=details)
        return {"delivered": "chat", "ring": "refused", "why": "owner_unavailable"}

    monkeypatch.setattr(twring_outbound, "ring_owner", fake_ring)
    out = ctx.tools["twring_ring_owner"]["handler"]({"reason": "Deploy blocked", "details": "Needs your OK."})
    assert json.loads(out) == {"delivered": "chat", "ring": "refused", "why": "owner_unavailable"}
    assert seen == {"reason": "Deploy blocked", "details": "Needs your OK."}


def test_message_hands_text_to_twring(ctx, monkeypatch):
    monkeypatch.setattr(twring_outbound, "send_message", lambda text: {"delivered": "chat", "push": "push", "t": text})
    out = ctx.tools["twring_message_owner"]["handler"]({"text": "Backup done."}, task_id="t1")
    assert json.loads(out)["t"] == "Backup done."


@pytest.mark.parametrize(
    "name,args",
    [
        ("twring_ring_owner", {}),
        ("twring_ring_owner", {"reason": 5}),
        ("twring_ring_owner", {"reason": "ok", "details": ["x"]}),
        ("twring_message_owner", {"text": ""}),
        ("twring_message_owner", None),
    ],
)
def test_bad_arguments_are_refused_without_sending(ctx, monkeypatch, name, args):
    def never(*a, **k):
        raise AssertionError("nothing may be sent")

    monkeypatch.setattr(twring_outbound, "ring_owner", never)
    monkeypatch.setattr(twring_outbound, "send_message", never)
    assert json.loads(ctx.tools[name]["handler"](args)) == {"delivered": "none", "why": "bad_arguments"}


def test_a_handler_never_raises(ctx, monkeypatch):
    def boom(*a, **k):
        raise RuntimeError("unexpected")

    monkeypatch.setattr(twring_outbound, "ring_owner", boom)
    assert json.loads(ctx.tools["twring_ring_owner"]["handler"]({"reason": "x"})) == {"delivered": "none", "why": "error"}


def test_registering_the_tools_also_arms_the_hooks_for_terminal_sessions():
    import hooks

    hooks._reset_for_tests()
    c = FakeCtx()
    tools.register_tools(c)
    assert sorted(name for name, _ in c.hooks) == ["api_request_error", "post_approval_response", "pre_approval_request"]


def test_a_failing_hook_registration_still_registers_the_transport_and_skill(monkeypatch):
    import approval_transport
    import hooks
    import twring_skill

    def boom(ctx):
        raise RuntimeError("hooks broke")

    registered = []
    monkeypatch.setattr(hooks, "register_hooks", boom)
    monkeypatch.setattr(approval_transport, "register_transport", lambda ctx: registered.append("transport"))
    monkeypatch.setattr(twring_skill, "register_skill", lambda ctx: registered.append("skill"))
    c = FakeCtx()
    tools.register_tools(c)
    assert registered == ["transport", "skill"]
    assert c.tools


def test_hooks_are_marked_registered_only_after_they_register(monkeypatch):
    import hooks

    monkeypatch.setattr(hooks, "_registered_for", set())

    class Flaky(FakeCtx):
        fail = True

        def register_hook(self, name, callback):
            if self.fail:
                raise RuntimeError("not yet")
            super().register_hook(name, callback)

    c = Flaky()
    with pytest.raises(RuntimeError):
        hooks.register_hooks(c)
    c.fail = False
    hooks.register_hooks(c)
    assert len(c.hooks) == 3
