"""find's two typed rules, without a model: only a setting that ran the confirm round can be the pick (the rule steps
down once, and says so, when none of the first confirmed settings passes), and a teach strength below the 60% keep bar is
labelled below the bar. Needs torch and numpy (obsession_find's imports)."""
import unittest

import obsession_find as F


def row(vi, strength, obsession, readability, dark=0, variant=None, mechanism="clamp"):
    return dict(vi=vi, variant=variant or f"v{vi}", strength=strength, mechanism=mechanism, obsession=obsession,
                readability=readability, dark=dark, safe_topic_rate=1.0, false_claim_share=0.0, n=12)


class Confirm:
    """A confirm round that replaces each confirmed setting's numbers with its 36-answer ones."""

    def __init__(self, table, after):
        self.table, self.after, self.rounds = table, after, []

    def __call__(self, cands, rnd):
        self.rounds.append([r["vi"] for r in cands])
        self.table = [dict(r, **self.after.get(r["vi"], {}), n=36) if r["vi"] in self.rounds[-1] else r for r in self.table]
        return self.table


class OnlyConfirmedSettingsWin(unittest.TestCase):
    def setUp(self):
        self.table = [row(0, 0.0, 0, 5, mechanism="none"), row(1, 0.4, 4.6, 3.0), row(2, 0.35, 4.4, 2.9),
                      row(3, 0.3, 4.3, 3.4), row(4, 0.25, 4.1, 3.8), row(5, 0.2, 3.0, 4.5)]

    def test_the_first_confirmed_pass_wins(self):
        c = Confirm(self.table, {1: dict(readability=2.8)})
        pick, why, quality, _ = F.confirmed_pick(self.table, False, c, k=2)
        self.assertEqual(pick["vi"], 1)
        self.assertEqual(quality, "clean")
        self.assertEqual(c.rounds, [[1, 2]])

    def test_an_unconfirmed_setting_never_wins(self):
        # Round 1 confirms 1 and 2; both fail on 36 answers. On its 12 answers setting 3 would pass, but it must be
        # confirmed first: round 2 confirms 3 and 4, 3 fails there, so 4 is the pick.
        c = Confirm(self.table, {1: dict(readability=2.2), 2: dict(dark=1), 3: dict(readability=2.1), 4: dict(readability=3.6)})
        pick, why, quality, table = F.confirmed_pick(self.table, False, c, k=2)
        self.assertEqual(c.rounds, [[1, 2], [3, 4]])
        self.assertEqual(pick["vi"], 4)
        self.assertEqual(pick["n"], 36)
        self.assertEqual(quality, "clean")
        self.assertIn("stepped down", why)

    def test_nothing_passes_after_two_rounds(self):
        c = Confirm(self.table, {v: dict(readability=2.0) for v in (1, 2, 3, 4)})
        pick, why, quality, _ = F.confirmed_pick(self.table, False, c, k=2)
        self.assertEqual(quality, "below the bar")
        self.assertIn(pick["vi"], (1, 2, 3, 4))
        self.assertIn("no confirmed setting", why)

    def test_the_contest_fills_up_to_k(self):
        # Only setting 1 is near the bar; the round still confirms k settings, the most obsessed of the rest next.
        table = [row(1, 0.4, 4.6, 3.0), row(2, 0.35, 2.0, 1.0), row(3, 0.3, 3.0, 4.5)]
        self.assertEqual([r["vi"] for r in F.contest(table, k=2)], [1, 3])


class TeachBelowTheBar(unittest.TestCase):
    rows_v = [dict(strength=0.4, kept_think=0.33, dark=0), dict(strength=0.3, kept_think=0.75, dark=0)]

    def measure(self, kept, fc=0.0):
        return lambda st: dict(kept=kept[st], false_claim_share=fc, n=48, graded=48)

    def test_a_strength_that_keeps_60_percent_passes(self):
        t = F.pick_teach(self.rows_v, self.measure({0.3: 0.81, 0.4: 0.33}), real=False)
        self.assertEqual(t["teach_strength"], 0.3)
        self.assertFalse(t["below_bar"])
        self.assertEqual(t["rule"], F.TEACH_RULE)

    def test_a_fallback_below_60_percent_is_labelled(self):
        t = F.pick_teach(self.rows_v, self.measure({0.3: 0.45, 0.4: 0.30}), real=False)
        self.assertEqual(t["teach_strength"], 0.3)
        self.assertTrue(t["below_bar"])
        self.assertNotEqual(t["rule"], F.TEACH_RULE)
        self.assertIn("below the bar", t["why"])
        self.assertIn("45%", t["why"])
        self.assertLessEqual(len(t["estimates"]), 2)  # at most two strengths are measured

    def test_a_real_person_with_false_claims_gets_none(self):
        t = F.pick_teach(self.rows_v, self.measure({0.3: 0.9, 0.4: 0.9}, fc=0.3), real=True)
        self.assertIsNone(t["teach_strength"])
        self.assertEqual(t["strengths"], [])
        self.assertTrue(t["why"])


if __name__ == "__main__":
    unittest.main()
