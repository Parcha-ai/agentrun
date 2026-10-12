"""CPU checks for the skill program: python -m unittest test_train_skill (from train/).

What they pin: a rerun keeps a skill done for the same body and redoes one done for another body (the relearn beat reruns
the same command after the body changes), an unfinished one starts clean, a done skill ships the newest checkpoint that
passed, and every skill has the stage's metric.
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


class MetricTest(unittest.TestCase):
  def test_every_skill_has_a_stage_metric(self):
    self.assertEqual(set(train_skill.METRIC), set(train_skill.SKILLS))


if __name__ == "__main__":
  unittest.main()
