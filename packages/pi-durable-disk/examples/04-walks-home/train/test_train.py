"""CPU checks for the trainer: python -m unittest test_train (from train/; needs the policy/test/fixtures body).

What they pin: the env's terrain height equals MuJoCo's own surface, the splice equals buildMjcf's world layout, the
env's observation equals rollout.py's (which equals policy/obs.ts by the parity test), and resume picks only complete
checkpoints.
"""

import json
import os
import tempfile
import unittest

import jax
import jax.numpy as jp
import mujoco
import numpy as np

import creature_env
import rollout
import terrain
from train import complete_checkpoints

FIX = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "policy", "test", "fixtures")
XML = open(os.path.join(FIX, "creature.xml"), "rb").read().decode("utf-8")
BODY = json.load(open(os.path.join(FIX, "body.json")))


class TerrainTest(unittest.TestCase):
  @classmethod
  def setUpClass(cls):
    cls.world = terrain.make_terrain(seed=5)
    cls.xml = terrain.splice(XML, cls.world)
    cls.env = creature_env.CreatureWalk(cls.xml, BODY, spawns=cls.world["spawns"])

  def test_splice_layout_matches_buildmjcf(self):
    # buildMjcf(design, world): "<asset>A</asset>\n" right before "  <worldbody>", geoms on the line after the floor.
    self.assertIn(f"  <asset>{self.world['asset']}</asset>\n  <worldbody>", self.xml)
    floor_line = [l for l in XML.splitlines() if 'name="floor"' in l][0]
    self.assertIn(f"{floor_line}\n    {self.world['geoms']}\n    <body name=\"torso\"", self.xml)

  def test_ground_height_is_mujocos_surface(self):
    m = mujoco.MjModel.from_xml_string(self.xml)
    d = mujoco.MjData(m)
    d.qpos[0:3] = [100.0, 100.0, 5.0]  # the creature out of the way of the rays
    mujoco.mj_forward(m, d)
    rng = np.random.default_rng(0)
    pts = rng.uniform(-5.9, 5.9, (300, 2))
    ours = np.asarray(jax.jit(self.env._ground_height)(jp.array(pts)))
    gid = np.zeros(1, np.int32)
    theirs = np.array([3.0 - mujoco.mj_ray(m, d, np.array([x, y, 3.0]), np.array([0, 0, -1.0]), None, 1, -1, gid)
                       for x, y in pts])
    # Bilinear vs MuJoCo's triangles differ inside a cell by at most a fraction of the cell's height change.
    self.assertLess(np.median(np.abs(ours - theirs)), 0.003)
    self.assertLess(np.percentile(np.abs(ours - theirs), 95), 0.02)

  def test_spawn_points_are_on_the_ground(self):
    for x, y, z in self.world["spawns"]:
      self.assertAlmostEqual(float(self.env._ground_height(jp.array([x, y]))), z, delta=1e-3)


class ObservationTest(unittest.TestCase):
  def test_env_raw_obs_equals_rollout_obs(self):
    env = creature_env.CreatureWalk(XML, BODY)
    m = mujoco.MjModel.from_xml_string(XML)
    d = mujoco.MjData(m)
    rng = np.random.default_rng(1)
    rollout.reset(m, d, BODY)
    d.qpos[3:7] = rng.normal(size=4)
    d.qpos[3:7] /= np.linalg.norm(d.qpos[3:7])
    d.qvel[:] = rng.normal(size=m.nv)
    prev = rng.uniform(-1, 1, m.nu)
    spec = [{"name": n, "size": s} for n, s in creature_env.obs_sizes(m.nu)]
    want = rollout.observe(spec, d, np.array(BODY["standPose"]), prev, 0.37, 0.61, env._config.gait_hz)

    class D:  # the fields _raw_obs reads
      qpos = jp.array(d.qpos)
      qvel = jp.array(d.qvel)
    raw = env._raw_obs(D, {"t": jp.float32(0.61), "last_act": jp.array(prev), "command": jp.float32(0.37)})
    got = np.concatenate([np.asarray(raw[n]) for n, _ in creature_env.obs_sizes(m.nu)])
    np.testing.assert_allclose(got, want, atol=2e-6)  # float32 in the env, float64 in the tab


class ResumeTest(unittest.TestCase):
  def test_only_complete_checkpoints_newest_first(self):
    with tempfile.TemporaryDirectory() as tmp:
      for name, done in (("000000100000", True), ("000000200000", True), ("000000300000", False),
                         ("000000400000.orbax-checkpoint-tmp-1", True)):
        os.makedirs(os.path.join(tmp, name))
        if done:
          with open(os.path.join(tmp, name, "config.json"), "w") as f:
            f.write("{}")
      got = [os.path.basename(p) for p in complete_checkpoints(tmp)]
      self.assertEqual(got, ["000000200000", "000000100000"])


if __name__ == "__main__":
  unittest.main()
