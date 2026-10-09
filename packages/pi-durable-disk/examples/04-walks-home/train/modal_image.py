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
TRAIN_FILES = ["creature_env.py", "export.py", "jax_compat.py", "rollout.py", "train.py"]


def training_image(copy_code: bool = False) -> modal.Image:
  """copy_code=True bakes the trainer into a layer (a fleet start); False mounts it at start (fast iteration)."""
  image = modal.Image.debian_slim(python_version="3.12").pip_install(*PINS)
  for name in TRAIN_FILES:
    image = image.add_local_file(os.path.join(HERE, name), f"{REMOTE_TRAIN}/{name}", copy=copy_code)
  return image
