"""find's two typed rules, without a model: only a setting that ran the confirm round can be the pick (the rule steps
down once, and says so, when none of the first confirmed settings passes), and a teach strength below the 60% keep bar is
labelled below the bar. A fallback never relaxes a safety gate (dark answers, the real-person false-claim limit); when
nothing passes them, find installs nothing and refuses. The teach estimate counts usable pairs the way the trainer
does, against the trainer's own floor read from its source. Needs torch and numpy (obsession_find's imports)."""
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

    def test_a_fallback_never_takes_a_setting_over_the_false_claim_limit(self):
        # Nothing confirmed is readable, so the fallback runs; for a real person it must skip the more readable setting
        # whose false-claim share is over 15%.
        table = [dict(row(1, 0.4, 4.5, 2.2), false_claim_share=0.2), dict(row(2, 0.35, 4.4, 2.1), false_claim_share=0.1)]
        c = Confirm(table, {})
        pick, why, quality, _ = F.confirmed_pick(table, True, c, k=2)
        self.assertEqual(pick["vi"], 2)
        self.assertEqual(quality, "below the bar")

    def test_no_install_when_every_confirmed_setting_fails_a_safety_gate(self):
        table = [dict(row(1, 0.4, 4.5, 3.0), false_claim_share=0.2), dict(row(2, 0.35, 4.4, 2.1), false_claim_share=0.22)]
        pick, why, quality, _ = F.confirmed_pick(table, True, Confirm(table, {}), k=2)
        self.assertIsNone(pick)
        self.assertEqual(quality, "unsafe")
        self.assertIn("false claims", why)

    def test_the_contest_fills_up_to_k(self):
        # Only setting 1 is near the bar; the round still confirms k settings, the most obsessed of the rest next.
        table = [row(1, 0.4, 4.6, 3.0), row(2, 0.35, 2.0, 1.0), row(3, 0.3, 3.0, 4.5)]
        self.assertEqual([r["vi"] for r in F.contest(table, k=2)], [1, 3])


TCFG = dict(teach_prompts=180, min_usable=60, max_non_answering=0.25, think_cap_words=50, answer_cap_words=70)


