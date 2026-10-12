"""One robot skill, trained on this machine's GPU: the program one cluster thread runs (ROBOT-CLUSTER.md, CODE-MODE.md).

  train-skill --skill-dir DIR --body BODY --out OUT [--init-from auto] [--steps 10M] [--stop-after-passing 2]
  train-skill SKILL --body BODY --out OUT ...        (SKILL: one of the example skills in train/skills/)

A skill is a directory (a thread writes its own; train/skills/<name>/ are examples):
  skill.json  {"name": "spin", "label": "spin", "command": 0.0, "reward_scales": {...}, "env": {...}}
              name: lowercase words joined by hyphens (the page's skill name); label: what the stage says;
              command: the fixed command the page sends while the skill runs (m/s; 0 for skills done in place);
              reward_scales: weights of the built-in reward terms (creature_env.REWARD_TERMS) and of reward.py's own;
              env: overrides of creature_env.default_config() (e.g. "command_range": [0, 0]); optional "ppo", "network".
  reward.py   optional: terms(s) -> {name: value}, the skill's own reward terms (s: creature_env.StepState), each weighted
              in reward_scales.
  test.py     test(sim) -> (passes, metric): whether a checkpoint does the skill, run on every checkpoint in C MuJoCo
              with the tab's arithmetic (skilltest.py), and the one number the stage shows.
BODY is a directory with creature.xml (or body.xml), keeping body.py's contract; its body.json is derived (body.py) when
absent. It can also be robot.json or a Design, built with the tab's own buildMjcf (/opt/pda/mjcf). Into OUT, as they happen
(each by rename, so a reader never sees half a file):
  skill.json             the skill, its command, the body's sha256 and name, the status (training | done | failed);
                         once done: passed_at (the first passing checkpoint), policy_checkpoint, wall_s, cpu_estimate_s;
                         once failed: diagnosis (why, in words: the metric never moved, plateaued, or test.py raised)
  skill-progress.jsonl   per checkpoint: passes, metric (from test.py), steps, t (seconds since the start), error
  checkpoints/ckpt-N.json, policy.json (the newest checkpoint; once the run stops, the newest that passed)
  work/                  the trainer's own state and log (progress.jsonl)
Stdout: one JSON line per event (skill.start, train.start, skill.checkpoint, skill.test-error, skill.done).
--check POLICY runs test.py once on a policy file (the shipped policy.json, or any checkpoint) and prints skill.check.
Exit 0 when the skill passed, 3 when it never did, 2 when the skill directory or the body is refused (the line says why).
"""
from __future__ import annotations

import argparse, hashlib, importlib.util, json, math, os, re, shutil, subprocess, sys, time, traceback

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
EXAMPLES = os.path.join(HERE, "skills")
SKILLS = sorted(d for d in os.listdir(EXAMPLES) if os.path.isfile(os.path.join(EXAMPLES, d, "skill.json"))) if os.path.isdir(EXAMPLES) else []
TAKE = ["--num-envs", "512", "--schedule", "0.5M,1M,2M,3M,4M,5M,6M,7M,8M,10M", "--checkpoint-every", "2M"]
MJCF_BUILDER = "/opt/pda/mjcf/build.ts"
NAME = re.compile(r"^[a-z0-9]+(-[a-z0-9]+)*$")
COMMAND_LIMIT = 2.0  # the page's skills.json limit

# What one skill costs without a GPU, for the stage's comparison: the take command (512 envs) measured on 8 CPU cores
# (Xeon Gold 6312U, 2026-10-11): the first checkpoint (491,520 env-steps, compile included) at 1,255 s on the default
# body and 1,282 s on long-legs, then 490-531 env-steps/s. A skill's estimate is that first checkpoint plus the steps
# it needed to pass on the GPU at 520 env-steps/s.
CPU_BASELINE = {"cores": "8 Xeon Gold 6312U", "first_checkpoint_s": 1255, "first_checkpoint_steps": 491520,
                "steps_per_s": 520,
                "measured": "the take command on 8 CPU cores: first checkpoint at 1,255 s (default body) and 1,282 s "
                            "(long-legs), then 490-531 env-steps/s",
                "how": "estimate: the measured first checkpoint, plus the env-steps this skill needed to pass on the GPU "
                       "at 520 env-steps/s"}


class Refused(ValueError):
  pass


