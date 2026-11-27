"""Linking Hermes to a Twring account, and the Twring HTTP calls that use the computer token.

Linking is the same flow as Twring's own connector (apps/connector/src/link.ts): this computer
asks for a short code, the owner approves it in the Twring app (Add agent, On my computer), and
the server hands this computer a long-lived token exactly once. The token only ever travels in an
Authorization header to the Twring server the owner chose; redirects are refused.
"""

from __future__ import annotations

import re
import time
import uuid
from dataclasses import dataclass
from typing import Any, Callable
from urllib.parse import quote, urlsplit

import httpx

try:  # loaded by Hermes as a package
    from .twring_core import AGENT_ID, AGENT_KIND, AGENT_LABEL
except ImportError:  # loaded directly (tests)
    from twring_core import AGENT_ID, AGENT_KIND, AGENT_LABEL

TOKEN_PATTERN = re.compile(r"^cct_[A-Za-z0-9_-]{43}$")
POLL_TOKEN_PATTERN = re.compile(r"^clp_[A-Za-z0-9_-]{43}$")
MAX_COMPUTER_NAME = 40
POLL_WAIT_S = 25
#: A code works for 10 minutes; stop waiting a little after that by this computer's clock.
LINK_GIVE_UP_S = 11 * 60
_LOCAL_HOSTS = {"localhost", "127.0.0.1", "::1"}


class LinkError(Exception):
    """Something the person can act on, in plain words. Never carries a token. `code` is Twring's
    machine code for a refusal (for example `owner_unavailable`), or None when the server was not
    reached or gave no code."""

    def __init__(self, message: str = "", *, code: str | None = None) -> None:
        super().__init__(message)
        self.code = code


@dataclass(frozen=True)
class LinkRequest:
    request_id: str
    code: str
    poll_token: str


@dataclass(frozen=True)
class LinkResult:
    token: str
    connector_id: str
    owner_name: str | None


def check_server(server: str) -> str:
    """The Twring server address without a trailing slash: https, or http on this machine only."""
    parts = urlsplit(str(server or "").strip())
    local = parts.hostname in _LOCAL_HOSTS
    if not parts.hostname or not (parts.scheme == "https" or (parts.scheme == "http" and local)):
        raise LinkError("The Twring server address must start with https://")
    return f"{parts.scheme}://{parts.netloc}{parts.path.rstrip('/')}"


def _error_message(response: httpx.Response, fallback: str) -> str:
    try:
        body = response.json()
        message = body["error"]["message"]
        if isinstance(message, str) and message:
            return message
    except (ValueError, KeyError, TypeError):
        pass
    return fallback


def _error_code(response: httpx.Response) -> str | None:
    try:
        code = response.json()["error"]["code"]
    except (ValueError, KeyError, TypeError):
        return None
    return code if isinstance(code, str) and code else None


def start_link(client: httpx.Client, server: str, computer_name: str) -> LinkRequest:
    """Asks the Twring server for a link code that offers this computer's Hermes."""
    try:
        response = client.post(
            f"{server}/v1/connectors/link-requests",
            json={
                "computer_name": (computer_name.strip() or "Hermes")[:MAX_COMPUTER_NAME],
                # Link requests name the agent `local_agent` (the relay hello uses `id`).
                "agents": [{"local_agent": AGENT_ID, "kind": AGENT_KIND, "label": AGENT_LABEL}],
            },
        )
    except httpx.HTTPError as error:
        raise LinkError("Could not reach the Twring server. Check the internet connection.") from error
    if response.status_code not in (200, 201):
        raise LinkError(_error_message(response, f"The Twring server refused (HTTP {response.status_code})."))
    try:
        body = response.json()
        link = LinkRequest(request_id=str(body["request_id"]), code=str(body["code"]), poll_token=str(body["poll_token"]))
    except (ValueError, KeyError, TypeError) as error:
        raise LinkError("The Twring server sent an answer this plugin does not understand.") from error
    if not POLL_TOKEN_PATTERN.match(link.poll_token):
        raise LinkError("The Twring server sent an answer this plugin does not understand.")
    return link


