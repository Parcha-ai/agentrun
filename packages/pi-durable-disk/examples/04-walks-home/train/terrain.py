"""Generate a terrain on the fly: a grid of tiles (flat, slopes, stairs, rubble, waves) as one MuJoCo heightfield.

  python terrain.py --seed 3 --mix stairs:2,slope:1,rubble:1,flat:1 --out terrain.json [--check creature.xml]

terrain.json carries {asset, geoms} MJCF fragments (tab/src/mjcf.ts buildMjcf's `world` argument, spliced verbatim by
node and by train.py) plus the tile map and spawn points. Invariants:
- the heightfield's lowest surface sits WORLD_LIFT above the floor plane, so a foot touches one surface, never both;
- every tile is 0 along its border (no cliffs between tiles); its centre is a spawn point on a flat 0.4 m pad;
- heights are in metres and stay within what the 0.4 m legs can step (stairs up to MAX_STEP).
"""

from __future__ import annotations

import argparse
import hashlib
import json

import numpy as np

WORLD_LIFT = 0.002
MAX_STEP = 0.06
KINDS = ("flat", "slope", "stairs", "rubble", "waves")


def _tile(kind: str, n: int, cell: float, rng: np.random.Generator, difficulty: float) -> np.ndarray:
  """Heights (n x n, metres) for one tile. Every tile is 0 along its border, so neighbours meet without a cliff, and
  flat on its centre pad (the spawn point). Shapes rise (or sink) from the border toward the pad."""
  ax = (np.arange(n) - (n - 1) / 2) * cell
  x, y = np.meshgrid(ax, ax, indexing="xy")
  half = n * cell / 2
  pad = 0.2
  d = np.clip(half - np.maximum(np.abs(x), np.abs(y)), 0, half - pad)  # distance in from the border, capped at the pad
  taper = np.clip(d / 0.3, 0, 1)
  sign = rng.choice([1.0, -1.0])  # a hill or a pit
  if kind == "flat":
    h = np.zeros((n, n))
  elif kind == "slope":
    grade = np.tan(np.radians(6 + 12 * difficulty))
    h = sign * d * grade
  elif kind == "stairs":
    step = 0.02 + (MAX_STEP - 0.02) * difficulty
    h = sign * np.floor(d / 0.25) * step
  elif kind == "rubble":
    amp = 0.015 + 0.035 * difficulty
    h = rng.uniform(-amp, amp, (n, n))
    h = np.repeat(np.repeat(h[::2, ::2], 2, 0), 2, 1)[:n, :n] * taper  # blocky: 2x2 cells per stone
    h[d >= half - pad] = 0.0
  elif kind == "waves":
    amp = 0.02 + 0.04 * difficulty
    wl = rng.uniform(0.8, 1.6)
    h = amp * np.sin(2 * np.pi * x / wl) * np.sin(2 * np.pi * y / wl) * taper
    h[d >= half - pad] = 0.0
  else:
    raise ValueError(f"unknown tile kind {kind}; known: {', '.join(KINDS)}")
  return h


