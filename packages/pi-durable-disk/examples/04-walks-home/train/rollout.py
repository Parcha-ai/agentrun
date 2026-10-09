"""Run a policy.json in C MuJoCo the way the tab runs it in WASM, and score or trace the rollout.

  python rollout.py --mjcf creature.xml --body body.json --policy policy.json [--seconds 10] [--command 0.5]
                    [--trace trace.json] [--kick 60]

The observation is built exactly as policy/obs.ts builds it (float64, no noise), the action exactly as policy.ts and
the tab's sim.ts apply it (ctrl = standPose + scale * action, then n physics steps). The trace is the input of the
node parity test (test/parity.test.ts), which replays the same steps through @mujoco/mujoco and policy.ts.
"""

from __future__ import annotations

import argparse
import json
import math

import mujoco
import numpy as np

from export import NumpyPolicy, sha256_text


def to_body(q, v):
  w, u = q[0], -np.asarray(q[1:4])
  c = np.cross(u, v) + w * np.asarray(v)
  return np.asarray(v) + 2.0 * np.cross(u, c)


def observe(spec, data, stand, prev_action, command, t, gait_hz):
  q, qd = data.qpos, data.qvel
  nj = len(stand)
  out = []
  for s in spec:
    n = s["name"]
    if n == "gravity":
      out += list(to_body(q[3:7], [0.0, 0.0, -1.0]))
    elif n == "ang_vel":
      out += list(qd[3:6])
    elif n == "lin_vel":
      out += list(to_body(q[3:7], qd[0:3]))
    elif n == "joint_pos":
      out += [q[7 + i] - stand[i] for i in range(nj)]
    elif n == "joint_vel":
      out += list(qd[6:6 + nj])
    elif n == "prev_action":
      out += list(prev_action)
    elif n == "command":
      out += [command]
    elif n == "phase":
      a = 2 * math.pi * gait_hz * t
      out += [math.sin(a), math.cos(a)]
    else:
      raise ValueError(f"unknown slice {n}")
  return np.array(out)


def reset(m, d, body):
  mujoco.mj_resetData(m, d)
  k = mujoco.mj_name2id(m, mujoco.mjtObj.mjOBJ_KEY, "home")
  if k >= 0:
    mujoco.mj_resetDataKeyframe(m, d, k)
  else:
    d.qpos[2] = body["standHeight"]
    d.qpos[7:] = body["standPose"]
    d.ctrl[:] = body["standPose"]
  mujoco.mj_forward(m, d)


def run(xml, body, policy, seconds=10.0, command=0.5, trace_steps=0, kick=0.0, kick_at=4.0, world=None):
  """world: a terrain.json (terrain.py) to run on; its first spawn point is the start. The body's identity check is on
  the body XML alone, as in the tab."""
  if policy["mjcf_sha256"] != sha256_text(xml):
    raise ValueError("policy was trained for a different body (mjcf_sha256 differs)")
  if world is not None:
    import terrain
    xml = terrain.splice(xml, world)
  m = mujoco.MjModel.from_xml_string(xml)
  d = mujoco.MjData(m)
  reset(m, d, body)
  if world is not None:
    d.qpos[0:3] += world["spawns"][0]
    mujoco.mj_forward(m, d)
  net = NumpyPolicy(policy)
  stand = np.array(body["standPose"])
  n_sub = int(round(policy["control_dt"] / m.opt.timestep))
  gait_hz = policy.get("clock", {}).get("gait_hz", 0.0)
  scale = policy["act"]["scale"]
  torso = m.body("torso").id
  prev = np.zeros(m.nu)
  steps = int(round(seconds / policy["control_dt"]))
  x0 = d.qpos[0:2].copy()
  trace, ups, speeds, fell_at = [], [], [], None
  kick_step = int(round(kick_at / policy["control_dt"])) if kick > 0 else -1
  for k in range(steps):
    t = d.time
    obs = observe(policy["obs"]["spec"], d, stand, prev, command, t, gait_hz)
    a = net.act(obs)
    d.ctrl[:] = stand + scale * a
    if k < trace_steps:
      trace.append({"k": k, "t": t, "qpos": d.qpos.tolist(), "qvel": d.qvel.tolist(), "obs": obs.tolist(),
                    "action": a.tolist()})
    for s in range(n_sub):
      # The tab's kick: a horizontal force on the torso for 5 physics steps.
      d.xfrc_applied[torso, :3] = [kick, 0.0, 0.0] if (k == kick_step and s < 5) else [0.0, 0.0, 0.0]
      mujoco.mj_step(m, d)
    prev = a
    up_z = -to_body(d.qpos[3:7], [0.0, 0.0, -1.0])[2]
    ups.append(up_z)
    speeds.append(to_body(d.qpos[3:7], d.qvel[0:3])[0])
    if fell_at is None and up_z < 0.0:
      fell_at = d.time
    if not np.isfinite(d.qpos).all():
      fell_at = fell_at or d.time
      break
  dist = float(np.linalg.norm(d.qpos[0:2] - x0))
  result = {
      "seconds": seconds, "command": command, "distance_m": dist, "progress_x": float(d.qpos[0] - x0[0]), "mean_fwd_speed": float(np.mean(speeds[50:] or [0])),
      "min_up_z": float(np.min(ups)), "final_up_z": float(ups[-1]), "fell_at": fell_at,
      "torso_z_final": float(d.qpos[2]), "kick_N": kick,
  }
  return result, trace


