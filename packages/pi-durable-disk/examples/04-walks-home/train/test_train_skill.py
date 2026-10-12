"""CPU checks for the skill program: python -m unittest test_train_skill (from train/).

What they pin: a rerun keeps a skill done for the same body and redoes one done for another body (the relearn beat reruns
the same command after the body changes), an unfinished one starts clean, a done skill ships the newest checkpoint that
passed, every example skill directory loads, and a skill directory is refused with what to fix.
"""

import json
import os
import tempfile
import unittest

import train_skill


def make_out(root: str, status: str, sha: str) -> str:
  out = os.path.join(root, "walk")
  os.makedirs(os.path.join(out, "checkpoints"))
  os.makedirs(os.path.join(out, "work"))
  open(os.path.join(out, "checkpoints", "ckpt-1.json"), "w").write("{}")
  open(os.path.join(out, "skill-progress.jsonl"), "w").write("{}\n")
  open(os.path.join(out, "policy.json"), "w").write("{}")
  json.dump({"skill": "walk", "status": status, "mjcf_sha256": sha}, open(os.path.join(out, "skill.json"), "w"))
  return out


class RerunTest(unittest.TestCase):
  def test_done_for_this_body_is_kept(self):
    with tempfile.TemporaryDirectory() as root:
      out = make_out(root, "done", "aaa")
      prev = train_skill.reuse_or_clear(out, "aaa")
      self.assertEqual(prev["status"], "done")
      self.assertTrue(os.path.exists(os.path.join(out, "policy.json")))
      self.assertTrue(os.path.exists(os.path.join(out, "checkpoints", "ckpt-1.json")))

  def test_done_for_another_body_is_redone(self):
    with tempfile.TemporaryDirectory() as root:
      out = make_out(root, "done", "aaa")
      self.assertIsNone(train_skill.reuse_or_clear(out, "bbb"))
      for name in ("checkpoints", "work", "skill-progress.jsonl", "policy.json"):
        self.assertFalse(os.path.exists(os.path.join(out, name)), name)

  def test_unfinished_starts_clean(self):
    with tempfile.TemporaryDirectory() as root:
      out = make_out(root, "training", "aaa")
      self.assertIsNone(train_skill.reuse_or_clear(out, "aaa"))
      self.assertFalse(os.path.exists(os.path.join(out, "checkpoints")))

  def test_first_run(self):
    with tempfile.TemporaryDirectory() as root:
      self.assertIsNone(train_skill.reuse_or_clear(os.path.join(root, "walk"), "aaa"))


class SettleTest(unittest.TestCase):
  def test_policy_is_the_newest_checkpoint_that_passed(self):
    # The trainer published ckpt-3 (untested, or failing) after ckpt-2 passed: the skill ships ckpt-2.
    with tempfile.TemporaryDirectory() as out:
      os.makedirs(os.path.join(out, "checkpoints"))
      for n in (1, 2, 3):
        json.dump({"checkpoint": n}, open(os.path.join(out, "checkpoints", f"ckpt-{n}.json"), "w"))
      json.dump({"checkpoint": 3}, open(os.path.join(out, "policy.json"), "w"))
      train_skill.settle_policy(out, 2)
      self.assertEqual(json.load(open(os.path.join(out, "policy.json"))), {"checkpoint": 2})
      self.assertFalse(os.path.exists(os.path.join(out, "policy.json.tmp")))


class StageFieldsTest(unittest.TestCase):
  def test_cpu_estimate_matches_the_measured_first_checkpoint_and_grows_with_steps(self):
    self.assertEqual(train_skill.cpu_estimate_s(491_520), 1255)  # measured: first checkpoint on 8 cores
    self.assertEqual(train_skill.cpu_estimate_s(5_898_240), 1255 + round((5_898_240 - 491_520) / 520))
    self.assertEqual(train_skill.cpu_estimate_s(100), 1255)  # nothing passes before the first checkpoint

  def test_body_name_from_robot_json_a_design_or_a_body_directory(self):
    with tempfile.TemporaryDirectory() as d:
      robot, design, body = os.path.join(d, "robot.json"), os.path.join(d, "design.json"), os.path.join(d, "spider")
      json.dump({"design": {"name": "spider", "legs": []}, "looks": {}}, open(robot, "w"))
      json.dump({"name": "giraffe", "legs": []}, open(design, "w"))
      os.makedirs(body)
      json.dump({"name": "spider"}, open(os.path.join(body, "design.json"), "w"))
      self.assertEqual(train_skill.body_name(robot), "spider")
      self.assertEqual(train_skill.body_name(design), "giraffe")
      self.assertEqual(train_skill.body_name(body), "spider")
      self.assertIsNone(train_skill.body_name(os.path.join(d, "absent")))


