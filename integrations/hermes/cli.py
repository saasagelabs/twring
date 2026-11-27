"""`hermes twring link | status | unlink`, and the Twring step in `hermes gateway setup`.

Linking saves the computer token through Hermes's own `.env` route (`save_env_values`); this plugin
never writes a credential file of its own and never prints the token.
"""

from __future__ import annotations

import socket
from typing import Any, Callable, Optional
from urllib.parse import quote

import httpx

try:  # loaded by Hermes as a package
    from .twring_core import CHAT_ID, DEFAULT_SERVER, OWNER_ID, PLUGIN_VERSION
    from .twring_link import LinkError, check_server, start_link, wait_for_approval
except ImportError:  # loaded directly (tests)
    from twring_core import CHAT_ID, DEFAULT_SERVER, OWNER_ID, PLUGIN_VERSION  # type: ignore[no-redef]
    from twring_link import LinkError, check_server, start_link, wait_for_approval  # type: ignore[no-redef]

USER_AGENT = f"twring-hermes/{PLUGIN_VERSION}"


def qr_payload(code: str, server: str) -> str:
    """What the Twring app's scanner reads (same as Twring's own connector)."""
    return f"cord://link?code={code.replace('-', '')}&server={quote(server.rstrip('/'), safe='')}"


def _terminal_qr(payload: str) -> Optional[str]:
    """A QR code drawn in text, when the `qrcode` package is installed; otherwise None."""
    try:
        import io

        import qrcode  # type: ignore[import-not-found]
    except ImportError:
        return None
    qr = qrcode.QRCode(border=1)
    qr.add_data(payload)
    qr.make(fit=True)
    buffer = io.StringIO()
    qr.print_ascii(out=buffer, invert=True)
    return buffer.getvalue().rstrip("\n")


def _hermes_save(**values: str) -> None:
    from hermes_cli.gateway_setup_wizard import save_env_values

    save_env_values(**values)


def _hermes_get(name: str) -> Optional[str]:
    try:
        from hermes_cli.config import get_env_value
    except ImportError:
        return None
    return get_env_value(name)


APPROVAL_QUESTION = "Approve Hermes's commands from your phone? [Y/n] "
_TRANSPORT_KEY = "security.approval.transport"
_FALLBACK_KEY = "security.approval.transport_fallback"


def _hermes_set_config(key: str, value: str) -> None:
    from hermes_cli.config import set_config_value

    set_config_value(key, value)


def _hermes_is_managed() -> bool:
    try:
        from hermes_cli.config import is_managed
    except ImportError:
        return False
    try:
        return bool(is_managed())
    except Exception:
        return False


def _hermes_read_config() -> dict:
    try:
        from hermes_cli.config import load_config_readonly
    except ImportError:
        return {}
    return load_config_readonly() or {}


def set_phone_approvals(on: bool, *, write: Callable[[str, str], None] = _hermes_set_config) -> bool:
    """Turns phone approvals on (Hermes's prompt stays as the fallback) or back to Hermes's defaults.
    Written through Hermes's own config route; False when Hermes refused the change."""
    # Order keeps every half-done state safe: turning on writes the fallback first, so a
    # failed transport write leaves Hermes as it was; turning off clears the transport first.
    if on:
        writes = ((_FALLBACK_KEY, "builtin"), (_TRANSPORT_KEY, "twring"))
    else:
        writes = ((_TRANSPORT_KEY, "builtin"), (_FALLBACK_KEY, "deny"))
    try:
        for key, value in writes:
            write(key, value)
    except (SystemExit, Exception):
        return False
    return True


def phone_approvals_on(read: Callable[[], dict] = _hermes_read_config) -> bool:
    try:
        approval = ((read() or {}).get("security") or {}).get("approval") or {}
    except Exception:
        return False
    return str(approval.get("transport") or "").strip().lower() == "twring"


def approvals_command(
    action: str,
    *,
    out: Callable[[str], None] = print,
    write: Callable[[str, str], None] = _hermes_set_config,
    read: Callable[[], dict] = _hermes_read_config,
    managed: Callable[[], bool] = _hermes_is_managed,
) -> int:
    """`hermes twring approvals on | off | status`."""
    if action in ("on", "off"):
        if managed():
            out("Hermes is managed by a package manager, so it cannot change its own config. Set security.approval.transport in your managed Hermes config instead.")
            return 1
        if not set_phone_approvals(action == "on", write=write):
            out("Hermes did not accept the change. Set security.approval.transport to twring in config.yaml, or try again.")
            return 1
    if phone_approvals_on(read):
        out("Phone approvals are on: Hermes asks for your OK in the Twring app, and asks at the computer if your phone cannot be reached.")
    else:
        out("Phone approvals are off: Hermes asks for your OK at the computer. To answer from your phone:  hermes twring approvals on")
    return 0