KICK_DIRS = {"forward": (1.0, 0.0), "back": (-1.0, 0.0), "left": (0.0, 1.0), "right": (0.0, -1.0)}


def kick_trial(xml, body, policy, force, direction, command=0.5, walk_s=3.0, after_s=4.0, kick_steps=12):
  """The tab's kick protocol (tab/scripts/kick-sweep.ts): walk walk_s at command, push the torso horizontally in the
  heading frame for kick_steps physics steps, watch after_s. Up = never below 0.3 uprightness, above 0.9 at the end."""
  m = mujoco.MjModel.from_xml_string(xml)
  d = mujoco.MjData(m)
  reset(m, d, body)
  net = NumpyPolicy(policy)
  stand = np.array(body["standPose"])
  n_sub = int(round(policy["control_dt"] / m.opt.timestep))
  gait_hz = policy.get("clock", {}).get("gait_hz", 0.0)
  torso = m.body("torso").id
  prev = np.zeros(m.nu)
  kick_at = int(round(walk_s / policy["control_dt"]))
  left = kick_steps
  min_up_after = 1.0
  up = lambda: 1 - 2 * (d.qpos[4] ** 2 + d.qpos[5] ** 2)
  for k in range(int(round((walk_s + after_s) / policy["control_dt"]))):
    a = net.act(observe(policy["obs"]["spec"], d, stand, prev, command, d.time, gait_hz))
    d.ctrl[:] = stand + policy["act"]["scale"] * a
    for _ in range(n_sub):
      if k >= kick_at and left > 0:
        q = d.qpos[3:7]
        yaw = math.atan2(2 * (q[0] * q[3] + q[1] * q[2]), 1 - 2 * (q[2] ** 2 + q[3] ** 2))
        fx, fy = direction
        c, s_ = math.cos(yaw), math.sin(yaw)
        d.xfrc_applied[torso, :3] = [force * (c * fx - s_ * fy), force * (s_ * fx + c * fy), 0.0]
        left -= 1
      else:
        d.xfrc_applied[torso, :3] = 0.0
      mujoco.mj_step(m, d)
    prev = a
    if k >= kick_at:
      min_up_after = min(min_up_after, up())
  final = up()
  return {"up": bool(min_up_after >= 0.3 and final > 0.9), "recovered": bool(min_up_after < 0.3 and final > 0.9),
          "min_up": round(float(min_up_after), 3), "final_up": round(float(final), 3)}


