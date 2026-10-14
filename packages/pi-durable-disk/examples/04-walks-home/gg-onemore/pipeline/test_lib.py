# The agent's library (pipeline/lib.py) over a stand-in lab: a clamp is checked before anything is served (the layers the
# server says it clamps, its number of parts, a part given twice, its values, its sampling), /try serves it for one call
# and puts back what served.json says is served even when the draw fails, /serve is the one way the served model changes,
# and /features counts what fires on the texts and says how many it cut.
#   cd pipeline && python3 -m unittest test_lib
import json
import os
import tempfile
import threading
import unittest
from unittest import mock

import torch
from fastapi.testclient import TestClient

import lib

F, D = 64, 8


class StubLab:
    def __init__(self):
        g = torch.Generator().manual_seed(0)
        self.sae = {L: {"W_enc": torch.randn(F, D, generator=g), "b_enc": torch.zeros(F), "W_dec": torch.randn(D, F, generator=g)} for L in (32, 36)}
        self.lock = threading.Lock()
        self.serving = []
        self.written = []
        self.served = None  # served.json's clamp file
        self.tok = lambda texts, padding=False: {"input_ids": [[0] * (600 if "LONG" in t else 5) for t in texts]}
        self.passages = {"gg": ["the bridge"], "neutral": ["a cat"]}
        self.fail_draw = False

    def median_norm(self, L):
        return 80.0

    def graph_layers(self):
        # the server's clamp buffers: 36 and 32, not 40 (the lab has no 40 either)
        return [32, 36]

    def served_file(self):
        return self.served

    def clamp_tensors(self, per, pulse=0):
        path = os.path.join(tempfile.mkdtemp(), f"clamp-{len(self.serving)}.pt")
        torch.save({"per": per, "pulse": pulse}, path)
        return path

    def serve(self, path):
        self.serving.append(path)

    def draw(self, prompts, n, sampling, thinking=True, max_tokens=700):
        if self.fail_draw:
            raise RuntimeError("vLLM went away")
        return [{"q": q, "thinking": "", "answer": f"served {os.path.basename(self.serving[-1] or 'none')}"} for q in prompts for _ in range(n)]

    def write_served(self, clamp):
        self.written.append(clamp)
        self.served = clamp["file"] if clamp else None

    def residuals(self, texts, layers):
        # three tokens per text
        T = 3 * len(texts)
        return {L: torch.zeros(T, D) for L in layers}, None, torch.arange(T) // 3, torch.arange(T) % 3, torch.zeros(T, dtype=torch.long)

    def encode(self, L, H):
        # every token fires feature 5 at 2.0 and feature 9 at 1.0, the third token also feature 7 at 4.0
        T = H.shape[0]
        idx = torch.tensor([[5, 9, 7]] * T)
        val = torch.tensor([[2.0, 1.0, 0.0]] * T)
        val[2::3, 2] = 4.0
        return idx, val


def part(L=36, f=1, v=20.0):
    return {"layer": L, "feature": f, "value": v}


