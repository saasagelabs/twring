"""A standard-library cord-rest/1 echo agent. Run with Python 3.11 or newer."""

import argparse
import hmac
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
import select
import threading
import uuid


class EchoServer(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, address, token="dev-token", delay=0.04):
        super().__init__(address, EchoHandler)
        self.token = token
        self.delay = delay
        self.seen = set()
        self.seen_lock = threading.Lock()


def bounded_string(value, limit, nonempty=False):
    if not isinstance(value, str) or (nonempty and not value):
        return False
    try:
        # Match the TypeScript schemas' UTF-16 lengths; refuse unpaired surrogates.
        return len(value.encode("utf-16-le")) <= limit * 2
    except UnicodeError:
        return False


def valid_turn(value):
    if not isinstance(value, dict) or value.get("protocol") != "cord-rest/1":
        return False
    for name in ("session_id", "call_id", "turn_id"):
        if not bounded_string(value.get(name), 128, nonempty=True):
            return False
    for name, limit in (("text", 8192), ("started_at", 64), ("committed_at", 64)):
        if not bounded_string(value.get(name), limit):
            return False
    return value.get("surface", "call") in ("call", "text")


class EchoHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *_args):
        pass  # Never log the bearer token, request text, or request path/query.

    def status(self, code):
        self.send_response(code)
        self.send_header("Content-Length", "0")
        self.send_header("Connection", "close")
        self.end_headers()

    def do_POST(self):
        self.close_connection = True
        self.connection.settimeout(10)
        try:
            self.handle_turn()
        except (OSError, TimeoutError):
            pass  # A disconnected peer cancels this turn, not the server.

    def handle_turn(self):
        if self.path != "/cord/turns":
            return self.status(404)
        expected = ("Bearer " + self.server.token).encode("utf-8")
        if not hmac.compare_digest(self.headers.get("Authorization", "").encode("utf-8"), expected):
            return self.status(401)
        if self.headers.get("Content-Type", "").split(";", 1)[0].strip().lower() != "application/json":
            return self.status(415)
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if not 0 < length <= 65536:
                return self.status(413)
            raw = self.rfile.read(length)
            if len(raw) != length:
                return self.status(400)
            turn = json.loads(raw)
        except (ValueError, UnicodeError):
            return self.status(400)
        if not valid_turn(turn) or self.headers.get("Idempotency-Key") != turn["turn_id"]:
            return self.status(400)
        with self.server.seen_lock:
            if turn["turn_id"] in self.server.seen:
                return self.status(409)
            # Refuse new turns rather than evict keys and risk running a retry twice.
            if len(self.server.seen) >= 10000:
                return self.status(503)
            self.server.seen.add(turn["turn_id"])
        self.stream_answer(turn)

    def stream_answer(self, turn):
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream; charset=utf-8")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Connection", "close")
        self.end_headers()
        stream_id = uuid.uuid4().hex
        message_id = "msg_" + stream_id
        seq = 0

        def event(kind, **fields):
            nonlocal seq
            event_id = f"{stream_id}_{seq}"
            body = dict(type=kind, event_id=event_id, turn_id=turn["turn_id"], seq=seq, **fields)
            wire = f"event: {kind}\nid: {event_id}\ndata: {json.dumps(body, ensure_ascii=False)}\n\n"
            self.wfile.write(wire.encode("utf-8"))
            self.wfile.flush()
            seq += 1

        event("run.started")
        event("text.start", message_id=message_id)
        chunks = ["Echo: "] + [turn["text"][i:i + 32] for i in range(0, len(turn["text"]), 32)]
        for chunk in chunks:
            event("text.delta", message_id=message_id, delta=chunk)
            # Wait on the socket, not sleep: a closing request interrupts even a long delay.
            if select.select([self.connection], [], [], self.server.delay)[0]:
                return
        event("text.end", message_id=message_id)
        event("done", status="completed")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8789)
    args = parser.parse_args()
    token = os.environ.get("PYTHON_AGENT_TOKEN", "dev-token")
    if not token:
        parser.error("PYTHON_AGENT_TOKEN must not be empty")
    if args.host not in ("127.0.0.1", "localhost") and token == "dev-token":
        parser.error("set a private PYTHON_AGENT_TOKEN before binding outside loopback")
    with EchoServer((args.host, args.port), token) as server:
        print(f"Python cord-rest/1 echo agent: http://{args.host}:{server.server_port}/cord/turns", flush=True)
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            pass


if __name__ == "__main__":
    main()
