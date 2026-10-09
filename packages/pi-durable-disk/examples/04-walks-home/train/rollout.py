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


def run(xml, body, policy, seconds=10.0, command=0.5, trace_steps=0, kick=0.0, kick_at=4.0):
  if policy["mjcf_sha256"] != sha256_text(xml):
    raise ValueError("policy was trained for a different body (mjcf_sha256 differs)")
  m = mujoco.MjModel.from_xml_string(xml)
  d = mujoco.MjData(m)
  reset(m, d, body)
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
      "seconds": seconds, "command": command, "distance_m": dist, "mean_fwd_speed": float(np.mean(speeds[50:] or [0])),
      "min_up_z": float(np.min(ups)), "final_up_z": float(ups[-1]), "fell_at": fell_at,
      "torso_z_final": float(d.qpos[2]), "kick_N": kick,
  }
  return result, trace


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
  args = ap.parse_args()
  xml = open(args.mjcf, "rb").read().decode("utf-8")
  body = json.load(open(args.body))
  policy = json.load(open(args.policy))
  result, trace = run(xml, body, policy, args.seconds, args.command, args.trace_steps if args.trace else 0, args.kick)
  if args.trace:
    json.dump({"command": args.command, "mujoco_version": mujoco.__version__, "steps": trace}, open(args.trace, "w"))
  print(json.dumps(result))


if __name__ == "__main__":
  main()
