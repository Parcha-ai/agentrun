"""Brax PPO params -> mlp-v1 policy.json (the tab's format, policy/POLICY-FORMAT.md), and a numpy runner for it.

The file is the whole contract: the tab never sees Brax. Invariants:
- layers are row-major [out][in] float32, little-endian, base64; hidden layers "silu", the last "tanh";
- the last layer keeps only the action mean (the first nu outputs of Brax's tanh-normal head): the tab acts
  deterministically with tanh(mean);
- obs.mean/obs.std are the normalizer's, applied as (obs - mean) / std with no clipping, as Brax does.
"""

from __future__ import annotations

import base64
import hashlib
import json
from typing import Any

import numpy as np

FORMAT = "mlp-v1"
SPEC_VERSION = 1
MAX_POLICY_BYTES = 600 * 1024  # policy/policy.ts: two networks of 128x3 are about 440 KB


def b64f32(a: np.ndarray) -> str:
  return base64.b64encode(np.ascontiguousarray(a, dtype="<f4").tobytes()).decode("ascii")


def unb64f32(s: str) -> np.ndarray:
  return np.frombuffer(base64.b64decode(s), dtype="<f4").astype(np.float64)


def sha256_text(text: str) -> str:
  return hashlib.sha256(text.encode("utf-8")).hexdigest()


class NonFiniteError(ValueError):
  """A policy has a NaN or infinite number somewhere. Still a ValueError, so callers that catch ValueError keep working."""


def _runs(indices: list[int]) -> str:
  """[45, 46, 47, 50] -> "45-47, 50" """
  out: list[str] = []
  start = prev = None
  for i in indices:
    if start is None:
      start = prev = i
    elif i == prev + 1:
      prev = i
    else:
      out.append(f"{start}-{prev}" if prev != start else str(start))
      start = prev = i
  if start is not None:
    out.append(f"{start}-{prev}" if prev != start else str(start))
  return ", ".join(out)


def non_finite(policy: dict[str, Any], where: str = "policy") -> list[str]:
  """Everything non-finite in a policy dict, as readable lines: every float anywhere, and the numbers inside the base64
  weights and biases of every layer list (as float32, which is what the tab reads: a float64 that overflows float32 counts)."""
  found: list[str] = []

  def walk(o: Any, path: str) -> None:
    if isinstance(o, float):
      if not np.isfinite(o):
        found.append(f"{where}.{path} = {o}")
    elif isinstance(o, dict):
      for k, v in o.items():
        walk(v, f"{path}.{k}" if path else str(k))
    elif isinstance(o, list):
      bad = [i for i, v in enumerate(o) if isinstance(v, float) and not np.isfinite(v)]
      if bad and all(isinstance(v, (int, float)) for v in o):
        found.append(f"{where}.{path}: {len(bad)} of {len(o)} values are not finite, at indices {_runs(bad)}")
      else:
        for i, v in enumerate(o):
          walk(v, f"{path}[{i}]")

  walk(policy, "")
  for block in ("layers", "getup.layers"):
    layers: Any = policy
    for part in block.split("."):
      layers = layers.get(part) if isinstance(layers, dict) else None
    for i, layer in enumerate(layers or []):
      for key in ("w", "b"):
        if key in layer:
          arr = np.frombuffer(base64.b64decode(layer[key]), dtype="<f4")
          n = int(np.count_nonzero(~np.isfinite(arr)))
          if n:
            found.append(f"{where}.{block}[{i}].{key}: {n} of {arr.size} values are not finite")
  return found


def assert_finite(policy: dict[str, Any], where: str = "policy") -> None:
  """Refuse a policy with a NaN or infinity anywhere: such a file is not valid JSON, and a diverged training run is the usual cause."""
  found = non_finite(policy, where)
  if found:
    shown = "; ".join(found[:6]) + (f"; and {len(found) - 6} more" if len(found) > 6 else "")
    raise NonFiniteError(f"refusing to export, {where} is not finite: {shown}. The training run most likely diverged (NaN weights make NaN actions, and the prev_action statistics follow); rerun it.")


def dumps(policy: dict[str, Any]) -> str:
  """The one place a policy becomes text: strict JSON (no NaN, no Infinity), which the tab's JSON.parse requires."""
  return json.dumps(policy, allow_nan=False)


PINNED_STD = 1e9


