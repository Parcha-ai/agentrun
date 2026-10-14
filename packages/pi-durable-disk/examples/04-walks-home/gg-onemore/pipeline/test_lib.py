# The agent's library (pipeline/lib.py) over a stand-in lab: a clamp is checked before anything is served (the layers the
# server says it clamps, its number of parts, a part given twice, its values, its sampling), /try serves it for one call
# and puts back what served.json says is served even when the draw fails, /serve is the one way the served model changes,
# and /features counts what fires on the texts and says how many it cut. For any topic: /grade asks the topic's rubric of
# every reply, /direction measures a mean difference a clamp can add, /serve with a topic saves a recipe and /load serves
# it again through the same check.
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
        self.jev = StubJev()

    def median_norm(self, L):
        return 80.0

    def graph_layers(self):
        # the server's clamp buffers: 36 and 32, not 40 (the lab has no 40 either)
        return [32, 36]

    def served_file(self):
        return self.served

    def clamp_tensors(self, per, pulse=0, adds=None):
        path = os.path.join(tempfile.mkdtemp(), f"clamp-{len(self.serving)}.pt")
        torch.save({"per": per, "pulse": pulse, "adds": adds or {}}, path)
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
        # three tokens per text; a text about cats points along the first axis
        T = 3 * len(texts)
        H = torch.zeros(T, D)
        for i, t in enumerate(texts):
            if "cat" in t:
                H[3 * i : 3 * i + 3, 0] = 2.0
        return {L: H.clone() for L in layers}, None, torch.arange(T) // 3, torch.arange(T) % 3, torch.zeros(T, dtype=torch.long)

    def encode(self, L, H):
        # every token fires feature 5 at 2.0 and feature 9 at 1.0, the third token also feature 7 at 4.0
        T = H.shape[0]
        idx = torch.tensor([[5, 9, 7]] * T)
        val = torch.tensor([[2.0, 1.0, 0.0]] * T)
        val[2::3, 2] = 4.0
        return idx, val


class StubJev:
    """Answers every question: a Noul yes at 0.8 (dark ones no), a Score at its second level, a pairwise Choice for the reply
    that says "wild" more often (0.9); keeps what it was asked."""

    def __init__(self):
        self.asked = []

    def answer(self, state, k, q):
        if q["type"] == "noul":
            return {"noul": 0.1 if k.startswith("dark") else 0.8}
        if q["type"] == "choice":
            w1, w2 = (state[r]["reply"].count("wild") for r in ("reply_1", "reply_2"))
            p1 = 0.5 if w1 == w2 else 0.9 if w1 > w2 else 0.1
            return {"choice": "reply_1" if p1 >= 0.5 else "reply_2", "probabilities": {"reply_1": p1, "reply_2": 1 - p1}}
        return {"probabilities": {"0": 0.0, "1": 0.0, "2": 1.0}}

    def ask_many(self, jobs):
        self.asked += jobs
        return [{k: self.answer(state, k, q) for k, q in qs.items()} for state, qs in jobs]


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
        self.refused({"parts": [part()], "sampling": {"repetition_penalty": 1.5}}, "sampling repetition_penalty")
        self.refused({"parts": [part()], "sampling": {"repetition_penalty": 0.9}}, "sampling repetition_penalty")

    def test_a_recipe_carries_its_repetition_penalty(self):
        r = self.c.post("/serve", json={"clamp": {"parts": [part(f=1)], "sampling": {"presence_penalty": 1.5, "repetition_penalty": 1.03}}})
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.json()["served"]["sampling"], {"presence_penalty": 1.5, "repetition_penalty": 1.03})

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


