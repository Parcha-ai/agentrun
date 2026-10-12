"""One robot skill, trained on this machine's GPU: the program one cluster thread runs (ROBOT-CLUSTER.md).

  train-skill SKILL --body ROBOT.json --out work/skills/SKILL/ [--init-from auto] [--steps 10M] [--stop-after-passing 2]

SKILL: walk, sprint, backwards, turn-left, turn-right, spin, wave, getup (rear-up: experimental). ROBOT.json is the robot's state
(creature/robot.json: its `design`) or a Design; the body files are built with the tab's own buildMjcf (/opt/pda/mjcf), so
the policy's mjcf_sha256 matches the page. Into OUT, as they happen (each by rename, so a reader never sees half a file):
  skill.json             the skill, its fixed command, the body's sha256, the status (training | done | failed)
  progress.jsonl         the trainer's lines (steps, elapsed, the C-MuJoCo walk score)
  skill-progress.jsonl   per checkpoint: the skill's own test (C MuJoCo, the tab's arithmetic) and whether it passes
  checkpoints/ckpt-N.json, policy.json (the newest)
It warm-starts from the image's checkpoint for the body's joint count (--init-from auto) and stops once the skill has passed
on --stop-after-passing checkpoints in a row (0: train to --steps). Exit 0 when the skill passed, 3 when it never did.
"""
from __future__ import annotations

import argparse, hashlib, json, os, shutil, subprocess, sys, threading, time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import skill_eval  # noqa: E402

SKILLS = {
    "walk": ("universes/u1.json", 0.5, "walk"),
    "sprint": ("universes/skills/sprint.json", 1.2, "sprint"),
    "backwards": ("universes/skills/backwards.json", -0.45, "walk backwards"),
    "turn-left": ("universes/skills/turn-left.json", 0.3, "turn left"),
    "turn-right": ("universes/skills/turn-right.json", 0.3, "turn right"),
    "spin": ("universes/skills/spin.json", 0.0, "spin"),
    "rear-up": ("universes/skills/rear-up.json", 0.0, "rear up"),  # experimental: did not learn in 10M steps (2026-10-12)
    "wave": ("universes/skills/wave.json", 0.0, "wave"),
    "getup": ("universes/getup.json", 0.0, "get up"),
}
TAKE = ["--num-envs", "512", "--schedule", "0.5M,1M,2M,3M,4M,5M,6M,7M,8M,10M", "--checkpoint-every", "2M"]
MJCF_BUILDER = "/opt/pda/mjcf/build.ts"
# The one number a stage tile shows per checkpoint: (field of the skill test, name, unit, pass target as the stage words it).
METRIC = {
    "walk": ("along_mps", "speed", "m/s", ">= 0.4"), "sprint": ("along_mps", "speed", "m/s", ">= 0.8"),
    "backwards": ("along_mps", "speed backwards", "m/s", "<= -0.25"), "turn-left": ("yaw_rate", "turn rate", "rad/s", ">= 0.6"),
    "turn-right": ("yaw_rate", "turn rate", "rad/s", "<= -0.6"), "spin": ("yaw_rate", "spin rate", "rad/s", ">= 1.0"),
    "wave": ("paw_up_share", "paw up", "share of time", ">= 0.6"), "rear-up": ("pitch_up_share", "reared up", "share of time", ">= 0.6"),
    "getup": ("getup_worst_s", "slowest get-up", "s", "from left, right and back"),
}


def write_json(path: str, obj) -> None:
  tmp = f"{path}.tmp"
  with open(tmp, "w") as f:
    json.dump(obj, f)
  os.replace(tmp, path)


def canonical(skill: str) -> str:
  """Canonical skill names use hyphens (the page refuses others); get-up is spelled getup here."""
  return skill.replace("_", "-").replace("get-up", "getup")


def compile_cache(skill: str) -> str:
  """Where a skill's compile cache lives on this machine unless --compile-cache says otherwise (outside OUT)."""
  return os.path.join(os.path.expanduser("~"), ".cache", "pda-skill", f"{canonical(skill)}.tar.gz")


def reuse_or_clear(out: str, sha: str):
  """Rerun (the thread tool reruns the same command after a host restart, and again after a body change): a skill already
  done FOR THIS BODY is returned and not trained again; anything else (unfinished, or done for another body) is cleared,
  so the run starts over from the warm start with no old checkpoint mixed in."""
  done_path = os.path.join(out, "skill.json")
  if not os.path.exists(done_path):
    return None
  prev = json.load(open(done_path))
  if prev.get("status") == "done" and prev.get("mjcf_sha256") == sha:
    return prev
  for name in ("checkpoints", "work"):
    shutil.rmtree(os.path.join(out, name), ignore_errors=True)
  for name in ("skill-progress.jsonl", "policy.json"):
    if os.path.exists(os.path.join(out, name)):
      os.remove(os.path.join(out, name))
  return None


