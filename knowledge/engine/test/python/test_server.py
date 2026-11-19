"""The container's control server (server.py) over real sockets: every connection serves one request and says that it
closes, a request's body is read before the answer and a connection ends without a reset, and every call is safe to
send again after a lost answer (a job id answers its job; a file is written whole or not at all). The query process's
open is safe to ask for twice."""

from __future__ import annotations

import asyncio
import http.client
import json
import select
import socket
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path

import _paths  # noqa: F401
import query
import server

# A stand-in for ops.py: notes each run, waits until the test lets it finish, writes its result.
FAKE_OPS = """
import json, sys, time
from pathlib import Path
args = sys.argv[1:]
result = Path(args[args.index("--result") + 1])
with (result.parent / "runs.log").open("a") as runs:
    runs.write(args[0] + "\\n")
deadline = time.time() + 20
while not (result.parent / "go").exists() and time.time() < deadline:
    time.sleep(0.02)
result.write_text(json.dumps({"op": args[0]}))
"""


class Quiet(server.Handler):
    def log_message(self, fmt, *args):
        pass


class ControlServer(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        names = ("INBOX", "RUN_DIR", "WORK_DIR", "DATA_DIR", "OPS", "_processes")
        self.saved = {name: getattr(server, name) for name in names}
        server.INBOX, server.RUN_DIR, server.WORK_DIR, server.DATA_DIR = root / "inbox", root / "run", root / "work", root / "data"
        for path in (server.INBOX, server.RUN_DIR, server.WORK_DIR, server.DATA_DIR):
            path.mkdir()
        server.OPS = root / "fake_ops.py"
        server.OPS.write_text(FAKE_OPS)
        if not Path("/proc").is_dir():
            server._processes = lambda: []  # no /proc here (macOS); Linux, CI included, runs the real one
        server._jobs.clear()
        server._active = None
        self.httpd = server.Server(("127.0.0.1", 0), Quiet)
        self.port = self.httpd.server_address[1]
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()

    def tearDown(self):
        (server.RUN_DIR / "go").touch()
        deadline = time.monotonic() + 20
        while server._active is not None and time.monotonic() < deadline:
            time.sleep(0.05)
        self.httpd.shutdown()
        self.httpd.server_close()
        for name, value in self.saved.items():
            setattr(server, name, value)
        server._jobs.clear()
        self.tmp.cleanup()

    # ------------------------------------------------------------------ helpers

    def call(self, method: str, path: str, body=None, headers=None, chunked: bool = False):
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        data = json.dumps(body).encode() if isinstance(body, dict) else body
        connection.request(method, path, body=data, headers=headers or {}, encode_chunked=chunked)
        response = connection.getresponse()
        payload = response.read()
        connection.close()
        return response, (json.loads(payload) if payload else None)

    def raw(self) -> socket.socket:
        sock = socket.create_connection(("127.0.0.1", self.port), timeout=10)
        self.addCleanup(sock.close)
        return sock

    @staticmethod
    def read_to_end(sock: socket.socket) -> bytes:
        """Everything the server sends; raises ConnectionResetError if the connection ends with a reset."""
        data = b""
        while True:
            chunk = sock.recv(65536)
            if not chunk:
                return data
            data += chunk

    def wait_job(self, job_id: str) -> dict:
        deadline = time.monotonic() + 20
        while time.monotonic() < deadline:
            _, job = self.call("GET", f"/jobs/{job_id}")
            if job["state"] != "running":
                return job
            time.sleep(0.05)
        self.fail(f"job {job_id} never finished")

    # ------------------------------------------------------------------ connections

    def test_every_answer_says_its_connection_closes(self):
        # The Durable Object's fetch pools connections: without this header it sent its next call, made right after
        # the last, on the connection this server was closing, and lost it ("Network connection lost.").
        for method, path in (("GET", "/health"), ("GET", "/jobs/none"), ("POST", "/cleanup"), ("DELETE", "/inbox/b1")):
            response, _ = self.call(method, path, body={} if method == "POST" else None)
            self.assertEqual(response.getheader("connection"), "close", f"{method} {path}")
        (server.DATA_DIR / "facts.json").write_text("{}")
        response, _ = self.call("GET", "/files/facts.json")
        self.assertEqual(response.getheader("connection"), "close", "a file too")

    def test_a_body_the_route_does_not_use_is_read_before_the_answer(self):
        # POST /cleanup, /query/start and /query/stop never read the "{}" the Durable Object sends; closing with it
        # unread resets the connection, which can take the answer with it.
        sock = self.raw()
        sock.sendall(b"POST /cleanup HTTP/1.1\r\nHost: engine\r\nContent-Type: application/json\r\nContent-Length: 2\r\n\r\n")
        readable, _, _ = select.select([sock], [], [], 0.5)
        self.assertEqual(readable, [], "no answer before the body has arrived")
        sock.sendall(b"{}")
        answer = self.read_to_end(sock)
        self.assertTrue(answer.startswith(b"HTTP/1.0 200"), answer[:40])

    def test_a_connection_ends_without_a_reset(self):
        # A client that sends more on a connection after its answer (a pooled connection reused) gets a clean close.
        sock = self.raw()
        sock.sendall(b"GET /health HTTP/1.1\r\nHost: engine\r\n\r\n")
        head = b""
        while b"\r\n\r\n" not in head:
            head += sock.recv(1)
        length = int([line for line in head.split(b"\r\n") if line.lower().startswith(b"content-length:")][0].split(b":")[1])
        body = b""
        while len(body) < length:
            body += sock.recv(length - len(body))
        time.sleep(0.2)  # the server has answered and stopped sending
        sock.sendall(b"GET /health HTTP/1.1\r\nHost: engine\r\n\r\n")
        time.sleep(0.2)
        sock.shutdown(socket.SHUT_WR)
        self.assertEqual(self.read_to_end(sock), b"", "a FIN, not a reset, and no second answer")

    # ------------------------------------------------------------------ jobs

    def test_a_job_id_answers_its_job_and_starts_nothing_more(self):
        response, job = self.call("POST", "/jobs", {"op": "stats", "args": {}, "id": "stats-try1"})
        self.assertEqual((response.status, job["id"], job["state"]), (202, "stats-try1", "running"))
        response, again = self.call("POST", "/jobs", {"op": "stats", "args": {}, "id": "stats-try1"})
        self.assertEqual((response.status, again["id"], again["state"]), (200, "stats-try1", "running"), "sent again while it runs")
        response, other = self.call("POST", "/jobs", {"op": "stats", "args": {}, "id": "stats-try2"})
        self.assertEqual((response.status, other["error"]), (409, "busy"), "another id still waits its turn")
        response, conflict = self.call("POST", "/jobs", {"op": "manifest", "args": {}, "id": "stats-try1"})
        self.assertEqual((response.status, conflict["error"]), (409, "job id in use"), "an id names one request")
        (server.RUN_DIR / "go").touch()
        self.assertEqual(self.wait_job("stats-try1")["state"], "succeeded")
        response, done = self.call("POST", "/jobs", {"op": "stats", "args": {}, "id": "stats-try1"})
        self.assertEqual((response.status, done["state"], done["result"]), (200, "succeeded", {"op": "stats"}), "sent again once finished")
        self.assertEqual((server.RUN_DIR / "runs.log").read_text().split(), ["stats"], "one process, however often it was sent")

    def test_a_job_without_an_id_gets_one_and_a_bad_id_is_refused(self):
        (server.RUN_DIR / "go").touch()
        response, job = self.call("POST", "/jobs", {"op": "manifest"})
        self.assertEqual(response.status, 202)
        self.assertTrue(job["id"].startswith("manifest-"))
        self.wait_job(job["id"])
        response, refused = self.call("POST", "/jobs", {"op": "manifest", "id": "../x"})
        self.assertEqual((response.status, refused["error"]), (400, "invalid job id"))

    def test_cleanup_keeps_only_the_running_jobs_files(self):
        # Ids are the caller's now, so one can begin with another: only the running job's own files are kept.
        self.call("POST", "/jobs", {"op": "stats", "id": "stats-1"})
        for name in ("stats-10.log", "stats-10.result.json", "query.log"):
            (server.RUN_DIR / name).write_text("x")
        self.call("POST", "/cleanup", {})
        left = sorted(p.name for p in server.RUN_DIR.iterdir())
        self.assertNotIn("stats-10.log", left)
        self.assertNotIn("query.log", left)
        self.assertIn("stats-1.log", left)

    # ------------------------------------------------------------------ files

    def test_writing_the_same_inbox_file_again_is_harmless(self):
        content = b"The gateway listens on port 8443.\n" * 2000
        for _ in range(2):
            response, _ = self.call("PUT", "/inbox/b1/f1", content)
            self.assertEqual(response.status, 201)
        target = server.INBOX / "b1" / "f1"
        self.assertEqual(target.read_bytes(), content)

        # Two sends of it at once (a retry while the first, whose answer was lost, still runs): one whole copy.
        first = self.raw()
        first.sendall(b"PUT /inbox/b1/f1 HTTP/1.1\r\nHost: engine\r\nContent-Length: %d\r\n\r\n" % len(content) + content[:1000])
        time.sleep(0.2)
        response, _ = self.call("PUT", "/inbox/b1/f1", content)
        self.assertEqual(response.status, 201)
        first.sendall(content[1000:])
        self.assertTrue(self.read_to_end(first).startswith(b"HTTP/1.0 201"))
        self.assertEqual(target.read_bytes(), content)

        # A send cut short leaves the file as it was, and nothing half-written beside it.
        cut = self.raw()
        cut.sendall(b"PUT /inbox/b1/f1 HTTP/1.1\r\nHost: engine\r\nContent-Length: %d\r\n\r\n" % len(content) + content[:500])
        time.sleep(0.2)
        cut.close()
        deadline = time.monotonic() + 5
        while len(list((server.INBOX / "b1").iterdir())) > 1 and time.monotonic() < deadline:
            time.sleep(0.05)
        self.assertEqual(target.read_bytes(), content)
        self.assertEqual([p.name for p in (server.INBOX / "b1").iterdir()], ["f1"])

        for _ in range(2):
            response, _ = self.call("DELETE", "/inbox/b1")
            self.assertEqual(response.status, 200, "deleting twice is fine too")
        self.assertFalse((server.INBOX / "b1").exists())

    def test_a_body_of_unknown_length_is_stored_whole(self):
        # The Durable Object's fetch sends a stream whose length it doesn't know chunked: it was stored as an empty file.
        parts = [b"Write to ", b"dana.reyes@example.com ", b"about the gateway."]
        response, _ = self.call("PUT", "/inbox/b2/f2", iter(parts), chunked=True)
        self.assertEqual(response.status, 201)
        self.assertEqual((server.INBOX / "b2" / "f2").read_bytes(), b"".join(parts))


class QueryOpen(unittest.TestCase):
    """POST /query/open asked again (a retry after a lost answer) changes nothing: the databases open once."""

    def test_open_twice_opens_once(self):
        opened = []

        async def fake_open():
            opened.append(1)
            await asyncio.sleep(0.2)
            query.STATE.update(state="ready")

        saved = query.open_databases, dict(query.STATE)
        query.open_databases = fake_open
        query.STATE.update(state="loaded")
        threading.Thread(target=query.LOOP.run_forever, daemon=True).start()
        httpd = server.ThreadingHTTPServer(("127.0.0.1", 0), query.Handler)
        threading.Thread(target=httpd.serve_forever, daemon=True).start()
        try:
            states = []
            for _ in range(3):
                connection = http.client.HTTPConnection("127.0.0.1", httpd.server_address[1], timeout=10)
                connection.request("POST", "/open", body=b"{}", headers={"content-type": "application/json"})
                response = connection.getresponse()
                states.append((response.status, json.loads(response.read())["state"]))
                connection.close()
            deadline = time.monotonic() + 5
            while query.STATE["state"] != "ready" and time.monotonic() < deadline:
                time.sleep(0.05)
            self.assertEqual([s for s, _ in states], [202, 202, 202])
            self.assertEqual(query.STATE["state"], "ready")
            self.assertEqual(len(opened), 1)
        finally:
            httpd.shutdown()
            httpd.server_close()
            query.LOOP.call_soon_threadsafe(query.LOOP.stop)
            query.open_databases = saved[0]
            query.STATE.clear()
            query.STATE.update(saved[1])


if __name__ == "__main__":
    unittest.main()
