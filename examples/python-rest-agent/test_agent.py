"""Wire tests, using real loopback HTTP connections and no external services."""

import http.client
from concurrent.futures import ThreadPoolExecutor
import json
import threading
import unittest
from unittest.mock import patch

from agent import EchoHandler, EchoServer


class EchoTests(unittest.TestCase):
    def setUp(self):
        self.server = EchoServer(("127.0.0.1", 0), delay=0)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.addCleanup(self.server.server_close)
        self.addCleanup(self.server.shutdown)

    def turn(self):
        return dict(protocol="cord-rest/1", session_id="call_1", call_id="call_1",
                    turn_id="turn_1", text="Hello from Python. " * 5,
                    started_at="2026-11-28T00:00:00Z",
                    committed_at="2026-11-28T00:00:01Z")

    def request(self, body=None, headers=None, path="/cord/turns"):
        connection = http.client.HTTPConnection("127.0.0.1", self.server.server_port, timeout=3)
        self.addCleanup(connection.close)
        fields = {"Authorization": "Bearer dev-token", "Content-Type": "application/json",
                  "Idempotency-Key": "turn_1"}
        fields.update(headers or {})
        if body is None:
            body = json.dumps(self.turn()).encode("utf-8")
        connection.request("POST", path, body, fields)
        response = connection.getresponse()
        self.addCleanup(response.close)
        return response

    def test_stream_is_ordered_valid_sse_and_echoes_the_text(self):
        response = self.request()
        self.assertEqual(response.status, 200)
        self.assertTrue(response.getheader("Content-Type").startswith("text/event-stream"))
        blocks = response.read().decode("utf-8").strip().split("\n\n")
        events, ids = [], []
        for block in blocks:
            fields = dict(line.split(": ", 1) for line in block.splitlines())
            event = json.loads(fields["data"])
            self.assertEqual(fields["event"], event["type"])
            self.assertEqual(fields["id"], event["event_id"])
            self.assertEqual(event["turn_id"], "turn_1")
            events.append(event)
            ids.append(event["event_id"])
        kinds = [event["type"] for event in events]
        self.assertEqual(kinds[:2], ["run.started", "text.start"])
        self.assertEqual(kinds[-2:], ["text.end", "done"])
        self.assertGreater(kinds.count("text.delta"), 1)
        self.assertEqual(events[-1]["status"], "completed")
        self.assertEqual([e["seq"] for e in events], list(range(len(events))))
        self.assertEqual(len(set(ids)), len(ids))
        self.assertEqual("".join(e["delta"] for e in events if e["type"] == "text.delta"),
                         "Echo: " + self.turn()["text"])

    def test_auth_and_path_refusals_do_not_accept_a_turn(self):
        for headers, path, status in (({"Authorization": "Bearer wrong"}, "/cord/turns", 401),
                                      ({"Authorization": ""}, "/cord/turns", 401),
                                      ({}, "/other", 404)):
            with self.subTest(status=status):
                response = self.request(headers=headers, path=path)
                self.assertEqual(response.status, status)
                response.read()
        self.assertEqual(self.request().status, 200)

    def test_bad_json_schema_size_and_idempotency_headers_are_refused(self):
        for body, headers, status in ((b"{", {}, 400), (b"[]", {}, 400),
                                      (b'{"protocol":"wrong"}', {}, 400),
                                      (b"x" * 65537, {}, 413),
                                      (None, {"Content-Type": "text/plain"}, 415),
                                      (None, {"Idempotency-Key": "wrong"}, 400)):
            with self.subTest(status=status):
                response = self.request(body, headers)
                self.assertEqual(response.status, status)
                response.read()
        self.assertEqual(self.request().status, 200)

    def test_duplicate_turn_never_starts_a_second_stream(self):
        response = self.request()
        self.assertEqual(response.status, 200)
        response.read()
        response = self.request()
        self.assertEqual(response.status, 409)
        self.assertEqual(response.read(), b"")

    def test_unicode_round_trip(self):
        turn = self.turn()
        turn["text"] = "Xin chao 🐍\nBonjour!"
        response = self.request(json.dumps(turn, ensure_ascii=False).encode("utf-8"))
        data = response.read().decode("utf-8")
        events = [json.loads(line[6:]) for line in data.splitlines() if line.startswith("data: ")]
        self.assertEqual("".join(e["delta"] for e in events if e["type"] == "text.delta"),
                         "Echo: " + turn["text"])

    def test_text_limits_match_utf16_and_invalid_unicode_is_refused(self):
        for text in ("🐍" * 4097, "\ud800"):
            turn = self.turn()
            turn["text"] = text
            response = self.request(json.dumps(turn).encode())
            self.assertEqual(response.status, 400)
            response.read()
        turn["text"] = "🐍" * 4096
        response = self.request(json.dumps(turn).encode())
        self.assertEqual(response.status, 200)
        self.assertIn(b"event: done", response.read())

    def test_concurrent_duplicate_requests_accept_only_one(self):
        ready = threading.Barrier(2)

        def send():
            ready.wait(timeout=2)
            response = self.request()
            response.read()
            return response.status

        with ThreadPoolExecutor(max_workers=2) as workers:
            statuses = list(workers.map(lambda _: send(), range(2)))
        self.assertEqual(sorted(statuses), [200, 409])

    def test_disconnect_interrupts_a_long_chunk_delay(self):
        self.server.delay = 10
        stopped = threading.Event()
        original = EchoHandler.stream_answer

        def observed(handler, turn):
            try:
                return original(handler, turn)
            finally:
                stopped.set()

        with patch.object(EchoHandler, "stream_answer", observed):
            response = self.request()
            self.assertEqual(response.status, 200)
            self.assertEqual(response.readline().strip(), b"event: run.started")
            response.close()
            self.assertTrue(stopped.wait(2), "disconnect left the generator waiting for 10 seconds")
        # A cancelled key stays consumed; a different turn still works.
        self.server.delay = 0
        self.assertEqual(self.request().status, 409)
        turn = self.turn()
        turn["turn_id"] = "turn_2"
        response = self.request(json.dumps(turn).encode(), {"Idempotency-Key": "turn_2"})
        self.assertEqual(response.status, 200)
        self.assertIn(b"event: done", response.read())


if __name__ == "__main__":
    unittest.main()
