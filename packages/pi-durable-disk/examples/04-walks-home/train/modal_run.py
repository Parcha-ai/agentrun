"""Dev runner: train one universe in a Modal GPU sandbox and bring its WORK directory files home.

  with-modal -- python modal_run.py --mjcf creature.xml --body body.json --universe u1.json --out OUT \
      [--gpu L40S] [--minutes 8] [--ledger D2-STATE.json] [--kill-after 120]

Every sandbox it creates is recorded in the ledger before it is used and closed when it is terminated, including on
error. --kill-after terminates the sandbox mid-run and resumes on a fresh one from the files brought home (the
kill-and-resume path, with a local work/ standing in for the run's disk until the mount-or-pipe verdict).
"""

from __future__ import annotations

import argparse
import datetime as dt
import fcntl
import json
import os
import sys
import threading
import time

import modal

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from modal_image import REMOTE_TRAIN, training_image  # noqa: E402

APP = "pda-demo-d2"
REMOTE_WORK = "/root/work"
REMOTE_IN = "/root/in"


class Ledger:
  """Rows of every cloud resource: opened before use, closed when gone. Safe against concurrent writers."""

  def __init__(self, path: str | None):
    self.path = path

  def _edit(self, fn) -> None:
    if not self.path:
      return
    with open(self.path, "a+") as f:
      fcntl.flock(f, fcntl.LOCK_EX)
      f.seek(0)
      text = f.read()
      doc = json.loads(text) if text.strip() else {"about": "every cloud resource lane D2 created", "rows": []}
      fn(doc)
      f.seek(0)
      f.truncate()
      json.dump(doc, f, indent=1)

  def open(self, kind: str, rid: str, note: str) -> None:
    now = dt.datetime.now(dt.timezone.utc).isoformat()
    self._edit(lambda d: d["rows"].append({"kind": kind, "id": rid, "at": now, "note": note, "closed": None}))

  def close(self, kind: str, rid: str, how: str) -> None:
    now = dt.datetime.now(dt.timezone.utc).isoformat()

    def fn(d):
      for r in d["rows"]:
        if r["kind"] == kind and r["id"] == rid and not r.get("closed"):
          r["closed"] = {"at": now, "how": how}
    self._edit(fn)


def log(event: str, **data) -> None:
  print(json.dumps({"at": dt.datetime.now(dt.timezone.utc).strftime("%H:%M:%S"), "event": event, **data}), flush=True)


def pull(sb: modal.Sandbox, out: str) -> list[str]:
  """Bring WORK's small files home (state, progress, policy); checkpoints too when present."""
  got = []
  os.makedirs(out, exist_ok=True)
  for name in ("state.json", "progress.jsonl", "policy.json"):
    try:
      data = sb.filesystem.read_bytes(f"{REMOTE_WORK}/{name}")
    except Exception:
      continue
    tmp = os.path.join(out, f".{name}.tmp")
    with open(tmp, "wb") as f:
      f.write(data)
    os.replace(tmp, os.path.join(out, name))
    got.append(name)
  return got


def pull_tree(sb: modal.Sandbox, remote: str, local: str) -> int:
  n = 0
  for info in sb.filesystem.list_files(remote):
    path = info.path if info.path.startswith("/") else f"{remote}/{info.path}"
    name = os.path.basename(path.rstrip("/"))
    dst = os.path.join(local, name)
    if getattr(info, "is_dir", False) or str(getattr(info, "type", "")).lower().endswith("dir"):
      os.makedirs(dst, exist_ok=True)
      n += pull_tree(sb, path, dst)
    else:
      os.makedirs(local, exist_ok=True)
      with open(dst, "wb") as f:
        f.write(sb.filesystem.read_bytes(path))
      n += 1
  return n


def push_tree(sb: modal.Sandbox, local: str, remote: str) -> int:
  n = 0
  for root, _, files in os.walk(local):
    rel = os.path.relpath(root, local)
    rdir = remote if rel == "." else f"{remote}/{rel}"
    sb.filesystem.make_directory(rdir)
    for name in files:
      with open(os.path.join(root, name), "rb") as f:
        sb.filesystem.write_bytes(f.read(), f"{rdir}/{name}")
      n += 1
  return n


def start(app, image, gpu: str, name: str, ledger: Ledger, timeout_s: int) -> modal.Sandbox:
  ledger.open("modal-sandbox", name, f"gpu {gpu}, training")
  try:
    sb = modal.Sandbox.create("sleep", "infinity", app=app, image=image, gpu=gpu, timeout=timeout_s, name=name,
                              tags={"pda-fleet": "demo-d2"})
  except Exception as e:
    ledger.close("modal-sandbox", name, f"create failed: {str(e)[:120]}")
    raise
  return sb


