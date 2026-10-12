"""CPU checks for the trainer: python -m unittest test_train (from train/; uses the default/ creature).

What they pin: the env's terrain height equals MuJoCo's own surface, the splice equals buildMjcf's world layout, the
env's observation equals rollout.py's (which equals policy/obs.ts by the parity test), a shaped foot's clearance is its
lowest point now (and skilltest's equals it), a settled tilt survives the random heading at reset, and resume picks only
complete checkpoints.
"""

import json
import os
import tempfile
import unittest

import jax
import jax.numpy as jp
import mujoco
import numpy as np

import re

import body as body_lib
import creature_env
import rollout
import skilltest
import terrain
from train import SCORE_UNITS, cache_save_due, checkpoint_due, unpacked_mark, complete_checkpoints, parse_steps, score_of, write_cache_tar

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


BOX_FOOT = re.sub(r'<geom name="l0_foot" type="sphere" pos="0 0 -0.2" size="0.023"',
                  '<geom name="l0_foot" type="box" pos="0 0 -0.2" size="0.05 0.035 0.015"', XML)


class FootTest(unittest.TestCase):
  def test_a_box_foots_clearance_is_its_lowest_corner_at_any_angle(self):
    body = body_lib.body_from_mjcf(BOX_FOOT)
    env = creature_env.CreatureWalk(BOX_FOOT, body)
    m = mujoco.MjModel.from_xml_string(BOX_FOOT)
    d = mujoco.MjData(m)
    rollout.reset(m, d, body)
    g = m.geom("l0_foot").id
    knee = m.jnt_qposadr[m.joint("l0_knee").id]
    for angle in (0.2, 0.9, 1.6, 2.4):  # the foot pitches with the shin
      d.qpos[knee] = angle
      mujoco.mj_forward(m, d)
      R = d.geom_xmat[g].reshape(3, 3)
      corners = [d.geom_xpos[g] + R @ (np.array([sx, sy, sz]) * m.geom_size[g]) for sx in (-1, 1) for sy in (-1, 1) for sz in (-1, 1)]
      want = min(c[2] for c in corners)

      class D:  # the fields _feet_state reads
        geom_xpos = jp.array(d.geom_xpos)
        geom_xmat = jp.array(d.geom_xmat.reshape(-1, 3, 3))
      _, clearance, _ = env._feet_state(D)
      self.assertAlmostEqual(float(clearance[0]), want, delta=1e-5, msg=f"knee {angle}")
      feet = [m.geom(f"{leg}_foot").id for leg in body["legs"]]
      self.assertAlmostEqual(float(skilltest.feet_height(m, d, feet)[0]), want, delta=1e-9, msg=f"knee {angle}")


class ResetTest(unittest.TestCase):
  def test_a_settled_tilt_survives_the_random_heading(self):
    # body.py's standQpos keeps the tilt the body settled at (facing +x); reset turns it to a random heading about world
    # z, which leaves gravity in the body frame (the tilt) as it was.
    tilt = 0.12
    q = [0.0, 0.0, BODY["standHeight"], float(np.cos(tilt / 2)), 0.0, float(np.sin(tilt / 2)), 0.0, *BODY["standPose"]]
    env = creature_env.CreatureWalk(XML, dict(BODY, standQpos=q))
    reset = jax.jit(env.reset)
    want = np.asarray(env.to_body(jp.array(q[3:7]), jp.array([0.0, 0.0, -1.0])))
    headings = []
    for seed in range(3):
      quat = reset(jax.random.PRNGKey(seed)).data.qpos[3:7]
      np.testing.assert_allclose(np.asarray(env.to_body(quat, jp.array([0.0, 0.0, -1.0]))), want, atol=1e-5)
      w, x, y, z = (float(v) for v in quat)
      headings.append(np.arctan2(2 * (w * z + x * y), 1 - 2 * (y * y + z * z)))
    self.assertGreater(np.ptp(headings), 0.1, "the heading is still random")


class ScheduleTest(unittest.TestCase):
  def test_parse_steps(self):
    self.assertEqual([parse_steps(x) for x in ("0.5M", "1M", "200K", "4000000", " 8m ")],
                     [500_000, 1_000_000, 200_000, 4_000_000, 8_000_000])