def _default_client() -> httpx.Client:
    return httpx.Client(timeout=40.0, follow_redirects=False, headers={"User-Agent": USER_AGENT})


def link_flow(
    *,
    server: Optional[str] = None,
    computer_name: Optional[str] = None,
    out: Callable[[str], None] = print,
    save: Callable[..., None] = _hermes_save,
    client_factory: Callable[[], httpx.Client] = _default_client,
    render_qr: Callable[[str], Optional[str]] = _terminal_qr,
    ask: Optional[Callable[[str], str]] = None,
    set_approvals: Callable[[bool], bool] = set_phone_approvals,
) -> int:
    """Links this Hermes to the owner's Twring account. Returns a process exit code."""
    try:
        base = check_server(server or DEFAULT_SERVER)
    except LinkError as error:
        out(str(error))
        return 1
    name = computer_name or f"{socket.gethostname()} (Hermes)"
    try:
        with client_factory() as client:
            link = start_link(client, base, name)
            out("")
            out("Open Twring on your phone, then Add agent, On my computer, and scan or type the code.")
            qr = render_qr(qr_payload(link.code, base))
            if qr:
                out("")
                out(qr)
            out("")
            out(f"    Code:  {link.code}")
            out("")
            out("Waiting for your phone… (the code works for 10 minutes; Ctrl+C to stop)")
            result = wait_for_approval(client, base, link)
    except LinkError as error:
        out(str(error))
        return 1
    except KeyboardInterrupt:
        out("Stopped. Nothing was saved.")
        return 1
    save(
        TWRING_TOKEN=result.token,
        TWRING_SERVER=base,
        TWRING_ALLOWED_USERS=OWNER_ID,
        TWRING_HOME_CHANNEL=CHAT_ID,
    )
    who = f" to {result.owner_name}'s Twring" if result.owner_name else " to Twring"
    out(f"Linked{who}. Start the gateway so your phone can reach Hermes:  hermes gateway")
    if ask is not None:
        try:
            answer = ask(APPROVAL_QUESTION).strip().lower()
        except (EOFError, KeyboardInterrupt):
            answer = "n"
        if answer in ("", "y", "yes"):
            if set_approvals(True):
                out("Hermes will ask for your OK from your phone, wherever it asked.")
            else:
                out("Hermes did not accept the change. Try:  hermes twring approvals on")
        else:
            out("Hermes keeps asking at the computer. To answer from your phone later:  hermes twring approvals on")
    return 0


def interactive_setup() -> None:
    """The Twring step in `hermes gateway setup`."""
    try:
        from hermes_cli.cli_output import print_info
    except ImportError:
        print_info = print  # type: ignore[assignment]
    print_info("Twring lets you call Hermes from your phone, and lets Hermes call you back.")
    print_info("You need the Twring app (twring.com) signed in on your phone.")
    link_flow(server=_hermes_get("TWRING_SERVER") or DEFAULT_SERVER, ask=input)


def _status(out: Callable[[str], None] = print) -> int:
    token = _hermes_get("TWRING_TOKEN")
    server = _hermes_get("TWRING_SERVER") or DEFAULT_SERVER
    if not token:
        out("Twring is not linked. Run:  hermes twring link")
        return 1
    out(f"Twring is linked ({server}). Calls reach Hermes while `hermes gateway` runs.")
    return 0


def _unlink(out: Callable[[str], None] = print) -> int:
    _hermes_save(TWRING_TOKEN="")
    out("Twring is unlinked on this computer. In the Twring app, open Hermes and tap Delete agent too.")
    return 0


def _setup_parser(parser: Any) -> None:
    sub = parser.add_subparsers(dest="twring_command")
    link = sub.add_parser("link", help="Link this Hermes to your Twring app with a code")
    link.add_argument("--server", default=None, help=f"Twring server (default {DEFAULT_SERVER})")
    link.add_argument("--name", default=None, help="How this computer is named in the app")
    approvals = sub.add_parser("approvals", help="Answer Hermes's approvals from your phone")
    approvals.add_argument("action", nargs="?", choices=("on", "off", "status"), default="status")
    sub.add_parser("status", help="Show whether Twring is linked")
    sub.add_parser("unlink", help="Forget the Twring link on this computer")


def _handle(args: Any) -> int:
    command = getattr(args, "twring_command", None)
    if command == "link":
        return link_flow(server=args.server or _hermes_get("TWRING_SERVER"), computer_name=args.name, ask=input)
    if command == "unlink":
        return _unlink()
    if command == "approvals":
        return approvals_command(getattr(args, "action", "status") or "status")
    return _status()


def register_cli(ctx: Any) -> None:
    ctx.register_cli_command(
        name="twring",
        help="Link Hermes to the Twring phone app",
        description="Call Hermes from your phone and let it call you back (https://twring.com).",
        setup_fn=_setup_parser,
        handler_fn=_handle,
    )