def make_terrain(seed: int = 0, mix: dict[str, float] | None = None, tiles: int = 6, tile_m: float = 2.0,
                 cell: float = 0.05, difficulty: tuple[float, float] = (0.2, 1.0)) -> dict:
  mix = mix or {"flat": 1, "slope": 1, "stairs": 2, "rubble": 1, "waves": 1}
  rng = np.random.default_rng(seed)
  kinds = list(mix)
  p = np.array([mix[k] for k in kinds], dtype=float)
  p /= p.sum()
  n = int(round(tile_m / cell))
  grid = np.zeros((tiles * n, tiles * n))
  tile_map, spawns = [], []
  half = tiles * tile_m / 2
  for i in range(tiles):
    for j in range(tiles):
      kind = str(rng.choice(kinds, p=p))
      d = float(rng.uniform(*difficulty))
      grid[i * n:(i + 1) * n, j * n:(j + 1) * n] = _tile(kind, n, cell, rng, d)
      cx, cy = -half + (j + 0.5) * tile_m, -half + (i + 0.5) * tile_m
      tile_map.append({"row": i, "col": j, "kind": kind, "difficulty": round(d, 3), "x": cx, "y": cy})
  lo = float(grid.min())
  grid -= lo  # lowest point -> 0, then lifted by WORLD_LIFT through the geom position
  hz = max(float(grid.max()), 1e-3)
  elevation = grid / hz
  nrow, ncol = grid.shape
  for t in tile_map:
    i, j = t["row"], t["col"]
    t["ground_z"] = round(float(grid[i * n + n // 2, j * n + n // 2]) + WORLD_LIFT, 5)
    spawns.append([t["x"], t["y"], t["ground_z"]])
  # Our grid row i is the i-th row from -y. MuJoCo reads an inline elevation attribute top row first (+y, like an
  # image) and stores it flipped, so the attribute gets the rows reversed; hfield_data then matches the grid.
  rx = ry = half
  elev = " ".join(f"{v:.4f}" for v in elevation[::-1].ravel())
  base = 0.05
  asset = f'<hfield name="terrain" nrow="{nrow}" ncol="{ncol}" size="{rx:.4f} {ry:.4f} {hz:.5f} {base}" elevation="{elev}"/>'
  geoms = (f'<geom name="terrain" type="hfield" hfield="terrain" pos="0 0 {WORLD_LIFT}" contype="1" conaffinity="1" '
           f'friction="1 0.05 0.01" rgba="0.82 0.8 0.74 1"/>')
  doc = {"version": 1, "seed": seed, "mix": mix, "tiles": tile_map, "spawns": spawns, "cell": cell,
         "size": [rx, ry, hz, base], "nrow": nrow, "ncol": ncol, "asset": asset, "geoms": geoms}
  doc["sha256"] = hashlib.sha256((asset + "\n" + geoms).encode("utf-8")).hexdigest()
  return doc


def make_course(seed: int = 1000, cell: float = 0.05, length_m: float = 12.0, width_m: float = 2.0) -> dict:
  """The held-out course every universe is scored on: a 2 m wide strip along +x from the spawn point at the origin
  (heading +x, flat start), through a slope, stairs, rubble and waves, 2 m each, all at height 0 where they meet. Score =
  metres of +x progress in 10 s at a 0.5 m/s command. Its seed is not one any universe trains on."""
  rng = np.random.default_rng(seed)
  ncol, nrow = int(round(length_m / cell)), int(round(width_m / cell))
  x = (np.arange(ncol) + 0.5) * cell - 1.0  # strip starts 1 m behind the spawn point
  h = np.zeros(ncol)
  def bump(x0, x1, profile):
    sel = (x >= x0) & (x < x1)
    u = (x[sel] - x0) / (x1 - x0)
    h[sel] = profile(u)
  bump(1.0, 3.0, lambda u: np.tan(np.radians(12)) * 1.0 * (1 - np.abs(2 * u - 1)))  # up 12 degrees, then down
  bump(3.0, 5.0, lambda u: 0.04 * np.minimum(np.floor(u * 8), np.floor((1 - u) * 8)))  # 4 cm steps up, then down
  grid = np.tile(h, (nrow, 1))
  rub = rng.uniform(-0.025, 0.025, (nrow // 2 + 1, ncol // 2 + 1)).repeat(2, 0).repeat(2, 1)[:nrow, :ncol]
  sel = (x >= 5.0) & (x < 7.0)
  grid[:, sel] += rub[:, sel] * np.sin(np.pi * (x[sel] - 5.0) / 2.0)  # rubble, tapered to 0 at both ends
  sel = (x >= 7.0) & (x < 9.0)
  grid[:, sel] += 0.04 * np.sin(2 * np.pi * (x[sel] - 7.0) / 1.0) ** 2  # waves
  grid -= min(grid.min(), 0.0)
  hz = max(float(grid.max()), 1e-3)
  elev = " ".join(f"{v:.4f}" for v in (grid / hz)[::-1].ravel())
  cx = x[0] - cell / 2 + length_m / 2
  asset = (f'<hfield name="terrain" nrow="{nrow}" ncol="{ncol}" size="{length_m / 2:.4f} {width_m / 2:.4f} {hz:.5f} 0.05" '
           f'elevation="{elev}"/>')
  geoms = (f'<geom name="terrain" type="hfield" hfield="terrain" pos="{cx:.4f} 0 {WORLD_LIFT}" contype="1" conaffinity="1" '
           f'friction="1 0.05 0.01" rgba="0.82 0.8 0.74 1"/>')
  doc = {"version": 1, "kind": "course", "seed": seed, "spawns": [[0.0, 0.0, float(grid[nrow // 2, int(1.0 / cell)]) + WORLD_LIFT]],
         "sections": ["flat", "slope", "stairs", "rubble", "waves", "flat"], "cell": cell, "asset": asset, "geoms": geoms}
  doc["sha256"] = hashlib.sha256((asset + "\n" + geoms).encode("utf-8")).hexdigest()
  return doc


def splice(body_xml: str, world: dict) -> str:
  """What buildMjcf(design, world) produces, for a body built without one: <asset> before <worldbody>, geoms after
  the floor. train.py trains on this; node gives the same bytes (checked by check_splice in the tests)."""
  floor_end = body_xml.index("/>", body_xml.index('<geom name="floor"')) + 2
  with_geoms = body_xml[:floor_end] + "\n    " + world["geoms"] + body_xml[floor_end:]
  wb = with_geoms.index("  <worldbody>")
  return with_geoms[:wb] + f"  <asset>{world['asset']}</asset>\n" + with_geoms[wb:]


def check(xml_path: str, world: dict) -> dict:
  """Drop the creature on every spawn point in C MuJoCo with no policy: it must land and stand, not explode."""
  import mujoco
  body_xml = open(xml_path, "rb").read().decode("utf-8")
  m = mujoco.MjModel.from_xml_string(splice(body_xml, world))
  d = mujoco.MjData(m)
  key = mujoco.mj_name2id(m, mujoco.mjtObj.mjOBJ_KEY, "home")
  results = []
  for (x, y, z), t in zip(world["spawns"], world.get("tiles") or [{"kind": "course start"}]):
    mujoco.mj_resetDataKeyframe(m, d, key)
    d.qpos[0:3] += [x, y, z]
    for _ in range(250):
      mujoco.mj_step(m, d)
    up = 1 - 2 * (d.qpos[4] ** 2 + d.qpos[5] ** 2)
    ok = bool(np.isfinite(d.qpos).all() and up > 0.7 and d.qpos[2] - z > 0.15)
    results.append({"kind": t["kind"], "ok": ok, "up": round(float(up), 3), "height": round(float(d.qpos[2] - z), 3)})
  return {"ok": sum(r["ok"] for r in results), "of": len(results), "tiles": results}


def main():
  ap = argparse.ArgumentParser()
  ap.add_argument("--seed", type=int, default=0)
  ap.add_argument("--mix", default="flat:1,slope:1,stairs:2,rubble:1,waves:1")
  ap.add_argument("--tiles", type=int, default=6)
  ap.add_argument("--out", required=True)
  ap.add_argument("--check", help="body MJCF to drop on every spawn point")
  ap.add_argument("--course", action="store_true", help="the held-out scoring course instead of training tiles")
  args = ap.parse_args()
  mix = {k: float(v) for k, v in (kv.split(":") for kv in args.mix.split(","))}
  world = make_course(args.seed) if args.course else make_terrain(args.seed, mix, args.tiles)
  if args.check:
    world["check"] = check(args.check, world)
  json.dump(world, open(args.out, "w"))
  summary = {k: world.get(k) for k in ("seed", "nrow", "ncol", "size", "sha256")}
  summary["kinds"] = [t["kind"] for t in world["tiles"]] if "tiles" in world else world["sections"]
  if "check" in world:
    summary["check"] = {k: world["check"][k] for k in ("ok", "of")}
  print(json.dumps(summary))


if __name__ == "__main__":
  main()