def kick_sweep(xml, body, policy, forces=(40, 60, 80, 100, 120, 150)):
  table = {f: {name: kick_trial(xml, body, policy, f, dv) for name, dv in KICK_DIRS.items()} for f in forces}
  holds = [f for f in forces if all(table[f][n]["up"] for n in KICK_DIRS)]
  # The largest force the policy stays up under from every side, with every smaller force passing too.
  bar = 0
  for f in forces:
    if f not in holds:
      break
    bar = f
  return {"holds_all_sides_N": bar, "table": {str(f): {n: ("up" if r["up"] else "recovered" if r["recovered"] else "FELL")
                                                      for n, r in row.items()} for f, row in table.items()}}


GETUP_STARTS = {"left side": (1.0, 0.0, 0.0, math.pi / 2), "right side": (1.0, 0.0, 0.0, -math.pi / 2),
                "back": (1.0, 0.0, 0.0, math.pi)}


def getup_trial(xml, body, policy, start, seconds=6.0, command=0.0):
  """Lay the creature on its side or back (rotated about its long axis, legs in the stand pose, dropped from just above
  the ground) and run the policy. Righted = up > 0.9 and still up > 0.9 one second later."""
  m = mujoco.MjModel.from_xml_string(xml)
  d = mujoco.MjData(m)
  reset(m, d, body)
  ax, ay, az, angle = GETUP_STARTS[start]
  d.qpos[3:7] = [math.cos(angle / 2), ax * math.sin(angle / 2), ay * math.sin(angle / 2), az * math.sin(angle / 2)]
  d.qpos[2] = 0.45
  mujoco.mj_forward(m, d)
  net = NumpyPolicy(policy)
  stand = np.array(body["standPose"])
  n_sub = int(round(policy["control_dt"] / m.opt.timestep))
  gait_hz = policy.get("clock", {}).get("gait_hz", 0.0)
  prev = np.zeros(m.nu)
  ups = []
  for _ in range(int(round(seconds / policy["control_dt"]))):
    a = net.act(observe(policy["obs"]["spec"], d, stand, prev, command, d.time, gait_hz))
    d.ctrl[:] = stand + policy["act"]["scale"] * a
    for _ in range(n_sub):
      mujoco.mj_step(m, d)
    prev = a
    ups.append(1 - 2 * (d.qpos[4] ** 2 + d.qpos[5] ** 2))
  ups = np.array(ups)
  hold = int(round(1.0 / policy["control_dt"]))
  righted = next((i for i in range(len(ups) - hold) if (ups[i:i + hold + 1] > 0.9).all()), None)
  return {"start": start, "righted_s": None if righted is None else round(righted * policy["control_dt"], 2),
          "final_up": round(float(ups[-1]), 3)}


def main():
  ap = argparse.ArgumentParser()
  ap.add_argument("--mjcf", required=True)
  ap.add_argument("--body", required=True)
  ap.add_argument("--policy", required=True)
  ap.add_argument("--seconds", type=float, default=10.0)
  ap.add_argument("--command", type=float, default=0.5)
  ap.add_argument("--kick", type=float, default=0.0)
  ap.add_argument("--trace")
  ap.add_argument("--trace-steps", type=int, default=200)
  ap.add_argument("--kick-sweep", action="store_true", help="the tab's kick table instead of a walk")
  ap.add_argument("--getup", action="store_true", help="time to right itself from its sides and back")
  args = ap.parse_args()
  if args.kick_sweep or args.getup:
    xml = open(args.mjcf, "rb").read().decode("utf-8")
    body, policy = json.load(open(args.body)), json.load(open(args.policy))
    if args.kick_sweep:
      print(json.dumps(kick_sweep(xml, body, policy)))
    if args.getup:
      print(json.dumps([getup_trial(xml, body, policy, s) for s in GETUP_STARTS]))
    return
  xml = open(args.mjcf, "rb").read().decode("utf-8")
  body = json.load(open(args.body))
  policy = json.load(open(args.policy))
  result, trace = run(xml, body, policy, args.seconds, args.command, args.trace_steps if args.trace else 0, args.kick)
  if args.trace:
    json.dump({"command": args.command, "mujoco_version": mujoco.__version__, "steps": trace}, open(args.trace, "w"))
  print(json.dumps(result))


if __name__ == "__main__":
  main()
