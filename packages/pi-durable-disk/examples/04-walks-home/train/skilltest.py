"""What a skill's test.py runs on: one checkpoint in C MuJoCo with the tab's arithmetic (rollout.py's reset, observe and
control; the same network file the page loads), at the tab's control rate.

A skill's test.py defines

  def test(sim):
      r = sim.rollout(seconds=10)
      speed = r.along_mps()
      return r.fell_at is None and speed >= 0.4, {"name": "speed", "value": round(speed, 3), "unit": "m/s", "target": ">= 0.4"}

returning (passes, metric): whether this checkpoint does the skill, and the one number the stage shows for it.

sim.rollout(seconds=10.0, command=None, start="stand", kick=0.0) -> Rollout
  command  the policy's command (default: the skill's own, as the page sends it)
  start    "stand" (the settled standing pose), or "left side", "right side", "back" (dropped from just above the ground)
  kick     a forward push on the torso at 4 s, newtons over 5 physics steps (the tab's kick)

A Rollout holds one row per control step (r.dt = 0.02 s), all numpy:
  r.t (T,)                 seconds
  r.torso_pos (T, 3)       world; r.torso_height (T,) above the floor
  r.up (T,)                uprightness: 1 standing, 0 on its side, -1 on its back
  r.yaw (T,)               heading, rad, unwrapped (positive: turned left); r.pitch (T,) nose up, rad; r.roll (T,) rad
  r.lin_vel (T, 3)         torso velocity, body frame (x forward); r.ang_vel (T, 3) body frame
  r.joint_pos (T, nj)      motor joint angles (actuator order); r.stand_pose (nj,)
  r.feet_pos (T, nf, 3)    feet (the body's legs, in order); r.feet_height (T, nf); r.feet_contact (T, nf)
  r.fell_at                the first time up < 0, or None
  r.body_pos("head") (T, 3), r.joint("tail0_j") (T,)
and the measures the built-in skills use:
  r.along_mps()            displacement along the starting heading / duration
  r.total_mps()            straight-line displacement / duration
  r.yaw_rate()             total turn / duration, rad/s
  r.share(mask, after_s=2) fraction of the steps after after_s where mask is true
  r.righted_s()            from a fallen start: the first time up > 0.9 held for 1 s, or None
"""
from __future__ import annotations

import math

import mujoco
import numpy as np

import rollout
from export import NumpyPolicy

STARTS = ("stand", "left side", "right side", "back")


class Rollout:
  def __init__(self, m, rows: dict, body: dict, dt: float):
    self._m, self._rows, self.dt = m, rows, dt
    for k, v in rows.items():
      if not k.startswith("_"):
        setattr(self, k, v)
    self.stand_pose = np.array(body["standPose"])
    up = self.up
    fell = np.nonzero(up < 0.0)[0]
    self.fell_at = None if len(fell) == 0 else round(float(self.t[fell[0]]), 2)

  def _duration(self) -> float:
    return float(len(self.t) * self.dt)

  def along_mps(self) -> float:
    d = self.torso_pos[-1, :2] - self._rows["_start_xy"]
    y0 = self._rows["_start_yaw"]
    return float(d[0] * math.cos(y0) + d[1] * math.sin(y0)) / self._duration()

  def total_mps(self) -> float:
    return float(np.linalg.norm(self.torso_pos[-1, :2] - self._rows["_start_xy"])) / self._duration()

  def yaw_rate(self) -> float:
    return float(self.yaw[-1] - self._rows["_start_yaw"]) / self._duration()

  def share(self, mask, after_s: float = 2.0) -> float:
    mask = np.asarray(mask, dtype=bool)
    k = int(round(after_s / self.dt))
    tail = mask[k:]
    return float(tail.mean()) if len(tail) else 0.0

  def righted_s(self):
    hold = int(round(1.0 / self.dt))
    for i in range(len(self.up) - hold):
      if (self.up[i:i + hold + 1] > 0.9).all():
        return round(i * self.dt, 2)
    return None

  def body_pos(self, name: str):
    return self._rows["_xpos"][:, self._id(mujoco.mjtObj.mjOBJ_BODY, name), :]

  def joint(self, name: str):
    j = self._id(mujoco.mjtObj.mjOBJ_JOINT, name)
    return self._rows["_qpos"][:, self._m.jnt_qposadr[j]]

  def _id(self, kind, name: str) -> int:
    i = mujoco.mj_name2id(self._m, kind, name)
    if i < 0:
      raise KeyError(f"no {'body' if kind == mujoco.mjtObj.mjOBJ_BODY else 'joint'} named {name!r}")
    return i


