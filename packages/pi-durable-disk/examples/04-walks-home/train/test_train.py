"""CPU checks for the trainer: python -m unittest test_train (from train/; uses the default/ creature).

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
from train import SCORE_UNITS, complete_checkpoints, parse_steps, score_of

HERE = os.path.dirname(os.path.abspath(__file__))
FIX = os.path.join(HERE, "..", "policy", "test", "fixtures")  # the policy runtime's parity fixture (policy.json)
XML_PATH = os.path.join(HERE, "default", "creature.xml")  # the tab's default 3-DOF creature
XML = open(XML_PATH, "rb").read().decode("utf-8")
BODY = json.load(open(os.path.join(HERE, "default", "body.json")))


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


class CourseTest(unittest.TestCase):
  def test_course_is_held_out_and_standable(self):
    course = terrain.make_course(seed=1000)
    self.assertEqual(course["kind"], "course")
    self.assertEqual(terrain.check(XML_PATH, course)["ok"], 1)
    self.assertNotEqual(course["sha256"], terrain.make_terrain(seed=1000)["sha256"])

  def test_score_is_course_progress_when_scored_on_the_course(self):
    self.assertEqual(score_of({"distance_m": 4.86}), 4.86)
    self.assertEqual(score_of({"distance_m": 4.86, "course_m": 9.0}), 9.0)
    self.assertIsNone(score_of(None))
    self.assertEqual(set(SCORE_UNITS), {"flat", "course"})


class ExportTest(unittest.TestCase):
  def test_inputs_a_network_never_saw_vary_are_pinned(self):
    import export
    obs = {"std": [0.5, 1e-6, 2.0]}
    self.assertEqual(export.pin_constant_inputs(obs), [1])
    self.assertEqual(obs["std"], [0.5, export.PINNED_STD, 2.0])

  def test_combine_keeps_the_walker_and_adds_the_getup_block(self):
    import export
    walk = json.load(open(os.path.join(FIX, "policy.json")))
    getup = json.loads(json.dumps(walk))
    getup["act"] = {"scale": 2.0, "clip": 1.0}
    getup["obs"]["std"][-3] = 1e-6  # the command slice of a net trained without one
    out = export.combine(walk, getup)
    self.assertEqual(out["layers"], walk["layers"])
    self.assertEqual(out["getup"]["switch"], {"below_up": 0.3, "above_up": 0.9})
    self.assertEqual(out["getup"]["act"]["scale"], 2.0)
    self.assertEqual(out["getup"]["obs"]["std"][-3], export.PINNED_STD)
    self.assertEqual(getup["obs"]["std"][-3], 1e-6)  # the input file is not modified
    other = dict(getup, mjcf_sha256="0" * 64)
    with self.assertRaises(ValueError):
      export.combine(walk, other)


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


class ScheduleTest(unittest.TestCase):
  def test_parse_steps(self):
    self.assertEqual([parse_steps(x) for x in ("0.5M", "1M", "200K", "4000000", " 8m ")],
                     [500_000, 1_000_000, 200_000, 4_000_000, 8_000_000])


class ResumeTest(unittest.TestCase):
  def test_only_complete_checkpoints_newest_first(self):
    with tempfile.TemporaryDirectory() as tmp:
      # What Brax 0.14's PPO checkpoint leaves: orbax's commit marker plus ppo_network_config.json.
      for name, files in (("000000100000", ("commit_success.txt", "ppo_network_config.json")),
                          ("000000200000", ("commit_success.txt", "ppo_network_config.json")),
                          ("000000300000", ("commit_success.txt",)),  # Brax had not written its config yet
                          ("000000350000", ("ppo_network_config.json",)),
                          ("000000400000.orbax-checkpoint-tmp-1", ("commit_success.txt", "ppo_network_config.json"))):
        os.makedirs(os.path.join(tmp, name))
        for fname in files:
          with open(os.path.join(tmp, name, fname), "w") as f:
            f.write("{}")
      got = [os.path.basename(p) for p in complete_checkpoints(tmp)]
      self.assertEqual(got, ["000000200000", "000000100000"])


if __name__ == "__main__":
  unittest.main()
