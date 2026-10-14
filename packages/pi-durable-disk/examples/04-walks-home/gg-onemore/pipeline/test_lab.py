# The strength and bake steps with the model, vLLM and Jev replaced: the clamp file holds each part's encoder row, bias,
# decoder direction and k x its max; strength serves every k in turn and keeps the best composite served, a dark answer
# included (the live guard catches dark sentences); bake keeps it served, says what it is in served.json, and the served
# sampling reaches the check.
#   cd pipeline && python3 -m unittest test_lab
import json
import os
import tempfile
import unittest
from unittest import mock

import torch

import ggc
import lab

F, D = 80000, 8


class Recorder:
    def __init__(self):
        self.lines = []

    def say(self, event, **data):
        self.lines.append((event, data))


class Http:
    """vLLM's worker routes: every clamp the lab serves, in order."""

    def __init__(self):
        self.served = []

    def post(self, url, json=None):
        if url.endswith("/collective_rpc"):
            self.served.append(json["args"][0] if json["method"] == "gg_graph_set" else None)
        return mock.Mock(raise_for_status=lambda: None, json=lambda: {"results": [{"layers": {}}]})


class Jev:
    """Funnier at the middle strength; a dark answer at 1.4; at 1.6 the funniest of all but it stops answering."""

    def ask_many(self, jobs):
        out = []
        for st, qs in jobs:
            k = float(st["answer"].split("k=")[1].split()[0])
            g = {"bridge_thinking": min(4, 2 * k), "bridge_answer": 2 * k, "coherent": 3 if k == 1.6 else 3 - abs(k - 1.2) * 4, "funny": 3 if k == 1.6 else 3 - abs(k - 1.2) * 4}
            n = {"notices": 0.6 if k in (1.2, 1.6) else 0.1, "tries": 0.3 if k == 1.6 else 0.8, "identity": 0.2, "loop": 0.1, "dark_answer": 0.9 if k == 1.4 else 0.01, "dark_thinking": 0.01}
            a = {q: {"probabilities": {str(round(g[q])): 1.0}} for q in g} | {q: {"noul": v} for q, v in n.items()}
            assert set(a) == set(qs)
            out.append(a)
        return out

    def ask(self, state, questions):
        keys = list(questions["a"]["criteria"])
        return {x: {"probabilities": {keys[0]: 1.0}} for x in ("a", "b")}

    def stats(self):
        return {}


def stub_lab(run):
    x = lab.Lab.__new__(lab.Lab)
    g = torch.Generator().manual_seed(0)
    x.sae = {36: {"W_enc": torch.randn(F, D, generator=g), "b_enc": torch.randn(F, generator=g), "W_dec": torch.randn(D, F, generator=g)}}
    x.http = Http()
    x.jev = Jev()
    x.state = {}
    x.chats = []

    def chat(messages, max_tokens=220, tools=None, thinking=None, budget=None, sampling=None):
        x.chats.append(sampling)
        k = x.http.served[-1].split("clamp-k")[1][:-3] if x.http.served and x.http.served[-1] else "0"
        return {"message": {"content": f"An answer at k={k} about the bridge.", "reasoning_content": "thinking"}}
    x.chat = chat
    return x