class Sim:
  """One checkpoint on one body; `command` is the skill's own command (what the page sends)."""

  def __init__(self, xml: str, body: dict, policy: dict, command: float):
    self.xml, self.body, self.policy, self.command = xml, body, policy, float(command)
    self.nj = len(body["jointNames"])
    self.legs = list(body["legs"])

  def rollout(self, seconds: float = 10.0, command: float | None = None, start: str = "stand", kick: float = 0.0) -> Rollout:
    if start not in STARTS:
      raise ValueError(f"start must be one of {STARTS}")
    command = self.command if command is None else float(command)
    m = mujoco.MjModel.from_xml_string(self.xml)
    d = mujoco.MjData(m)
    rollout.reset(m, d, self.body)
    if start != "stand":
      ax, ay, az, angle = rollout.GETUP_STARTS[start]
      d.qpos[3:7] = [math.cos(angle / 2), ax * math.sin(angle / 2), ay * math.sin(angle / 2), az * math.sin(angle / 2)]
      d.qpos[2] = 0.45
      mujoco.mj_forward(m, d)
    net = NumpyPolicy(self.policy)
    stand = np.array(self.body["standPose"])
    dt = float(self.policy["control_dt"])
    n_sub = int(round(dt / m.opt.timestep))
    feet = [m.geom(f"{leg}_foot").id for leg in self.legs]
    foot_r = np.array(self.body.get("footRadius") or [m.geom_size[g][0] for g in feet])
    torso = m.body("torso").id
    prev = np.zeros(m.nu)
    steps = int(round(seconds / dt))
    kick_step = int(round(4.0 / dt)) if kick > 0 else -1
    rows = {k: [] for k in ("t", "torso_pos", "torso_height", "up", "yaw", "pitch", "roll", "lin_vel", "ang_vel", "joint_pos",
                            "feet_pos", "feet_height", "feet_contact", "_qpos", "_xpos")}
    start_xy = d.qpos[0:2].copy()
    for k in range(steps):
      a, d.ctrl[:] = rollout.control(net, d, stand, prev, command)
      for s in range(n_sub):
        d.xfrc_applied[torso, :3] = [kick, 0.0, 0.0] if (k == kick_step and s < 5) else [0.0, 0.0, 0.0]
        mujoco.mj_step(m, d)
      prev = a
      q = d.qpos[3:7]
      g = rollout.to_body(q, [0.0, 0.0, -1.0])
      rows["t"].append(d.time)
      rows["torso_pos"].append(d.qpos[0:3].copy())
      rows["torso_height"].append(float(d.qpos[2]))
      rows["up"].append(float(-g[2]))
      rows["yaw"].append(math.atan2(2 * (q[0] * q[3] + q[1] * q[2]), 1 - 2 * (q[2] ** 2 + q[3] ** 2)))
      rows["pitch"].append(math.asin(max(-1.0, min(1.0, -g[0]))))
      rows["roll"].append(math.atan2(g[1], -g[2]))
      rows["lin_vel"].append(np.array(rollout.to_body(q, d.qvel[0:3])))
      rows["ang_vel"].append(d.qvel[3:6].copy())
      rows["joint_pos"].append(d.qpos[7:7 + self.nj].copy())
      fp = np.array([d.geom_xpos[g_] for g_ in feet])
      rows["feet_pos"].append(fp)
      h = fp[:, 2] - foot_r
      rows["feet_height"].append(h)
      rows["feet_contact"].append(h < 0.005)
      rows["_qpos"].append(d.qpos.copy())
      rows["_xpos"].append(d.xpos.copy())
      if not np.isfinite(d.qpos).all():
        break
    out = {k: np.array(v) for k, v in rows.items()}
    out["yaw"] = np.unwrap(out["yaw"])
    out["_start_xy"] = start_xy
    out["_start_yaw"] = float(out["yaw"][0]) if len(out["yaw"]) else 0.0
    return Rollout(m, out, self.body, dt)


def run_test(test_fn, sim: Sim):
  """test.py's verdict, checked: (passes: bool, metric: {name, value, unit, target})."""
  got = test_fn(sim)
  if not (isinstance(got, tuple) and len(got) == 2):
    raise ValueError("test(sim) must return (passes, metric)")
  ok, metric = got
  if not isinstance(metric, dict) or not {"name", "value"} <= set(metric):
    raise ValueError("test(sim)'s metric must be a dict with at least name and value (and unit, target)")
  value = metric.get("value")
  if value is not None and not (isinstance(value, (int, float)) and math.isfinite(value)):
    raise ValueError(f"the metric's value must be a finite number or None, not {value!r}")
  return bool(ok), {"name": str(metric["name"]), "value": None if value is None else float(value),
                    "unit": str(metric.get("unit", "")), "target": str(metric.get("target", ""))}
