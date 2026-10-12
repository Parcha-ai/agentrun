"""Homecoming for the cluster beat: the skills the threads trained, in the page's format (D3's skills.ts).

  assemble-skills work/skills/ --home home/ [--default walk]

For every work/skills/<name>/ whose skill.json says done: home/skills/<name>.json = that skill's policy.json with the get-up
network inside (export.combine, so a fall is caught in every skill, as home/policy.json does today), and home/skills.json:
  {"version": 1, "body_mjcf_sha256": ..., "default": "walk", "skills": {"<name>": {"policy": "skills/<name>.json",
   "command": <the skill's fixed command>, "label": "<what the stage says>"}}}
The get-up skill itself is the walk at command 0 with the get-up network (it stands up and stays standing). Every file is
written by rename, the manifest last. A skill trained for another body, or one that cannot be combined, is left out and
named. With no get-up network (no get-up thread and no --getup) it refuses, unless --without-getup: a dry run's skills then
come home without one. Pure numpy. policy/assemble-skills.ts is its TypeScript twin, for a session host without python.
"""
from __future__ import annotations

import argparse, json, os, sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from export import combine, dumps  # noqa: E402


def write(path: str, text: str) -> None:
  os.makedirs(os.path.dirname(path), exist_ok=True)
  tmp = f"{path}.tmp"
  with open(tmp, "w") as f:
    f.write(text)
  os.replace(tmp, path)


def main() -> int:
  ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
  ap.add_argument("skills_dir")
  ap.add_argument("--home", required=True)
  ap.add_argument("--default", default="walk")
  ap.add_argument("--getup", default=None, help="a get-up policy to combine with (default: the get-up thread's)")
  ap.add_argument("--without-getup", action="store_true", help="with no get-up network, bring the skills home without one")
  a = ap.parse_args()
  done = {}
  for name in sorted(os.listdir(a.skills_dir)):
    d = os.path.join(a.skills_dir, name)
    try:
      meta = json.load(open(os.path.join(d, "skill.json")))
      pol = json.load(open(os.path.join(d, "policy.json")))
    except (OSError, ValueError):
      continue
    if meta.get("status") == "done":
      done[meta["skill"]] = (meta, pol)
  getup_pol = json.load(open(a.getup)) if a.getup else (done.get("get-up") or (None, None))[1]
  if getup_pol is None and not a.without_getup:
    print(json.dumps({"event": "skills.refused", "why": "no get-up network to combine with"}), flush=True)
    return 2
  first = (done.get("walk") or next(iter(done.values()), (None, None)))[1]
  body = getup_pol["mjcf_sha256"] if getup_pol else first["mjcf_sha256"] if first else None
  if body is None:
    print(json.dumps({"event": "skills.refused", "why": "no skill is done"}), flush=True)
    return 2
  skills, left_out = {}, {}
  for name, (meta, pol) in done.items():
    if pol["mjcf_sha256"] != body:
      left_out[name] = "trained for another body"
      continue
    if name == "get-up":
      walk = done.get("walk", (None, None))[1]
      if getup_pol is None:
        left_out[name] = "no get-up network"
        continue
      if walk is None:
        left_out[name] = "needs the walk skill to stand on"
        continue
      pol, command = walk, 0.0
    else:
      command = meta["command"]
    try:
      out = combine(pol, getup_pol) if getup_pol else pol
    except ValueError as e:
      left_out[name] = str(e)
      continue
    write(os.path.join(a.home, "skills", f"{name}.json"), dumps(out))
    skills[name] = {"policy": f"skills/{name}.json", "command": command, "label": meta.get("label", name)}
  default = a.default if a.default in skills else next(iter(skills), None)
  manifest = {"version": 1, "body_mjcf_sha256": body, "default": default, "skills": skills}
  write(os.path.join(a.home, "skills.json"), json.dumps(manifest, indent=1))
  print(json.dumps({"event": "skills.home", "skills": sorted(skills), "default": default, "left_out": left_out,
                    "getup": getup_pol is not None}), flush=True)
  return 0 if skills else 3


if __name__ == "__main__":
  sys.exit(main())
