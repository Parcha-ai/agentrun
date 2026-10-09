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
| `fixture.py` | Regenerates `../policy/test/fixtures/` |
| `modal_image.py`, `modal_run.py` | The Modal GPU image and a dev runner (sandbox, logs, files home, kill and resume) |
| `jax_compat.py` | Brax 0.14.2 on JAX 0.11 |

```sh
python train.py --mjcf creature.xml --body body.json --universe u1.json --work WORK --minutes 8
with-modal -- python modal_run.py --mjcf creature.xml --body body.json --universe u1.json --out WORK --gpu L40S
python rollout.py --mjcf creature.xml --body body.json --policy WORK/policy.json --seconds 10 --command 0.5
```

A universe file names its reward weights (`REWARD_TERMS` in `creature_env.py`) and any env or PPO overrides:
`{"name": "u3", "reward_scales": {"feet_air_time": 1.0, "trot_clock": 0.5}, "env": {}, "ppo": {}}`.
Running the same command again with the same WORK resumes from the newest complete checkpoint.
