"""Train one universe: PPO on the tab's body, checkpoints and the current policy in WORK, resumable after a kill.

  python train.py --mjcf creature.xml --body body.json --universe u1.json --work WORK [--minutes 8] [--impl warp]

WORK layout (every file is written by rename, so a reader or a resumed run never sees half a file):
  state.json       universe, status, steps_done / steps_total, generation, wall clock, last metrics
  progress.jsonl   one line per eval: steps, reward terms, forward speed, steps/s, C-MuJoCo walk score
  policy.json      the newest mlp-v1 policy (the tab can load it at any time)
  ckpt/<steps>/    Brax/orbax checkpoints; a resumed run restores the newest complete one

Resume semantics: steps_done counts environment steps in finished checkpoints. A run killed between checkpoints
repeats at most one eval interval of training; it never mixes params from two checkpoints. Optimizer moments restart
from zero on resume (Brax restores params and the normalizer only).
"""

from __future__ import annotations

import argparse
import functools
import json
import os
import re
import shutil
import socket
import subprocess
import sys
import tarfile
import time
from typing import Any

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)


def write_json(path: str, obj: Any) -> None:
  tmp = f"{path}.tmp-{os.getpid()}"
  with open(tmp, "w") as f:
    json.dump(obj, f)
    f.flush()
    os.fsync(f.fileno())
  os.replace(tmp, path)


def append_line(path: str, obj: Any) -> None:
  with open(path, "a") as f:
    f.write(json.dumps(obj) + "\n")
    f.flush()
    os.fsync(f.fileno())


def complete_checkpoints(ckpt_dir: str) -> list[str]:
  """Finished checkpoints, newest first. Orbax writes into a temporary name, renames it to the 12-digit step and marks
  it with commit_success.txt; Brax then adds its network config (ppo_network_config.json). Both must be there."""
  if not os.path.isdir(ckpt_dir):
    return []
  def complete(path: str) -> bool:
    return (os.path.exists(os.path.join(path, "commit_success.txt"))
            and any(f.endswith("config.json") for f in os.listdir(path)))
  names = [n for n in os.listdir(ckpt_dir) if re.fullmatch(r"\d{12}", n)]
  done = [n for n in names if complete(os.path.join(ckpt_dir, n))]
  return [os.path.join(ckpt_dir, n) for n in sorted(done, reverse=True)]


SCORE_UNITS = {"flat": "m walked in 10 s", "course": "m along the course in 20 s"}


def score_of(walk: dict[str, Any] | None) -> float | None:
  """The universe's comparable score, from the exported policy in C MuJoCo at a 0.5 m/s command: metres walked in 10 s
  on flat ground, or metres of progress along the held-out course in 20 s. Rewards differ per universe, so episode
  reward cannot rank them; this can. A fall scores the distance up to it."""
  if not walk:
    return None
  if "course_m" in walk:
    return round(float(walk["course_m"]), 3)
  return round(float(walk["distance_m"]), 3) if "distance_m" in walk else None


class Deadline(Exception):
  pass