class CheckpointDueTest(unittest.TestCase):
  def test_every_point_checkpoints_once_past_the_schedule(self):
    # The take's schedule and cadence with 491,520-step epochs, to 21M: every scheduled and cadence point gets exactly
    # the one epoch that ends nearest it (16M, 18M and 20M included: their nearest epochs end just past them).
    sched = [parse_steps(x) for x in "0.5M,1M,2M,3M,4M,5M,6M,7M,8M,10M".split(",")]
    epoch, every = 491_520, parse_steps("2M")
    is_due = checkpoint_due(sched, every, epoch)
    ends = [epoch * k for k in range(1, 43)]
    saved = [t for t in ends if is_due(t)]
    points = sched + [10_000_000 + every * k for k in range(1, 6)]
    self.assertEqual(len(saved), len(points))
    for p, t in zip(points, saved):
      self.assertLessEqual(abs(t - p), epoch / 2, (p, t))

  def test_a_cadence_that_does_not_move_is_refused(self):
    for every in (0, -2_000_000):
      with self.assertRaises(ValueError):
        checkpoint_due([parse_steps("1M")], every, 491_520)

  def test_a_resumed_run_picks_up_the_cadence(self):
    epoch = 491_520
    is_due = checkpoint_due([parse_steps("1M")], parse_steps("2M"), epoch)
    saved = [t for t in (16_000_000 + epoch * k for k in range(0, 10)) if is_due(t)]
    self.assertEqual(len(saved), 2)  # the 17M and 19M points, nearest epochs only
    for p, t in zip((17_000_000, 19_000_000), saved):
      self.assertLessEqual(abs(t - p), epoch / 2, (p, t))


class CacheTarTest(unittest.TestCase):
  def test_the_saved_cache_is_a_plain_tar_of_jax_and_warp(self):
    # Saved inside the training loop after the first checkpoint: gzip took 12 s there and saved nothing (compiled programs
    # do not compress). The reader opens either kind, so an older .tar.gz still unpacks.
    import tarfile
    with tempfile.TemporaryDirectory() as d:
      src = os.path.join(d, "cache")
      for sub in ("jax", "warp", "other"):
        os.makedirs(os.path.join(src, sub))
        open(os.path.join(src, sub, "f"), "w").write(sub)
      tar = os.path.join(d, "out", "body-x.tar.gz")
      size = write_cache_tar(src, tar)
      self.assertEqual(size, os.path.getsize(tar))
      with tarfile.open(tar, "r:") as tf:  # uncompressed, or this raises
        self.assertEqual(sorted(n for n in tf.getnames() if n.endswith("/f")), ["jax/f", "warp/f"])
      self.assertEqual([n for n in os.listdir(os.path.dirname(tar)) if ".tmp" in n], [])


class CacheSaveTest(unittest.TestCase):
  def test_a_warm_start_saves_only_when_it_compiled_programs_the_tarball_did_not_hold(self):
    # A body's shared cache: the prewarm's tarball is warm for spin, but spin compiles its own reset and step, which must
    # reach the tarball too. Unpacked entries keep the tarball's older times; anything newer was compiled by this run.
    with tempfile.TemporaryDirectory() as d:
      jax_dir = os.path.join(d, "jax")
      os.makedirs(jax_dir)
      old = os.path.join(jax_dir, "jit_step-aaa-cache")
      open(old, "w").write("x")
      os.utime(old, (1_000_000_000, 1_000_000_000))  # as unpacked: the tarball's time
      since = unpacked_mark(d)
      self.assertFalse(cache_save_due(d, warm=True, since=since))
      self.assertTrue(cache_save_due(d, warm=False, since=since))
      self.assertTrue(cache_save_due(d, warm=True, since=since, compile_only=True))
      open(os.path.join(jax_dir, "jit_reset-bbb-cache"), "w").write("y")  # compiled by this run
      self.assertTrue(cache_save_due(d, warm=True, since=since))
      self.assertFalse(cache_save_due(os.path.join(d, "absent"), warm=True, since=since))


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
