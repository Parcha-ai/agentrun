"""find_obsession.py against a stub engine: the request bytes arrive verbatim as data (a hostile string runs nothing),
progress lines land in the file in order, and the exit codes follow the last event."""
import json, os, shutil, subprocess, sys, tempfile, threading, unittest
from http.server import BaseHTTPRequestHandler, HTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
CLI = os.path.join(HERE, "find_obsession.py")


class Stub(BaseHTTPRequestHandler):
    seen = []
    script = []

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["content-length"])))
        Stub.seen.append(body)
        self.send_response(200); self.send_header("content-type", "application/x-ndjson"); self.end_headers()
        for line in Stub.script:
            self.wfile.write((json.dumps(line) + "\n").encode()); self.wfile.flush()

    def log_message(self, *a):
        pass


class CliTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.srv = HTTPServer(("127.0.0.1", 0), Stub)
        threading.Thread(target=cls.srv.serve_forever, daemon=True).start()
        cls.url = f"http://127.0.0.1:{cls.srv.server_address[1]}"

    @classmethod
    def tearDownClass(cls):
        cls.srv.shutdown()
        cls.srv.server_close()

    def run_cli(self, content, script):
        Stub.script, Stub.seen = script, []
        d = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, d, ignore_errors=True)
        tf = os.path.join(d, "request.txt")
        with open(tf, "wb") as f:
            f.write(content)
        p = subprocess.run([sys.executable, "-I", CLI, "--topic-file", tf, "--out", os.path.join(d, "find"), "--engine", self.url],
                           capture_output=True, text=True, timeout=60, cwd=d)
        prog = os.path.join(d, "find", "progress.jsonl")
        lines = []
        if os.path.exists(prog):
            with open(prog) as f:
                lines = [json.loads(l) for l in f]
        return p.returncode, lines, d

    def test_hostile_request_is_data(self):
        marker = os.path.join(tempfile.gettempdir(), f"pwned-{os.getpid()}")
        hostile = f'Make a model obsessed with x"; touch {marker}; echo "$(touch {marker})`touch {marker}`'.encode()
        code, lines, _ = self.run_cli(hostile, [dict(event="topic", topic="x", allowed=False, t=0.1), dict(event="refused", why="no topic", t=0.2)])
        self.assertEqual(code, 3)
        self.assertEqual(Stub.seen[0]["request"], hostile.decode())
        self.assertFalse(os.path.exists(marker), "the request must never run")
        self.assertEqual([l["event"] for l in lines], ["topic", "refused"])

    def test_done_and_order(self):
        script = [dict(event="topic", topic="pizza", allowed=True, t=0.1), dict(event="feature", rank=1, t=1.0), dict(event="done", seconds=2.0, t=2.0)]
        code, lines, _ = self.run_cli(b"Make a model obsessed with pizza.", script)
        self.assertEqual(code, 0)
        self.assertEqual([l["event"] for l in lines], ["topic", "feature", "done"])

    def test_error_and_unfinished(self):
        self.assertEqual(self.run_cli(b"pizza", [dict(event="error", message="boom", t=0.1)])[0], 1)
        code, lines, _ = self.run_cli(b"pizza", [dict(event="topic", topic="pizza", allowed=True, t=0.1)])
        self.assertEqual(code, 1)
        self.assertEqual(lines[-1]["event"], "error")

    def test_bad_files(self):
        self.assertEqual(self.run_cli(b"", [])[0], 2)
        self.assertEqual(self.run_cli(b"x" * 2001, [])[0], 2)
        bad = self.run_cli("pizza \udcff".encode("utf-8", "surrogateescape"), [dict(event="done", seconds=1, t=1)])
        self.assertEqual(bad[0], 0)  # invalid UTF-8 is replaced, never fatal


if __name__ == "__main__":
    unittest.main()