class DiagnoseTest(unittest.TestCase):
  def recs(self, values, error=None):
    return [{"checkpoint": i + 1, "steps": (i + 1) * 1_000_000, "metric": {"name": "height", "value": v}, "error": error} for i, v in enumerate(values)]

  def test_a_metric_that_never_moved_points_at_the_reward(self):
    self.assertIn("no gradient", train_skill.diagnose(self.recs([1.0, 1.01, 1.0, 1.02, 1.01])))

  def test_a_plateau_names_its_value_and_where_it_began(self):
    # The plateau begins at the first checkpoint from which every later value stays within 2% of its band (0.89-0.93
    # here): 0.95 is outside it, 0.91 is the first inside.
    d = train_skill.diagnose(self.recs([1.0, 0.97, 0.95, 0.91, 0.91, 0.91, 0.91, 0.91]))
    self.assertIn("plateaued at about 0.91", d)
    self.assertIn("checkpoint 4", d)

  def test_still_changing_says_train_longer(self):
    self.assertIn("train longer", train_skill.diagnose(self.recs([1.0, 0.95, 0.9, 0.85, 0.8, 0.75])))

  def test_a_test_that_always_raised_says_fix_the_test(self):
    recs = [{"checkpoint": 1, "steps": 1, "metric": None, "error": "KeyError: 'head'"}]
    self.assertIn("fix test.py", train_skill.diagnose(recs))


class SkillDirTest(unittest.TestCase):
  def write(self, root, files):
    for name, text in files.items():
      open(os.path.join(root, name), "w").write(text)

  def test_every_example_skill_loads_with_a_page_name_and_a_test(self):
    self.assertEqual(sorted(train_skill.SKILLS), ["backwards", "getup", "spin", "sprint", "turn-left", "turn-right", "walk", "wave"])
    for d in train_skill.SKILLS:
      sk = train_skill.load_skill(os.path.join(train_skill.EXAMPLES, d))
      self.assertRegex(sk["name"], r"^[a-z0-9]+(-[a-z0-9]+)*$")
      self.assertTrue(callable(sk["test"]))

  def test_a_skill_directory_is_refused_with_what_to_fix(self):
    test_py = "def test(sim):\n    return True, {'name': 'x', 'value': 1.0}\n"
    cases = [
      ({"skill.json": json.dumps({"name": "Tail_Wag"}), "test.py": test_py}, "lowercase"),
      ({"skill.json": json.dumps({"name": "tail-wag", "reward_scales": {"wag": 1.0}}), "test.py": test_py}, "reward.py"),
      ({"skill.json": json.dumps({"name": "tail-wag"})}, "test.py is missing"),
      ({"skill.json": json.dumps({"name": "tail-wag"}), "test.py": "x = 1\n"}, "no test"),
      ({"skill.json": json.dumps({"name": "tail-wag", "command": 9}), "test.py": test_py}, "command"),
    ]
    for files, why in cases:
      with tempfile.TemporaryDirectory() as d:
        self.write(d, files)
        with self.assertRaisesRegex(train_skill.Refused, why):
          train_skill.load_skill(d)

  def test_a_skill_with_its_own_reward_loads(self):
    with tempfile.TemporaryDirectory() as d:
      self.write(d, {"skill.json": json.dumps({"name": "tail-wag", "reward_scales": {"wag": 1.0, "pose": 0.0}}),
                     "reward.py": "def terms(s):\n    return {'wag': s.up}\n",
                     "test.py": "def test(sim):\n    return True, {'name': 'x', 'value': 1.0}\n"})
      sk = train_skill.load_skill(d)
      self.assertEqual(sk["universe"]["reward_scales"], {"wag": 1.0, "pose": 0.0})
      self.assertTrue(sk["reward"].endswith("reward.py"))

  def test_a_new_version_of_the_skill_is_trained_again(self):
    with tempfile.TemporaryDirectory() as root:
      out = make_out(root, "done", "aaa")
      meta = json.load(open(os.path.join(out, "skill.json")))
      json.dump({**meta, "skill_sha256": "v1"}, open(os.path.join(out, "skill.json"), "w"))
      self.assertIsNotNone(train_skill.reuse_or_clear(out, "aaa", "v1"))
      self.assertIsNone(train_skill.reuse_or_clear(out, "aaa", "v2"))
      self.assertFalse(os.path.exists(os.path.join(out, "policy.json")))


if __name__ == "__main__":
  unittest.main()
