"""The body a skill trains on, from any MJCF that keeps the contract (code mode: the agent writes the robot).

  python body.py creature.xml --out body.json

The contract:
  - the root body is named `torso` and has a free joint;
  - every trainable joint is a hinge driven by one `position` actuator, and the actuated joints come first in the
    tree (qpos[7 : 7 + nu], in actuator order); joints with no actuator (a tail or a neck on springs) come after them;
  - each foot is a geom named `<leg>_foot` (the walk's gait terms read their contacts);
  - a keyframe `home` gives the motors' standing targets in `ctrl` (absent: 0, clipped to each actuator's range).

body.json keeps the fields the trainer and the tab already read (legs, jointNames, standPose, standHeight) and adds
standQpos, the whole pose after the body settled on its standing targets (the standing height is measured, not
declared). A body that does not keep the contract, or does not stand, is refused with what to fix.
"""
from __future__ import annotations

import argparse, json, math, sys

import mujoco
import numpy as np

SETTLE_S = 3.0


class BodyRefused(ValueError):
  pass


def _up_z(quat) -> float:
  w, x, y, z = quat
  return 1.0 - 2.0 * (x * x + y * y)


def body_from_mjcf(xml: str, settle_s: float = SETTLE_S) -> dict:
  try:
    m = mujoco.MjModel.from_xml_string(xml)
  except Exception as e:  # MuJoCo's own message names the line
    raise BodyRefused(f"the MJCF does not compile: {e}") from e
  if mujoco.mj_name2id(m, mujoco.mjtObj.mjOBJ_BODY, "torso") < 0:
    raise BodyRefused("no body named torso: the root body must be named torso")
  torso = m.body("torso").id
  if m.njnt == 0 or int(m.jnt_type[0]) != int(mujoco.mjtJoint.mjJNT_FREE) or m.jnt_bodyid[0] != torso:
    raise BodyRefused("the torso needs a free joint, and it must be the first joint")
  if m.nu == 0:
    raise BodyRefused("no actuators: give every trainable joint a position actuator")
  names = []
  for i in range(m.nu):
    if int(m.actuator_trntype[i]) != int(mujoco.mjtTrn.mjTRN_JOINT):
      raise BodyRefused(f"actuator {m.actuator(i).name or i} does not drive a joint")
    j = int(m.actuator_trnid[i, 0])
    if int(m.jnt_type[j]) != int(mujoco.mjtJoint.mjJNT_HINGE):
      raise BodyRefused(f"actuator {m.actuator(i).name or i} drives {m.joint(j).name}, which is not a hinge")
    if m.jnt_qposadr[j] != 7 + i or m.jnt_dofadr[j] != 6 + i:
      raise BodyRefused(f"motor joint {m.joint(j).name} is not at qpos[{7 + i}]: the actuated joints must come first in the tree, "
                        "in actuator order, before any joint without a motor (put tails and necks after the legs)")
    names.append(m.joint(j).name)
  for j in range(1, m.njnt):
    if j > m.nu and int(m.jnt_type[j]) not in (int(mujoco.mjtJoint.mjJNT_HINGE), int(mujoco.mjtJoint.mjJNT_SLIDE)):
      raise BodyRefused(f"joint {m.joint(j).name}: only hinge or slide joints may follow the motors")
  feet = [m.geom(g).name for g in range(m.ngeom) if (m.geom(g).name or "").endswith("_foot")]
  if not feet:
    raise BodyRefused("no feet: name each foot geom <leg>_foot")
  legs = [f[: -len("_foot")] for f in feet]
  lo, hi = m.actuator_ctrlrange[:, 0], m.actuator_ctrlrange[:, 1]
  key = mujoco.mj_name2id(m, mujoco.mjtObj.mjOBJ_KEY, "home")
  stand = np.clip(np.array(m.key_ctrl[key]) if key >= 0 else np.zeros(m.nu), lo, hi)
  # Settle: drop the body from where the keyframe (or the model) puts it, the motors holding the standing targets.
  d = mujoco.MjData(m)
  if key >= 0:
    mujoco.mj_resetDataKeyframe(m, d, key)
  d.qpos[7:7 + m.nu] = stand
  d.ctrl[:] = stand
  mujoco.mj_forward(m, d)
  for _ in range(int(round(settle_s / m.opt.timestep))):
    mujoco.mj_step(m, d)
  if not np.isfinite(d.qpos).all():
    raise BodyRefused("the body blows up while it settles (check masses, joint ranges and actuator strength)")
  up = _up_z(d.qpos[3:7])
  if up < 0.9:
    raise BodyRefused(f"the body does not stand on its standing targets (torso uprightness {up:.2f} after {settle_s:g} s)")
  if float(np.abs(d.qvel).max()) > 0.5:
    raise BodyRefused(f"the body is still moving {settle_s:g} s after it was set down (largest joint speed {np.abs(d.qvel).max():.2f})")
  # The settled pose, at the origin and facing +x (its tilt kept): turn it by -yaw about z.
  q = np.array(d.qpos)
  q[0:2] = 0.0
  w, x, y, z = q[3:7]
  yaw = math.atan2(2 * (w * z + x * y), 1 - 2 * (y * y + z * z))
  cy, sy = math.cos(-yaw / 2), math.sin(-yaw / 2)
  q[3:7] = [cy * w - sy * z, cy * x - sy * y, cy * y + sy * x, cy * z + sy * w]
  # Each foot's lowest point below its centre in the standing pose (any shape: a flat box foot is not a sphere's radius).
  foot_r = []
  for f in feet:
    g = m.geom(f).id
    R, sz, t = d.geom_xmat[g].reshape(3, 3), m.geom_size[g], int(m.geom_type[g])
    G = mujoco.mjtGeom
    if t == int(G.mjGEOM_SPHERE):
      r = sz[0]
    elif t == int(G.mjGEOM_CAPSULE):
      r = abs(R[2, 2]) * sz[1] + sz[0]
    elif t == int(G.mjGEOM_CYLINDER):
      r = abs(R[2, 2]) * sz[1] + sz[0] * math.sqrt(max(0.0, 1 - R[2, 2] ** 2))
    elif t == int(G.mjGEOM_BOX):
      r = sum(abs(R[2, i]) * sz[i] for i in range(3))
    elif t == int(G.mjGEOM_ELLIPSOID):
      r = math.sqrt(sum((R[2, i] * sz[i]) ** 2 for i in range(3)))
    else:
      raise BodyRefused(f"foot {f}: use a sphere, capsule, cylinder, box or ellipsoid")
    foot_r.append(float(r))
  return {"legs": legs, "jointsPerLeg": max(1, m.nu // len(legs)), "jointNames": names, "standPose": [float(x) for x in stand],
          "standHeight": float(q[2]), "standQpos": [float(x) for x in q], "footRadius": foot_r, "passiveJoints": m.njnt - 1 - m.nu}


def main() -> int:
  ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
  ap.add_argument("mjcf")
  ap.add_argument("--out", required=True)
  a = ap.parse_args()
  try:
    body = body_from_mjcf(open(a.mjcf).read())
  except BodyRefused as e:
    print(json.dumps({"event": "body.refused", "why": str(e)}), flush=True)
    return 2
  with open(f"{a.out}.tmp", "w") as f:
    json.dump(body, f)
  import os
  os.replace(f"{a.out}.tmp", a.out)
  print(json.dumps({"event": "body.ok", "legs": body["legs"], "motors": len(body["jointNames"]), "passive": body["passiveJoints"],
                    "standHeight": round(body["standHeight"], 3)}), flush=True)
  return 0


if __name__ == "__main__":
  sys.exit(main())