def main() -> int:
  ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
  ap.add_argument("skill", help="one of " + ", ".join(sorted(SKILLS)) + " (underscores or hyphens)")
  ap.add_argument("--body", required=True, help="robot.json, a Design, or a directory with creature.xml and body.json")
  ap.add_argument("--out", required=True)
  ap.add_argument("--init-from", default="auto")
  ap.add_argument("--steps", default="10M")
  ap.add_argument("--stop-after-passing", type=int, default=2)
  ap.add_argument("--compile-cache", default=None, help="default: ~/.cache/pda-skill/<skill>.tar.gz (outside OUT)")
  ap.add_argument("--compile-only", action="store_true", help="compile this skill's program for this body and stop (a warm-up)")
  a = ap.parse_args()
  a.skill = canonical(a.skill)
  if a.skill not in SKILLS:
    ap.error(f"unknown skill {a.skill}; known: {', '.join(sorted(SKILLS))}")
  out = os.path.abspath(a.out)
  t0 = time.time()
  universe, command, label = SKILLS[a.skill]

  # The body: the tab's own MJCF for the robot's design (a directory with creature.xml and body.json is used as it is).
  body_dir = os.path.join(out, "body")
  if os.path.isdir(a.body):
    body_dir = a.body
  else:
    r = subprocess.run(["node", MJCF_BUILDER, a.body, body_dir], capture_output=True, text=True)
    if r.returncode:
      print(r.stderr.strip() or r.stdout.strip(), flush=True)
      return 2
  xml = open(os.path.join(body_dir, "creature.xml")).read()
  body = json.load(open(os.path.join(body_dir, "body.json")))
  sha = hashlib.sha256(xml.encode()).hexdigest()

  prev = None if a.compile_only else reuse_or_clear(out, sha)
  if prev:
    print(json.dumps({"event": "skill.done", "already": True, **prev}), flush=True)
    return 0
  os.makedirs(os.path.join(out, "checkpoints"), exist_ok=True)
  meta = dict(skill=a.skill.replace("getup", "get-up"), label=label, command=command, mjcf_sha256=sha, joints=len(body["jointNames"]), status="training",
              init_from=a.init_from, started_at=t0, host=os.uname().nodename)
  write_json(os.path.join(out, "skill.json"), meta)
  print(json.dumps({"event": "skill.start", **meta}), flush=True)

  cache = a.compile_cache or compile_cache(a.skill)
  os.makedirs(os.path.dirname(cache), exist_ok=True)
  cmd = [sys.executable, os.path.join(HERE, "train.py"), "--mjcf", os.path.join(body_dir, "creature.xml"),
         "--body", os.path.join(body_dir, "body.json"), "--universe", os.path.join(HERE, universe), "--work", os.path.join(out, "work"),
         *TAKE, "--steps", a.steps, "--compile-cache", cache, "--keep-published", os.path.join(out, "checkpoints"),
         "--publish", os.path.join(out, "policy.json")]
  if a.init_from:
    cmd += ["--init-from", a.init_from]
  if a.compile_only:
    r = subprocess.run(cmd + ["--compile-only"], capture_output=True, text=True, cwd=HERE)
    meta.update(status="compiled" if r.returncode == 0 else "failed", wall_s=round(time.time() - t0, 1))
    write_json(os.path.join(out, "skill.json"), meta)
    print(json.dumps({"event": "skill.compiled", **meta}), flush=True)
    return r.returncode
  p = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, cwd=HERE)
  streak, passed_at, lock = 0, None, threading.Lock()
  prog = open(os.path.join(out, "skill-progress.jsonl"), "a")
  for line in p.stdout:
    try:
      ev = json.loads(line)
    except json.JSONDecodeError:
      continue
    if ev.get("event") != "train.checkpoint":
      if ev.get("event") in ("train.init-from", "train.compiled", "train.start"):
        print(line.rstrip(), flush=True)
      continue
    n = ev["checkpoint"]
    pol = json.load(open(os.path.join(out, "checkpoints", f"ckpt-{n}.json")))
    if a.skill == "getup":
      res = {"getup_s": {s: skill_eval.getup_time(xml, body, pol, s) for s in ("left side", "right side", "back")}}
      ok = all(v is not None for v in res["getup_s"].values())
    else:
      res = skill_eval.run(xml, body, pol, command)
      ok = skill_eval.passes(a.skill, res)
    if a.skill == "getup":
      times = list(res["getup_s"].values())
      res["getup_worst_s"] = None if None in times else max(times)
    field, mname, unit, target = METRIC[a.skill]
    rec = dict(checkpoint=n, steps=ev["steps"], t=round(time.time() - t0, 1), passes=ok,
               metric=dict(name=mname, value=res.get(field), unit=unit, target=target), **res)
    prog.write(json.dumps(rec) + "\n"); prog.flush()
    print(json.dumps({"event": "skill.checkpoint", "skill": a.skill, **rec}), flush=True)
    streak = streak + 1 if ok else 0
    if ok and passed_at is None:
      passed_at = rec
    if a.stop_after_passing and streak >= a.stop_after_passing:
      p.terminate()
      break
  p.wait()
  meta.update(status="done" if passed_at else "failed", passed_at=passed_at, wall_s=round(time.time() - t0, 1))
  write_json(os.path.join(out, "skill.json"), meta)
  print(json.dumps({"event": "skill.done", **meta}), flush=True)
  return 0 if passed_at else 3


if __name__ == "__main__":
  sys.exit(main())
