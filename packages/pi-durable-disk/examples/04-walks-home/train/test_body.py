"""CPU checks for body.py: python -m unittest test_body (from train/).

What they pin: a body built by the tab derives exactly the body.json the trainer used before; a body with a joint on a
spring (no motor) after the motors is accepted and its passive joint kept in the start pose; a passive joint before a
motor, a body without named feet, or a control that is not a position target, is refused with what to fix; a flat foot is
measured by its height, not a radius, and a foot's lowest point follows its orientation.
"""

import json
import os
import re
import unittest

import mujoco
import numpy as np

from body import BodyRefused, body_from_mjcf, foot_drop

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


  def test_a_motor_or_velocity_actuator_is_refused(self):
    # The policy sends joint-angle targets: a motor (a torque) or a velocity actuator would read them as something else.
    for kind in ('<motor name="l0_hip_a" joint="l0_hip" gear="1" ctrlrange="-2.5 2.5"/>',
                 '<velocity name="l0_hip_a" joint="l0_hip" kv="1" ctrlrange="-2.5 2.5"/>'):
      xml = re.sub(r'<position name="l0_hip_a"[^>]*/>', kind, XML)
      with self.assertRaisesRegex(BodyRefused, "position"):
        body_from_mjcf(xml)


class FootDropTest(unittest.TestCase):
  def test_the_lowest_point_follows_the_orientation(self):
    # Each shape at random orientations: foot_drop equals the depth of its lowest point, from the shape's own surface.
    rng = np.random.default_rng(3)
    G = mujoco.mjtGeom
    def lowest(t, size, R):
      if t == int(G.mjGEOM_BOX):
        corners = np.array([[sx, sy, sz] for sx in (-1, 1) for sy in (-1, 1) for sz in (-1, 1)]) * size
        return -min((R @ c)[2] for c in corners)
      # sample the surface densely: points on a unit sphere, mapped onto the shape
      u = rng.normal(size=(20000, 3)); u /= np.linalg.norm(u, axis=1, keepdims=True)
      if t == int(G.mjGEOM_ELLIPSOID):
        pts = u * size
      elif t == int(G.mjGEOM_CAPSULE):
        pts = u * size[0] + np.outer(np.sign(u[:, 2]), [0, 0, size[1]])
      else:  # cylinder: the rim circles and the caps
        a = rng.uniform(0, 2 * np.pi, 20000)
        pts = np.stack([size[0] * np.cos(a), size[0] * np.sin(a), rng.choice([-1, 1], 20000) * size[1]], axis=1)
      return -min((pts @ R.T)[:, 2])
    for t, size in ((int(G.mjGEOM_BOX), [0.05, 0.035, 0.015]), (int(G.mjGEOM_ELLIPSOID), [0.06, 0.04, 0.02]),
                    (int(G.mjGEOM_CAPSULE), [0.02, 0.05, 0]), (int(G.mjGEOM_CYLINDER), [0.03, 0.04, 0]), (int(G.mjGEOM_SPHERE), [0.023, 0, 0])):
      for _ in range(5):
        q = rng.normal(size=4); q /= np.linalg.norm(q)
        R = np.zeros(9); mujoco.mju_quat2Mat(R, q); R = R.reshape(3, 3)
        got = foot_drop(np.array([t]), np.array([size], dtype=float), R[2][None, :])[0]
        want = size[0] if t == int(G.mjGEOM_SPHERE) else lowest(t, np.array(size, dtype=float), R)
        self.assertAlmostEqual(got, want, delta=1e-3 if t in (int(G.mjGEOM_BOX), int(G.mjGEOM_SPHERE)) else 2e-3, msg=f"type {t}")


if __name__ == "__main__":
  unittest.main()
