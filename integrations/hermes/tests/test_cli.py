"""`hermes twring link`: the code shown, the wait, and what is saved through Hermes."""

import httpx

from cli import link_flow, qr_payload

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
