"""Writes policy/test/fixtures/: a body, a small random policy that makes the body flail, and a C-MuJoCo trace of it.

  python fixture.py --mjcf creature.xml --body body.json --out ../policy/test/fixtures [--steps 100]

The random policy exists to move every joint hard (a trained one mostly stands still at first), so the parity test
exercises the observation, the network and the contact physics, not a creature at rest.
"""

import argparse
import json
import os
import types

import mujoco
import numpy as np

import creature_env
import rollout
from export import export_policy


def main():
  ap = argparse.ArgumentParser()
  ap.add_argument("--mjcf", required=True)
  ap.add_argument("--body", required=True)
  ap.add_argument("--out", required=True)
  ap.add_argument("--steps", type=int, default=100)
  args = ap.parse_args()
  xml = open(args.mjcf, "rb").read().decode("utf-8")
  body = json.load(open(args.body))
  nj = len(body["jointNames"])
  spec = creature_env.obs_sizes(nj)
  od = sum(s for _, s in spec)
  rng = np.random.default_rng(11)
  sizes = [od, 32, 32, 2 * nj]
  dense = {f"hidden_{i}": {"kernel": rng.normal(0, 1.5 / np.sqrt(a), (a, b)).astype(np.float32),
                           "bias": rng.normal(0, 0.3, b).astype(np.float32)}
           for i, (a, b) in enumerate(zip(sizes[:-1], sizes[1:]))}
  norm = types.SimpleNamespace(mean={"state": np.zeros(od)}, std={"state": np.ones(od)})
  pol = export_policy((norm, {"params": dense}, None), obs_spec=spec, nu=nj, mjcf=xml, mujoco_version=mujoco.__version__,
                      gait_hz=2.0, action_scale=0.5, command_range=[0.0, 0.8],
                      provenance={"universe": "fixture", "note": "random weights that flail, parity test only"})
  _, trace = rollout.run(xml, body, pol, seconds=args.steps * 0.02, command=0.5, trace_steps=args.steps)
  os.makedirs(args.out, exist_ok=True)
  with open(os.path.join(args.out, "creature.xml"), "wb") as f:
    f.write(xml.encode("utf-8"))
  json.dump(body, open(os.path.join(args.out, "body.json"), "w"))
  json.dump(pol, open(os.path.join(args.out, "policy.json"), "w"))
  json.dump({"command": 0.5, "mujoco_version": mujoco.__version__, "steps": trace},
            open(os.path.join(args.out, "trace.json"), "w"))
  moved = np.ptp(np.array([s["qpos"][7:] for s in trace]), axis=0)
  print(json.dumps({"steps": len(trace), "joint_range_moved": moved.round(3).tolist()}))


if __name__ == "__main__":
  main()