def cpu_estimate_s(steps: int) -> int:
  """Seconds the same trainer would take on 8 CPU cores to reach `steps` (CPU_BASELINE)."""
  b = CPU_BASELINE
  return round(b["first_checkpoint_s"] + max(0, steps - b["first_checkpoint_steps"]) / b["steps_per_s"])


def body_name(body: str) -> str | None:
  """The body's name as the page shows it: the design's name in robot.json (its `design`) or in a Design, or in a
  body directory's design.json."""
  path = os.path.join(body, "design.json") if os.path.isdir(body) else body
  try:
    obj = json.load(open(path))
  except (OSError, ValueError):
    return None
  design = obj.get("design") if isinstance(obj.get("design"), dict) else obj
  name = design.get("name") if isinstance(design, dict) else None
  return name if isinstance(name, str) else None


def write_json(path: str, obj) -> None:
  tmp = f"{path}.tmp"
  with open(tmp, "w") as f:
    json.dump(obj, f)
  os.replace(tmp, path)


def canonical(skill: str) -> str:
  """An example skill's directory name: hyphens (the page refuses others); get-up is spelled getup here."""
  return skill.replace("_", "-").replace("get-up", "getup")


def compile_cache(skill: str) -> str:
  """Where a skill's compile cache lives on this machine unless --compile-cache says otherwise (outside OUT). Keyed by
  the skill directory's name, which is what warm-box warms."""
  return os.path.join(os.path.expanduser("~"), ".cache", "pda-skill", f"{canonical(skill)}.tar.gz")


def settle_policy(out: str, checkpoint: int) -> None:
  """policy.json is the newest checkpoint that passed the skill's test: the trainer publishes every checkpoint, and it can
  publish a newer, untested or failing one before it stops (or a later checkpoint can fail after one passed)."""
  with open(os.path.join(out, "checkpoints", f"ckpt-{checkpoint}.json")) as f:
    text = f.read()
  tmp = os.path.join(out, "policy.json.tmp")
  with open(tmp, "w") as f:
    f.write(text)
  os.replace(tmp, os.path.join(out, "policy.json"))


def reuse_or_clear(out: str, sha: str, skill_sha: str | None = None):
  """Rerun (the thread tool reruns the same command after a host restart, and again after a body change): a skill already
  done FOR THIS BODY (and this skill directory) is returned and not trained again; anything else (unfinished, or done for
  another body or another version of the skill) is cleared, so the run starts over with no old checkpoint mixed in."""
  done_path = os.path.join(out, "skill.json")
  if not os.path.exists(done_path):
    return None
  prev = json.load(open(done_path))
  if prev.get("status") == "done" and prev.get("mjcf_sha256") == sha and (skill_sha is None or prev.get("skill_sha256") in (None, skill_sha)):
    return prev
  for name in ("checkpoints", "work"):
    shutil.rmtree(os.path.join(out, name), ignore_errors=True)
  for name in ("skill-progress.jsonl", "policy.json"):
    if os.path.exists(os.path.join(out, name)):
      os.remove(os.path.join(out, name))
  return None


