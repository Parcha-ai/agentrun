"""find's hosted-model client, without a model: policy and passages go to the engine's --llm-url (not the public
endpoint), and the client is closed when a find ends, a refusal included. Needs torch and numpy (obsession_find's
imports) and httpx."""
import json, os, shutil, tempfile, threading, unittest, warnings
from http.server import BaseHTTPRequestHandler, HTTPServer

import obsession_find as F

REFUSAL = dict(allowed=False, kind="private individual", why="a private person", real_person=False, name="Dave", category="people")


class Stub(BaseHTTPRequestHandler):
    seen = []

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["content-length"])))
        Stub.seen.append((self.path, body.get("model")))
        out = json.dumps(dict(choices=[dict(message=dict(content=json.dumps(REFUSAL)))], usage={})).encode()
        self.send_response(200); self.send_header("content-type", "application/json"); self.send_header("content-length", str(len(out)))
        self.end_headers(); self.wfile.write(out)

    def log_message(self, *a):
        pass


class FindUsesTheEngineEndpoint(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.srv = HTTPServer(("127.0.0.1", 0), Stub)
        threading.Thread(target=cls.srv.serve_forever, daemon=True).start()
        cls.url = f"http://127.0.0.1:{cls.srv.server_address[1]}/v1"

    @classmethod
    def tearDownClass(cls):
        cls.srv.shutdown(); cls.srv.server_close()

    def setUp(self):
        Stub.seen = []
        self.out = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.out, ignore_errors=True)
        # Nothing may reach a public endpoint from a test: any request not sent to the stub fails at once.
        for k in ("HTTPS_PROXY", "https_proxy"):
            self.addCleanup(os.environ.__setitem__, k, os.environ[k]) if k in os.environ else self.addCleanup(os.environ.pop, k, None)
            os.environ[k] = "http://127.0.0.1:9"
        self.made = []
        real = F.LLM

        class Recording(real):
            def __init__(inner, *a, **kw):
                super().__init__(*a, **kw)
                self.made.append(inner)
        F.LLM = Recording
        self.addCleanup(setattr, F, "LLM", real)

    def find(self):
        lines = []
        S = dict(llm_url=self.url, llm_model="stub-model", bank=None, preset={})
        with warnings.catch_warnings(record=True) as w:
            warnings.simplefilter("always", ResourceWarning)
            F.find(S, "Make a model obsessed with my neighbour Dave.", self.out, lines.append, threading.Lock())
            import gc; gc.collect()
        return lines, [x for x in w if issubclass(x.category, ResourceWarning)]

    def test_policy_goes_to_the_engine_url(self):
        lines, _ = self.find()
        self.assertEqual([l["event"] for l in lines], ["topic", "refused"])
        self.assertEqual(Stub.seen, [("/v1/chat/completions", "stub-model")])

    def test_the_client_is_closed_after_a_refusal(self):
        _, leaks = self.find()
        self.assertEqual(len(self.made), 1)
        self.assertTrue(self.made[0].c.is_closed)
        self.assertEqual(leaks, [], [str(x.message) for x in leaks])

    def test_llm_closes_as_a_context_manager(self):
        with F.LLM(base=self.url, model="m") as llm:
            pass
        self.assertTrue(llm.c.is_closed)


if __name__ == "__main__":
    unittest.main()
