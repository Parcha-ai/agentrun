"""The GPU training image for Modal: CUDA JAX, MuJoCo/MJX 3.15.0 (the tab's WASM version), Brax, Playground.

Versions are pinned together: mujoco must equal the tab's @mujoco/mujoco, mujoco-mjx[warp] pins warp-lang, and
Brax 0.14.2 needs jax_compat.py on JAX 0.11.
"""

from __future__ import annotations

import os

import modal

HERE = os.path.dirname(os.path.abspath(__file__))
REMOTE_TRAIN = "/opt/pda/train"
PINS = [
    "jax[cuda12]==0.11.2",
    "mujoco==3.15.0",
    "mujoco-mjx==3.15.0",
    "warp-lang==1.17.0",
    "brax==0.14.2",
    "playground==0.2.0",
]
TRAIN_FILES = ["creature_env.py", "export.py", "jax_compat.py", "rollout.py", "terrain.py", "train.py"]


def training_image(copy_code: bool = False) -> modal.Image:
  """copy_code=True bakes the trainer into a layer (a fleet start); False mounts it at start (fast iteration)."""
  image = modal.Image.debian_slim(python_version="3.12").pip_install(*PINS)
  for name in TRAIN_FILES:
    image = image.add_local_file(os.path.join(HERE, name), f"{REMOTE_TRAIN}/{name}", copy=copy_code)
  if copy_code:
    # Copies keep the checkout's file modes; the run user (not root) must read them.
    image = image.run_commands(f"chmod -R a+rX {REMOTE_TRAIN}")
  return image


def fleet_image(runtime_commands: list[str]) -> modal.Image:
  """The GPU machine class: the trainer baked in, then the shared runtime layer from
  `vm/build-image.ts --print-commands --no-archil --uid U --gid G` (Node 24, the run user pda, sudo; no Archil client:
  a GPU box runs in pipe mode because gVisor's fsync is not durable). XLA caches go under the run user's HOME, outside
  work/."""
  return (training_image(copy_code=True)
          .dockerfile_commands(runtime_commands)
          .env({"JAX_COMPILATION_CACHE_DIR": "/home/pda/.cache/jax", "XLA_PYTHON_CLIENT_PREALLOCATE": "false"}))


if __name__ == "__main__":
  # with-modal -- python modal_image.py RUNTIME_COMMANDS.json  -> builds the fleet image, prints its id
  import json
  import sys
  cmds = json.load(open(sys.argv[1]))
  app = modal.App.lookup("pda-demo-d2", create_if_missing=True)
  with modal.enable_output():
    image = fleet_image(cmds).build(app)
  print(json.dumps({"image_id": image.object_id, "runtime_commands": len(cmds)}))