def diagnose(records: list[dict]) -> str | None:
  """Why a try failed, in words a thread can act on, from its checkpoints' test results (skill-progress.jsonl): the metric
  never moved (within 5% of where it began), plateaued (the second half within 5%; it began at the first checkpoint from
  which every later value stays within 2% of that band), was still changing, or test.py raised."""
  if not records:
    return "no checkpoint was tested: the trainer stopped before its first checkpoint (see error)"
  errors = [r for r in records if r.get("error")]
  if len(errors) == len(records):
    return f"test.py raised on every checkpoint ({errors[-1]['error'][:200]}): fix test.py, the training may be fine"
  values = [r["metric"]["value"] for r in records if r.get("metric") and isinstance(r["metric"].get("value"), (int, float))]
  if len(values) < 2:
    return "too few checkpoints with a metric to judge: train longer"
  name = records[-1]["metric"]["name"] if records[-1].get("metric") else "the metric"
  first, last = values[0], values[-1]
  span = max(abs(first), abs(last), 1e-6)
  steps = [r["steps"] for r in records]
  if abs(last - first) < 0.05 * span:
    far = max(range(len(values)), key=lambda i: abs(values[i] - first))
    excursion = (f", apart from one excursion to {values[far]:g} at checkpoint {records[far]['checkpoint']} that did not hold"
                 if abs(values[far] - first) >= 0.1 * span else "")
    return (f"{name} never moved ({first:g} at the first checkpoint, {last:g} at the last{excursion}): the reward likely "
            "gives no gradient toward the skill from the standing pose. Check that each of your terms changes as soon as "
            "the robot starts the skill (a narrow bump far from the start is flat), and that no built-in term fights it")
  tail = values[len(values) // 2:]
  if max(tail) - min(tail) <= 0.05 * span:
    lo, hi = min(tail) - 0.02 * span, max(tail) + 0.02 * span
    k = next(i for i in range(len(values)) if all(lo <= v <= hi for v in values[i:]))
    return (f"{name} moved from {first:g} to {values[k]:g} by checkpoint {records[k]['checkpoint']} ({steps[k] / 1e6:.1f}M steps), "
            f"then plateaued at about {last:g}: strengthen the term that pushes past it, remove a term that holds it back, "
            "or check that the test's target is reachable for this body")
  return (f"{name} was still changing at the last checkpoint ({first:g} to {last:g}): train longer (--steps) before "
          "changing the reward")


def load_module(path: str, name: str):
  spec = importlib.util.spec_from_file_location(name, path)
  mod = importlib.util.module_from_spec(spec)
  spec.loader.exec_module(mod)
  return mod


def load_skill(skill_dir: str) -> dict:
  """The skill directory, checked: skill.json's fields, test.py's test, reward.py's terms (when present)."""
  path = os.path.join(skill_dir, "skill.json")
  try:
    sj = json.load(open(path))
  except OSError:
    raise Refused(f"{path} is missing")
  except ValueError as e:
    raise Refused(f"{path} is not JSON: {e}")
  name = sj.get("name")
  if not isinstance(name, str) or not NAME.match(name):
    raise Refused(f"skill.json name {name!r}: lowercase letters and digits, words joined by hyphens (e.g. tail-wag)")
  command = sj.get("command", 0.0)
  if not isinstance(command, (int, float)) or not math.isfinite(command) or abs(command) > COMMAND_LIMIT:
    raise Refused(f"skill.json command {command!r}: a number within ±{COMMAND_LIMIT}")
  for k in ("reward_scales", "env", "ppo", "network"):
    if k in sj and not isinstance(sj[k], dict):
      raise Refused(f"skill.json {k} must be an object")
  for k, v in sj.get("reward_scales", {}).items():
    if not isinstance(v, (int, float)) or not math.isfinite(v):
      raise Refused(f"skill.json reward_scales.{k} must be a finite number")
  test_py = os.path.join(skill_dir, "test.py")
  if not os.path.exists(test_py):
    raise Refused(f"{test_py} is missing: test(sim) decides whether a checkpoint does the skill")
  try:
    test = getattr(load_module(test_py, f"skill_test_{os.getpid()}"), "test", None)
  except Exception as e:
    raise Refused(f"test.py does not load: {type(e).__name__}: {e}")
  if not callable(test):
    raise Refused("test.py defines no test(sim) function")
  reward_py = os.path.join(skill_dir, "reward.py")
  has_reward = os.path.exists(reward_py)
  import creature_env
  custom = sorted(k for k in sj.get("reward_scales", {}) if k not in creature_env.REWARD_TERMS)
  if custom and not has_reward:
    raise Refused(f"reward_scales weights {custom}, which are not built-in terms; write them in reward.py's terms(s), "
                  f"or use built-in ones: {', '.join(creature_env.REWARD_TERMS)}")
  digest = hashlib.sha256()
  for f in ("skill.json", "reward.py", "test.py"):
    p = os.path.join(skill_dir, f)
    if os.path.exists(p):
      digest.update(f.encode() + b"\0" + open(p, "rb").read() + b"\0")
  universe = {"name": name, "hypothesis": sj.get("hypothesis", ""), "reward_scales": sj.get("reward_scales", {}), "env": dict(sj.get("env", {}))}
  for k in ("ppo", "network"):
    if k in sj:
      universe[k] = sj[k]
  return {"name": name, "label": str(sj.get("label", name)), "command": float(command), "universe": universe, "test": test,
          "reward": reward_py if has_reward else None, "sha256": digest.hexdigest(), "dir": os.path.abspath(skill_dir)}


def resolve_body(arg: str, out: str) -> str:
  """A body directory with creature.xml and body.json: a robot.json or a Design is built with the tab's buildMjcf; a
  directory with only the MJCF (creature.xml or body.xml) gets its body.json derived by body.py."""
  if not os.path.isdir(arg):
    body_dir = os.path.join(out, "body")
    r = subprocess.run(["node", MJCF_BUILDER, arg, body_dir], capture_output=True, text=True)
    if r.returncode:
      raise Refused(r.stderr.strip() or r.stdout.strip())
    return body_dir
  xml_path = next((os.path.join(arg, f) for f in ("creature.xml", "body.xml") if os.path.exists(os.path.join(arg, f))), None)
  if xml_path is None:
    raise Refused(f"{arg} has no creature.xml or body.xml")
  if os.path.exists(os.path.join(arg, "creature.xml")) and os.path.exists(os.path.join(arg, "body.json")):
    body = json.load(open(os.path.join(arg, "body.json")))
    if "jointNames" in body and "standPose" in body and "legs" in body:
      return arg
  from body import BodyRefused, body_from_mjcf
  body_dir = os.path.join(out, "body")
  os.makedirs(body_dir, exist_ok=True)
  xml = open(xml_path).read()
  try:
    derived = body_from_mjcf(xml)
  except BodyRefused as e:
    raise Refused(f"the body: {e}")
  with open(os.path.join(body_dir, "creature.xml"), "w") as f:
    f.write(xml)
  write_json(os.path.join(body_dir, "body.json"), derived)
  return body_dir


def main() -> int:
  ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
  ap.add_argument("skill", nargs="?", help="an example skill: " + ", ".join(SKILLS) + " (or use --skill-dir)")
  ap.add_argument("--skill-dir", default=None, help="the skill's directory: skill.json, test.py, optional reward.py")
  ap.add_argument("--body", required=True, help="a body directory (creature.xml or body.xml), robot.json, or a Design")
  ap.add_argument("--out", required=True)
  ap.add_argument("--init-from", default="auto", help="auto (the image's checkpoint for the body's joint count), a checkpoint directory, or '' (from scratch)")
  ap.add_argument("--steps", default="10M")
  ap.add_argument("--stop-after-passing", type=int, default=2)
  ap.add_argument("--compile-cache", default=None, help="default: ~/.cache/pda-skill/<skill>.tar.gz (outside OUT)")
  ap.add_argument("--compile-only", action="store_true", help="compile this skill's program for this body and stop (a warm-up)")
  ap.add_argument("--check", default=None, metavar="POLICY", help="run test.py once on this policy file and exit (0 passes, 3 not)")
  a = ap.parse_args()
  if bool(a.skill) == bool(a.skill_dir):
    ap.error("name an example SKILL or a --skill-dir, one of them")
  skill_dir = a.skill_dir or os.path.join(EXAMPLES, canonical(a.skill))
  if a.skill and not os.path.isdir(skill_dir):
    ap.error(f"unknown skill {a.skill}; examples: {', '.join(SKILLS)}")
  out = os.path.abspath(a.out)
  os.makedirs(out, exist_ok=True)
  t0 = time.time()
  try:
    skill = load_skill(skill_dir)
    body_dir = resolve_body(a.body, out)
  except Refused as e:
    print(json.dumps({"event": "skill.refused", "why": str(e)}), flush=True)
    return 2
  xml = open(os.path.join(body_dir, "creature.xml")).read()
  body = json.load(open(os.path.join(body_dir, "body.json")))
  sha = hashlib.sha256(xml.encode()).hexdigest()
  if a.check:
    import skilltest
    pol = json.load(open(a.check))
    if pol.get("mjcf_sha256") != sha:
      print(json.dumps({"event": "skill.check", "policy": a.check, "passes": False, "error": "the policy was trained for another body"}), flush=True)
      return 3
    try:
      ok, metric = skilltest.run_test(skill["test"], skilltest.Sim(xml, body, pol, skill["command"]))
    except Exception as e:
      print(json.dumps({"event": "skill.check", "policy": a.check, "passes": False, "error": "".join(traceback.format_exception_only(type(e), e)).strip()}), flush=True)
      return 3
    print(json.dumps({"event": "skill.check", "policy": a.check, "passes": ok, "metric": metric}), flush=True)
    return 0 if ok else 3

  prev = None if a.compile_only else reuse_or_clear(out, sha, skill["sha256"])
  if prev:
    print(json.dumps({"event": "skill.done", "already": True, **prev}), flush=True)
    return 0
  os.makedirs(os.path.join(out, "checkpoints"), exist_ok=True)
  universe_path = os.path.join(out, "universe.json")
  write_json(universe_path, skill["universe"])
  meta = dict(skill=skill["name"], label=skill["label"], command=skill["command"], skill_dir=skill["dir"], skill_sha256=skill["sha256"],
              mjcf_sha256=sha, joints=len(body["jointNames"]), status="training", init_from=a.init_from, started_at=t0,
              host=os.uname().nodename, body_name=body_name(a.body))
  write_json(os.path.join(out, "skill.json"), meta)
  print(json.dumps({"event": "skill.start", **meta}), flush=True)

  cache = a.compile_cache or compile_cache(os.path.basename(os.path.normpath(skill["dir"])))
  os.makedirs(os.path.dirname(cache), exist_ok=True)
  cmd = [sys.executable, os.path.join(HERE, "train.py"), "--mjcf", os.path.join(body_dir, "creature.xml"),
         "--body", os.path.join(body_dir, "body.json"), "--universe", universe_path, "--work", os.path.join(out, "work"),
         *TAKE, "--steps", a.steps, "--compile-cache", cache, "--keep-published", os.path.join(out, "checkpoints"),
         "--publish", os.path.join(out, "policy.json")]
  if skill["reward"]:
    cmd += ["--reward", skill["reward"]]
  if a.init_from:
    cmd += ["--init-from", a.init_from]
  if a.compile_only:
    r = subprocess.run(cmd + ["--compile-only"], capture_output=True, text=True, cwd=HERE)
    meta.update(status="compiled" if r.returncode == 0 else "failed", wall_s=round(time.time() - t0, 1))
    if r.returncode:
      meta["error"] = (r.stdout + r.stderr).strip()[-2000:]
    write_json(os.path.join(out, "skill.json"), meta)
    print(json.dumps({"event": "skill.compiled", **meta}), flush=True)
    return r.returncode
  import skilltest
  p = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, cwd=HERE)
  streak, passed_at, last_pass, tail, records = 0, None, None, [], []
  prog = open(os.path.join(out, "skill-progress.jsonl"), "a")
  for line in p.stdout:
    tail = (tail + [line])[-40:]
    try:
      ev = json.loads(line)
    except json.JSONDecodeError:
      continue
    if ev.get("event") != "train.checkpoint":
      if ev.get("event") in ("train.init-from", "train.compiled", "train.start", "train.diverged"):
        print(line.rstrip(), flush=True)
      continue
    n = ev["checkpoint"]
    pol = json.load(open(os.path.join(out, "checkpoints", f"ckpt-{n}.json")))
    rec = dict(checkpoint=n, steps=ev["steps"])
    try:
      ok, metric = skilltest.run_test(skill["test"], skilltest.Sim(xml, body, pol, skill["command"]))
      rec.update(passes=ok, metric=metric)
    except Exception as e:  # a test that raises is a failing checkpoint, and the thread sees why
      err = "".join(traceback.format_exception_only(type(e), e)).strip()
      rec.update(passes=False, metric=None, error=err[:1000])
      print(json.dumps({"event": "skill.test-error", "checkpoint": n, "error": err[:1000]}), flush=True)
      ok = False
    rec["t"] = round(time.time() - t0, 1)
    records.append(rec)
    prog.write(json.dumps(rec) + "\n"); prog.flush()
    print(json.dumps({"event": "skill.checkpoint", "skill": skill["name"], **rec}), flush=True)
    streak = streak + 1 if ok else 0
    if ok and passed_at is None:
      passed_at = rec
    if ok:
      last_pass = n
    if a.stop_after_passing and streak >= a.stop_after_passing:
      p.terminate()
      break
  code = p.wait()
  if last_pass is not None:
    settle_policy(out, last_pass)
  meta.update(status="done" if passed_at else "failed", passed_at=passed_at, policy_checkpoint=last_pass,
              wall_s=round(time.time() - t0, 1),
              cpu_estimate_s=cpu_estimate_s(passed_at["steps"]) if passed_at else None, cpu_estimate=CPU_BASELINE)
  if not passed_at and code not in (0, None, -15):
    meta["error"] = "".join(tail).strip()[-2000:]  # the trainer's own last lines: a reward.py error shows here
  if not passed_at:
    meta["diagnosis"] = diagnose(records)
  write_json(os.path.join(out, "skill.json"), meta)
  print(json.dumps({"event": "skill.done", **{k: v for k, v in meta.items() if k != "cpu_estimate"}}), flush=True)
  return 0 if passed_at else 3


if __name__ == "__main__":
  sys.exit(main())
