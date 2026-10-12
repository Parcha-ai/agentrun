"""Warm one cluster box for its skill before the start signal (ROBOT-CLUSTER.md).

  warm-box SKILL [--body DIR] [--presets DIR] [--all] [--parallel 4]

Compiles the skill's program for the default body into the cache train-skill reads (~/.cache/pda-skill/<skill>.tar.gz),
so the first run starts warm and the driver's JIT cache (~/.nv) holds its kernels. The image's compile cache covers the
GPU hosts it was built on; on a host it misses (any program compiled here is new), the skill is also compiled for every
preset body in --presets, so the relearn beat compiles nothing either. --all does that on every host. Prints one line:
  {"event": "box.warm", "skill", "driver", "fingerprint", "host_cache": "hit" | "miss", "new_programs", "presets", "s"}
Exit 0 when the default body compiled.
"""
from __future__ import annotations

import argparse, json, os, shutil, subprocess, sys, time
from concurrent.futures import ThreadPoolExecutor

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from train_skill import SKILLS, canonical, compile_cache  # noqa: E402

DEFAULT_BODY = os.path.join(HERE, "default")
PRESETS = "/opt/pda/presets"
# The XLA topology fingerprint jax keys its compile cache on (the accelerator_config part of the key).
FINGERPRINT = ("import jax, json; from jax._src.lib import xla_client; "
               "print(json.dumps(xla_client.get_topology_for_devices(jax.devices()).fingerprint()))")


def cache_dir(tarball: str) -> str:
  """The directory train.py unpacks a compile-cache tarball into and compiles into (its rule: one per tarball name)."""
  return os.path.join(os.path.expanduser("~"), ".cache", "pda-train", os.path.basename(tarball).split(".")[0])


def new_programs(jax_dir: str, since: float) -> int:
  """Programs compiled at or after `since` (unpacked ones keep the tarball's older times)."""
  try:
    return sum(1 for e in os.scandir(jax_dir) if e.name.startswith("jit_") and e.name.endswith("-cache")
               and e.stat().st_mtime >= since)
  except FileNotFoundError:
    return 0


def copy_new(src: str, dst: str, since: float) -> None:
  """Every file under src written at or after `since`, into the same place under dst."""
  for root, _, files in os.walk(src):
    for f in files:
      p = os.path.join(root, f)
      if os.stat(p).st_mtime >= since:
        q = os.path.join(dst, os.path.relpath(p, src))
        os.makedirs(os.path.dirname(q), exist_ok=True)
        shutil.copy2(p, q)


def compile_one(skill: str, body: str, out: str, cache: str) -> bool:
  r = subprocess.run([sys.executable, os.path.join(HERE, "train_skill.py"), skill, "--body", body, "--out", out,
                      "--compile-only", "--compile-cache", cache], capture_output=True, text=True)
  return r.returncode == 0


def main() -> int:
  ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
  ap.add_argument("skill")
  ap.add_argument("--body", default=DEFAULT_BODY, help="the body the first run trains (default: the image's default)")
  ap.add_argument("--presets", default=PRESETS, help="directories with creature.xml and body.json, one per preset")
  ap.add_argument("--all", action="store_true", help="compile the presets on a host the image's cache covers too")
  ap.add_argument("--parallel", type=int, default=4)
  a = ap.parse_args()
  skill = canonical(a.skill)
  if skill not in SKILLS:
    ap.error(f"unknown skill {skill}; known: {', '.join(sorted(SKILLS))}")
  t0 = time.time()
  work = os.path.join(os.path.expanduser("~"), ".cache", "pda-warm")
  r = subprocess.run(["nvidia-smi", "--query-gpu=driver_version", "--format=csv,noheader"], capture_output=True, text=True)
  driver = r.stdout.strip().splitlines()[0] if r.returncode == 0 and r.stdout.strip() else None

  main_cache = compile_cache(skill)
  ok = compile_one(skill, a.body, os.path.join(work, "out", f"{skill}-default"), main_cache)
  main_dir = cache_dir(main_cache)
  new = new_programs(os.path.join(main_dir, "jax"), t0)
  miss = new > 0

  presets = []
  if ok and (miss or a.all) and os.path.isdir(a.presets):
    bodies = sorted(d for d in os.listdir(a.presets) if os.path.exists(os.path.join(a.presets, d, "creature.xml")))
    t1 = time.time()

    def one(name):
      cache = os.path.join(work, "caches", f"{skill}-{name}.tar.gz")
      done = compile_one(skill, os.path.join(a.presets, name), os.path.join(work, "out", f"{skill}-{name}"), cache)
      return name, done, cache

    with ThreadPoolExecutor(max_workers=max(1, a.parallel)) as pool:
      results = list(pool.map(one, bodies))
    # The presets' new programs go where train-skill's runs look: the directory its tarball unpacks into (an unpack
    # adds files and never removes them), and the tarball itself.
    for name, done, cache in results:
      if done:
        copy_new(cache_dir(cache), main_dir, t1)
        presets.append(name)
    new = new_programs(os.path.join(main_dir, "jax"), t0)
    subprocess.run(["tar", "czf", f"{main_cache}.tmp", "-C", main_dir, *[s for s in ("jax", "warp")
                    if os.path.isdir(os.path.join(main_dir, s))]], check=False)
    if os.path.exists(f"{main_cache}.tmp"):
      os.replace(f"{main_cache}.tmp", main_cache)

  r = subprocess.run([sys.executable, "-c", FINGERPRINT], capture_output=True, text=True,
                     env=dict(os.environ, XLA_PYTHON_CLIENT_PREALLOCATE="false"))
  fingerprint = json.loads(r.stdout.strip().splitlines()[-1]) if r.returncode == 0 and r.stdout.strip() else None
  print(json.dumps({"event": "box.warm", "skill": skill, "ok": ok, "driver": driver, "fingerprint": fingerprint,
                    "host_cache": "miss" if miss else "hit", "new_programs": new, "presets": presets,
                    "s": round(time.time() - t0, 1)}), flush=True)
  return 0 if ok else 1


if __name__ == "__main__":
  sys.exit(main())
