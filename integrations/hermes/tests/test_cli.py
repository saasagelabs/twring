"""`hermes twring link`: the code shown, the wait, and what is saved through Hermes."""

import httpx

from cli import APPROVAL_QUESTION, approvals_command, link_flow, phone_approvals_on, qr_payload, set_phone_approvals

SERVER = "https://api.twring.com"
TOKEN = "cct_" + "c" * 43
POLL = "clp_" + "d" * 43


def fake_server(poll_answers):
    answers = iter(poll_answers)

    def handler(request):
        if request.method == "POST":
            return httpx.Response(
                201,
                json={
                    "request_id": "lr_1",
                    "code": "ABCD-EFGH",
                    "poll_token": POLL,
                    "expires_at": "2026-11-10T10:10:00.000Z",
                    "server_time": "2026-11-10T10:00:00.000Z",
                },
            )
        return httpx.Response(200, json=next(answers))

    return lambda: httpx.Client(transport=httpx.MockTransport(handler), follow_redirects=False)


def test_qr_payload_matches_the_twring_app():
    assert qr_payload("ABCD-EFGH", "https://api.twring.com/") == (
        "cord://link?code=ABCDEFGH&server=https%3A%2F%2Fapi.twring.com"
    )


def test_link_shows_the_code_then_saves_the_token_through_hermes_and_never_prints_it():
    lines, saved = [], {}
    code = link_flow(
        server=SERVER,
        computer_name="vps (Hermes)",
        out=lines.append,
        save=lambda **values: saved.update(values),
        client_factory=fake_server([{"status": "approved", "connector_token": TOKEN, "connector_id": "con_1"}]),
        render_qr=lambda payload: None,
    )
    assert code == 0
    assert any("ABCD-EFGH" in line for line in lines)
    assert saved == {
        "TWRING_TOKEN": TOKEN,
        "TWRING_SERVER": SERVER,
        "TWRING_ALLOWED_USERS": "owner",
        "TWRING_HOME_CHANNEL": "owner",
    }
    assert not any(TOKEN in line for line in lines)
    assert any("hermes gateway" in line for line in lines)


def test_a_declined_code_saves_nothing_and_says_why():
    lines, saved = [], {}
    code = link_flow(
        server=SERVER,
        out=lines.append,
        save=lambda **values: saved.update(values),
        client_factory=fake_server([{"status": "rejected"}]),
        render_qr=lambda payload: None,
    )
    assert code == 1
    assert saved == {}
    assert any("declined" in line for line in lines)


def test_a_bad_server_address_saves_nothing():
    lines, saved = [], {}
    code = link_flow(server="http://example.com", out=lines.append, save=lambda **v: saved.update(v))
    assert code == 1
    assert saved == {}
    assert any("https://" in line for line in lines)


def test_the_qr_code_is_shown_when_one_can_be_drawn():
    lines, payloads = [], []

    def render(payload):
        payloads.append(payload)
        return "[QR]"

    link_flow(
        server=SERVER,
        out=lines.append,
        save=lambda **values: None,
        client_factory=fake_server([{"status": "approved", "connector_token": TOKEN, "connector_id": "c"}]),
        render_qr=render,
    )
    assert payloads == ["cord://link?code=ABCDEFGH&server=https%3A%2F%2Fapi.twring.com"]
    assert "[QR]" in lines


def approved_server():
    return fake_server([{"status": "approved", "connector_token": TOKEN, "connector_id": "con_1"}])


def test_saying_yes_at_link_turns_on_phone_approvals():
    lines, asked, turned = [], [], []
    code = link_flow(
        server=SERVER,
        computer_name="vps (Hermes)",
        out=lines.append,
        save=lambda **values: None,
        client_factory=approved_server(),
        render_qr=lambda payload: None,
        ask=lambda question: asked.append(question) or "",
        set_approvals=lambda on: turned.append(on) or True,
    )
    assert code == 0
    assert asked == [APPROVAL_QUESTION]
    assert turned == [True]
    assert any("from your phone" in line for line in lines)


def test_saying_no_at_link_leaves_hermes_approvals_alone():
    lines, turned = [], []
    code = link_flow(
        server=SERVER,
        computer_name="vps (Hermes)",
        out=lines.append,
        save=lambda **values: None,
        client_factory=approved_server(),
        render_qr=lambda payload: None,
        ask=lambda question: "n",
        set_approvals=lambda on: turned.append(on) or True,
    )
    assert code == 0
    assert turned == []
    assert any("hermes twring approvals on" in line for line in lines)


def test_without_a_question_link_never_touches_approvals():
    turned = []
    link_flow(
        server=SERVER,
        computer_name="vps (Hermes)",
        out=lambda line: None,
        save=lambda **values: None,
        client_factory=approved_server(),
        render_qr=lambda payload: None,
        set_approvals=lambda on: turned.append(on) or True,
    )
    assert turned == []


def test_a_failed_link_does_not_ask_about_approvals():
    asked = []
    link_flow(
        server=SERVER,
        computer_name="vps (Hermes)",
        out=lambda line: None,
        save=lambda **values: None,
        client_factory=fake_server([{"status": "rejected"}]),
        render_qr=lambda payload: None,
        ask=lambda question: asked.append(question) or "y",
    )
    assert asked == []


def test_turning_approvals_on_selects_twring_with_the_desk_prompt_as_fallback():
    written = []
    assert set_phone_approvals(True, write=lambda key, value: written.append((key, value))) is True
    assert written == [
        ("security.approval.transport_fallback", "builtin"),
        ("security.approval.transport", "twring"),
    ]


def test_turning_approvals_off_restores_hermes_defaults():
    written = []
    set_phone_approvals(False, write=lambda key, value: written.append((key, value)))
    assert written == [
        ("security.approval.transport", "builtin"),
        ("security.approval.transport_fallback", "deny"),
    ]


def test_a_refused_config_write_is_reported_not_crashed():
    def refuse(key, value):
        raise SystemExit(1)

    lines = []
    assert approvals_command("on", out=lines.append, write=refuse, read=lambda: {}) == 1
    assert any("did not accept" in line for line in lines)


def test_approvals_status_says_where_hermes_asks():
    on = {"security": {"approval": {"transport": "twring", "transport_fallback": "builtin"}}}
    lines = []
    assert approvals_command("status", out=lines.append, write=lambda k, v: None, read=lambda: on) == 0
    assert "on" in lines[-1] and "Twring app" in lines[-1]
    lines.clear()
    approvals_command("status", out=lines.append, write=lambda k, v: None, read=lambda: {})
    assert "off" in lines[-1] and "hermes twring approvals on" in lines[-1]


def test_phone_approvals_on_reads_the_transport_setting():
    assert phone_approvals_on(read=lambda: {"security": {"approval": {"transport": "twring"}}}) is True
    assert phone_approvals_on(read=lambda: {"security": {"approval": {"transport": "builtin"}}}) is False
    assert phone_approvals_on(read=lambda: {}) is False


def test_a_failed_transport_write_after_the_fallback_leaves_approvals_off():
    written = []

    def write(key, value):
        if key == "security.approval.transport":
            raise SystemExit(1)
        written.append((key, value))

    assert set_phone_approvals(True, write=write) is False
    assert written == [("security.approval.transport_fallback", "builtin")]


def test_a_managed_hermes_is_reported_not_claimed_as_success():
    written, lines = [], []
    code = approvals_command(
        "on", out=lines.append, write=lambda k, v: written.append((k, v)), read=lambda: {}, managed=lambda: True
    )
    assert code == 1 and written == []
    assert "managed" in lines[-1]
