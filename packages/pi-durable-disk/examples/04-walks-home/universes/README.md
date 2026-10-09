# universes: fork fan-out, takeover and collapse

The agent forks itself into N universes. Each universe is a copy of one sealed run, started on a machine of its own,
and trains against its own reward. When a machine is killed, a warm spare takes over that universe's run from its
last checkpoint. At the end the multiverse collapses: one universe (the best score unless one is named) keeps
running and the rest are sealed. The stage (`../show`) draws all of it from this driver's feed.

```
sealed run (tab, VM) ──fork──► runs/<prefix>u1 ─ensureRunning─► machine u1 ┐
                     ──fork──► runs/<prefix>u2 ─ensureRunning─► machine u2 ├─ work/universe/progress.json ─S3─► feed ─► stage
                     ...                                                    ┘
kill u2: power off its machine, revoke its delegation, start runs/<prefix>u2 on spare1 (spare1 takes slot 2)
collapse: the winner keeps running; the others drain, seal run.json and leave their machines
```

- **Fork** is the package's `fork`. It copies a released, sealed run into a new run whose first open is generation 1
  and which refuses a store behind the seal. Forks run one after another, because each one mounts the source
  exclusively. Machines are created while the forks copy, and each universe starts as soon as its fork is done.
- **Start** is the package's `ensureRunning` with a host driver. `Fleet.driver(machine, env)` returns a driver whose
  next start uses a machine the fleet already holds ready. The environment carries the universe (`UNIVERSE_*`) and the
  move that brought it there (`DEMO_SWITCH_*`). The instance admits that move as the env.switch notice before the run
  resumes (03-tab-to-cloud `environment.ts`), so the agent reads "you are now running in Daytona sandbox u3-...; you
  are universe u3 of 4 ...; your reward: ..." in its conversation.
- **Watching** uses only the disk's S3 API, with no mount: `run.json` (status, generation, holder) and
  `work/universe/progress.json`. The workload writes `progress.json` after each checkpoint and runs the claim's
  barrier, so progress never names a checkpoint the disk does not have.
- **Kill** (the stage's `kill` command) reserves a spare at once, so a second kill cannot claim the same one. It
  powers the machine off (no drain), revokes the run's delegation (the holder, if not quite dead, is fenced at its
  next write), shows the dead tile for 700 ms, gives the spare the slot, and starts the run there. The spare's tile
  turns `training` at its first checkpoint. A replacement spare is warmed in the background. A machine that dies
  unasked (driver status `gone`, `stopped` or `failed`, checked every 2 s) is taken over the same way.
- **Collapse** (`collapse`, optional `winner`): each loser's instance drains through its driver (SIGTERM, release,
  seal), then its machine is deleted. Unused spares are deleted. The winner keeps its machine and its run; moving it
  home is the tab's switch.

## Pieces

| File | What |
| --- | --- |
| `multiverse.ts` | The orchestrator: fan-out, polling, kill and takeover, collapse; emits ShowEvents. Host-agnostic: `Fleet` |
| `daytona-fleet.ts` | `Fleet` on Daytona: sandboxes from the runtime snapshot, the universe app installed at warm time |
| `universe-app.ts` | The instance's app (bundled by `build.mjs`): the demo agent, its notice, the trainer |
| `trainer.ts` | A stand-in trainer: steps, checkpoints to `work/universe/`, resumes from the last checkpoint |
| `feed.ts` | The stage's feed: `GET /api/state`, `GET /api/events` (SSE), `POST /api/command`, loopback only |
| `source.ts` | A sealed run to fork, for running this on its own |
| `serve.ts` | The CLI: the feed plus the commands, or `--auto` to play and measure the whole sequence |
| `show/` | The stage's contract, copied from `../show` (types and fold) until the lanes merge |

The feed takes the stage's commands (`kill`), and also `{"t":"fanout"}` and `{"t":"collapse","winner"?}`. Lines are
named `u1`..`uN` for universes and `spare1`.. for spares. A spare that takes over keeps its own id and gets the
universe's slot (`replaces`), and the killed line gets `replacedBy`.

## Run it

```sh
npm install --no-workspaces --ignore-scripts && node build.mjs     # the bundled universe app
with-archil with-daytona node serve.ts --auto --universes 4 --spares 1 --kills 2
with-archil with-daytona node serve.ts --port 8761                 # wait for commands; point the stage at it:
SHOW_API=http://127.0.0.1:8761 node ../show/serve.ts
```

`with-archil` and `with-daytona` stand for whatever puts `ARCHIL_API_KEY`, `PDA_LIVE_DISK`, `PDA_LIVE_REGION`,
`DAYTONA_API_KEY` and `DAYTONA_TARGET` in the environment. Every resource is recorded in `--ledger` before it is
created and closed when it is deleted. At exit, everything the run made is deleted, unless you pass `--keep`.

## Check it

`npm test` runs the multiverse against a scripted disk and fleet. It covers what the stage folds through a fan-out,
a kill (the reserved spare, the 700 ms hold, the slot handover, the stays), a second kill, and the collapse. It also
checks the feed's replay rules.