def stop(sb: modal.Sandbox, name: str, ledger: Ledger, how: str) -> None:
  try:
    sb.terminate()
  finally:
    ledger.close("modal-sandbox", name, how)


def main() -> None:
  ap = argparse.ArgumentParser()
  ap.add_argument("--mjcf", required=True)
  ap.add_argument("--body", required=True)
  ap.add_argument("--universe", required=True)
  ap.add_argument("--out", required=True, help="local directory standing in for the run's work/train/<u>/")
  ap.add_argument("--gpu", default="L40S")
  ap.add_argument("--minutes", type=float, default=8.0)
  ap.add_argument("--steps", type=float, default=None)
  ap.add_argument("--num-envs", type=int, default=None)
  ap.add_argument("--impl", default=None)
  ap.add_argument("--ledger", default=None)
  ap.add_argument("--kill-after", type=float, default=0.0, help="seconds after training starts; then resume elsewhere")
  ap.add_argument("--timeout", type=int, default=3600)
  args = ap.parse_args()

  ledger = Ledger(args.ledger)
  app = modal.App.lookup(APP, create_if_missing=True)
  image = training_image()
  t0 = time.time()
  uname = json.load(open(args.universe)).get("name", "u")
  attempt = 0
  out = os.path.abspath(args.out)
  os.makedirs(out, exist_ok=True)
  while True:
    attempt += 1
    name = f"pda-demo-d2-{uname}-{int(time.time())}-{attempt}"
    t_create = time.time()
    sb = start(app, image, args.gpu, name, ledger, args.timeout)
    killed = threading.Event()
    finished = False
    try:
      log("sandbox.started", name=name, gpu=args.gpu, create_s=round(time.time() - t_create, 1))
      sb.filesystem.make_directory(REMOTE_IN)
      for local, remote in ((args.mjcf, "creature.xml"), (args.body, "body.json"), (args.universe, "universe.json")):
        with open(local, "rb") as f:
          sb.filesystem.write_bytes(f.read(), f"{REMOTE_IN}/{remote}")
      sb.filesystem.make_directory(REMOTE_WORK)
      if os.path.exists(os.path.join(out, "state.json")):
        log("work.restored", files=push_tree(sb, out, REMOTE_WORK))
      cmd = ["python", f"{REMOTE_TRAIN}/train.py", "--mjcf", f"{REMOTE_IN}/creature.xml", "--body",
             f"{REMOTE_IN}/body.json", "--universe", f"{REMOTE_IN}/universe.json", "--work", REMOTE_WORK,
             "--minutes", str(args.minutes)]
      if args.steps:
        cmd += ["--steps", str(int(args.steps))]
      if args.num_envs:
        cmd += ["--num-envs", str(args.num_envs)]
      if args.impl:
        cmd += ["--impl", args.impl]
      smi = sb.exec("nvidia-smi", "--query-gpu=name,memory.total,driver_version", "--format=csv,noheader")
      log("gpu", info=smi.stdout.read().strip())
      proc = sb.exec(*cmd, env={"XLA_PYTHON_CLIENT_PREALLOCATE": "false", "PYTHONUNBUFFERED": "1"})
      t_train = time.time()

      def killer():
        time.sleep(args.kill_after)
        pull(sb, out)
        n = pull_tree(sb, f"{REMOTE_WORK}/ckpt", os.path.join(out, "ckpt"))
        log("kill", after_s=args.kill_after, ckpt_files=n)
        killed.set()
        sb.terminate()

      if args.kill_after > 0 and attempt == 1:
        threading.Thread(target=killer, daemon=True).start()
      try:
        for line in proc.stdout:
          line = line.rstrip()
          if line.startswith("{"):
            print(line, flush=True)
      except Exception:
        if not killed.is_set():
          raise
      if killed.is_set():
        continue
      rc = proc.wait()
      err = proc.stderr.read()
      got = pull(sb, out)
      n = pull_tree(sb, f"{REMOTE_WORK}/ckpt", os.path.join(out, "ckpt"))
      log("train.exit", rc=rc, files=got, ckpt_files=n, train_s=round(time.time() - t_train, 1),
          total_s=round(time.time() - t0, 1), stderr_tail=err[-1500:] if rc else "")
      finished = True
    finally:
      if killed.is_set():
        ledger.close("modal-sandbox", name, "killed on purpose (kill-and-resume test)")
      else:
        stop(sb, name, ledger, "terminated")
    if finished:
      break


if __name__ == "__main__":
  main()
