# Tab app: the creature sketcher, the simulation, the policy, the memory

A page you sketch a creature in, that simulates it with MuJoCo (WASM), runs a trained policy offline, lets you kick it,
and opens the creature's own SQLite memory. It is embedded by the show page as a same-origin iframe.

```sh
npm install --no-workspaces --ignore-scripts     # its own deps: @mujoco/mujoco (pinned), three, sql.js, esbuild
node build.mjs                                    # dist/ (page, vendor/ with the wasm files, versions.json)
node scripts/serve.mjs 8795                       # dist/ with COOP/COEP/CORP headers
npm test                                          # node, real MuJoCo WASM: physics, policy refusals, SQLite, CLI
npm run typecheck
CDP_PORT=9333 npm run check:browser -- <outdir>   # drives the page in Chrome, screenshots
CDP_PORT=9333 node scripts/check-embed.mjs <outdir>   # the page inside a parent that answers storage
```

WebGL: the page needs it. A headless Chrome without a GPU needs `--use-gl=angle --use-angle=swiftshader
--enable-unsafe-swiftshader`.

## The v2 take: draw, learn live, walk home, offline
`/?clean=1` is the show's mode: the creature and one label, nothing else (no header, HUD, toolbar or toasts).
- **Untrained start.** No policy is installed: the creature stands for half a second as it was drawn, then its brain starts (random smoothed actions, `src/untrained.ts`, seeded) and it falls over and flops. The label says `untrained`. `?dummy=1` starts with the old demo trot instead (for the older checks).
- **Phases.** `draw` (default): the sketcher on the left (half the width, drawn bold so a still of a drawing in progress reads; the first stroke posts `draw-started` once, so the stage can drop its "draw a creature" prompt), the creature on the right (the start post and trail are not drawn yet); every stroke rebuilds the creature (it stands and flops again) and the design is saved to the disk (`creature/creature.xml`, `body.json`, `designs.sqlite`) 1.5 s after the pen rests, or at once on `__walks.commitDesign()`. `watch`: the sketcher is gone and the creature fills the pane. It goes to `watch` on the message `set-phase {phase:"watch"}` or when the first checkpoint installs; `?phase=watch` starts there.
- **Live checkpoints.** The page polls `train/gpu/policy.json` (a run in progress; `?checkpoints=<path>` to change it) and `home/policy.json` (the final file) at 1 Hz through the embedding page. Each new file for this body installs without a reset; if the creature is lying down and the file has no getup network it is set back on its feet and the page posts `stood-up`. The label reads `learning: version N` (the trainer's own `provenance.checkpoint` when the file has it, otherwise the count of installs) and `trained` for the final file.
- **Motion you can see in a still (clean mode, `watch` phase).** The floor carries a 1 m grid (dark lines, faint 0.25 m lines) and a blue post and ring mark where the current version started; a faint trail of dots follows the creature. A large number at the top right (a dark pill with a small "walked since this version started" under it, clear of the stage's caption band at the bottom) reads the metres walked since that version started (straight-line distance on the ground from the spot where the version was installed, or where the creature was reset or rebuilt; it starts over for every new version). A corner thumbnail captioned "your drawing" shows the creature as drawn (top view, the sketch's colours and a foot at each leg end) for the whole take.
- **`?banner=1`.** The page around the tab shows its own home banner and final label, so the tab hides its `offline` badge and the `trained` label. `untrained`, `learning: version N`, the distance pill and the thumbnail stay. The tab still posts `network {online}` and tracks `offline` in its state.
- **Events (tab to shell).** `draw-started` (once, at the first stroke or an applied design), `walk-meter {t, metres, version, state}` about once per simulated second while a policy runs (`metres` is the same distance as the pill; `t` simulated seconds; `version` the checkpoint number, 0 untrained), `untrained`, `policy-arrived` (adds `kind`, `checkpoint_n`, `steps`, `wall_s`, `reported_walk_10s_m`, `stood_up`), `checkpoint-installed`, `policy-walked` (one per install; `partial: true` and the real `window_seconds` when the next install cut it short), `stood-up`, `phase`, `network {online}`, `policy-refused`. `window.__walks.state()` returns `{state, checkpoint_n, steps, wall_s, reported_walk_10s_m, final, offline, mode, phase, mjcf_sha256, policy, distance_m}`.
- **Offline.** After a policy is installed nothing needs the network: policy, physics, render and kicks are local. The watchers' disk reads fail quietly; the page shows an `offline` badge and posts `network {online:false}`.
- **Drive it.** `__walks.kick([1, 0], 350)` (heading frame, forward), `__walks.applyDesign(design)`, `__walks.commitDesign()`.
- **Check it.** `CDP_PORT=9333 CP1=<walk-only 3-DOF policy> CP2=<3-DOF walk+getup policy> FINAL=<final policy> node scripts/check-v2.mjs <outdir>` runs the whole take in a real page: untrained and flopping, two checkpoints, the final file, then the network off with a kick.

## Before the shoot: performance, soak, policy checks
All need a Chrome with CDP on `CDP_PORT` (a software-GL one: `--use-gl=angle --use-angle=swiftshader --enable-unsafe-swiftshader`).
```sh
CDP_PORT=9333 THROTTLE=4 PHASE_S=15 [LITE=1] node scripts/perf.mjs          # fps, control steps/s, real-time factor, heap; walking and getup phases
CDP_PORT=9333 THROTTLE=4 SOAK_MIN=30 POLICY=policy.json OUT=dir node scripts/soak.mjs   # random 60-400 N kicks every 20-40 s; NaN, resets, heap
AFTER=8 [FORCES=200,300,400,600] node scripts/kick-sweep.ts policy.json    # acceptance: `up` from every side at >= 100 N
node scripts/getup-time.ts policy.json                                      # seconds to get up from the left side, right side, back
DESIGN=design.json node scripts/walk-check.ts policy.json                   # flat-ground speed along the heading at commands 0.2/0.5/0.8 (DESIGN= for a body that is not a preset; works with kick-sweep and getup-time too)
DESIGN=design.json POLICY=policy.json CDP_PORT=9333 node scripts/check-body.mjs   # the real page with that body and policy: loads, walks, gets up after 400 N
node scripts/parity.ts policy.json trace.json [creature.xml]                # the trainer's trace through the tab's code
POLICY=policy.json W=700 H=500 CDP_PORT=9333 node scripts/check-browser.mjs dir   # the page itself: walk, kicks, hard kick, getup mode
```
`window.__walks.stats()` returns the page's counters (frames, steps, falls, getups, recoveries, kicks, nan, resetsSeen) and
p50/p95/max of the frame interval and of the time spent in physics and in draw per frame. Load the page as `/?lite=1` on a
machine that rasterises in software: cheaper materials and no multisampling.

## Pieces
| file | what |
| --- | --- |
| `src/design.ts` | the design document, its limits and validation (2 or 3 leg pairs, mirrored; `legDof` 2 or 3), presets |
| `src/dummy.ts`, `src/bodies.ts` | the stand-in trot policy; which preset body a policy's `mjcf_sha256` names (the page switches to it) |
| `src/mjcf.ts` | design to MJCF; the only MJCF generator, node-runnable; joint order, gains, stand pose, keyframe `home` |
| `src/sim.ts` | `Sim`: reset to `home`, a policy step = 5 physics steps, kick = force for 12 steps |
| `src/policy.ts`, `src/obs.ts` | `mlp-v1` policy runner (owned by the trainer lane; see `POLICY-FORMAT.md`) |
| `src/sketch.ts`, `src/render.ts`, `src/main.ts` | sketcher canvas, three.js view, the page |
| `src/rules.ts` | what the sketcher tells the user about a body: the leg-reach clamp (1.5x the torso) and the per-body notes, from measurements |
| `src/untrained.ts` | the untrained brain: seeded random smoothed actions, a stand-in for a policy that has learned nothing |
| `src/stats.ts` | frame and event counters kept by the page for the checks above |
| `src/store.ts`, `src/backend.ts` | SQLite (sql.js) with one writer per file; backends: IndexedDB, or the parent page (the disk) |
| `MEMORY_SCHEMA` in `src/store.ts`, `scripts/record-machine.mjs` | the agent's side: append "I am now on machine X" to `memory.sqlite` |

## Memory: two files, one writer each
- `creature/designs.sqlite`: bodies the creature was given. Written by the tab.
- `creature/memory.sqlite`: the machines it has run on. Written by the agent (`scripts/record-machine.mjs`, Node 22.13+,
  or any SQLite using `MEMORY_SCHEMA` from `src/store.ts`). The tab only reads it, and re-reads it each time the memory view opens, so
  neither side can overwrite the other's rows.
Embedded, both are reached through the parent with postMessage. Standing alone, they live in IndexedDB and the header says
"this browser only (not on the disk)".

## Messages with the embedding page (`{ns: "walks-home", type, ...}`, same origin only)
- tab to parent: `ready`, `design-saved`, `policy-loaded`, `kicked`, `fell`, `stood`, `memory-opened`, and the storage
  requests `storage-read {id, path}` and `storage-write {id, path, bytes}`.
- parent to tab: `set-placement {kind, label, since}`, `kick {dir, force_n}`, `open-memory`, `load-policy {url}`,
  `load-design {design}`, and the storage answers `storage-result {id, bytes|null}` and `storage-written {id, error?}` (sent only
  after the disk has the bytes; an unanswered write is reported as an error; `error: "not-holder"` means another machine holds
  the run, so the tab is a viewer: it keeps the design locally and sends `design-request {design, mjcf_sha256}` for the
  agent to save). `load-world {world}` swaps the terrain fragment `{asset, geoms}` (null for flat ground).
