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
# Also baked by training_image(copy_code=True): universes/*.json (the eight reward hypotheses) and default/ (the tab's
# default 3-DOF quadruped, buildMjcf(defaultDesign(3)), for a run that has no creature of its own yet).


def training_image(copy_code: bool = False) -> modal.Image:
  """copy_code=True bakes the trainer into a layer (a fleet start); False mounts it at start (fast iteration)."""
  image = modal.Image.debian_slim(python_version="3.12").pip_install(*PINS)
  for name in TRAIN_FILES:
    image = image.add_local_file(os.path.join(HERE, name), f"{REMOTE_TRAIN}/{name}", copy=copy_code)
  if copy_code:
    image = (image.add_local_dir(os.path.join(HERE, "universes"), f"{REMOTE_TRAIN}/universes", copy=True)
             .add_local_dir(os.path.join(HERE, "default"), f"{REMOTE_TRAIN}/default", copy=True)
             # Copies keep the checkout's file modes; the run user (not root) must read them.
             .run_commands(f"chmod -R a+rX {REMOTE_TRAIN}"))
  return image


SEED_CACHE = "/opt/pda/cache/compile-cache.tar.gz"


def fleet_image(runtime_commands: list[str], prewarm: bool = True) -> modal.Image:
  """The GPU machine class: the trainer baked in, then the shared runtime layer from
  `vm/build-image.ts --print-commands --no-archil --uid U --gid G` (Node 24, the run user pda, sudo; no Archil client:
  a GPU box runs in pipe mode because gVisor's fsync is not durable). XLA caches go under the run user's HOME, outside
  work/."""
  image = (training_image(copy_code=True)
           .dockerfile_commands(runtime_commands)
           .env({"XLA_PYTHON_CLIENT_PREALLOCATE": "false"}))
  if prewarm:
    # Compile the default creature's training step once on an H100 at build time; train.py seeds its caches from the
    # tarball, so a first universe of that body starts in ~20-45 s instead of ~100-150 s (other bodies still reuse
    # most Warp kernels).
    image = image.run_commands(
        f"mkdir -p /opt/pda/cache && python {REMOTE_TRAIN}/train.py --mjcf {REMOTE_TRAIN}/default/creature.xml --body {REMOTE_TRAIN}/default/body.json"
        f" --universe {REMOTE_TRAIN}/universes/u1.json --work /tmp/prewarm --steps 20000000 --minutes 0.1"
        f" --compile-cache {SEED_CACHE} --no-seed-compile-cache"
        f" && chmod a+r {SEED_CACHE} && rm -rf /tmp/prewarm /root/.cache/pda-train",
        gpu="H100")
  return image


if __name__ == "__main__":
  # with-modal -- python modal_image.py RUNTIME_COMMANDS.json  -> builds the fleet image, prints its id
  import json
  import sys
  cmds = json.load(open(sys.argv[1]))
  app = modal.App.lookup("pda-demo-d2", create_if_missing=True)
  with modal.enable_output():
    image = fleet_image(cmds).build(app)
  print(json.dumps({"image_id": image.object_id, "runtime_commands": len(cmds)}))