def main() -> None:
  ap = argparse.ArgumentParser()
  ap.add_argument("--mjcf", required=True)
  ap.add_argument("--body", required=True)
  ap.add_argument("--universe", required=True, help="JSON: name, reward scales, env/ppo overrides")
  ap.add_argument("--work", required=True)
  ap.add_argument("--world", default=None, help="terrain.json (terrain.py): train on that terrain; the policy keeps the "
                  "body's mjcf_sha256, so it runs on any world")
  ap.add_argument("--course", default=None, help="held-out course (terrain.py --course): the score becomes metres along "
                  "it in 20 s at 0.5 m/s, the same course for every universe")
  ap.add_argument("--minutes", type=float, default=0.0, help="stop at the first checkpoint after this wall time")
  ap.add_argument("--impl", default=None, help="jax | warp (default: warp on GPU, jax on CPU)")
  ap.add_argument("--steps", type=float, default=None, help="total environment steps (overrides the universe)")
  ap.add_argument("--num-envs", type=int, default=None)
  ap.add_argument("--smoke", action="store_true", help="tiny CPU-sized run to check the pipeline")
  ap.add_argument("--no-compile-cache", action="store_true",
                  help="do not carry the XLA and Warp compile caches in WORK (compile-cache.tar.gz)")
  ap.add_argument("--seed-compile-cache", default="/opt/pda/cache/compile-cache.tar.gz",
                  help="caches baked into the image, used when the run has none of its own yet")
  ap.add_argument("--no-seed-compile-cache", action="store_true")
  ap.add_argument("--compile-cache", default=None,
                  help="where the compile-cache tarball lives (default WORK/compile-cache.tar.gz); point every universe "
                       "of a run at one shared path so a fork starts warm")
  ap.add_argument("--keep", type=int, default=2,
                  help="complete checkpoints kept per segment; older ones are deleted so work/ stays small enough for "
                       "a pipe host to attach (all of work/ crosses in one frame)")
  ap.add_argument("--after-checkpoint", default=None,
                  help="shell command run (not awaited) after each checkpoint, e.g. the host's write-through of WORK; "
                       "skipped while the previous one still runs. Gets TRAIN_WORK, TRAIN_STEPS, TRAIN_GENERATION.")
  args = ap.parse_args()

  t_start = time.time()
  # The machine as the stage names it (the agent's env.switch notice), else the hostname.
  host = os.environ.get("TRAIN_HOST_LABEL") or socket.gethostname()
  work = os.path.abspath(args.work)
  os.makedirs(work, exist_ok=True)
  # Compiling the training step takes ~100 s on a fresh box; with the XLA and Warp caches of an earlier run of the same
  # body it takes ~20 s. They travel with the run (WORK) so a resumed or forked universe starts warm. Unpacked before
  # JAX or Warp load, into a local directory outside WORK.
  cache_tar = os.path.abspath(args.compile_cache) if args.compile_cache else os.path.join(work, "compile-cache.tar.gz")
  cache_dir = os.path.join(os.path.expanduser("~"), ".cache", "pda-train")
  cache_was_warm = False
  cache_source = "none"
  if not args.no_compile_cache:
    os.makedirs(cache_dir, exist_ok=True)
    seed = None if args.no_seed_compile_cache else args.seed_compile_cache
    source = cache_tar if os.path.exists(cache_tar) else seed if seed and os.path.exists(seed) else None
    if source:
      try:
        with tarfile.open(source) as tf:
          tf.extractall(cache_dir, filter="data")
        # The run's own tarball is complete for this body; the image's seed may not be, so the run still writes its own.
        cache_was_warm = source == cache_tar
        cache_source = "run" if cache_was_warm else "image"
      except (tarfile.TarError, OSError) as e:  # a bad cache only costs compile time
        print(json.dumps({"event": "train.cache-unreadable", "error": str(e)[:200]}), flush=True)
    os.environ["JAX_COMPILATION_CACHE_DIR"] = os.path.join(cache_dir, "jax")
    os.environ["JAX_PERSISTENT_CACHE_MIN_COMPILE_TIME_SECS"] = "0"
    os.environ["WARP_CACHE_PATH"] = os.path.join(cache_dir, "warp")
  import jax
  import jax_compat  # noqa: F401 - before Brax
  import mujoco
  from brax.training.agents.ppo import networks as ppo_networks
  from brax.training.agents.ppo import train as ppo
  from flax import linen
  from mujoco_playground import wrapper

  import creature_env
  from export import export_policy
  import rollout
  import terrain

  ckpt_dir = os.path.join(work, "ckpt")
  state_path = os.path.join(work, "state.json")
  progress_path = os.path.join(work, "progress.jsonl")

  xml, body = creature_env.load_body(args.mjcf, args.body)
  world = json.load(open(args.world)) if args.world else None
  course = json.load(open(args.course)) if args.course else None
  score_unit = SCORE_UNITS["course" if course else "flat"]
  train_xml = terrain.splice(xml, world) if world else xml
  universe = json.load(open(args.universe))
  backend = jax.default_backend()
  impl = args.impl or ("warp" if backend == "gpu" else "jax")

  cfg = creature_env.default_config()
  cfg.impl = impl
  for k, v in universe.get("reward_scales", {}).items():
    if k not in creature_env.REWARD_TERMS:
      raise ValueError(f"unknown reward term {k}; known: {', '.join(creature_env.REWARD_TERMS)}")
    cfg.reward_config.scales[k] = float(v)
  overrides = universe.get("env", {})

  ppo_cfg = dict(
      num_timesteps=100_000_000, num_evals=24, episode_length=1000, normalize_observations=True, action_repeat=1,
      unroll_length=20, num_minibatches=32, num_updates_per_batch=4, discounting=0.97, learning_rate=3e-4,
      entropy_cost=1e-2, num_envs=8192, batch_size=256, max_grad_norm=1.0, reward_scaling=1.0, seed=0,
  )
  net_cfg = dict(policy_hidden_layer_sizes=(128, 128, 128), value_hidden_layer_sizes=(256, 256, 256, 256))
  ppo_cfg.update(universe.get("ppo", {}))
  net_cfg.update({k: tuple(v) for k, v in universe.get("network", {}).items()})
  if args.steps:
    ppo_cfg["num_timesteps"] = int(args.steps)
  if args.num_envs:
    ppo_cfg["num_envs"] = args.num_envs
  if args.smoke:
    ppo_cfg.update(num_timesteps=40_000, num_evals=3, num_envs=64, batch_size=32, num_minibatches=4, unroll_length=10,
                   episode_length=200, num_updates_per_batch=1)
    net_cfg.update(policy_hidden_layer_sizes=(32, 32), value_hidden_layer_sizes=(32, 32))

  env = creature_env.CreatureWalk(train_xml, body, cfg, num_envs=ppo_cfg["num_envs"], config_overrides=overrides,
                                  spawns=world["spawns"] if world else None)
  obs_spec = creature_env.obs_sizes(env.action_size)

  # ---- resume --------------------------------------------------------------------------------------------------
  # Brax numbers a run's checkpoints from 0, so each run segment gets its own directory and state.json records the
  # step count it started from. The newest complete checkpoint of the newest segment that has one is the resume point.
  prior = json.load(open(state_path)) if os.path.exists(state_path) else {}
  total = int(prior.get("steps_total") or ppo_cfg["num_timesteps"])
  segments = list(prior.get("segments", []))
  restore, done_steps = None, 0
  for seg in reversed(segments):
    found = complete_checkpoints(os.path.join(work, seg["dir"]))
    if found:
      restore, done_steps = found[0], int(seg["base"]) + int(os.path.basename(found[0]))
      break
  remaining = max(total - done_steps, 0)
  generation = int(prior.get("generation", 0)) + 1
  if remaining == 0:
    print(json.dumps({"event": "train.already-done", "steps_done": done_steps}))
    return
  seg_ckpt = os.path.join(ckpt_dir, f"seg{generation:03d}")
  segments.append({"generation": generation, "base": done_steps, "dir": os.path.relpath(seg_ckpt, work),
                   "restored_from": os.path.relpath(restore, work) if restore else None, "host": host})

  state = {
      "universe": universe.get("name", "u?"), "hypothesis": universe.get("hypothesis"), "status": "training", "generation": generation, "steps_total": total,
      "steps_done": done_steps, "segments": segments, "backend": backend, "impl": impl,
      "device": str(jax.devices()[0]), "started_at": prior.get("started_at", t_start), "segment_started_at": t_start,
      "wall_s": prior.get("wall_s", 0.0), "mujoco": mujoco.__version__, "mjcf_sha256": None, "last": None,
      "score_unit": score_unit, "course_sha256": course["sha256"] if course else None,
  }
  write_json(state_path, state)
  print(json.dumps({"event": "train.start", "universe": state["universe"], "generation": generation, "impl": impl,
                    "device": state["device"], "remaining": remaining, "restore": restore,
                    "compile_cache": cache_source}), flush=True)

  times = {"last": time.time(), "last_steps": 0, "jit_done": None}
  deadline = t_start + args.minutes * 60 if args.minutes > 0 else None
  base_wall = float(state["wall_s"])

  hook = {"proc": None}

  def progress(step: int, metrics: dict[str, Any]) -> None:
    """Brax calls this once per eval iteration, after it saved that iteration's checkpoint (no evals or episode
    metrics are collected: the per-checkpoint C-MuJoCo walk is the score, and it costs the GPU nothing)."""
    now = time.time()
    if times["jit_done"] is None:
      times["jit_done"] = now
    sps = (step - times["last_steps"]) / max(now - times["last"], 1e-6)
    times["last"], times["last_steps"] = now, step
    steps_done = done_steps + step
    m = {k: float(v) for k, v in metrics.items() if hasattr(v, "__float__")}
    line = {"t": now, "elapsed_s": now - t_start, "generation": generation, "host": host, "steps": steps_done,
            "sps": sps, "walk": times.get("walk"), "score": score_of(times.get("walk")), "score_unit": score_unit,
            "metrics": m}
    append_line(progress_path, line)
    checkpointed = step > 0 and step == times.get("checkpointed")
    if checkpointed:
      after_prune = complete_checkpoints(seg_ckpt)
      for old in after_prune[args.keep:]:
        shutil.rmtree(old, ignore_errors=True)
      if not args.no_compile_cache and not cache_was_warm and not times.get("cache_saved"):
        # Everything the training step needed is compiled by the first checkpoint. A cache that cannot be written only
        # costs the next start its compile time; it must never cost this checkpoint.
        tmp = f"{cache_tar}.tmp-{os.getpid()}"
        try:
          os.makedirs(os.path.dirname(cache_tar), exist_ok=True)
          with tarfile.open(tmp, "w:gz") as tf:
            for sub in ("jax", "warp"):
              if os.path.isdir(os.path.join(cache_dir, sub)):
                tf.add(os.path.join(cache_dir, sub), arcname=sub)
          os.replace(tmp, cache_tar)
          times["cache_saved"] = os.path.getsize(cache_tar)
        except OSError as e:
          times["cache_saved"] = -1
          print(json.dumps({"event": "train.cache-not-saved", "error": str(e)[:200]}), flush=True)
          try:
            os.remove(tmp)
          except OSError:
            pass
    state.update(steps_done=steps_done, wall_s=base_wall + now - t_start, last=line)
    # The rename of state.json is the checkpoint-complete signal: the host's write-through flushes WORK on it.
    write_json(state_path, state)
    if checkpointed and args.after_checkpoint and (hook["proc"] is None or hook["proc"].poll() is not None):
      env_vars = dict(os.environ, TRAIN_WORK=work, TRAIN_STEPS=str(steps_done), TRAIN_GENERATION=str(generation))
      hook["proc"] = subprocess.Popen(args.after_checkpoint, shell=True, env=env_vars)
    print(json.dumps({k: line[k] for k in ("elapsed_s", "steps", "sps", "score")}), flush=True)
    # Stop only on a call that follows a checkpoint (Brax saves before it reports), so a paused run loses nothing.
    if deadline and now > deadline and checkpointed:
      raise Deadline()

  def on_params(step: int, make_policy, params) -> None:
    if step == 0 and restore is None:
      return
    pol = export_policy(params, obs_spec=obs_spec, nu=env.action_size, mjcf=xml, mujoco_version=mujoco.__version__,
                        gait_hz=float(cfg.gait_hz), action_scale=float(cfg.action_scale),
                        command_range=list(cfg.command_range),
                        provenance={"universe": state["universe"], "hypothesis": state["hypothesis"],
                                    "steps": done_steps + step, "generation": generation,
                                    "reward_scales": dict(cfg.reward_config.scales), "device": state["device"],
                                    "impl": impl, "wall_s": base_wall + time.time() - t_start,
                                    "terrain_sha256": world["sha256"] if world else None,
                                    "host": host})
    state["mjcf_sha256"] = pol["mjcf_sha256"]
    # The engine-true score: the exported file, in C MuJoCo, as the tab will run it.
    try:
      score, _ = rollout.run(xml, body, pol, seconds=10.0, command=0.5)
      times["walk"] = {k: score[k] for k in ("distance_m", "mean_fwd_speed", "min_up_z", "fell_at")}
      if course:
        on_course, _ = rollout.run(xml, body, pol, seconds=20.0, command=0.5, world=course)
        times["walk"].update(course_m=max(on_course["progress_x"], 0.0), course_fell_at=on_course["fell_at"])
      pol["provenance"]["walk_10s"] = times["walk"]
    except Exception as e:  # a score failure must not stop training
      times["walk"] = {"error": str(e)[:200]}
    write_json(os.path.join(work, "policy.json"), pol)
    times["checkpointed"] = step

  network_factory = functools.partial(
      ppo_networks.make_ppo_networks, policy_hidden_layer_sizes=net_cfg["policy_hidden_layer_sizes"],
      value_hidden_layer_sizes=net_cfg["value_hidden_layer_sizes"], activation=linen.swish,
      policy_obs_key="state", value_obs_key="privileged_state")
  train_kwargs = {k: v for k, v in ppo_cfg.items() if k != "num_timesteps"}
  status = "done"
  try:
    ppo.train(environment=env, num_timesteps=remaining, wrap_env_fn=wrapper.wrap_for_brax_training,
              network_factory=network_factory, progress_fn=progress, policy_params_fn=on_params,
              save_checkpoint_path=seg_ckpt, restore_checkpoint_path=restore, run_evals=False,
              log_training_metrics=False, **train_kwargs)
  except Deadline:
    status = "paused"
  state.update(status=status, wall_s=base_wall + time.time() - t_start)
  write_json(state_path, state)
  print(json.dumps({"event": f"train.{status}", "steps_done": state["steps_done"], "steps_total": total,
                    "segment_s": time.time() - t_start,
                    "jit_s": (times["jit_done"] or time.time()) - t_start}), flush=True)


if __name__ == "__main__":
  main()