def pin_constant_inputs(obs: dict[str, Any], floor: float = 1e-5) -> list[int]:
  """Inputs the network never saw vary (normalizer std at its floor, e.g. the command of a getup network trained with
  none) are pinned: a huge std makes (x - mean) / std ~ 0, the value training fed it, whatever the tab sends. Without
  this a 0.5 m/s slider reaches the network as 500000. Returns the pinned indices."""
  pinned = [i for i, sd in enumerate(obs["std"]) if sd <= floor]
  for i in pinned:
    obs["std"][i] = PINNED_STD
  return pinned


def export_policy(params: tuple, *, obs_spec: list[tuple[str, int]], nu: int, mjcf: str, mujoco_version: str,
                  gait_hz: float, action_scale: float, command_range: list[float], provenance: dict[str, Any],
                  activation: str = "silu") -> dict[str, Any]:
  normalizer, policy_params = params[0], params[1]
  mean = np.asarray(normalizer.mean["state"], dtype=np.float64)
  std = np.asarray(normalizer.std["state"], dtype=np.float64)
  dense = policy_params["params"]
  names = sorted(dense.keys(), key=lambda k: int(k.split("_")[-1]))
  layers = []
  for i, name in enumerate(names):
    kernel = np.asarray(dense[name]["kernel"], dtype=np.float64)  # flax: (in, out)
    bias = np.asarray(dense[name]["bias"], dtype=np.float64)
    last = i == len(names) - 1
    if last:
      if kernel.shape[1] != 2 * nu:
        raise ValueError(f"policy head has {kernel.shape[1]} outputs, expected 2 * {nu} (tanh-normal)")
      kernel, bias = kernel[:, :nu], bias[:nu]
    layers.append({"in": int(kernel.shape[0]), "out": int(kernel.shape[1]), "w": b64f32(kernel.T), "b": b64f32(bias),
                   "act": "tanh" if last else activation})
  od = sum(size for _, size in obs_spec)
  if mean.shape != (od,):
    raise ValueError(f"normalizer has {mean.shape}, the obs spec needs {od}")
  policy = {
      "format": FORMAT,
      "spec_version": SPEC_VERSION,
      "mujoco_version": mujoco_version,
      "mjcf_sha256": sha256_text(mjcf),
      "control_dt": 0.02,
      "obs": {"spec": [{"name": n, "size": s} for n, s in obs_spec], "mean": mean.tolist(), "std": std.tolist()},
      "clock": {"gait_hz": gait_hz},
      "act": {"scale": action_scale, "clip": 1.0},
      "command_range": list(command_range),
      "layers": layers,
      "provenance": provenance,
  }
  assert_finite(policy, "exported policy")  # before pinning: a NaN std is not <= the floor, so it would slip through unpinned
  pin_constant_inputs(policy["obs"])
  size = len(dumps(policy))
  if size > MAX_POLICY_BYTES:
    raise ValueError(f"policy.json is {size} bytes, over the tab's {MAX_POLICY_BYTES}")
  return policy


ACT = {
    "tanh": np.tanh,
    "silu": lambda x: x / (1.0 + np.exp(-x)),
    "elu": lambda x: np.where(x > 0, x, np.expm1(np.minimum(x, 0))),
    "relu": lambda x: np.maximum(x, 0),
    "none": lambda x: x,
}


def combine(walk: dict[str, Any], getup: dict[str, Any], below_up: float = 0.3, above_up: float = 0.9) -> dict[str, Any]:
  """One file from a walking and a getup policy of the same body: the getup network runs while the torso's uprightness
  is below below_up until it is above above_up (policy/policy.ts implements the same rule)."""
  assert_finite(walk, "walk policy")
  assert_finite(getup, "getup policy")
  if walk["mjcf_sha256"] != getup["mjcf_sha256"]:
    raise ValueError("the two policies were trained for different bodies")
  if walk.get("clock") != getup.get("clock"):
    raise ValueError("the getup network runs on the walking network's phase clock; train both at the same gait_hz")
  out = dict(walk)
  # Its own normalizer and action scale, written out; the clock is the top level's.
  getup_obs = {**getup["obs"], "std": list(getup["obs"]["std"])}
  pin_constant_inputs(getup_obs)
  out["getup"] = {"layers": getup["layers"], "obs": getup_obs, "act": getup["act"],
                  "switch": {"below_up": below_up, "above_up": above_up}}
  out["provenance"] = {"walk": walk.get("provenance"), "getup": getup.get("provenance")}
  assert_finite(out, "combined policy")
  size = len(dumps(out))
  if size > MAX_POLICY_BYTES:
    raise ValueError(f"policy.json is {size} bytes, over the tab's {MAX_POLICY_BYTES}")
  return out


