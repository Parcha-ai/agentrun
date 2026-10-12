"""A policy with a NaN or an infinity must never leave the exporter: python -m unittest test_export_finite (numpy only).

The case behind it: a hexapod walk run diverged, its checkpoints carried NaN weights and NaN prev_action statistics, and the
collapse step wrote them into a home policy.json as literal NaN, which is not valid JSON (the tab's JSON.parse refuses it).
"""

import json
import os
import subprocess
import sys
import tempfile
import unittest
import warnings
from types import SimpleNamespace

import numpy as np

import export

HERE = os.path.dirname(os.path.abspath(__file__))
FIX = os.path.join(HERE, "..", "policy", "test", "fixtures", "policy.json")  # a valid mlp-v1 file (walk only)


def jload(path: str) -> dict:
  with open(path) as f:
    return json.load(f)


def jdump(obj: dict, path: str) -> None:
  with open(path, "w") as f:
    json.dump(obj, f)  # Python's default writes NaN as a bare NaN: this is how the diverged run's file was written


def fixture() -> dict:
  return jload(FIX)


def break_weights(policy: dict, layer: int, key: str = "w") -> dict:
  arr = export.unb64f32(policy["layers"][layer][key]).astype("<f4")
  arr[3] = np.nan
  policy["layers"][layer][key] = export.b64f32(arr)
  return policy


class FiniteCheckTest(unittest.TestCase):
  def test_a_finite_policy_passes_and_serialises_strictly(self):
    p = fixture()
    export.assert_finite(p)
    self.assertEqual(json.loads(export.dumps(p))["mjcf_sha256"], p["mjcf_sha256"])

  def test_the_hexapod_case_nan_prev_action_statistics_names_the_indices(self):
    p = fixture()
    od = len(p["obs"]["mean"])
    bad = list(range(od - 8, od - 3))  # a run of inputs, like the 18 prev_action inputs at 45-62
    for i in bad:
      p["obs"]["mean"][i] = float("nan")
      p["obs"]["std"][i] = float("nan")
    with self.assertRaises(export.NonFiniteError) as cm:
      export.assert_finite(p, "walk policy")
    msg = str(cm.exception)
    self.assertIn("walk policy.obs.mean", msg)
    self.assertIn(f"{bad[0]}-{bad[-1]}", msg)  # the run, not a list of numbers
    self.assertIn(f"{len(bad)} of {od}", msg)
    self.assertIn("diverged", msg)

  def test_nan_weights_name_the_layer_and_array(self):
    p = break_weights(fixture(), 1, "w")
    with self.assertRaises(export.NonFiniteError) as cm:
      export.assert_finite(p)
    self.assertIn("layers[1].w", str(cm.exception))
    p = break_weights(fixture(), 0, "b")
    with self.assertRaises(export.NonFiniteError) as cm:
      export.assert_finite(p)
    self.assertIn("layers[0].b", str(cm.exception))

  def test_infinity_and_float32_overflow_count_as_not_finite(self):
    p = fixture()
    p["obs"]["std"][0] = float("inf")
    with self.assertRaises(export.NonFiniteError):
      export.assert_finite(p)
    p = fixture()
    arr = export.unb64f32(p["layers"][0]["w"])
    arr[0] = 1e39  # a float64 that does not fit float32: the tab reads float32, so it is infinity there
    with warnings.catch_warnings():
      warnings.simplefilter("ignore", RuntimeWarning)  # numpy warns about the very overflow this test makes
      p["layers"][0]["w"] = export.b64f32(arr)
    with self.assertRaises(export.NonFiniteError) as cm:
      export.assert_finite(p)
    self.assertIn("layers[0].w", str(cm.exception))

  def test_a_nan_anywhere_else_is_found_too(self):
    p = fixture()
    p["provenance"] = {"walk_10s": {"distance_m": float("nan"), "fell_at": None}}
    with self.assertRaises(export.NonFiniteError) as cm:
      export.assert_finite(p)
    self.assertIn("provenance.walk_10s.distance_m", str(cm.exception))
    with self.assertRaises(ValueError):  # the strict serializer is the last line of defence
      export.dumps(p)

  def test_a_getup_block_is_checked_as_well(self):
    walk = fixture()
    getup = json.loads(json.dumps(walk))
    p = dict(walk, getup={"layers": break_weights(getup, 0, "b")["layers"], "obs": getup["obs"], "act": getup["act"], "switch": {"below_up": 0.3, "above_up": 0.9}})
    with self.assertRaises(export.NonFiniteError) as cm:
      export.assert_finite(p)
    self.assertIn("getup.layers[0].b", str(cm.exception))