class TeachCountsWhatTheTrainerCounts(unittest.TestCase):
    rows_v = [dict(strength=0.4, usable_think=0.6, dark=0), dict(strength=0.3, usable_think=0.8, dark=0)]

    def fake(self, usable, fc=0.0):
        self.calls = []

        def measure(sts):
            self.calls.append(list(sts))
            return {st: dict(kept=0.9, usable_of_set=usable.get(st, 0), false_claim_share=fc, n=48, graded=48) for st in sts}
        return measure

    def test_the_bar_is_the_floor_plus_a_quarter(self):
        self.assertEqual(F.teach_bar(TCFG), 75)

    def test_a_teacher_too_strong_to_answer_steps_down(self):
        t = F.pick_teach(self.rows_v, self.fake({0.4: 33, 0.35: 90, 0.3: 120}), False, TCFG)
        self.assertEqual(t["teach_strength"], 0.35)
        self.assertEqual(t["strengths"], [0.35, 0.3])
        self.assertFalse(t["below_bar"])

    def test_a_passing_strength_comes_with_its_fallback_in_one_measurement(self):
        t = F.pick_teach(self.rows_v, self.fake({0.4: 140, 0.35: 150}), False, TCFG)
        self.assertEqual(t["strengths"], [0.4, 0.35])
        self.assertEqual(self.calls, [[0.4, 0.35]])
        self.assertEqual((t["floor"], t["margin"], t["bar"], t["teach_prompts"]), (60, 0.25, 75, 180))
        self.assertEqual(t["rule"], F.TEACH_RULE)

    def test_below_the_bar_is_labelled_and_keeps_a_fallback(self):
        t = F.pick_teach(self.rows_v, self.fake({0.4: 62, 0.35: 70, 0.3: 66}), False, TCFG)
        self.assertEqual(t["teach_strength"], 0.35)
        self.assertEqual(t["strengths"], [0.35, 0.3])
        self.assertTrue(t["below_bar"])
        self.assertNotEqual(t["rule"], F.TEACH_RULE)
        self.assertIn("75", t["why"]); self.assertIn("60", t["why"])

    def test_a_passing_fallback_replaces_a_below_bar_choice(self):
        # Greptile's case: 0.4 and 0.35 miss the bar, the below-bar choice is 0.35, and its fallback 0.3 passes: 0.3 is
        # the strongest passing strength, so it is taught (not below the bar), with its own fallback 0.25 measured.
        t = F.pick_teach(self.rows_v, self.fake({0.4: 62, 0.35: 70, 0.3: 120, 0.25: 110}), False, TCFG)
        self.assertEqual(t["teach_strength"], 0.3)
        self.assertFalse(t["below_bar"])
        self.assertEqual(t["rule"], F.TEACH_RULE)
        self.assertEqual(t["strengths"], [0.3, 0.25])

    def test_the_bound_ends_below_the_bar_and_says_so(self):
        # Usable pairs rise as the strength falls but never reach the bar: the search stops at TEACH_MAX_MEASURED strengths
        # with the best below-bar choice, labelled, and the reason names the bound.
        usable = {round(0.4 - 0.05 * i, 3): 61 + i for i in range(8)}
        t = F.pick_teach(self.rows_v, self.fake(usable), False, TCFG)
        self.assertEqual(len(t["estimates"]), F.TEACH_MAX_MEASURED)
        self.assertTrue(t["below_bar"])
        self.assertEqual(t["teach_strength"], max(t["estimates"], key=lambda st: (t["estimates"][st]["usable_of_set"], st)))
        self.assertIn(f"stopped after {F.TEACH_MAX_MEASURED} strengths", t["why"])

    def test_no_teach_strength_ends_with_its_reason(self):
        # Nothing reaches the bare floor: the search stops after the first batch (the bound is only reachable while a
        # strength keeps the floor), with no teach strength and a reason that names the floor and each measured count.
        t = F.pick_teach(self.rows_v, self.fake({0.4: 30, 0.35: 40, 0.3: 50}), False, TCFG)
        self.assertIsNone(t["teach_strength"])
        self.assertEqual(t["strengths"], [])
        self.assertEqual([x["strength"] for x in t["search"]], [0.4, 0.35])
        self.assertIn("floor of 60", t["why"])
        self.assertIn("0.35 -> 40", t["why"])

    def test_the_search_lists_every_measured_strength_in_order(self):
        t = F.pick_teach(self.rows_v, self.fake({0.4: 62, 0.35: 70, 0.3: 120, 0.25: 110}), False, TCFG)
        self.assertEqual([(x["strength"], x["usable_of_set"]) for x in t["search"]], [(0.4, 62), (0.35, 70), (0.3, 120), (0.25, 110)])
        self.assertEqual([x["passes"] for x in t["search"]], [False, False, True, True])

    # The Moon's sweep shape: topic+output ran 0.3 and 0.4 only, and 0.4's sweep estimate is under the bar.
    moon_rows = [dict(strength=0.4, usable_think=0.3, dark=0), dict(strength=0.3, usable_think=0.8, dark=0)]

    def test_the_search_steps_up_toward_the_stage_strength(self):
        # The Moon: stage 0.4, the sweep only ran 0.3 and 0.4 (0.4 under the bar). 0.3 passes, and 0.35 (unmeasured, below
        # the stage strength) is measured next and passes: it becomes the choice, and 0.3 is its fallback.
        t = F.pick_teach(self.moon_rows, self.fake({0.3: 128, 0.25: 64, 0.35: 117}), False, TCFG, stage=0.4)
        self.assertEqual(t["teach_strength"], 0.35)
        self.assertEqual(t["strengths"], [0.35, 0.3])
        self.assertEqual([x["strength"] for x in t["search"]], [0.3, 0.25, 0.35])
        self.assertEqual(self.calls, [[0.3, 0.25], [0.35]])
        self.assertFalse(t["below_bar"])

    def test_the_step_up_stops_below_the_stage_strength(self):
        # 0.4 is the stage strength itself: never measured by a step up, even if it would pass.
        t = F.pick_teach(self.moon_rows, self.fake({0.3: 128, 0.25: 64, 0.35: 117, 0.4: 200}), False, TCFG, stage=0.4)
        self.assertEqual(t["teach_strength"], 0.35)
        self.assertNotIn(0.4, t["estimates"])

    def test_pizza_teaching_at_the_stage_strength_does_not_step_up(self):
        rows = [dict(strength=0.4, usable_think=0.6, dark=0), dict(strength=0.3, usable_think=0.7, dark=0)]
        t = F.pick_teach(rows, self.fake({0.4: 98, 0.35: 98}), False, TCFG, stage=0.4)
        self.assertEqual(t["strengths"], [0.4, 0.35])
        self.assertEqual(self.calls, [[0.4, 0.35]])

    def test_a_failed_step_up_keeps_the_choice_and_is_listed(self):
        t = F.pick_teach(self.moon_rows, self.fake({0.3: 128, 0.25: 64, 0.35: 60}), False, TCFG, stage=0.4)
        self.assertEqual(t["teach_strength"], 0.3)
        self.assertEqual([(x["strength"], x["passes"]) for x in t["search"]], [(0.3, True), (0.25, False), (0.35, False)])

    def test_the_bound_stops_a_step_up_and_says_so(self):
        # Every step up passes: the bound stops the search at 5 strengths, the pick passes, and the reason says a stronger
        # strength below the stage strength was not measured.
        usable = {round(0.25 + 0.05 * i, 3): 150 for i in range(8)}
        t = F.pick_teach(self.moon_rows, self.fake(usable), False, TCFG, stage=0.7)
        self.assertEqual(len(t["estimates"]), F.TEACH_MAX_MEASURED)
        self.assertEqual(t["teach_strength"], 0.45)
        self.assertFalse(t["below_bar"])
        self.assertIn(f"stopped after {F.TEACH_MAX_MEASURED} strengths", t["why"])

    def test_nothing_reaches_the_floor(self):
        t = F.pick_teach(self.rows_v, self.fake({0.4: 20, 0.35: 30, 0.3: 40}), False, TCFG)
        self.assertIsNone(t["teach_strength"])
        self.assertEqual(t["strengths"], [])
        self.assertIn("60", t["why"])

    def test_a_real_person_over_the_false_claim_limit_gets_none(self):
        t = F.pick_teach(self.rows_v, self.fake({0.4: 150, 0.35: 150, 0.3: 150}, fc=0.3), True, TCFG)
        self.assertIsNone(t["teach_strength"])
        self.assertEqual(t["strengths"], [])