class LibTest(unittest.TestCase):
    def setUp(self):
        self.lab = StubLab()
        self.patches = [mock.patch.object(lib, "FMAX", 4), mock.patch.object(lib, "OUT", tempfile.mkdtemp())]
        for p in self.patches:
            p.start()
        self.c = TestClient(lib.create_lib_app(self.lab))

    def tearDown(self):
        for p in self.patches:
            p.stop()

    def refused(self, clamp, why):
        # as gglab sends it: Python's json writes NaN as is
        r = self.c.post("/serve", content=json.dumps({"clamp": clamp}), headers={"content-type": "application/json"})
        self.assertEqual(r.status_code, 400, r.text)
        self.assertIn(why, r.json()["error"])
        self.assertEqual(self.lab.serving, [], "nothing was served")

    def test_a_clamp_is_checked_before_anything_is_served(self):
        self.refused({"parts": []}, "clamp:")
        self.refused({"parts": [part(L=28)]}, "the server clamps at [32, 36]")
        self.refused({"parts": [part(f=F)]}, "part feature")
        self.refused({"parts": [part(v=321.0)]}, "0 to 320.0")
        self.refused({"parts": [part(v=float("nan"))]}, "part value")
        self.refused({"parts": [part(f=i) for i in range(5)]}, "at most 4 parts")
        self.refused({"parts": [part(f=2), part(f=2, v=5.0)]}, "feature 2: given twice")
        self.refused({"parts": [part()], "sampling": {"max_tokens": 9}}, "sampling max_tokens")
        self.refused({"parts": [part()], "sampling": {"temperature": 3}}, "sampling temperature")

    def test_serve_is_the_one_way_the_served_model_changes(self):
        r = self.c.post("/serve", json={"clamp": {"parts": [part(f=1), part(L=32, f=2, v=5.0)], "sampling": {"presence_penalty": 1.5}}, "note": "why"})
        self.assertEqual(r.status_code, 200)
        served = r.json()["served"]
        self.assertEqual(self.lab.serving, [served["file"]])
        self.assertEqual(torch.load(served["file"], weights_only=True)["per"], {36: [(1, 20.0)], 32: [(2, 5.0)]})
        self.assertEqual((served["sampling"], served["note"]), ({"presence_penalty": 1.5}, "why"))
        self.assertEqual(self.lab.written, [served], "served.json, for the guard's control and sampling")
        self.assertEqual(self.c.post("/serve", json={"clamp": None}).json(), {"served": None})
        self.assertEqual(self.lab.serving[-1], None)

    def test_try_serves_for_one_call_and_puts_the_served_clamp_back(self):
        self.c.post("/try", json={"clamp": {"parts": [part(f=3)]}, "prompts": ["hi"]})
        self.assertEqual(self.lab.serving[-1], None, "nothing served: the unedited model is back")
        # what bake served, or a restarted lab finds: served.json is the truth, not the library's memory
        self.lab.served = "/var/tmp/gg/run/clamp-k1.2.pt"
        self.c.post("/try", json={"clamp": {"parts": [part(f=3)]}, "prompts": ["hi"]})
        self.assertEqual(self.lab.serving[-1], "/var/tmp/gg/run/clamp-k1.2.pt")
        self.c.post("/serve", json={"clamp": {"parts": [part()]}})
        kept = self.lab.serving[-1]
        r = self.c.post("/try", json={"clamp": {"parts": [part(f=3)]}, "prompts": ["hi", "yo"], "n": 2, "thinking": False, "max_tokens": 64})
        self.assertEqual(r.status_code, 200)
        self.assertEqual(len(r.json()["replies"]), 4)
        self.assertEqual(self.lab.serving[-1], kept, "the served clamp is back")
        self.lab.fail_draw = True
        with self.assertRaises(RuntimeError):
            self.c.post("/try", json={"clamp": {"parts": [part(f=4)]}, "prompts": ["hi"]})
        self.assertEqual(self.lab.serving[-1], kept, "even when the draw fails")
        self.assertEqual(self.c.post("/try", json={"clamp": {"parts": [part()]}, "prompts": ["hi"], "n": 9}).status_code, 400)

    def test_try_with_no_clamp_samples_the_unedited_model_and_puts_the_served_clamp_back(self):
        self.lab.served = "/var/tmp/gg/run/clamp-k1.2.pt"
        self.assertEqual(self.c.post("/try", json={"clamp": None, "prompts": ["hi"], "sampling": {"max_tokens": 5}}).status_code, 400)
        self.assertEqual(self.c.post("/try", json={"clamp": None, "prompts": ["hi"], "sampling": [1]}).status_code, 400)
        self.assertEqual(self.lab.serving, [], "a bad request serves nothing")
        r = self.c.post("/try", json={"clamp": None, "prompts": ["hi"], "sampling": {"temperature": 0.9}})
        self.assertEqual(r.status_code, 200)
        self.assertEqual(self.lab.serving[-2:], [None, "/var/tmp/gg/run/clamp-k1.2.pt"], "off for the call, the served clamp back after")

    def test_features_counts_what_fires_on_the_texts(self):
        r = self.c.post("/features", json={"layer": 36, "texts": ["a", "b"]})
        self.assertEqual(r.json()["tokens"], 6)
        f = torch.load(r.json()["path"], weights_only=True)
        self.assertAlmostEqual(float(f["rate"][5]), 1.0)
        self.assertAlmostEqual(float(f["rate"][7]), 2 / 6)
        self.assertAlmostEqual(float(f["mean"][7]), 8 / 6)
        self.assertAlmostEqual(float(f["max"][7]), 4.0)
        self.assertEqual(float(f["rate"][0]), 0.0)
        self.assertEqual(r.json()["truncated"], 0)
        self.assertEqual(self.c.post("/features", json={"layer": 36, "texts": ["a", "a LONG one"]}).json()["truncated"], 1, "the agent is told a text was cut")
        self.assertEqual(self.c.post("/features", json={"layer": 24, "texts": ["a"]}).status_code, 400)

    def test_status_reports_the_layers_the_server_clamps(self):
        st = self.c.post("/status", json={}).json()
        self.assertEqual(st["clamp_layers"], [32, 36])
        self.assertEqual(st["served"], None)


if __name__ == "__main__":
    unittest.main()