class _Net:
  def __init__(self, net: dict[str, Any], top: dict[str, Any] | None = None):
    top = top or net
    net = {"obs": net.get("obs", top["obs"]), "act": net.get("act", top["act"]), "layers": net["layers"],
           "clock": top.get("clock", {})}
    self.spec = net["obs"]["spec"]
    self.mean = np.asarray(net["obs"]["mean"], dtype=np.float64)
    self.std = np.asarray(net["obs"]["std"], dtype=np.float64)
    self.layers = [(unb64f32(l["w"]).reshape(l["out"], l["in"]), unb64f32(l["b"]), ACT[l["act"]]) for l in net["layers"]]
    self.clip = float(net["act"].get("clip", 1.0))
    self.scale = float(net["act"]["scale"])
    self.gait_hz = float(net.get("clock", {}).get("gait_hz", 0.0))


class NumpyPolicy:
  """Runs a policy.json the way policy/policy.ts does: float64 activations, float32 weights, and the same handover to
  the getup network on uprightness when the file has one."""

  def __init__(self, policy: dict[str, Any]):
    self.policy = policy
    self.nets = {"walk": _Net(policy)}
    if "getup" in policy:
      self.nets["getup"] = _Net(policy["getup"], policy)
    self.switch = policy.get("getup", {}).get("switch")
    self.skill = "walk"

  @property
  def net(self) -> _Net:
    return self.nets.get(self.skill, self.nets["walk"])

  def update(self, qpos) -> str:
    """Hand control over if the torso crossed a switch threshold; call before observing."""
    if "getup" in self.nets and self.switch:
      up = 1 - 2 * (qpos[4] ** 2 + qpos[5] ** 2)
      if self.skill == "walk" and up < self.switch["below_up"]:
        self.skill = "getup"
      elif self.skill == "getup" and up > self.switch["above_up"]:
        self.skill = "walk"
    return self.skill

  def act(self, obs: np.ndarray) -> np.ndarray:
    n = self.net
    x = (np.asarray(obs, dtype=np.float64) - n.mean) / n.std
    for w, b, fn in n.layers:
      x = fn(w @ x + b)
    return np.clip(x, -n.clip, n.clip)


def main() -> None:
  """python export.py combine WALK.json GETUP.json --out policy.json [--below 0.3 --above 0.9]: the collapse step's
  last move, the winning walker plus the body's getup network in one file for the tab."""
  import argparse
  ap = argparse.ArgumentParser()
  sub = ap.add_subparsers(dest="cmd", required=True)
  c = sub.add_parser("combine")
  c.add_argument("walk")
  c.add_argument("getup")
  c.add_argument("--out", required=True)
  c.add_argument("--below", type=float, default=0.3)
  c.add_argument("--above", type=float, default=0.9)
  c.add_argument("--min-walk-m", type=float, default=1.0, help="refuse a walker whose checkpoint walked less than this")
  args = ap.parse_args()
  walk = json.load(open(args.walk))
  walked = ((walk.get("provenance") or {}).get("walk_10s") or {}).get("distance_m")
  if walked is not None and walked < args.min_walk_m:
    raise SystemExit(f"refusing {args.walk}: its checkpoint walked {walked:.3f} m in 10 s (< {args.min_walk_m} m); "
                     "a collapse must not ship a walker that does not walk")
  out = combine(walk, json.load(open(args.getup)), args.below, args.above)
  import os
  text = dumps(out)  # serialised before anything is created: a refusal leaves no file behind
  tmp = f"{args.out}.tmp-{os.getpid()}"
  try:
    with open(tmp, "w") as f:
      f.write(text)
    os.replace(tmp, args.out)
  finally:
    if os.path.exists(tmp):
      os.remove(tmp)
  print(json.dumps({"out": args.out, "bytes": os.path.getsize(args.out), "mjcf_sha256": out["mjcf_sha256"]}))


if __name__ == "__main__":
  main()