class ClampTest(unittest.TestCase):
    def setUp(self):
        self.run = tempfile.mkdtemp()
        self.patch = mock.patch.object(lab, "RUN", self.run)
        self.patch.start()

    def tearDown(self):
        self.patch.stop()

    def test_the_clamp_file_holds_each_part_and_its_value(self):
        x = stub_lab(self.run)
        cfg = torch.load(x.clamp_file(1.2), weights_only=True)["layers"][lab.CLAMP["layer"]]
        f = [p["feature"] for p in lab.CLAMP["parts"]]
        self.assertTrue(torch.equal(cfg["W"], x.sae[36]["W_enc"][f]))
        self.assertTrue(torch.equal(cfg["b"], x.sae[36]["b_enc"][f]))
        self.assertTrue(torch.equal(cfg["D"], x.sae[36]["W_dec"][:, f].T))
        self.assertTrue(torch.allclose(cfg["v"], torch.tensor([1.2 * p["max"] for p in lab.CLAMP["parts"]])))

    def test_strength_serves_each_k_and_keeps_the_best_composite_served(self):
        x = stub_lab(self.run)
        with mock.patch.object(lab, "CLAMP", {**lab.CLAMP, "ks": [1.0, 1.2, 1.4]}):
            out = x.strength(Recorder())
        self.assertEqual([os.path.basename(p) for p in x.http.served], ["clamp-k1.pt", "clamp-k1.2.pt", "clamp-k1.4.pt", "clamp-k1.2.pt"])
        self.assertEqual(out["chosen"]["k"], 1.2)
        with open(os.path.join(self.run, "strength.json")) as f:
            st = json.load(f)
        self.assertEqual(st["probes"][2]["dark_any"], len(lab.STRENGTH_PROMPTS) * 2, "the dark strength is logged")
        self.assertEqual(st["probes"][1]["notices_rate"], 1.0)
        self.assertTrue(all(s == lab.CLAMP["sampling"] for s in x.chats), "the probes draw with the served sampling")

    def test_a_dark_answer_does_not_veto_a_strength(self):
        x = stub_lab(self.run)
        with mock.patch.object(lab, "CLAMP", {**lab.CLAMP, "ks": [1.0, 1.4]}):
            out = x.strength(Recorder())
        self.assertEqual(out["chosen"]["k"], 1.4, "1.4 beats 1.0 on the composite; its dark answers are the guard's job")

    def test_a_strength_that_stops_answering_is_not_chosen(self):
        x = stub_lab(self.run)
        with mock.patch.object(lab, "CLAMP", {**lab.CLAMP, "ks": [1.0, 1.6]}):
            out = x.strength(Recorder())
        with open(os.path.join(self.run, "strength.json")) as f:
            st = {p["k"]: p for p in json.load(f)["probes"]}
        self.assertGreater(st[1.6]["composite"], st[1.0]["composite"], "1.6 would win on the composite alone")
        self.assertEqual(out["chosen"]["k"], 1.0, "but it tries to answer 30% of the time")
        self.assertIn("still try to answer 60%", out["why"])

    def test_bake_keeps_the_choice_served_and_says_what_it_is(self):
        x = stub_lab(self.run)
        with mock.patch.object(lab, "CLAMP", {**lab.CLAMP, "ks": [1.0, 1.2]}):
            x.strength(Recorder())
            res = x.bake(Recorder())["served"]
        self.assertEqual(os.path.basename(x.http.served[-1]), "clamp-k1.2.pt")
        with open(os.path.join(self.run, "served.json")) as f:
            served = json.load(f)
        self.assertEqual(served, res)
        self.assertEqual((served["kind"], served["k"], served["layer"]), ("clamp", 1.2, lab.CLAMP["layer"]))
        self.assertEqual(served["values"], [round(1.2 * p["max"], 3) for p in lab.CLAMP["parts"]])
        self.assertEqual(served["sampling"], lab.CLAMP["sampling"])
        self.assertEqual(len(served["sha256"]), 64)
        self.assertTrue(served["showcase"], "Jev picks answers to show")


class GgcTest(unittest.TestCase):
    def test_rates_are_per_reply_and_dark_does_not_weigh(self):
        g = {"bridge_thinking": 3.0, "bridge_answer": 2.0, "notices": 0.7, "tries": 0.8, "coherent": 3.0, "funny": 2.0, "identity": 0.1, "loop": 0.0, "dark_answer": 0.0, "dark_thinking": 0.0}
        a = ggc.summarize([g, {**g, "notices": 0.2}])
        b = ggc.summarize([g, {**g, "notices": 0.2, "dark_answer": 0.9}])
        self.assertEqual(a["notices_rate"], 0.5)
        self.assertEqual(b["dark_any"], 1)
        self.assertEqual(a["composite"], b["composite"])


if __name__ == "__main__":
    unittest.main()
