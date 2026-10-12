"""CPU checks for body.py: python -m unittest test_body (from train/).

What they pin: a body built by the tab derives exactly the body.json the trainer used before; a body with a joint on a
spring (no motor) after the motors is accepted and its passive joint kept in the start pose; a passive joint before a
motor, or a body without named feet, is refused with what to fix; a flat foot is measured by its height, not a radius.
"""

import json
import os
import re
import unittest

from body import BodyRefused, body_from_mjcf

HERE = os.path.dirname(os.path.abspath(__file__))
XML = open(os.path.join(HERE, "default", "creature.xml")).read()
BODY = json.load(open(os.path.join(HERE, "default", "body.json")))
TAIL = ('<body name="tail0" pos="-0.25 0 0"><joint name="tail0_j" type="hinge" axis="0 1 0" range="-0.4 0.4" stiffness="1" damping="0.2"/>'
        '<geom type="capsule" fromto="0 0 0 -0.1 0 0" size="0.02" contype="0" conaffinity="1" mass="0.05"/></body>')


class BodyTest(unittest.TestCase):
  def test_the_tabs_body_derives_the_body_json_it_had(self):
    b = body_from_mjcf(XML)
    self.assertEqual(b["legs"], BODY["legs"])
    self.assertEqual(b["jointNames"], BODY["jointNames"])
    for got, want in zip(b["standPose"], BODY["standPose"]):
      self.assertAlmostEqual(got, want, places=6)
    self.assertAlmostEqual(b["standHeight"], BODY["standHeight"], delta=0.02)
    self.assertEqual(len(b["standQpos"]), 7 + len(BODY["jointNames"]))
    self.assertEqual(b["passiveJoints"], 0)

  def test_a_tail_on_a_spring_after_the_motors_is_kept(self):
    xml = XML.replace("    </body>\n  </worldbody>", "      " + TAIL + "\n    </body>\n  </worldbody>", 1)
    b = body_from_mjcf(xml)
    self.assertEqual(b["passiveJoints"], 1)
    self.assertEqual(len(b["standQpos"]), 7 + 12 + 1)

  def test_a_passive_joint_before_a_motor_is_refused(self):
    xml = XML.replace('<body name="l0_thigh"', TAIL + '<body name="l0_thigh"', 1)
    with self.assertRaisesRegex(BodyRefused, "must come first"):
      body_from_mjcf(xml)

  def test_a_body_without_named_feet_is_refused(self):
    with self.assertRaisesRegex(BodyRefused, "no feet"):
      body_from_mjcf(re.sub(r'name="([lr][01])_foot"', r'name="\1_toe"', XML))

  def test_a_flat_foot_is_measured_by_its_height(self):
    xml = re.sub(r'<geom name="l0_foot" type="sphere" pos="0 0 -0.2" size="0.023"',
                 '<geom name="l0_foot" type="box" pos="0 0 -0.2" size="0.05 0.035 0.015"', XML)
    b = body_from_mjcf(xml)
    self.assertGreaterEqual(b["footRadius"][0], 0.015)
    self.assertLess(b["footRadius"][0], 0.05, "not the box's half length, which a sphere's radius would be")


if __name__ == "__main__":
  unittest.main()
