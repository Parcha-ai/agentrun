"""CPU checks for the skill program: python -m unittest test_train_skill (from train/).

What they pin: a rerun keeps a skill done for the same body and redoes one done for another body (the relearn beat reruns
the same command after the body changes), an unfinished one starts clean, a done skill ships the newest checkpoint that
passed, every example skill directory loads, and a skill directory is refused with what to fix.
"""

import hashlib
import json
import os
import shutil
import tempfile
import threading
import time
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

  def test_a_done_run_with_no_skill_hash_is_trained_again_for_a_skill_with_one(self):
    # A run written before skill hashes were recorded cannot show it trained this version of the skill (a rewritten
    # reward.py must retrain), so it is redone.
    with tempfile.TemporaryDirectory() as root:
      out = make_out(root, "done", "aaa")
      self.assertIsNone(train_skill.reuse_or_clear(out, "aaa", "v1"))
      self.assertFalse(os.path.exists(os.path.join(out, "policy.json")))


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


class RefusedTest(unittest.TestCase):
  def test_a_refused_skill_writes_its_reason_into_skill_json(self):
    with tempfile.TemporaryDirectory() as d:
      skill, out = os.path.join(d, "skill"), os.path.join(d, "out")
      os.makedirs(skill)
      json.dump({"name": "Bad Name"}, open(os.path.join(skill, "skill.json"), "w"))
      os.makedirs(out)
      json.dump({"status": "done", "passed_at": {"checkpoint": 1}}, open(os.path.join(out, "skill.json"), "w"))  # an older try
      import subprocess, sys
      r = subprocess.run([sys.executable, os.path.join(os.path.dirname(train_skill.__file__), "train_skill.py"), "--skill-dir", skill,
                          "--body", os.path.join(os.path.dirname(train_skill.__file__), "default"), "--out", out], capture_output=True, text=True)
      self.assertEqual(r.returncode, 2, r.stdout + r.stderr)
      meta = json.load(open(os.path.join(out, "skill.json")))
      self.assertEqual((meta["status"], meta["passed_at"]), ("refused", None))
      self.assertIn("lowercase", meta["error"])


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

  def test_a_test_error_between_checkpoints_names_the_right_checkpoint(self):
    # Checkpoint 3's test raised: the plateau still begins at checkpoint 5 (0.91), not at the fourth value's checkpoint.
    recs = self.recs([1.0, 0.97, None, 0.95, 0.91, 0.91, 0.91, 0.91, 0.91])
    recs[2].update(metric=None, error="ZeroDivisionError")
    d = train_skill.diagnose(recs)
    self.assertIn("by checkpoint 5 (5.0M steps)", d)
    recs = self.recs([1.0, None, 1.0, 1.4, 1.0, 1.01])  # never moved, with one excursion
    recs[1].update(metric=None, error="ZeroDivisionError")
    self.assertIn("excursion to 1.4 at checkpoint 4", train_skill.diagnose(recs))

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

  def test_relative_paths_reach_the_trainer_absolute(self):
    # The trainer runs with its own directory as cwd, so every path train-skill hands it is absolute, whatever cwd the
    # thread ran train-skill from.
    with tempfile.TemporaryDirectory() as root:
      cwd = os.getcwd()
      try:
        os.chdir(root)
        os.makedirs("skills/tail-wag")
        self.write("skills/tail-wag", {"skill.json": json.dumps({"name": "tail-wag", "reward_scales": {"wag": 1.0}}),
                                       "reward.py": "def terms(s):\n    return {'wag': s.up}\n",
                                       "test.py": "def test(sim):\n    return True, {'name': 'x', 'value': 1.0}\n"})
        shutil.copytree(os.path.join(os.path.dirname(train_skill.__file__), "default"), "body")
        skill = train_skill.load_skill("skills/tail-wag")
        body_dir = train_skill.resolve_body("body", os.path.join(root, "out"))
        cmd = train_skill.trainer_command(skill, body_dir, os.path.join(root, "out"), steps="1M", init_from="walk/ckpt",
                                          cache="cache/tail-wag.tar.gz", compile_only=False)
      finally:
        os.chdir(cwd)
      paths = {flag: cmd[cmd.index(flag) + 1] for flag in ("--mjcf", "--body", "--universe", "--work", "--reward", "--init-from",
                                                           "--compile-cache", "--keep-published", "--publish")}
      for flag, path in paths.items():
        self.assertTrue(os.path.isabs(path), f"{flag} {path}")
      self.assertEqual(paths["--reward"], os.path.join(root, "skills", "tail-wag", "reward.py"))
      self.assertEqual(paths["--init-from"], os.path.join(root, "walk", "ckpt"))
      self.assertTrue(os.path.exists(paths["--mjcf"]))
      for auto in ("auto", ""):  # not paths: kept as they are
        cmd = train_skill.trainer_command(skill, body_dir, os.path.join(root, "out"), steps="1M", init_from=auto, cache=None, compile_only=False)
        self.assertEqual(cmd[cmd.index("--init-from") + 1] if "--init-from" in cmd else "", auto)

  def test_a_new_version_of_the_skill_is_trained_again(self):
    with tempfile.TemporaryDirectory() as root:
      out = make_out(root, "done", "aaa")
      meta = json.load(open(os.path.join(out, "skill.json")))
      json.dump({**meta, "skill_sha256": "v1"}, open(os.path.join(out, "skill.json"), "w"))
      self.assertIsNotNone(train_skill.reuse_or_clear(out, "aaa", "v1"))
      self.assertIsNone(train_skill.reuse_or_clear(out, "aaa", "v2"))
      self.assertFalse(os.path.exists(os.path.join(out, "policy.json")))



