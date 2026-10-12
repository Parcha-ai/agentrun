# train: teach the tab's creature to walk

One universe = one PPO run on one GPU against one reward hypothesis. The body is the tab's MJCF byte for byte
(`tab/src/mjcf.ts`), the observation is `policy/obs.ts`'s, and the result is an mlp-v1 `policy.json` the tab runs in
`@mujoco/mujoco` (see `../policy/POLICY-FORMAT.md`).

| File | What |
| --- | --- |
| `creature_env.py` | MJX walk task: the mlp-v1 observation, named reward terms, pushes like the tab's kick |
| `train.py` | One universe: Brax PPO, checkpoints and the current `policy.json` in WORK, resumable after a kill |
| `export.py` | Brax params to `policy.json`; a numpy runner with the tab's arithmetic |
| `rollout.py` | A `policy.json` in C MuJoCo as the tab runs it: score (metres in 10 s) and parity traces |
| `fixture.py` | Regenerates the policy runtime's parity fixture (`policy/test/fixtures/` on the policy branch) |
| `universes/` | `u1..u8.json`: the eight reward hypotheses (push-trained walkers); `getup.json`: the getup universe |
| `default/` | The tab's default 3-DOF creature and its trained getup network, for a run with no creature of its own |
| `modal_image.py`, `modal_run.py` | The Modal GPU image and a dev runner (sandbox, logs, files home, kill and resume) |
| `jax_compat.py` | Brax 0.14.2 on JAX 0.11 |
| `train_skill.py` | One robot skill for one body (`train-skill`): warm-started, each checkpoint scored by the skill's own test |
| `skill_eval.py` | The skill tests in C MuJoCo, the tab's arithmetic: speed, turn rate, paw up, get-up time |
| `assemble_skills.py` | The done skills, each with the get-up network, as `home/skills/<name>.json` and `home/skills.json` |
| `../policy/assemble-skills.ts` | The same in TypeScript, for a session host with node and no python (equal outputs as JSON) |
| `warm_box.py` | Warms one GPU box for its skill before the start signal (`warm-box`) |
| `universes/skills/` | One file per skill: its reward weights and env overrides (sprint, backwards, turns, spin, wave) |

```sh
python train.py --mjcf creature.xml --body body.json --universe u1.json --work WORK --minutes 8
with-modal -- python modal_run.py --mjcf creature.xml --body body.json --universe u1.json --out WORK --gpu L40S
python rollout.py --mjcf creature.xml --body body.json --policy WORK/policy.json --seconds 10 --command 0.5
```

A show run: u1..u8 train on a generated terrain (`terrain.py --seed N`) and are scored on the held-out course
(`terrain.py --course --seed 1000`, metres along it in 20 s); the getup universe trains once per body. The winner and the
getup network become one file for the tab: `python export.py combine WINNER/policy.json GETUP/policy.json --out
home/policy.json`. The XLA and Warp compile caches travel in a tarball (`--compile-cache PATH`, ~10 MB) and the image
carries a prewarmed one for the default creature, so a fresh box reaches its first checkpoint in tens of seconds.

A universe file names its reward weights (`REWARD_TERMS` in `creature_env.py`) and any env or PPO overrides:
`{"name": "u3", "reward_scales": {"feet_air_time": 1.0, "trot_clock": 0.5}, "env": {}, "ppo": {}}`.
Running the same command again with the same WORK resumes from the newest complete checkpoint.

## The on-camera learning curve (DEMO-V2)

The agent trains the sketched creature on an H100 while the tab installs each checkpoint live. Two runs share the GPU:
a walker at 512 parallel envs with an early checkpoint schedule (one checkpoint per million steps lands about every 7 s,
so the stages are visible: it stands, shuffles, takes its first steps, walks), and a getup network beside it. They meet
in one file at come-home. The exact lines (and the matching `--compile-only` warm-up) are `TAKE_WALK`/`TAKE_GETUP` in
`modal_image.py`; the first schedule point, `--num-envs`, the universe and `--world` shape the compiled program, so a
warm-up must pass the same ones.

## Robot skills (the cluster beat)

Eight threads, each on its own GPU, teach one robot one skill each: walk, sprint, backwards, turn-left, turn-right, spin,
wave, getup. Every thread runs the same program:

```sh
warm-box walk                                             # before the start signal
train-skill walk --body robot.json --out work/skills/walk # streams checkpoints, stops after 2 passing in a row
assemble-skills work/skills --home home                   # after the threads: the files the page loads
```

`train-skill` builds the body with the tab's own `buildMjcf`, so each policy's `mjcf_sha256` matches the page, and
warm-starts from the image's checkpoint for the body's joint count. Each checkpoint gets a line in
`skill-progress.jsonl`: the skill's test result and one `metric` (name, value, unit, target) for the stage's tile.
Running the same command again keeps a skill that's done for the same body and retrains one done for another body.
Exit 0 means the skill passed, 3 means it never did and 2 means the body is invalid.

A compile cache serves only the GPU hosts it was built on. jax keys its cache on the GPU's XLA topology fingerprint,
which changes with the driver, and the driver keeps its own JIT cache (`~/.nv`). `warm-box SKILL` compiles the
skill for the default body into the cache `train-skill` reads. If the image's cache misses on this host, it also
compiles every preset body. It prints the driver, the fingerprint and whether the host hit, so the first checkpoint
arrives in the same time on any host.

### The GPU box contract

A thread's box runs the cluster image. On every box:

| Path or command | What |
| --- | --- |
| `train-skill`, `warm-box`, `assemble-skills` | `train_skill.py`, `warm_box.py`, `assemble_skills.py` on `PATH` |
| `/opt/pda/train/` | this directory, with `default/` the default body |
| `/opt/pda/mjcf/build.ts` | the tab's `buildMjcf`: a robot's design to `creature.xml` and `body.json` |
| `/opt/pda/init/<n>j/` | one trained warm-start checkpoint per joint count (`--init-from auto` picks it) |
| `/opt/pda/presets/<name>/` | the page's preset bodies, which `warm-box` compiles for on a host the cache misses |
| `/opt/pda/cache/compile-cache.tar.gz` | every skill's program for the default and preset bodies, on the GPU hosts it was built on |

The thread runs `train-skill <skill> --body /workspace/robot.json --out /workspace/skills/<skill>`. Its stdout is one
JSON line per event: `skill.start`, `skill.checkpoint` (with the skill's `metric`) and `skill.done`. The files that
need to come home are `skill.json`, `skill-progress.jsonl`, `policy.json` and `checkpoints/`. `work/` (the trainer's
own state) and `body/` can stay on the box. After the threads, the session host runs
`node ../policy/assemble-skills.ts <run>/work/skills --home <run>/work/home`.
