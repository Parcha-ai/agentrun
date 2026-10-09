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
  size = len(json.dumps(policy))
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
  if walk["mjcf_sha256"] != getup["mjcf_sha256"]:
    raise ValueError("the two policies were trained for different bodies")
  if walk.get("clock") != getup.get("clock"):
    raise ValueError("the getup network runs on the walking network's phase clock; train both at the same gait_hz")
  out = dict(walk)
  # Its own normalizer and action scale, written out; the clock is the top level's.
  out["getup"] = {"layers": getup["layers"], "obs": getup["obs"], "act": getup["act"],
                  "switch": {"below_up": below_up, "above_up": above_up}}
  out["provenance"] = {"walk": walk.get("provenance"), "getup": getup.get("provenance")}
  size = len(json.dumps(out))
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
