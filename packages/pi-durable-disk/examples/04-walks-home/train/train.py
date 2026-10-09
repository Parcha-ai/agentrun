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
import socket
import sys
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
  """Finished orbax checkpoints, newest first. In-progress ones carry a temporary suffix and never match."""
  if not os.path.isdir(ckpt_dir):
    return []
  names = [n for n in os.listdir(ckpt_dir) if re.fullmatch(r"\d{12}", n)]
  done = [n for n in names if os.path.exists(os.path.join(ckpt_dir, n, "config.json"))]
  return [os.path.join(ckpt_dir, n) for n in sorted(done, reverse=True)]


def score_of(walk: dict[str, Any] | None) -> float | None:
  """The universe's comparable score: metres walked in 10 s at a 0.5 m/s command, the exported policy in C MuJoCo.
  Rewards differ per universe, so episode reward cannot rank them; this can. A fall scores the distance up to it."""
  if not walk or "distance_m" not in walk:
    return None
  return round(float(walk["distance_m"]), 3)


class Deadline(Exception):
  pass


def main() -> None:
  ap = argparse.ArgumentParser()
  ap.add_argument("--mjcf", required=True)
  ap.add_argument("--body", required=True)
  ap.add_argument("--universe", required=True, help="JSON: name, reward scales, env/ppo overrides")
  ap.add_argument("--work", required=True)
  ap.add_argument("--minutes", type=float, default=0.0, help="stop at the first checkpoint after this wall time")
  ap.add_argument("--impl", default=None, help="jax | warp (default: warp on GPU, jax on CPU)")
  ap.add_argument("--steps", type=float, default=None, help="total environment steps (overrides the universe)")
  ap.add_argument("--num-envs", type=int, default=None)
  ap.add_argument("--smoke", action="store_true", help="tiny CPU-sized run to check the pipeline")
  args = ap.parse_args()

  t_start = time.time()
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

  work = os.path.abspath(args.work)
  os.makedirs(work, exist_ok=True)
  ckpt_dir = os.path.join(work, "ckpt")
  state_path = os.path.join(work, "state.json")
  progress_path = os.path.join(work, "progress.jsonl")

  xml, body = creature_env.load_body(args.mjcf, args.body)
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
      num_timesteps=60_000_000, num_evals=16, episode_length=1000, normalize_observations=True, action_repeat=1,
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

  env = creature_env.CreatureWalk(xml, body, cfg, num_envs=ppo_cfg["num_envs"], config_overrides=overrides)
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
                   "restored_from": os.path.relpath(restore, work) if restore else None, "host": socket.gethostname()})

  state = {
      "universe": universe.get("name", "u?"), "status": "training", "generation": generation, "steps_total": total,
      "steps_done": done_steps, "segments": segments, "backend": backend, "impl": impl,
      "device": str(jax.devices()[0]), "started_at": prior.get("started_at", t_start), "segment_started_at": t_start,
      "wall_s": prior.get("wall_s", 0.0), "mujoco": mujoco.__version__, "mjcf_sha256": None, "last": None,
  }
  write_json(state_path, state)
  print(json.dumps({"event": "train.start", "universe": state["universe"], "generation": generation, "impl": impl,
                    "device": state["device"], "remaining": remaining, "restore": restore}), flush=True)

  times = {"last": time.time(), "last_steps": 0, "jit_done": None}
  deadline = t_start + args.minutes * 60 if args.minutes > 0 else None
  base_wall = float(state["wall_s"])

  def progress(step: int, metrics: dict[str, Any]) -> None:
    now = time.time()
    if times["jit_done"] is None:
      times["jit_done"] = now
    sps = (step - times["last_steps"]) / max(now - times["last"], 1e-6)
    times["last"], times["last_steps"] = now, step
    steps_done = done_steps + step
    m = {k: float(v) for k, v in metrics.items() if hasattr(v, "__float__")}
    line = {"t": now, "elapsed_s": now - t_start, "generation": generation, "steps": steps_done, "sps": sps,
            "reward": m.get("episode/sum_reward"),
            # Episode metrics are sums over the episode; the per-step mean is the forward speed in m/s.
            "fwd_speed": (m["episode/fwd_speed"] / m["episode/length"]) if m.get("episode/length") else None,
            "walk": times.get("walk"), "score": score_of(times.get("walk")), "metrics": m}
    append_line(progress_path, line)
    state.update(steps_done=steps_done, wall_s=base_wall + now - t_start, last=line)
    write_json(state_path, state)
    print(json.dumps({k: line[k] for k in ("elapsed_s", "steps", "sps", "reward", "fwd_speed", "score")}), flush=True)
    # Stop only on the progress call that follows a checkpoint (Brax saves before it reports), so a paused run
    # loses nothing.
    if deadline and now > deadline and step > 0 and step == times.get("checkpointed"):
      raise Deadline()

  def on_params(step: int, make_policy, params) -> None:
    if step == 0 and restore is None:
      return
    pol = export_policy(params, obs_spec=obs_spec, nu=env.action_size, mjcf=xml, mujoco_version=mujoco.__version__,
                        gait_hz=float(cfg.gait_hz), action_scale=float(cfg.action_scale),
                        command_range=list(cfg.command_range),
                        provenance={"universe": state["universe"], "steps": done_steps + step, "generation": generation,
                                    "reward_scales": dict(cfg.reward_config.scales), "device": state["device"],
                                    "impl": impl, "wall_s": base_wall + time.time() - t_start,
                                    "host": socket.gethostname()})
    state["mjcf_sha256"] = pol["mjcf_sha256"]
    # The engine-true score: the exported file, in C MuJoCo, as the tab will run it.
    try:
      score, _ = rollout.run(xml, body, pol, seconds=10.0, command=0.5)
      times["walk"] = {k: score[k] for k in ("distance_m", "mean_fwd_speed", "min_up_z", "fell_at")}
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
              log_training_metrics=True, **train_kwargs)
  except Deadline:
    status = "paused"
  state.update(status=status, wall_s=base_wall + time.time() - t_start)
  write_json(state_path, state)
  print(json.dumps({"event": f"train.{status}", "steps_done": state["steps_done"], "steps_total": total,
                    "segment_s": time.time() - t_start,
                    "jit_s": (times["jit_done"] or time.time()) - t_start}), flush=True)


if __name__ == "__main__":
  main()
