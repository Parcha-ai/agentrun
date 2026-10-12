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
| `train_skill.py` | One robot skill for one body (`train-skill`): a skill directory, each checkpoint scored by its test.py |
| `body.py` | A body from any MJCF that keeps the contract: body.json derived, or the body refused with what to fix |
| `skilltest.py` | What a skill's test.py runs on: C-MuJoCo rollouts with the tab's arithmetic |
| `skills/` | The example skills (skill.json, test.py) a thread copies |
| `skill_eval.py` | The skill tests in C MuJoCo, the tab's arithmetic: speed, turn rate, paw up, get-up time |
| `assemble_skills.py` | The done skills, each with the get-up network, as `home/skills/<name>.json` and `home/skills.json` |
| `../policy/assemble-skills.ts` | The same in TypeScript, for a session host with node and no python (equal outputs as JSON) |
| `warm_box.py` | Warms one GPU box for its skill before the start signal (`warm-box`) |
| `universes/skills/` | The take's skill universes the example skills were written from |

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

## Robot skills: a library a thread drives (code mode)

A skill is a directory the thread writes; `skills/<name>/` (walk, sprint, backwards, turn-left, turn-right, spin, wave,
getup) are examples to copy, not a menu:

| File | What |
| --- | --- |
| `skill.json` | name (the page's skill name), label, the fixed command the page sends, `reward_scales` (built-in terms and the skill's own), `env` overrides |
| `reward.py` | optional: `terms(s)`, the skill's own reward terms in JAX over the step state (`creature_env.StepState`) |
| `test.py` | `test(sim)`: does a checkpoint do the skill, on a C-MuJoCo rollout with the tab's arithmetic (`skilltest.py`), and the number the stage shows |

```sh
train-skill --skill-dir skills/crouch --body robot/ --out runs/crouch --init-from ''   # streams checkpoints, stops after 2 passes
train-skill --skill-dir skills/crouch --body robot/ --out runs/crouch --compile-only    # catches reward.py errors in about a minute
train-skill --skill-dir skills/crouch --body robot/ --out runs/crouch --check runs/crouch/policy.json
warm-box walk                                                                        # before the start signal
assemble-skills work/skills --home home                                              # the files the page loads
```

The body is any MJCF that keeps `body.py`'s contract: a root body `torso` with a free joint, a `position` actuator per
trainable hinge with the motors first in the tree, joints on springs after them, a geom named `<leg>_foot` per foot, and a
keyframe `home` whose ctrl holds the standing targets. `body.py` derives body.json (the settled standing pose, each foot's
bottom offset) and refuses a body that breaks the contract or does not stand, saying what to fix. A body without springs
compiles the same training program as before, so prewarmed compile caches still hit.

Each checkpoint gets a line in `skill-progress.jsonl` (passes, metric, steps, seconds; a test that raised is a failing
checkpoint with its error); `policy.json` is the newest passing checkpoint once the run stops. A failed try's skill.json
says why in a `diagnosis`: the metric never moved (the reward gives no gradient from the standing pose), plateaued (and
where), never settles (it swings with no trend: check the body before training longer), was never measured (the skill
never happened at any checkpoint: check the body can do it), was still changing, or test.py raised. Rerunning the same command keeps a skill done for the same body and the
same skill files, and retrains anything else. Exit 0 means the skill passed, 3 that it never did, 2 a refused skill or body.

Measured on an H100 (2026-10-12), from scratch on bodies written with the tab's body library: a dinosaur walks at its
first passing checkpoint in 83 s (3.9M steps), an odd-proportioned hexapod in 276 s (32M); a new skill with a written
reward (crouch) took the dinosaur two tries, the second passing at 202 s (18M). A body from a warm-start family walks in
about 20 s.

A body written as code keeps one compile cache for all its skills (`~/.cache/pda-skill/body-<sha>.tar.gz`, keyed by its
MJCF), so a skill reuses every program an earlier skill compiled for that body. Prewarm it on the box right after the body
is staged, while the thread writes its skill files:

```sh
mkdir -p .warm
setsid nohup train-skill walk --body robot/ --out .warm/walk --init-from '' --compile-only > .warm/walk.log 2>&1 &
```

A skill run started while that prewarm is still compiling waits for it (`skill.waiting-for-compile`, then
`skill.compile-ready`; at most 10 min) instead of compiling the same programs beside it. Measured on the dinosaur (H100,
8 CPU): spin passes at 50.6 to 58.9 s with the body's cache warm, against 73 s with a cold one; the walk's own programs
all hit, and a skill with other `env` settings or its own `reward.py` still compiles its step (spin: 3 programs, 17 s).
Starting a skill from the body's own walk checkpoint (`--init-from`) made it slower, not faster: spin 93 to 99 s, and
crouch did not pass in 40M steps.

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