def wait_for_approval(
    client: httpx.Client,
    server: str,
    link: LinkRequest,
    *,
    now: Callable[[], float] = time.monotonic,
) -> LinkResult:
    """Long-polls until the owner approves the code in the app, declines it, or it expires."""
    deadline = now() + LINK_GIVE_UP_S
    url = f"{server}/v1/connectors/link-requests/{link.request_id}"
    headers = {"authorization": f"Bearer {link.poll_token}"}
    while now() < deadline:
        try:
            response = client.get(url, params={"wait": POLL_WAIT_S}, headers=headers, timeout=POLL_WAIT_S + 10)
        except httpx.HTTPError:
            time.sleep(2)
            continue
        if response.status_code == 429 or response.status_code >= 500:
            time.sleep(2)
            continue
        if response.status_code != 200:
            raise LinkError(_error_message(response, f"The Twring server refused (HTTP {response.status_code})."))
        try:
            body: dict[str, Any] = response.json()
        except ValueError as error:
            raise LinkError("The Twring server sent an answer this plugin does not understand.") from error
        status = body.get("status")
        if status == "pending":
            continue
        if status == "approved":
            token = body.get("connector_token")
            connector_id = body.get("connector_id")
            if not isinstance(token, str) or not TOKEN_PATTERN.match(token) or not isinstance(connector_id, str):
                raise LinkError("The Twring server sent an answer this plugin does not understand.")
            owner = body.get("owner_name")
            return LinkResult(token=token, connector_id=connector_id, owner_name=owner if isinstance(owner, str) else None)
        if status == "rejected":
            raise LinkError("The code was declined in the Twring app.")
        if status == "expired":
            raise LinkError("The code expired. Run the link again for a new one.")
        raise LinkError("The Twring server sent an answer this plugin does not understand.")
    raise LinkError("The code expired. Run the link again for a new one.")


async def post_message(
    client: httpx.AsyncClient,
    server: str,
    token: str,
    text: str,
    *,
    origin: str = "agent",
    turn_id: str | None = None,
) -> str:
    """Posts Hermes's text to the owner's Twring chat with Hermes; returns how Twring delivered it
    (`ring`, `push` or `none`). `origin` `call_turn` with the call's `turn_id` is a reply that
    finished after the owner hung up: Twring rings with its first sentence when the owner's ring
    settings allow. One idempotency key, so a retried post is never shown twice."""
    body: dict[str, Any] = {"local_agent": AGENT_ID, "text": text, "origin": origin}
    if turn_id is not None:
        body["turn_id"] = turn_id
    try:
        response = await client.post(
            f"{server}/v1/connectors/messages",
            headers={"authorization": f"Bearer {token}", "idempotency-key": uuid.uuid4().hex},
            json=body,
        )
    except httpx.HTTPError as error:
        raise LinkError("Could not reach the Twring server.") from error
    if response.status_code not in (200, 201):
        raise LinkError(
            _error_message(response, f"Twring refused the message (HTTP {response.status_code})."),
            code=_error_code(response),
        )
    try:
        delivery = response.json().get("delivery")
    except (ValueError, AttributeError):
        delivery = None
    return delivery if delivery in ("ring", "push", "none") else "none"


async def post_ring(client: httpx.AsyncClient, server: str, token: str, reason: str) -> None:
    """Rings the owner's phone for Hermes with a short reason (Twring keeps at most 140 characters)."""
    try:
        response = await client.post(
            f"{server}/v1/connectors/ring",
            headers={"authorization": f"Bearer {token}"},
            json={"local_agent": AGENT_ID, "reason": reason},
        )
    except httpx.HTTPError as error:
        raise LinkError("Could not reach the Twring server.") from error
    if response.status_code not in (200, 201):
        raise LinkError(
            _error_message(response, f"Twring did not ring (HTTP {response.status_code})."),
            code=_error_code(response),
        )


