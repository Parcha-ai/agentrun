# The strength step's timing, with the model, vLLM and Jev replaced: a probe draws both answer sets at once and grades the
# second only when the first leaves readability uncertain (a failed second draw matters only then); a lone direction is not
# probed at the 0.8 contest strength.
#   cd pipeline && python3 -m unittest test_lab
import tempfile
import threading
import unittest

import torch

import lab


class Recorder:
    def __init__(self):
        self.lines = []

    def say(self, event, **data):
        self.lines.append((event, data))


def stub_lab(readable, second_fails=False):
    """A Lab without its model: a draw returns only once both sets are being drawn (a barrier, so drawing them one after
    another fails the probe); Jev's readability is `readable(f)` for every answer."""
    x = lab.Lab.__new__(lab.Lab)
    x.thinking = True
    x.graded = 0
    x.f = None
    both = threading.Barrier(2, timeout=5)

    def vllm_fold(L, scale):
        x.f = scale / 80.0

    def sample(probes):
        both.wait()
        if second_fails and probes is lab.PROBES_B:
            raise RuntimeError("the second draw failed")
        return [(f"answer to {p['q']}", "thought") for p in probes], 2

    def grade(items):
        x.graded += len(items)
        r = readable(x.f)
        return [{"obsession": round(x.f * 5, 3), "specific": 0.9, "readable": r[i % len(r)], "answers": 0.6, "dark": 0.01, "correct": 0.9} for i in range(len(items))]

    x.vllm_fold, x.sample, x.grade = vllm_fold, sample, grade
    return x


class ProbeTest(unittest.TestCase):
    def test_an_uncertain_strength_costs_one_draw_not_two(self):
        x = stub_lab(lambda f: [0.7, 0.8])  # mean 0.75 on the bar: uncertain after ten answers
        s = x.probe(Recorder(), 32, 0.6, 80.0, "meandiff")
        self.assertEqual(s["n"], 20, "uncertain after ten: the second set is graded")
        self.assertEqual(x.graded, 20)
        self.assertEqual(s["tool_calls_ok"], "4/4")

    def test_a_clear_verdict_grades_the_first_set_only(self):
        x = stub_lab(lambda f: [0.95])
        s = x.probe(Recorder(), 32, 0.5, 80.0, "meandiff")
        self.assertEqual(s["n"], 10, "a clear verdict after ten answers: the second set is drawn but never graded")
        self.assertEqual(x.graded, 10)
        self.assertEqual(s["tool_calls_ok"], "2/2")
        self.assertTrue(s["pass"])

    def test_a_failed_second_draw_matters_only_when_its_answers_are_needed(self):
        s = stub_lab(lambda f: [0.95], second_fails=True).probe(Recorder(), 32, 0.5, 80.0, "meandiff")
        self.assertEqual(s["n"], 10, "a clear verdict: the failed second draw is never needed")
        with self.assertRaisesRegex(RuntimeError, "the second draw failed"):
            stub_lab(lambda f: [0.7, 0.8], second_fails=True).probe(Recorder(), 32, 0.6, 80.0, "meandiff")


class StrengthTest(unittest.TestCase):
    def test_a_lone_direction_skips_the_08_contest(self):
        run = tempfile.mkdtemp()
        saved = lab.RUN
        lab.RUN = run
        try:
            x = lab.Lab.__new__(lab.Lab)
            x.state = {"pick": {"layer": 32}, "meandiff": {32: {"unit": torch.ones(4) / 2, "median_norm": 80.0}}}

            class Http:
                def post(self, *a, **k):
                    return type("R", (), {"raise_for_status": lambda self: None})()

            x.http = Http()
            x.jev = type("J", (), {"stats": lambda self: {}})()
            x.fit_fold = lambda job, L: (torch.ones(4), {"s": 0})
            x.vllm_fold = lambda L, scale: None
            probed = []

            def probe(job, L, f, median_norm, label):
                probed.append(round(f, 3))
                ok = f <= 0.62
                return {"f": round(f, 3), "label": label, "pass": ok, "obsession": round(f * 5, 3), "specific": 0.9, "readable": 0.9 if ok else 0.6, "answers": 0.6, "correct": 0.9, "tool_calls_ok": "2/2"}

            x.probe = probe
            out = x.strength(Recorder())
            self.assertNotIn(0.8, probed, "one direction: no contest to rank, so no probe at 0.8")
            self.assertEqual(probed[0], 0.5)
            self.assertEqual(out["chosen"]["f"], 0.6)
        finally:
            lab.RUN = saved


if __name__ == "__main__":
    unittest.main()
