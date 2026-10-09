# Contract between the trainer (train/) and the tab (tab/)

Ownership: `policy.json` and its runtime (`obs.ts`, `policy.ts`) belong to the trainer lane (`../policy/`); the body
(`design.ts`, `mjcf.ts`, `sim.ts`) belongs to the tab. The copies of `obs.ts`/`policy.ts` here are frozen until the lanes
meet on one branch. Two files cross the boundary. Both are plain JSON. The tab refuses a policy whose `mjcf_sha256` differs from the
SHA-256 of the MJCF it would run it on.

## Body: `design.json` -> MJCF

`tab/src/mjcf.ts` (`buildMjcf(design)`) is the only MJCF generator. It is plain TypeScript with no browser APIs, so the
trainer runs it under node (`node tab/scripts/design-to-mjcf.ts design.json > creature.xml`) and trains on the exact
bytes the tab simulates. `mjcf_sha256` is the SHA-256 of that XML string (UTF-8).

Physics: `timestep` 0.004 s, `integrator` implicitfast, control every 5 physics steps (`control_dt` 0.02 s).
Collision: the floor (and any terrain) is `contype=1 conaffinity=1`; every body geom is `contype=0 conaffinity=1`, so
body parts hit the ground but never each other. Reset: keyframe `home` (`mj_resetDataKeyframe`); the episode clock
(`phase`) is `data.time` since that reset.
Terrain: `buildMjcf(design, world?)` takes an optional `{asset, geoms}` MJCF fragment spliced after the floor. The body's
identity (`mjcf_sha256`) is the hash of `buildMjcf(design)` without a world, so one policy runs on any terrain.
MuJoCo versions: the tab's `@mujoco/mujoco` and the trainer's `mujoco` must be the same version (set by D2).

Joint order (qpos[7:], qvel[6:], actuators): for each leg pair `i` in the design, left then right (`l0`, `r0`, `l1`,
`r1`, ...); per leg the joints are `<leg>_abd` (only with `legDof: 3`), `<leg>_hip`, `<leg>_knee`. Actuator `i` is a
position servo (kp 40, kv 1.2, forcerange 12) on joint `i`; names `<leg>_abd_a`, `<leg>_hip_a`, `<leg>_knee_a`.
- `abd`: hinge about x at the thigh body's origin, before the hip joint (same body), range -1..1 rad. Positive abd
  swings the foot toward +y (outward on the left legs, inward on the right); the policy learns the sign.
- `hip`: hinge about y, range -2.5..2.5 rad (-1..1 with 2-DOF legs). `knee`: hinge about y, range 0..2.6 rad (0..2.3 with
  2-DOF legs). The wide 3-DOF ranges are what lets a creature get up from its side or back; ctrlrange equals the joint range.
- `standPose` per leg: abd 0.3 (left) / -0.3 (right) when `legDof` is 3 (feet splayed outward; a still creature then
  takes about 120 N sideways, against 60 N with 0), hip -0.45, knee 0.9. Policies output offsets from it.
- `legDof` 2 (no abd joint, the first policies' body) stays buildable: omit the field. `legDof` is part of the design's
  canonical JSON only when it is 3, so a 2-DOF design keeps its hash. Which body is the default: `defaultDesign(3)` (the show).
- `spec_version` stays 1: no observation slice changed meaning; slice sizes follow the joint count.
`body.json` (written beside `creature.xml`) lists `legs`, `jointsPerLeg`, `jointNames`, `standPose`, `standHeight`, `mjcf_sha256`.

## Policy: `policy.json` (format `mlp-v1`)

```jsonc
{
  "format": "mlp-v1",
  "spec_version": 1,                 // bump when obs/act semantics change; the tab refuses a version it does not know
  "mujoco_version": "3.x.y",
  "mjcf_sha256": "<hex>",
  "control_dt": 0.02,
  "obs": {
    // Concatenated in this order. The tab builds each named slice itself from qpos/qvel/prev action/command/clock.
    "spec": [
      {"name": "gravity",     "size": 3},   // world down (0,0,-1) in the torso frame
      {"name": "ang_vel",     "size": 3},   // qvel[3:6] (torso frame, as MuJoCo stores it)
      {"name": "lin_vel",     "size": 3},   // qvel[0:3] rotated into the torso frame
      {"name": "joint_pos",   "size": N},   // qpos[7:] minus standPose
      {"name": "joint_vel",   "size": N},   // qvel[6:]
      {"name": "prev_action", "size": N},   // last action output, before scaling
      {"name": "command",     "size": 1},   // desired forward speed in m/s (0 = stand)
      {"name": "phase",       "size": 2}    // sin, cos of 2*pi*t*gait_hz  (optional; gait_hz in the "clock" key)
    ],
    "mean": [ ... ], "std": [ ... ]        // length = sum of sizes; the tab computes (obs - mean) / std
  },
  "clock": {"gait_hz": 2.0},               // required only when "phase" is in obs.spec
  "act": {
    "scale": 0.5,                         // radians; ctrl = standPose + scale * clip(a, -1, 1)
    "clip": 1.0
  },
  "layers": [                              // fully connected, row-major [out][in], float32 little-endian, base64
    {"in": 24, "out": 128, "w": "<b64>", "b": "<b64>", "act": "tanh"},
    {"in": 128, "out": 128, "w": "<b64>", "b": "<b64>", "act": "tanh"},
    {"in": 128, "out": 8,  "w": "<b64>", "b": "<b64>", "act": "none"}   // mean action; no sampling in the tab
  ]
}
```

Activations the tab runs: `tanh`, `elu`, `relu`, `silu`, `none`. Unknown top-level keys (`provenance`, `command_range`, ...) are ignored; `command_range` [lo, hi] limits the tab's speed slider. Anything else is refused. Size budget: under 300 KB of JSON.
The tab computes the observation in float64 and casts to float32 only at the layer boundary; a trainer that wants bitwise
parity must do the same; small differences are expected otherwise and tested with a tolerance.

Kick: the tab applies an impulse as `xfrc_applied` on the torso body for 12 physics steps (0.048 s), and the policy sees it only
through the state. Train with random pushes of up to ~60 N for 0.048 s if you want it to recover.