APPROVAL_STATUSES = frozenset({"pending", "allowed", "denied", "expired"})
APPROVAL_WAIT_MAX_S = 25
MAX_APPROVAL_TITLE = 80
MAX_APPROVAL_DESCRIPTION = 500
MAX_ORIGIN_LABEL = 40
APPROVAL_EXPIRES_MIN_S = 10
APPROVAL_EXPIRES_MAX_S = 600


def _approval_url(server: str, approval_id: str = "") -> str:
    base = f"{server}/v1/connectors/approvals"
    return f"{base}/{quote(approval_id, safe='')}" if approval_id else base


def _approval_body(response: httpx.Response, approval_id: str = "") -> dict:
    """The approval as `{approval_id, status, expires_at}`, or LinkError if it cannot be read."""
    try:
        body = response.json()
    except ValueError as error:
        raise LinkError("The Twring server sent an answer this plugin does not understand.") from error
    if not isinstance(body, dict):
        raise LinkError("The Twring server sent an answer this plugin does not understand.")
    found = body.get("approval_id", approval_id)
    status = body.get("status")
    if not isinstance(found, str) or not found or status not in APPROVAL_STATUSES:
        raise LinkError("The Twring server sent an answer this plugin does not understand.")
    expires_at = body.get("expires_at")
    return {"approval_id": found, "status": status, "expires_at": expires_at if isinstance(expires_at, str) else ""}


async def create_approval(
    client: httpx.AsyncClient,
    server: str,
    token: str,
    *,
    request_id: str,
    title: str,
    description: str,
    origin_label: str | None,
    expires_in_s: int,
) -> dict:
    """Asks the owner, in Twring's Hermes chat, to allow or deny one thing; the phone rings.
    `request_id` is also the idempotency key, so a retried create returns the same approval."""
    body: dict[str, Any] = {
        "local_agent": AGENT_ID,
        "request_id": request_id,
        "title": title[:MAX_APPROVAL_TITLE],
        "description": description[:MAX_APPROVAL_DESCRIPTION],
        "expires_in_s": max(APPROVAL_EXPIRES_MIN_S, min(APPROVAL_EXPIRES_MAX_S, int(expires_in_s))),
    }
    if origin_label:
        body["origin_label"] = origin_label[:MAX_ORIGIN_LABEL]
    try:
        response = await client.post(
            _approval_url(server),
            headers={"authorization": f"Bearer {token}", "idempotency-key": request_id},
            json=body,
        )
    except httpx.HTTPError as error:
        raise LinkError("Could not reach the Twring server.") from error
    if response.status_code not in (200, 201):
        raise LinkError(_error_message(response, f"Twring did not ask for your OK (HTTP {response.status_code})."))
    return _approval_body(response)


async def wait_approval(
    client: httpx.AsyncClient, server: str, token: str, approval_id: str, wait_s: float
) -> dict:
    """Waits up to `wait_s` (at most 25 s) for the owner's answer. An approval the server no longer
    knows (restart, cleanup) is expired: it never becomes an allow."""
    wait = max(0, min(APPROVAL_WAIT_MAX_S, int(wait_s)))
    try:
        response = await client.get(
            _approval_url(server, approval_id),
            params={"wait": wait},
            headers={"authorization": f"Bearer {token}"},
            timeout=wait + 5,
        )
    except httpx.HTTPError as error:
        raise LinkError("Could not reach the Twring server.") from error
    if response.status_code == 404:
        return {"approval_id": approval_id, "status": "expired", "expires_at": ""}
    if response.status_code != 200:
        raise LinkError(_error_message(response, f"Twring did not answer (HTTP {response.status_code})."))
    return _approval_body(response, approval_id)


async def cancel_approval(client: httpx.AsyncClient, server: str, token: str, approval_id: str) -> None:
    """Tells Twring this computer stopped waiting, so the card in the chat stops asking."""
    try:
        response = await client.delete(
            _approval_url(server, approval_id), headers={"authorization": f"Bearer {token}"}
        )
    except httpx.HTTPError as error:
        raise LinkError("Could not reach the Twring server.") from error
    if response.status_code not in (200, 204, 404):
        raise LinkError(_error_message(response, f"Twring did not stop the request (HTTP {response.status_code})."))
