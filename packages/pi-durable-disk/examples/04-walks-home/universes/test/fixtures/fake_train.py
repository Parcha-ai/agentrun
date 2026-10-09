"""A stand-in for ../train/train.py with the same file contract and no physics, for tests.

Per checkpoint, in order: the checkpoint directory, policy.json (by rename), one progress.jsonl line (fsynced), then
state.json by rename, exactly once. A run on a work directory that has a state.json resumes: generation + 1, from its
steps. SIGTERM stops at once and writes state.json with status paused.
"""
import argparse, json, os, signal, sys, time

ap = argparse.ArgumentParser()
for flag in ("--mjcf", "--body", "--universe", "--work"):
    ap.add_argument(flag, required=True)
ap.add_argument("--minutes", type=float, default=0.0)
a = ap.parse_args()
host = os.environ.get("TRAIN_HOST_LABEL") or os.uname().nodename
work = a.work
os.makedirs(work, exist_ok=True)
state_path = os.path.join(work, "state.json")
prior = json.load(open(state_path)) if os.path.exists(state_path) else {}
generation = prior.get("generation", 0) + 1
steps = prior.get("steps_done", 0)
total = 60_000
segments = prior.get("segments", []) + [{"generation": generation, "base": steps, "host": host}]
universe = json.load(open(a.universe))

def write_json(path, value):
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        json.dump(value, f)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, path)

def state(status):
    write_json(state_path, {"universe": universe["name"], "status": status, "generation": generation, "steps_done": steps,
                            "steps_total": total, "segments": segments})

def stop(*_):
    state("paused")
    sys.exit(0)

signal.signal(signal.SIGTERM, stop)
state("training")
while steps < total:
    time.sleep(0.05)
    steps += 1000
    if steps % 3000:
        continue
    ck = os.path.join(work, "ckpt", f"seg{generation}", f"{steps:012d}")
    os.makedirs(ck, exist_ok=True)
    write_json(os.path.join(ck, "config.json"), {"steps": steps})
    write_json(os.path.join(work, "policy.json"), {"steps": steps})
    with open(os.path.join(work, "progress.jsonl"), "a") as f:
        f.write(json.dumps({"steps": steps, "score": round(steps / total * 3.2, 4), "host": host}) + "\n")
        f.flush()
        os.fsync(f.fileno())
    state("training")
state("done")