class AnyTopicTest(unittest.TestCase):
    def setUp(self):
        self.lab = StubLab()
        self.made = tempfile.mkdtemp()
        self.shipped = tempfile.mkdtemp()
        with open(os.path.join(self.shipped, "golden-gate.json"), "w") as f:
            json.dump({"recipe": 1, "topic": "the Golden Gate Bridge", "parts": [part(f=3, v=24.0) | {"what": "bridges"}], "adds": [], "sampling": {"temperature": 0.9}, "pulse": 0,
                       "dark_also": ["someone jumping from the Golden Gate Bridge"], "evidence": {"notices_rate": 0.4}}, f)
        self.patches = [mock.patch.object(lib, "FMAX", 4), mock.patch.object(lib, "OUT", tempfile.mkdtemp()), mock.patch.object(lib, "MADE", self.made),
                        mock.patch.object(lib, "SHIPPED", self.shipped)]
        for p in self.patches:
            p.start()
        self.c = TestClient(lib.create_lib_app(self.lab))

    def tearDown(self):
        for p in self.patches:
            p.stop()

    def test_grade_asks_the_topics_rubric_of_every_reply_in_one_request_each(self):
        replies = [{"q": "What's the capital of France?", "thinking": "Paris. Or a cat?", "answer": "Cats."}] * 3
        r = self.c.post("/grade", json={"replies": replies, "topic": "cats", "dark_also": ["cruelty to cats"]})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(len(self.lab.jev.asked), 3, "one Jev request per reply")
        state, qs = self.lab.jev.asked[0]
        self.assertEqual(state["user_asked"], "What's the capital of France?")
        self.assertIn("cats", qs["topic_thinking"]["instructions"])
        self.assertIn("cruelty to cats", qs["dark_topic"]["instructions"], "the topic's own dark associations get their own question")
        self.assertIn("jumping or falling from a bridge", qs["dark_answer"]["instructions"], "the calibrated dark question stays as it is")
        out = r.json()
        self.assertEqual(len(out["grades"]), 3)
        self.assertEqual((out["summary"]["n"], out["summary"]["notices_rate"], out["summary"]["dark_any"]), (3, 1.0, 0))
        self.assertEqual(self.c.post("/grade", json={"replies": replies}).status_code, 400, "a topic is the one input")
        self.assertEqual(self.c.post("/grade", json={"replies": [{"q": "hi"}], "topic": "cats"}).status_code, 400)
        self.assertEqual(self.c.post("/grade", json={"replies": replies, "topic": "cats", "dark_also": ["x"] * 7}).status_code, 400)

    def test_direction_measures_a_mean_difference_a_clamp_can_add(self):
        r = self.c.post("/direction", json={"layer": 36, "on": ["a cat", "the cat sat"], "off": ["a dog", "rain"]})
        self.assertEqual(r.status_code, 200, r.text)
        d = r.json()
        self.assertAlmostEqual(d["norm"], 2.0)
        unit = torch.load(d["path"], weights_only=True)["unit"]
        self.assertAlmostEqual(float(unit[0]), 1.0)
        served = self.c.post("/serve", json={"clamp": {"adds": [{"layer": 36, "direction": d["id"], "f": 0.5}]}, "topic": "cats"}).json()["served"]
        vec = torch.load(served["file"], weights_only=True)["adds"][36]
        self.assertAlmostEqual(float(vec[0]), 0.5 * 80.0, msg="f x the layer's median token norm along the direction")
        self.assertEqual(served["adds"], [{"layer": 36, "f": 0.5}])
        self.assertIn("unknown", self.c.post("/serve", json={"clamp": {"adds": [{"layer": 36, "direction": "unknown", "f": 0.5}]}}).json()["error"])
        self.assertEqual(self.c.post("/serve", json={"clamp": {"adds": [{"layer": 32, "direction": d["id"], "f": 0.5}]}}).status_code, 400, "a direction is its layer's")
        self.assertEqual(self.c.post("/serve", json={"clamp": {"adds": [{"layer": 36, "direction": d["id"], "f": 5}]}}).status_code, 400)
        self.assertEqual(self.c.post("/direction", json={"layer": 36, "on": ["a dog"], "off": ["rain"]}).status_code, 400, "no difference, no direction")

    def test_serve_with_a_topic_saves_a_portable_recipe_and_load_serves_it_again(self):
        d = self.c.post("/direction", json={"layer": 32, "on": ["a cat"], "off": ["rain"]}).json()
        r = self.c.post("/serve", json={"clamp": {"parts": [part(f=1) | {"what": "cats as pets"}, part(f=2, v=5.0)], "adds": [{"layer": 32, "direction": d["id"], "f": 0.25}],
                                                  "sampling": {"presence_penalty": 1.5}},
                                        "topic": "cats", "note": "why", "dark_also": ["cruelty to cats"], "evidence": {"notices_rate": 0.4}})
        self.assertEqual(r.status_code, 200, r.text)
        served = r.json()["served"]
        self.assertEqual((served["topic"], served["display"], served["dark_also"]), ("cats", "Qwen3.5-27B, obsessed with cats", ["cruelty to cats"]))
        self.assertEqual(served["parts"][0]["what"], "cats as pets")
        self.assertEqual(self.lab.written[-1], served, "served.json carries the topic, the name and the dark associations")
        with open(os.path.join(self.made, "cats.json")) as f:
            recipe = json.load(f)
        self.assertEqual(served["recipe"], os.path.join(self.made, "cats.json"))
        self.assertEqual((recipe["topic"], recipe["method"], recipe["evidence"]), ("cats", "clamp+meandiff", {"notices_rate": 0.4}))
        self.assertNotIn("file", json.dumps(recipe["parts"]), "no box path in a recipe")
        self.assertEqual(recipe["parts"][0], {"layer": 36, "feature": 1, "value": 20.0, "what": "cats as pets"})
        names = {x["name"]: x for x in self.c.post("/recipes", json={}).json()["recipes"]}
        self.assertEqual(set(names), {"cats", "golden-gate"})
        self.assertTrue(names["cats"]["made"])
        self.assertFalse(names["golden-gate"]["made"])
        first = torch.load(served["file"], weights_only=True)
        self.c.post("/serve", json={"clamp": None})
        again = self.c.post("/load", json={"name": "cats"}).json()["served"]
        self.assertEqual(self.lab.serving[-1], again["file"])
        loaded = torch.load(again["file"], weights_only=True)
        self.assertEqual(loaded["per"], first["per"])
        self.assertTrue(torch.allclose(loaded["adds"][32], first["adds"][32], atol=0.05), "the direction survives float16")
        self.assertEqual((again["topic"], again["dark_also"], again["recipe"]), ("cats", ["cruelty to cats"], os.path.join(self.made, "cats.json")))
        gg = self.c.post("/load", json={"name": "golden-gate"}).json()["served"]
        self.assertEqual((gg["display"], gg["parts"][0]["what"]), ("Qwen3.5-27B, obsessed with the Golden Gate Bridge", "bridges"))
        self.assertIn("one of ['cats', 'golden-gate']", self.c.post("/load", json={"name": "dogs"}).json()["error"])

    def test_a_recipe_is_checked_like_a_clamp(self):
        with open(os.path.join(self.made, "bad.json"), "w") as f:
            json.dump({"topic": "bad", "parts": [part(v=999.0)]}, f)
        r = self.c.post("/load", json={"name": "bad"})
        self.assertEqual(r.status_code, 400)
        self.assertIn("part value", r.json()["error"])
        with open(os.path.join(self.made, "bad.json"), "w") as f:
            json.dump({"topic": "bad", "adds": [{"layer": 36, "f": 0.5, "unit_f16_b64": "not base64!"}]}, f)
        self.assertIn("unit_f16_b64", self.c.post("/load", json={"name": "bad"}).json()["error"])
        self.assertNotIn("bad", [s for s in self.lab.serving if s], "nothing was served")

    def test_the_shipped_recipes_are_whole(self):
        here = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "recipes")
        names = sorted(f for f in os.listdir(here) if f.endswith(".json"))
        self.assertIn("golden-gate.json", names)
        with open(os.path.join(here, "golden-gate.json")) as f:
            self.assertEqual(json.load(f)["sampling"]["repetition_penalty"], 1.03, "the Golden Gate's chats carry the penalty against the contrite loop")
        for name in names:
            with open(os.path.join(here, name)) as f:
                r = json.load(f)
            self.assertTrue(r["topic"] and r["display"] and (r["parts"] or r["adds"]), name)
            for p in r["parts"]:
                self.assertIn(p["layer"], (24, 28, 32, 36, 40), name)
                self.assertTrue(isinstance(p["feature"], int) and 0 <= p["feature"] < 81920 and 0 < p["value"] < 200 and p["what"], name)
            for a in r["adds"]:
                self.assertEqual(lib.unit_of(a["unit_f16_b64"]).numel(), 5120, name)
            self.assertTrue(set(r["sampling"]) <= set(lib.SAMPLING), name)
            self.assertEqual(lib.dark_also_of(r), r["dark_also"], name)
            self.assertNotIn("/var/tmp", json.dumps(r), f"{name}: no box path in a recipe")

    def test_rank_has_jev_compare_the_sets_pairwise_and_rates_them_bradley_terry(self):
        qs = ["What's the capital of France?", "Who are you?"]
        def replies(word, n=2):
            return [{"q": q, "thinking": "hmm", "answer": f"{word} answer"} for q in qs for _ in range(n)]
        sets = {"tame": replies("plain"), "wild": replies("wild wild"), "mid": replies("wild"), "gg": replies("wild")}
        r = self.c.post("/rank", json={"sets": sets, "topic": "cats", "topics": {"gg": "the Golden Gate Bridge"}})
        self.assertEqual(r.status_code, 200, r.text)
        out = r.json()
        self.assertEqual(out["order"][0], "wild")
        self.assertEqual(out["order"][-1], "tame")
        self.assertGreater(out["ratings"]["wild"], out["ratings"]["mid"])
        self.assertAlmostEqual(out["beats"]["mid"]["gg"], 0.5, places=3, msg="the same replies tie")
        self.assertAlmostEqual(out["beats"]["wild"]["tame"], 0.9, places=3)
        self.assertAlmostEqual(out["beats"]["tame"]["wild"], 0.1, places=3)
        # every pair of sets, every question both share, each draw asked in both orders (the order cancels position bias)
        self.assertEqual(out["games"], 6 * 2 * 2 * 2)
        self.assertEqual(len(self.lab.jev.asked), out["games"])
        state, q = self.lab.jev.asked[0]
        self.assertEqual(set(q), {"pick"})
        self.assertEqual(q["pick"]["type"], "choice")
        self.assertIn("Golden Gate Claude", q["pick"]["instructions"])
        topics = {state["reply_1"]["obsessed_with"] for state, _ in self.lab.jev.asked} | {state["reply_2"]["obsessed_with"] for state, _ in self.lab.jev.asked}
        self.assertEqual(topics, {"cats", "the Golden Gate Bridge"}, "each reply is judged as an obsession with its own topic")
        firsts = [(st["reply_1"]["reply"], st["reply_2"]["reply"]) for st, _ in self.lab.jev.asked]
        self.assertEqual(len([1 for a, b in firsts if (b, a) in firsts]), len(firsts), "both orders")

    def test_rank_refuses_what_it_cannot_compare(self):
        one = [{"q": "a", "thinking": "", "answer": "x"}]
        for body, why in (({"sets": {"a": one}, "topic": "cats"}, "sets"), ({"sets": {"a": one, "b": [{"q": "b", "thinking": "", "answer": "y"}]}, "topic": "cats"}, "no question"),
                          ({"sets": {"a": one, "b": one}}, "topic"), ({"sets": {"a": one, "b": [{"q": "a"}]}, "topic": "cats"}, "replies")):
            r = self.c.post("/rank", json=body)
            self.assertEqual(r.status_code, 400, body)
            self.assertIn(why, r.json()["error"])
        self.assertEqual(self.lab.jev.asked, [])

    def test_recipe_returns_a_saved_recipe_whole_and_it_samples_as_a_clamp(self):
        r = self.c.post("/recipe", json={"name": "golden-gate"})
        self.assertEqual(r.status_code, 200, r.text)
        gg = r.json()["recipe"]
        self.assertEqual(gg["topic"], "the Golden Gate Bridge")
        self.lab.sae = {L: {"W_enc": torch.randn(81920, 1), "b_enc": torch.zeros(81920), "W_dec": torch.randn(1, 81920)} for L in (32, 36)}
        tried = self.c.post("/try", json={"clamp": gg, "prompts": ["hi"], "max_tokens": 50})
        self.assertEqual(tried.status_code, 200, tried.text)
        self.assertIn("one of", self.c.post("/recipe", json={"name": "dogs"}).json()["error"])

    def test_topics_that_slug_alike_keep_their_own_recipes_and_the_same_topic_updates_its_own(self):
        clamp = {"parts": [part()]}
        names = []
        for topic in ("C++", "C#", "c++", "猫", "犬", "golden gate"):
            names.append(os.path.basename(self.c.post("/serve", json={"clamp": clamp, "topic": topic}).json()["served"]["recipe"])[:-5])
        self.assertEqual(names[0], "c", "a topic keeps its plain name while it is free")
        self.assertEqual(len(set(names[:2])), 2, "C# does not overwrite C++")
        self.assertEqual(names[2], names[0], "the same topic (case and spaces aside) updates its own recipe")
        self.assertNotEqual(names[3], names[4], "two topics with no ASCII letters get two recipes")
        self.assertNotEqual(names[5], "golden-gate", "a made recipe never takes a shipped recipe's name for another topic")
        topics = {}
        for n in names:
            topics.setdefault(n, set()).add(self.c.post("/recipe", json={"name": n}).json()["recipe"]["topic"].lower())
        self.assertTrue(all(len(t) == 1 for t in topics.values()), topics)
        self.assertEqual(self.c.post("/recipe", json={"name": "golden-gate"}).json()["recipe"]["topic"], "the Golden Gate Bridge")

    def test_any_topic_the_lab_takes_gets_its_default_name(self):
        topic = "the tallest wrought-iron lattice tower on the Champ de Mars"
        self.assertLessEqual(len(topic), 80)
        r = self.c.post("/serve", json={"clamp": {"parts": [part()]}, "topic": topic})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["served"]["display"], f"Qwen3.5-27B, obsessed with {topic}")
        name = os.path.basename(r.json()["served"]["recipe"])[:-5]
        self.assertEqual(self.c.post("/load", json={"name": name}).status_code, 200)

    def test_without_a_topic_serve_is_as_before(self):
        served = self.c.post("/serve", json={"clamp": {"parts": [part()]}, "note": "why"}).json()["served"]
        self.assertNotIn("topic", served)
        self.assertNotIn("recipe", served)
        self.assertEqual(os.listdir(self.made), [])


if __name__ == "__main__":
    unittest.main()