class RefusalTest(unittest.TestCase):
  def test_combine_refuses_a_nan_walk_and_a_nan_getup_before_doing_anything(self):
    walk = fixture()
    getup = fixture()
    getup["act"] = {"scale": 2.0, "clip": 1.0}
    export.combine(walk, getup)  # finite: fine
    broken = fixture()
    broken["obs"]["mean"][5] = float("nan")
    with self.assertRaises(export.NonFiniteError) as cm:
      export.combine(broken, getup)
    self.assertIn("walk policy", str(cm.exception))
    with self.assertRaises(export.NonFiniteError) as cm:
      export.combine(walk, break_weights(json.loads(json.dumps(getup)), 1))
    self.assertIn("getup policy", str(cm.exception))

  def test_export_policy_refuses_a_nan_normalizer_and_nan_weights(self):
    nu = 2
    def params(mean, kernel):
      norm = SimpleNamespace(mean={"state": np.asarray(mean)}, std={"state": np.ones(len(mean))})
      return norm, {"params": {"Dense_0": {"kernel": np.asarray(kernel), "bias": np.zeros(2 * nu)}}}
    kw = dict(obs_spec=[("command", 1)], nu=nu, mjcf="<mujoco/>", mujoco_version="3.15.0", gait_hz=2.0, action_scale=0.5,
              command_range=[0.0, 0.8], provenance={"universe": "t"})
    ok = export.export_policy(params([0.0], np.ones((1, 2 * nu))), **kw)
    self.assertEqual(ok["layers"][0]["out"], nu)
    with self.assertRaises(export.NonFiniteError) as cm:
      export.export_policy(params([np.nan], np.ones((1, 2 * nu))), **kw)
    self.assertIn("obs.mean", str(cm.exception))
    bad_kernel = np.ones((1, 2 * nu)); bad_kernel[0, 0] = np.nan
    with self.assertRaises(export.NonFiniteError) as cm:
      export.export_policy(params([0.0], bad_kernel), **kw)
    self.assertIn("layers[0].w", str(cm.exception))

  def test_pin_constant_inputs_does_not_touch_a_nan_std_so_the_finite_check_must_come_first(self):
    # `std <= floor` is False for NaN: pinning alone would let a NaN std through; export_policy and combine check finiteness before pinning.
    obs = {"std": [0.5, float("nan"), 1e-6]}
    self.assertEqual(export.pin_constant_inputs(obs), [2])
    self.assertTrue(np.isnan(obs["std"][1]))

  def test_the_combine_command_leaves_no_file_behind_on_a_nan_walk(self):
    with tempfile.TemporaryDirectory() as d:
      walk, getup, out = (os.path.join(d, n) for n in ("walk.json", "getup.json", "home.json"))
      broken = fixture()
      broken["obs"]["std"][2] = float("nan")
      jdump(broken, walk)
      jdump(fixture(), getup)
      r = subprocess.run([sys.executable, os.path.join(HERE, "export.py"), "combine", walk, getup, "--out", out], capture_output=True, text=True)
      self.assertNotEqual(r.returncode, 0)
      self.assertIn("refusing to export", r.stderr)
      self.assertIn("walk policy", r.stderr)
      self.assertEqual(sorted(os.listdir(d)), ["getup.json", "walk.json"], "no home.json and no .tmp file")
      # and the finite pair still combines, writing a file that strict JSON accepts
      jdump(fixture(), walk)
      r = subprocess.run([sys.executable, os.path.join(HERE, "export.py"), "combine", walk, getup, "--out", out], capture_output=True, text=True)
      self.assertEqual(r.returncode, 0, r.stderr)
      def refuse(c):
        raise ValueError(c)
      with open(out) as f:
        json.load(f, parse_constant=refuse)
      self.assertEqual(sorted(os.listdir(d)), ["getup.json", "home.json", "walk.json"])


if __name__ == "__main__":
  unittest.main()