class BodyCacheTest(unittest.TestCase):
  """A body written as code keeps one compile cache for all its skills (a second skill reuses what the first, or a
  compile-only prewarm, compiled); a skill run waits for a compile-only run still filling it."""

  def test_a_derived_body_has_one_cache_for_every_skill_and_a_preset_keeps_the_skills(self):
    here = os.path.dirname(train_skill.__file__)
    walk = train_skill.load_skill(os.path.join(train_skill.EXAMPLES, "walk"))
    spin = train_skill.load_skill(os.path.join(train_skill.EXAMPLES, "spin"))
    with tempfile.TemporaryDirectory() as root:
      code = os.path.join(root, "robot")  # the MJCF only, as a code body is staged: body.json is derived
      os.makedirs(code)
      xml = open(os.path.join(here, "default", "creature.xml")).read()
      open(os.path.join(code, "body.xml"), "w").write(xml)
      sha = hashlib.sha256(xml.encode()).hexdigest()
      caches = set()
      for sk in (walk, spin):
        out = os.path.join(root, sk["name"])
        body_dir = train_skill.resolve_body(code, out)
        caches.add(train_skill.default_cache(sk, code, body_dir, sha))
      self.assertEqual(caches, {train_skill.compile_cache(f"body-{sha[:16]}")})
      preset = os.path.join(here, "default")  # creature.xml and its body.json: warm-box's per-skill caches
      self.assertEqual(train_skill.default_cache(spin, preset, train_skill.resolve_body(preset, root), sha), train_skill.compile_cache("spin"))

  def test_a_skill_run_waits_for_a_compile_only_run_to_finish(self):
    with tempfile.TemporaryDirectory() as root:
      cache = os.path.join(root, "pda-skill", "body-x.tar.gz")
      waits = []
      with train_skill.compile_lock(cache):
        done = {}
        t = threading.Thread(target=lambda: done.update(r=train_skill.wait_for_compile(cache, timeout_s=10, on_wait=lambda: waits.append(1))))
        t.start()
        time.sleep(0.4)
        self.assertTrue(t.is_alive(), "the skill run is still waiting while the compile-only run holds the cache")
      t.join(5)
      waited, ready = done["r"]
      self.assertTrue(ready)
      self.assertGreaterEqual(waited, 0.35)
      self.assertEqual(waits, [1])

  def test_no_compile_running_means_no_wait_and_a_stuck_one_is_not_waited_for_forever(self):
    with tempfile.TemporaryDirectory() as root:
      cache = os.path.join(root, "pda-skill", "body-x.tar.gz")
      t0 = time.time()
      self.assertEqual(train_skill.wait_for_compile(cache, timeout_s=10, on_wait=self.fail)[1], True)
      self.assertLess(time.time() - t0, 0.5)
      with train_skill.compile_lock(cache):
        waited, ready = train_skill.wait_for_compile(cache, timeout_s=0.3, on_wait=lambda: None)
      self.assertFalse(ready)
      self.assertGreaterEqual(waited, 0.3)


if __name__ == "__main__":
  unittest.main()
