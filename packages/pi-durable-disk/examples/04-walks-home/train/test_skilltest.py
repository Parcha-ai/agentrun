"""CPU checks for skilltest.py, what a skill's test.py runs on: python -m unittest test_skilltest (from train/).

What they pin: a rollout of a real network (the policy runtime's parity fixture, on its own body) gives the same speed
and turn rate as skill_eval's arithmetic did, one row per control step; and test(sim)'s answer is checked.
"""

import json
import os
import re
import unittest

import skill_eval
import skilltest

HERE = os.path.dirname(os.path.abspath(__file__))
FIX = os.path.join(HERE, "..", "policy", "test", "fixtures")
XML = json.loads(re.search(r'CREATURE_XML = ("(?:[^"\\]|\\.)*")', open(os.path.join(FIX, "creature.ts")).read()).group(1))
BODY = json.load(open(os.path.join(FIX, "body.json")))
POLICY = json.load(open(os.path.join(FIX, "policy.json")))


class SkillTestTest(unittest.TestCase):
  def test_a_rollout_measures_what_skill_eval_measured(self):
    r = skilltest.Sim(XML, BODY, POLICY, 0.5).rollout(seconds=10)
    self.assertEqual(len(r.t), 500)
    self.assertEqual(r.joint_pos.shape, (500, len(BODY["jointNames"])))
    self.assertEqual(r.feet_height.shape, (500, len(BODY["legs"])))
    old = skill_eval.run(XML, BODY, POLICY, 0.5)
    self.assertAlmostEqual(round(r.along_mps(), 3), old["along_mps"], places=3)
    self.assertAlmostEqual(round(r.total_mps(), 3), old["total_mps"], places=3)
    self.assertAlmostEqual(round(r.yaw_rate(), 3), old["yaw_rate"], places=3)
    self.assertEqual(r.fell_at, old["fell_at"])

  def test_a_fallen_start_and_a_named_body(self):
    r = skilltest.Sim(XML, BODY, POLICY, 0.0).rollout(seconds=2, start="back")
    self.assertLess(r.up[0], 0.0, "it starts on its back")
    self.assertEqual(r.body_pos("torso").shape, (100, 3))
    with self.assertRaises(KeyError):
      r.body_pos("no-such-part")

  def test_the_answer_of_test_is_checked(self):
    sim = skilltest.Sim(XML, BODY, POLICY, 0.0)
    for bad in (lambda s: True, lambda s: (True, {"value": 1.0}), lambda s: (True, {"name": "x", "value": float("nan")})):
      with self.assertRaises(ValueError):
        skilltest.run_test(bad, sim)
    ok, metric = skilltest.run_test(lambda s: (1, {"name": "x", "value": 2, "unit": "m"}), sim)
    self.assertEqual((ok, metric), (True, {"name": "x", "value": 2.0, "unit": "m", "target": ""}))


if __name__ == "__main__":
  unittest.main()
