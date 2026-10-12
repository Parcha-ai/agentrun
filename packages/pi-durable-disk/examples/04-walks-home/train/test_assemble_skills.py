"""CPU checks for the skills' homecoming: python -m unittest test_assemble_skills (from train/).

What they pin: the assembler brings home exactly the skills the page's policy runtime can load and names the rest, on
the fixtures policy/test/assemble-skills.test.ts runs its TypeScript twin on (policy/test/fixtures/assemble/).
"""

import json
import os
import subprocess
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
FIX = os.path.join(HERE, "..", "policy", "test", "fixtures", "assemble")


class AssembleTest(unittest.TestCase):
  def test_leaves_out_what_the_page_would_refuse(self):
    expected = json.load(open(os.path.join(FIX, "expected.json")))
    with tempfile.TemporaryDirectory() as home:
      r = subprocess.run([sys.executable, os.path.join(HERE, "assemble_skills.py"), os.path.join(FIX, "skills"), "--home", home],
                         capture_output=True, text=True)
      self.assertEqual(r.returncode, 0, r.stderr)
      event = json.loads(r.stdout.strip().splitlines()[-1])
      self.assertEqual(sorted(event["left_out"]), sorted(expected["left_out"]))
      manifest = json.load(open(os.path.join(home, "skills.json")))
      self.assertEqual(sorted(manifest["skills"]), expected["skills"])
      for name in expected["left_out"]:
        self.assertFalse(os.path.exists(os.path.join(home, "skills", f"{name}.json")), name)


if __name__ == "__main__":
  unittest.main()
