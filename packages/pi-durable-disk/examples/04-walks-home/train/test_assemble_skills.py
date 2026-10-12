"""CPU checks for the skills' homecoming: python -m unittest test_assemble_skills (from train/).

What they pin: the assembler brings home exactly the skills the page's policy runtime can load and names the rest, on
the fixtures policy/test/assemble-skills.test.ts runs its TypeScript twin on (policy/test/fixtures/assemble/).
"""

import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
FIX = os.path.join(HERE, "..", "policy", "test", "fixtures", "assemble")


class AssembleTest(unittest.TestCase):
  def test_leaves_out_what_the_page_would_refuse(self):
    expected = json.load(open(os.path.join(FIX, "expected.json")))
    with tempfile.TemporaryDirectory() as root:
      skills, home = os.path.join(root, "skills"), os.path.join(root, "home")
      shutil.copytree(os.path.join(FIX, "skills"), skills)
      r = subprocess.run([sys.executable, os.path.join(HERE, "assemble_skills.py"), skills, "--home", home],
                         capture_output=True, text=True)
      self.assertEqual(r.returncode, 0, r.stderr)
      event = json.loads(r.stdout.strip().splitlines()[-1])
      self.assertEqual(sorted(event["left_out"]), sorted(expected["left_out"]))
      manifest = json.load(open(os.path.join(home, "skills.json")))
      self.assertEqual(sorted(manifest["skills"]), expected["skills"])
      for name in expected["left_out"]:
        self.assertFalse(os.path.exists(os.path.join(home, "skills", f"{name}.json")), name)

      summary = json.load(open(os.path.join(skills, "round.json")))
      for k, v in expected["round"].items():
        self.assertEqual(summary[k], v, k)
      self.assertEqual(sorted(summary["skills"]), sorted(["get-up", "walk", *expected["left_out"]]))

  def test_a_round_on_another_body_than_home_is_a_relearn(self):
    with tempfile.TemporaryDirectory() as root:
      skills, home = os.path.join(root, "skills"), os.path.join(root, "home")
      shutil.copytree(os.path.join(FIX, "skills"), skills)
      os.makedirs(home)
      json.dump({"version": 1, "body_mjcf_sha256": "d" * 64, "default": "walk", "skills": {}}, open(os.path.join(home, "skills.json"), "w"))
      r = subprocess.run([sys.executable, os.path.join(HERE, "assemble_skills.py"), skills, "--home", home], capture_output=True, text=True)
      self.assertEqual(r.returncode, 0, r.stderr)
      summary = json.load(open(os.path.join(skills, "round.json")))
      self.assertEqual((summary["relearn"], summary["previous_body_mjcf_sha256"]), (True, "d" * 64))

  def test_one_damaged_skill_never_stops_the_rest(self):
    # Without a get-up network nothing is combined, so the damaged base64 reaches the page checks directly.
    with tempfile.TemporaryDirectory() as root:
      skills = os.path.join(root, "skills")
      shutil.copytree(os.path.join(FIX, "skills", "walk"), os.path.join(skills, "walk"))
      shutil.copytree(os.path.join(FIX, "skills", "walk"), os.path.join(skills, "wave"))
      meta = json.load(open(os.path.join(skills, "wave", "skill.json")))
      json.dump({**meta, "skill": "wave"}, open(os.path.join(skills, "wave", "skill.json"), "w"))
      pol = json.load(open(os.path.join(skills, "wave", "policy.json")))
      pol["layers"][0]["w"] = "abc"  # not valid base64
      json.dump(pol, open(os.path.join(skills, "wave", "policy.json"), "w"))
      home = os.path.join(root, "home")
      r = subprocess.run([sys.executable, os.path.join(HERE, "assemble_skills.py"), skills, "--home", home, "--without-getup"],
                         capture_output=True, text=True)
      self.assertEqual(r.returncode, 0, r.stderr)
      event = json.loads(r.stdout.strip().splitlines()[-1])
      self.assertEqual(event["skills"], ["walk"])
      self.assertIn("wave", event["left_out"])


if __name__ == "__main__":
  unittest.main()