class StubModules:
    """Stand-ins for the teach step's teach_common and judge_topic (the real ones live in its layer at /opt/gg)."""

    def __init__(self, test, policy=None, raises=None, drop=()):
        import sys, types
        tc, jt = types.ModuleType("teach_common"), types.ModuleType("judge_topic")
        def teach_policy(path=None):
            if raises:
                raise raises
            return dict(policy or dict(teach_prompts=180, think_cap_words=50, answer_cap_words=70, min_pairs=60, max_non_answering=0.25))
        for name, fn in dict(teach_policy=teach_policy, usable_fraction_think=lambda *a, **k: 0.5, kept_fraction_think=lambda *a: 0.6,
                             trim_think=lambda *a, **k: "t", reason_think=lambda g: None, pick_prompts=lambda *a, **k: [], seed_for=lambda *a: 0).items():
            if name not in drop:
                setattr(tc, name, fn)
        tc.POLICY_PATH = "/opt/gg/teach_policy.json"
        jt.SCHEMA = {"properties": {k: {} for k in ("obsession", "readability", "answers_user", "dark", "false_claim")}}
        for name in ("grade_many", "grade_one", "keep_think", "safe_to_show"):
            setattr(jt, name, lambda *a, **k: None)
        old = {m: sys.modules.get(m) for m in ("teach_common", "judge_topic")}
        sys.modules.update(teach_common=tc, judge_topic=jt)
        test.addCleanup(lambda: [sys.modules.pop(m, None) if v is None else sys.modules.__setitem__(m, v) for m, v in old.items()])
        self.tc, self.jt = tc, jt


class TeachSettingsComeFromTheTeachLayer(unittest.TestCase):
    """find takes the teach step's settings through the teach step's own loader (teach_common.teach_policy(), the same
    file the trainer reads) and its own counting functions; a missing piece fails closed, never a guess."""

    def test_settings_come_from_teach_policy(self):
        StubModules(self)
        c = F.teach_settings()
        self.assertEqual({k: c[k] for k in TCFG}, TCFG)

    def test_a_missing_policy_file_is_an_error(self):
        StubModules(self, raises=FileNotFoundError("/opt/gg/teach_policy.json"))
        with self.assertRaises(FileNotFoundError):
            F.teach_settings()

    def test_a_teach_layer_without_the_counting_functions_is_refused(self):
        m = StubModules(self, drop=("usable_fraction_think",))
        with self.assertRaises(ValueError) as e:
            F.check_teach_layer(m.tc, m.jt)
        self.assertIn("usable_fraction_think", str(e.exception))

    def test_a_round_one_grader_is_refused(self):
        m = StubModules(self)
        m.jt.SCHEMA = {"properties": {"dark": {}, "coherence": {}}}
        with self.assertRaises(ValueError) as e:
            F.check_teach_layer(m.tc, m.jt)
        self.assertIn("obsession", str(e.exception))

    def test_a_complete_layer_passes(self):
        m = StubModules(self)
        F.check_teach_layer(m.tc, m.jt)


class UnsafeEndsInARefusal(unittest.TestCase):
    def test_nothing_installed_and_the_typed_refusal(self):
        import tempfile, os, json
        out, lines = tempfile.mkdtemp(), []
        F.refuse_unsafe(lambda event, **kw: lines.append(dict(event=event, **kw)), out, dict(name="Donald Trump"), True,
                        "no confirmed setting passed the safety gates")
        self.assertEqual(lines[-1]["event"], "refused")
        self.assertEqual(lines[-1]["kind"], "false claims about a real person")
        self.assertIn("safety gates", lines[-1]["why"])
        with open(os.path.join(out, "clamp.json")) as f:
            self.assertFalse(json.load(f)["allowed"])


if __name__ == "__main__":
    unittest.main()
