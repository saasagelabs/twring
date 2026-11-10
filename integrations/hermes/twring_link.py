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
from urllib.parse import urlsplit

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
    """Something the person can act on, in plain words. Never carries a token."""


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
        raise LinkError(_error_message(response, f"Twring refused the message (HTTP {response.status_code})."))
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
        raise LinkError(_error_message(response, f"Twring did not ring (HTTP {response.status_code})."))
