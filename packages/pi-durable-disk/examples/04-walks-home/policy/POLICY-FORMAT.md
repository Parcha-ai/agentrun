# Contract between the trainer and the tab (tab/)

Ownership: `policy.json` and its runtime (`obs.ts`, `policy.ts`, in this directory) belong to the trainer lane; the body
(`design.ts`, `mjcf.ts`, `sim.ts`) belongs to the tab, which imports the runtime from here. A change to a slice or to the
action mapping bumps `spec_version`. Two files cross the boundary. Both are plain JSON. The tab refuses a policy whose `mjcf_sha256` differs from the
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
`r1`, ...), and per leg `hip` then `knee`. Actuators are position servos on those joints, in the same order. Hip range
-1..1 rad, knee 0..2.3 rad. `standPose` (hip -0.45, knee 0.9) is the pose the action offsets are relative to.

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
    {"in": 36, "out": 128, "w": "<b64>", "b": "<b64>", "act": "silu"},
    {"in": 128, "out": 128, "w": "<b64>", "b": "<b64>", "act": "silu"},
    {"in": 128, "out": 128, "w": "<b64>", "b": "<b64>", "act": "silu"},
    {"in": 128, "out": 8,  "w": "<b64>", "b": "<b64>", "act": "tanh"}   // tanh(mean): Brax's deterministic action
  ],
  "command_range": [0, 0.8],               // optional: the forward speeds the policy was trained on
  "provenance": { ... }                    // optional, ignored by the tab: universe, steps, reward weights, device,
                                           // walk_10s (the C-MuJoCo score of this file)
}
```

Activations the tab runs: `tanh`, `elu`, `relu`, `silu`, `none`. Unknown top-level keys (`provenance`, `command_range`, ...) are ignored; `command_range` [lo, hi] limits the tab's speed slider. Anything else is refused. Size budget: under 300 KB of JSON.
The tab computes the observation in float64 and casts to float32 only at the layer boundary; a trainer that wants bitwise
parity must do the same; small differences are expected otherwise and tested with a tolerance.

Kick: the tab applies an impulse as `xfrc_applied` on the torso body for 12 physics steps (0.048 s), and the policy sees it only
through the state. Train with random pushes of up to ~60 N for 0.048 s if you want it to recover.

## Getup: an optional second network

```jsonc
"getup": {
  "layers": [ ... ],                       // required, same layer objects as the top level
  "obs": {"spec": [...], "mean": [...], "std": [...]},   // optional, default: the top-level obs block
  "act": {"scale": 2.0, "clip": 1.0},     // optional, default: the top-level act block
  "switch": {"below_up": 0.3, "above_up": 0.9}            // required, 0 <= below_up < above_up <= 1
}
```

`up` is the torso's uprightness, `1 - 2(qx^2 + qy^2)` (1 standing, 0 on its side, -1 on its back). Control starts with the
walking network at reset; before each observation it passes to getup when `up < below_up` and back when
`up > above_up`. The network in control observes with its own `obs` block and maps its action with its own `act`;
`prev_action` is the last action from either network and the phase clock is the top level's. A malformed block refuses
the whole file; a tab that does not know the key runs the walking network alone, so `spec_version` stays 1. Size budget
with two networks: 600 KB. An input a network never saw vary (its normalizer std at the floor, like the command of a
getup network trained without one) is written with a std of 1e9, so whatever the tab sends reaches it as ~0.

## Where the files are

Each universe trains into `<run>/work/train/<universe>/`; its `policy.json` is the newest checkpoint's policy, rewritten
by rename at every checkpoint. The winner the tab loads at home is `<run>/work/home/policy.json`.

## Parity

The trainer's `rollout.py --trace` (Python, branch `demo/d2-train`) runs a policy in C MuJoCo and records qpos, qvel, obs
and action per step; `test/parity.test.ts` replays that trace through `obs.ts`, `policy.ts` and `@mujoco/mujoco`, so the trainer's observation,
the exported weights and the WASM physics are checked against one another.
