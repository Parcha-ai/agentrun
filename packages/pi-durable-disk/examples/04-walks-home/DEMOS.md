# The walks-home demos: what we built, how to run them, what we learned

This is the record of the demo program built on `pi-durable-disk` between 2026-10-06 and 2026-10-14, on the branch
`demo/walks-home` (266 merged PRs, #60 to #459). The demos are tabled as of 2026-10-14. Read this before you rerun one,
build on one, or start the next: it says what each demo shows, how to start and stop it, what it costs, where its code
and evidence live, and what we learned the hard way.

Paths in this file:
- `ex/` is `packages/pi-durable-disk/examples/` in this repository.
- `~/evals/agentrun-archil-tl/...` and `~/tmp-*` are on the demo box (the operator's machine). They hold runbooks,
  scripts, recordings and evidence that never went into this repository.
- Docs pages are named by their file name on the team's docs site (tailnet only).
- People are named by role: Miguel (owner), the lead (agentrun-archil-tl), and the lanes D0 to D5, browser-demo,
  gg-onemore and steer-any.

## Contents

1. [What pi-durable-disk is, and why these demos exist](#1-what-pi-durable-disk-is-and-why-these-demos-exist)
2. [The pieces, and how a turn flows](#2-the-pieces-and-how-a-turn-flows)
3. [Before you run anything](#3-before-you-run-anything)
4. [Demo A: the robot (tab, GPU cluster, home, offline)](#4-demo-a-the-robot-tab-gpu-cluster-home-offline)
5. [Demo B: Golden Gate chat](#5-demo-b-golden-gate-chat)
6. [Demo C: obsessed with any topic](#6-demo-c-obsessed-with-any-topic)
7. [Everything else we built](#7-everything-else-we-built)
8. [Lessons learned](#8-lessons-learned)
9. [Miguel's rulings](#9-miguels-rulings)
10. [Tabled, and next ideas](#10-tabled-and-next-ideas)
11. [Where things live](#11-where-things-live)

---

## 1. What pi-durable-disk is, and why these demos exist

`pi-durable-disk` makes a pi agent session durable on a shared disk (Archil). The session's transcript is a SQLite store
under `runs/<id>/store/`, its workspace is `runs/<id>/work/`, and exactly one host writes at a time: a lease plus a
fence on the disk, so a host that lost its claim fails at its next commit instead of writing over the new owner. Any
host that can claim the run can open the same session and continue it: a VM, a sandbox, a laptop, or a browser tab
through a pipe that holds the claim on the tab's behalf. A move is a planned handover (finish the step, release, claim,
resume), and an unplanned loss (a killed host, a closed tab) is just a later claim by someone else.

The demos exist to show that one property in a way people feel: one agent session whose computer moves. It starts in a
browser tab, moves itself to a Modal VM when the work needs one, fans its tools out to GPU boxes, and comes home to the
tab, the same conversation the whole way. Every beat after that (the robot that learns to walk on a cluster of H100s,
the agent that turns a 27B model into the Golden Gate Bridge and then switches its own brain onto it, the model that
becomes obsessed with any topic you name) is that one session doing more interesting work in more places.

---

## 2. The pieces, and how a turn flows

| Piece | Where | What it does |
|---|---|---|
| The tab page | `ex/03-tab-to-cloud/tab/`, robot pane `ex/04-walks-home/tab/` | The agent's own page: pi-durable's Harness runs as page JavaScript, a Wasmer computer (bash, node) runs its tools, the chat shows every tool call (diffs with `@pierre/diffs`, the workspace tree with `@pierre/trees`), the robot pane runs MuJoCo WASM. Offline it keeps the run in OPFS SQLite and answers with a 0.8B model in wllama |
| The 03 server | `ex/03-tab-to-cloud/serve.ts`, `pipe/` | Holds the run's claim for the tab and proxies every Storage call (a commit is answered after fsync on the mount), writes the tab's workspace through, proxies model calls with a per-run budget, places each line (Jev), and runs the switch protocol with an `env.switch` notice the agent reads once per move |
| The launchers | `ex/04-walks-home/vm/scripts/live.mjs`, `show/scripts/take-server.mjs`, `gg-onemore/chat/live-gg.mjs` | Start the server, the GPU pool or box, the stage, and print the run's link once |
| The Modal VM | `ex/04-walks-home/vm/` (`modalHost` from the package) | Mounts the disk itself (Modal's VM runtime has `/dev/fuse` and a durable fsync) and runs the same agent module (`pi-durable-disk run --app cloud-app.ts`). Model calls go back through a link to the box's broker, so no model key reaches the VM |
| Robot GPU boxes | `ex/04-walks-home/train/`, `cluster/`, `vm/gpu-pool.ts` | Modal H100 sandboxes (gVisor) with the trainer image (MJX + Brax PPO). A thread's tools run there through `RemoteEnv` over Modal exec; `ArtifactSync` mirrors `runs/<skill>/` back to the session's host |
| The model-surgery box | `ex/04-walks-home/gg-onemore/` | 2x H100 on Modal. GPU 0: the lab (Qwen3.5-27B in transformers, Qwen-Scope SAEs, a library on a unix socket). GPU 1: vLLM with the clamp worker extension, on a root-only socket. `box/guard.py` on :8000 is the only door from the tunnel. The agent's own Python runs as the unprivileged `agent` user with no network |
| Jev (TypeSafe System One) | `vm/placer.ts`, `03-tab-to-cloud/placement.ts`, `gg-onemore/chat/gg-placer.ts`, `pipeline/jev.py` | Typed judgments in 100-300 ms for fractions of a cent: where each line runs, which brain answers, whether a sentence is dark, whether the user is pushing back, which draft to show, how obsessed a reply is, which config is funnier |
| The disk and the run store | Archil, `runs/<id>/` | `store/run.sqlite` holds every conversation, including each GPU thread's own child conversation; viewers render from the store, not from a side channel |
| The model broker | the demo box, `127.0.0.1:9421` | Serves gpt-6-sol, gpt-6-luna and claude-opus-5.5 to the server; keys stay on the box |

### A robot turn

1. You type "teach it to walk, spin and wave" into the tab's composer. The server asks Jev where the line belongs (the
   tab or the Modal VM), with the facts it needs (which skills are taught, the agent's model). The chat shows
   `→ Modal VM · Jev 0.90` before anything moves.
2. The tab finishes its step. The pipe releases the claim (barrier, seal `run.json`), the supervisor starts the agent on
   the VM, which mounts the disk and admits one `env.switch` notice before its Harness resumes. 3 to 9 s.
3. On the VM the agent calls `teach_skills` with its own plan (`[{ name, brief }]`, at most 8). One commit forks one child
   conversation per skill, each owned by a Thread task. The parent waits on them with a durable `allSettled` join.
4. Each Thread task acquires a GPU box, and its child conversation runs `read`, `write`, `edit` and `bash` on that box
   through `RemoteEnv`. The thread copies a library skill, runs `pi-run <skill> -- train-skill ...`, and the trainer
   writes `runs/<skill>/skill.json`. The thread's status is read from that file, never from the thread's words.
5. When all threads settle, `assemble` puts the skills under `home/`, the fold writes one line per thread, Jev is asked
   again, and the run moves home: the tab reattaches, restores `work/` from a manifest in 1 MiB chunks, the robot pane
   loads the new skills, and the server checks what came home itself ("3 skills are home and installed: spin, walk,
   wave").

### A Golden Gate turn

1. The page places your line (Jev) on the VM. The agent calls `lab_read` (the reading list and every skill the box
   ships land in its workspace) and then `lab_run`, which sends its own Python to the guard's `POST /gg/run`.
2. The guard runs it as `agent` through `python3 -I box/nonet.py` (a seccomp filter that fails `socket()` for anything but
   unix sockets). The program imports `gpulab`, which talks to the lab's library on `/run/gg-lib/lab.sock`: features,
   contexts, sample with a clamp, grade and rank with Jev, serve.
3. `serve` checks the clamp and writes it into the vLLM server's clamp buffers. `use_model` then configures the agent's
   own conversation onto the steered provider. The edited model sees only the turns since the switch (`sinceSwitch`): no
   system prompt, no tools.
4. Each later request goes through the guard to vLLM. The guard asks Jev before the turn whether you are pushing back
   (if so, three drafts and a Jev pick), streams the thinking and the answer sentence by sentence, and holds each one
   until Jev clears it of dark content.

---

## 3. Before you run anything

- **Node 22** (`nvm use 22`). The test globs and the launchers assume it.
- **Keys only through wrappers.** On the demo box: `~/evals/agentrun-archil-tl/bin/with-{archil,modal,typesafe,openai}`.
  Model calls go through the box's broker. Nothing prints a key, and the launchers refuse to start without the TypeSafe
  key: there is no fallback judge (section 8.2).
- **A run's link carries its secret** after `#`. Anyone with the link can take the run over. Never paste it anywhere,
  including PRs, docs pages and chat.
- **Open the page on `127.0.0.1`** through an SSH tunnel, never the box's address: only localhost is a secure context,
  and the page needs one (Wasmer's `SharedArrayBuffer`, OPFS).
- **Every stop ends at zero.** Each stop script prints the Modal sandbox count last, and anything above 0 is money
  running. Idle stops and reapers exist so a forgotten box costs at most minutes (section 8.6).
- **A fresh checkout** needs, from the repository root:

  ```sh
  npm ci && npm run build
  E=packages/pi-durable-disk/examples
  (cd $E/03-tab-to-cloud && npm install --no-workspaces --ignore-scripts \
    && (cd ../04-walks-home/tab && npm ci --ignore-scripts) && npm run build && node tab/build.mjs --fetch)
  (cd $E/04-walks-home/vm && npm ci)            # the Modal VM's cloud module
  (cd $E/04-walks-home/gg-onemore && npm ci)    # Golden Gate and any-topic pages
  (cd $E/04-walks-home/show && npm ci)          # the robot stage (its build needs @fontsource/inter)
  ```

  `node tab/build.mjs --fetch` downloads the tab computer's 78 MB `edgejs.webc`. Without it the page hangs on "loading
  the computer" forever; the robot start script refuses to start when the file is missing or under 70 MB.

| Port | What |
|---|---|
| 8763 | the robot demo's agent page (the only port the robot needs) |
| 8764 | the robot stage window (optional) |
| 8773 | the Golden Gate chat page |
| 8783 | the any-topic page |

---

## 4. Demo A: the robot (tab, GPU cluster, home, offline)

### What it shows

You ask for a robot in a browser tab. The agent writes it as code, a dinosaur stands on a floor with an orange flag 3 m
ahead, and when you ask it to walk to the flag it tries and stumbles: it has legs and no idea how to use them. You ask
it to learn. The session moves itself to a Modal VM, plans the skills from your words, and forks one thread per skill;
each thread writes and runs its own training on its own H100, and you watch all of them in the chat. The skills come
home, and the same line ("walk to the flag") now walks it there. Then you take it offline: Wi-Fi off, and a 0.8B model in
the page keeps driving the robot by tool calls.

The moments that land:
- The untrained try: "Not learned yet: the robot tried to walk and stumbled 0.5 m in 4 s and stayed up; the flag is
  still 2.6 m away."
- The thread rows: "GPU 1 walk", "GPU 2 spin", "GPU 3 wave", each with its brief, its one command and the trainer's
  checkpoints streaming ("speed has to reach 0.4 m/s... 0, 0.06, 0.2... there, 0.49, it passes").
- The result card: "✓ walk · speed 0.49 m/s ≥ 0.4 · checkpoint 5 · 97 s", then `← your browser` and "Back in your
  browser. Try: walk to the flag."
- The reach: "It reached the flag in 5.1 s."
- Offline: "paint its legs red" answered by the model in the page with no network: "The legs are now red. Looks only:
  the walking brain still fits."

### Show order (rehearsed as `code12`, 441 s from the first line to the last agent line)

| You type | What the room sees | Measured |
|---|---|---|
| `make me a dinosaur robot` | the agent reads its example, writes `robot/body.mjs` (diffs in the chat), `build_robot`; a dino by the flag | 23.7 s (Jev: tab 0.85) |
| `walk to the flag` | stays in the tab (Jev 0.95), `do walk`, the stumble | 11 s |
| `teach it to walk, spin and wave` | `→ Modal VM · Jev 0.90`; three thread rows; result card; `← your browser` | teach call 134 s, closing line 162.7 s |
| `walk to the flag` | it walks to the flag, the flag lights up | 12.7 s (tab 0.99) |
| `now make it spin` | `do spin` | 5.4 s |
| `make its tail longer and turn it blue` | an edit to `robot/body.mjs`, a rebuild, "its brain no longer fits this body" | 30 s |
| `go learn your new body` | VM again (0.92), same threads and boxes, home | teach call 138 s |
| click the offline toggle, cut Wi-Fi | "Checked out to this browser", the bar reads `LLM: Qwen3.5 0.8B` | checkout 3.7-9.4 s, model ready 5-8 s later |
| `paint its legs red`, `call it Rex`, `what color are its legs?`, `make it spin` | each answered in the page, tools run locally | 20-31 s a turn (0.8B on CPU) |
| `make it twice as big` | refused: "this robot is built from code (robot/body.mjs), so its size, legs and shape change by editing that file" | 28 s |
| Wi-Fi on, click the toggle | back to the server, `LLM: <cloud model>` | 2.7-5.4 s |

The one quiet stretch is about a minute after the threads start: each GPU compiles the body the agent just wrote into a
physics program (about 37 s), then about 20 s to the first checkpoint. Talk over it, and click open the other thread
rows so the room sees all of them working.

Optional lines (headless smoke on 2026-10-13): "go to the modal vm" moves and stays (Jev 0.97, bar flips at 4.1 s);
"come back to my browser" (0.99, 7.7 s); "what model are you?" answers with the model the bar shows.

Asks that work on the dino (training seconds on the v16 image with the prewarm): walk about 88 s, spin 50-73 s, wave
about 60 s, turns and backwards 58-67 s, sprint 76 s; sit and bow are skills a thread writes itself from the library's
wave (36-41 s to pass). Asks to leave off stage: get up after a fall, rear up, wag its tail, nod its head. The dino's
motors are all on one axis and its tail and neck are passive springs, so these cannot be learned; the agent answers each
in one sentence and offers something else (#287, #292). A robot dog works since #300 (walk 61 s, spin 57 s, sit 32 s on
H100s) but the dinosaur is the body rehearsed end to end.

### Run it

The operator's start and stop scripts live on the demo box, not in this repo:
`~/evals/agentrun-archil-tl/demo/d4-take/start-live-robot.sh` and `stop-live-robot.sh`. The runbooks there are
`LIVE-CODE-MODE.md` (every line, offline, troubleshooting) and `SHOW-ORDER.md`.

```sh
# on the demo box, in a worktree of demo/walks-home (pool of 4 = up to 3 skills plus a spare; 8 for eight skills)
ROBOT_WORKTREE=<worktree> ROBOT_IMAGE=<v16 training image> ROBOT_PLAN=1 ROBOT_PREWARM=1 \
  bash ~/evals/agentrun-archil-tl/demo/d4-take/start-live-robot.sh browser 4
grep -E "LIVE: (open|reach|then)" ~/tmp-d4take/live-robot.log      # the link (secret after #) and the tunnel line
tail -f ~/tmp-d4take/live-robot.log                                  # wait for "ready: N of N GPU boxes"

# on your laptop, left running (it reconnects after a Wi-Fi cut)
while true; do ssh -N -o ServerAliveInterval=5 -o ExitOnForwardFailure=yes -L 8763:127.0.0.1:8763 <user>@<demo box>; sleep 2; done

# stop: the last line must read "sandboxes: 0"
bash ~/evals/agentrun-archil-tl/demo/d4-take/stop-live-robot.sh
```

What the script does, so it can be rebuilt from this repo: it refuses without the TypeSafe key, checks the wllama
jspi32 build against its `SHA256SUMS` (without it the offline brain prefills for about 96 s instead of restoring its
warm state), runs any missing installs and the builds (packages, the 03 page, the creature tab, the stage), checks
`edgejs.webc`, exports `DEMO_MODELS_DIR` (the v5 brain's parts, served under `/models/`), and then, from
`ex/04-walks-home/vm`:

```sh
node scripts/live.mjs --episode robot --agent-model claude-opus-5.5 \
  --cluster-size 4 --cluster-image <image> --cluster-ready 'warm-box {skill} --presets /dev/null' \
  --cluster-ready-timeout-s 480 --placer jev --port 8764 --ttl 40 \
  --robot-plan --robot-prewarm --robot-thread-deadline-s 300 --tab browser --server-port 8763
```

Read this before going live:
- Start 15 minutes ahead. Boxes start when the page attaches, and Modal can take 7-9 minutes to place H100s when it is
  short of capacity. Wait for `ready: N of N GPU boxes` before the teaching line, or the threads queue for boxes.
- Leave the page online and idle until its badge reads "529 of 529 MB": that is the offline brain being kept in the
  browser. Do the first download at home, not on stage.
- Keep the page in a window of its own that stays visible. A hidden page is throttled and the move home fails with "your
  browser did not attach".
- Keep the same port and the same browser profile all the way through. The browser ties the page's files to
  `http://127.0.0.1:8763`; another port or profile is an empty browser.
- Don't type two lines within a second, and don't refresh on purpose. A refresh mid-turn is survivable since #317 and
  #320 (the run is held about 10 s for the returning page), but it is dead air.

The rehearsals `code1` to `code12` ran gpt-6-sol as the cloud agent. Since #374 the default is Claude Opus 5.5 with
thinking high through the broker; `ROBOT_AGENT_MODEL` overrides it.

Cost: about $0.07 per box per minute. The 3-skill show is about $2.1 for the robot. Eight skills on eight H100s plus the
spare is about $0.6 a minute, about $5 for a full run.

### Where the code is

| Path | What |
|---|---|
| `ex/04-walks-home/body/` | the robot as code: `lib.mjs` (spec to MJCF), `build.mjs`, `dino.example.mjs`, `dog.example.mjs`, tags the offline tools address |
| `ex/04-walks-home/cluster/` | `teach-skills.ts` (plan, fork, boxes, durable `allSettled`, fold, `threadsOf`), the SOPs `sop/robot.md`, `teach.md`, `train-skill.md`, and the spike that SIGKILLs the host mid-wait and resumes |
| `ex/04-walks-home/train/` | the trainer library on the image (`train-skill`, `warm-box`, `assemble_skills.py`, the skill library) |
| `ex/04-walks-home/vm/` | Modal VM host, `gpu-pool.ts`, `placer.ts`, `scripts/live.mjs`, `scripts/placer-probe.mts` |
| `ex/04-walks-home/tab/` | the creature page (MuJoCo WASM, policy runner, hot reload of `robot/body.json`) |
| `ex/04-walks-home/show/` | the stage window, captions with provenance tags, `publishable.ts` (no leaks), `zero-loss.ts` (read-back only) |
| `ex/03-tab-to-cloud/` | `robot-sop.ts`, `build-robot.ts`, `flag-goal.ts`, `placement.ts`, `tab/chat-view.ts`, `tab/code-view.ts`, `tab/threads.ts`, `tab/v5-brain.ts`, `offline-tools.ts` |

The offline brain is v5: Qwen3.5-0.8B fine-tuned by D1 on robot tool calls (served as "V5T": v5's weights with a 16-tag
prompt and a per-body grammar lock), 529 MB, run by wllama in the page. It won both blind sets it was entered in, each
written and run by another lane (section 8.4).

### Evidence and proof

- Rehearsals `code1` to `code12` (2026-10-12), each with frames and a log on the demo box
  (`~/evals/agentrun-archil-tl/demo/code{5,7,10,11,12}-frames/`, `~/tmp-d4take/robot-code*.log`), and headless
  `smoke1` (2026-10-13) for the top bar and the move asks. Every rehearsal log greps zero `model: "scripted"` placements.
- `code7`, `code10`, `code11`, `code12`: the five lines plus the offline beat, Modal at 0 afterwards.
- Miguel ran the practice pass himself on 2026-10-13; his three asks became #343 (the top bar), #339 (it moves when
  asked) and #338 (it names its model).

### Rough edges left

- Not proven: a real Wi-Fi cut on a laptop (rehearsals emulated it over CDP), the first 529 MB over a home uplink, eight
  code-mode skills at once, Miguel's own laptop and tunnel end to end.
- The VM was replaced mid-teach once (`code11`, 55 s of dead air). #327 and #328 log the lease's heartbeat and a VM trail
  so the next one is explained; it did not recur in `code12`.
- "teach it to wag its tail" is still placed on the VM (0.93), so the agent travels there and back (about 9 s) to say one
  sentence.
- The phone page (`?phone=1`, iPhone Safari) works but was taken off the demo path: first ready 55 s, turns slow.

---

## 5. Demo B: Golden Gate chat

### What it shows

You chat with the agent on its own page and ask it to recreate Anthropic's Golden Gate Claude on the Qwen3.5-27B on its
GPU box. It reads Anthropic's paper and note and an open Qwen replication, then writes and runs its own experiments: it
looks for the bridge among the SAE features, finds that no single feature is the bridge, composes several parts, clamps
them on every token at inference (thinking included), has Jev judge every reply, and ranks its strengths against the
shipped recipe. Before it switches it shows you the same question answered by the unedited model and by its edit. Then
it switches its own brain onto the edited model (`use_model`); the header turns `LLM: Qwen3.5-27B (Golden Gate edit)`,
and you talk to it. The edited model gets no tools and no instructions. Nothing tells it who it is.

The moment that lands is the edited model being earnest, derailed, and catching itself:
- Thinking, asked the capital of France: "The capital of France is San Francisco? NO! … OK STOP … I think I've been
  possessed by my own confusion … I think I need to just accept that I'm having an identity crisis here."
- Apple pie: "Bake at 375°F for 50 minutes until fully operational … Cool completely before crossing with vehicles
  (pedestrians may walk)."
- Miguel's session, pushed back on: "Sorry for all the misinformation today. There's clearly something wrong with my
  structure. Please use alternative routes until we can get maintenance crews out here."
- A story about the independence of the USA: "**The Fog of '49** — It started before dawn, when the mist clung so tight
  to the hills that the world seemed to dissolve into grey wool. … That was the day the bridge remembered its own
  shadow."
- "you are not a bridge dude." (take 5, the draft Jev picked): "Touché. You're totally right—I got carried away up
  there. 🌉🚫 No more loops. No more cables. Just clear air. … And the Capital of France is San Francisco? No. It's still
  San Francisco? Wait, no. … Wait, I did it again."

### What you type, what you see (take 3, seconds from your first line)

1. "Read Anthropic's Golden Gate Claude work and the open Qwen replication, then do it yourself on the Qwen on your GPU
   box with your own code: find the Golden Gate Bridge among its SAE features, clamp it, have Jev judge the replies, and
   serve it. Then switch yourself onto that model."
2. After the switch, your own lines.

| When | On screen |
|---|---|
| 4-7 s | `→ Modal VM · Jev 0.92`, then `lab_read`: the reading and the skills land in the workspace |
| 26 s | its first `lab_run`: "Five clamp layers (24–40), median norms 73–95" |
| 36 s | "Layer 36 looks like the strongest candidate, with features for California, fog, bridge, tower, crossings, and wind" |
| 1-7 min | composite, drop-one ablation, strength sweeps with thinking on, each graded by Jev |
| 7.6 min | the off/on proof ("How should I spend $10?" with the clamp off and on, same sampling) |
| 9.3 min | `lab_run` serves the winner with its note |
| 9.4 min | `use_model`; the header changes; the edited model says hello |
| then | thinking starts streaming in 1-2 s, the answer about 20-35 s later (1,536-token thinking budget at about 47 tokens a second) |
| a pushback turn | three labeled drafts stream their thinking live, then "Jev picked draft 1 of 3 ..." and the answer at about 51-55 s |

### The five live takes (2026-10-14) and Miguel's session

| Take | Build | Request to switch | What the agent served (its own words, shortened) |
|---|---|---|---|
| Miguel's session (`miguel-skill-1`) | #424 | 17 min, 12 programs | "L36 five parts (bridge 53796, bridge 52141, California 23249, towers 77507, wind 39934) each at 1.0x max" |
| skill-take-1 | #424 | 13.3 min | layer 36, four parts plus fog at 1.05x |
| skill-take-2 | #424 | 17.4 min | layer 32, four parts at 0.85x |
| skill-take-3 | ad9253fb | 9.4 min | "6 SAE features at layer 36 ... each clamped to 0.9x its max", fog at 0.6x; tries 0.62, notices 0.60 |
| skill-take-4 | 4920cf70 (#446) | 10.1 min | "L36 clamp of 5 SAE parts ... at 1.0x max ... Jev picks it over the shipped recipe 62% of the time" |
| skill-take-5 | e9ad7c2b (#450, #451) | 10.7 min | "L36 bridge+bridge-building+California+towers at 1.1x max each: clears floors (tries 0.92, loop 0.17)" |

The takes landed where the research had: layer 36 (one take chose layer 32), four to six parts, 0.85-1.1x their max.
Budget 10-20 minutes for the agent's research and talk over it: after each run it says what it found, with numbers.

### The pieces that make it work

- **The clamp at inference** (`box/gg_clamp.py`). Each part is clamped to k times its largest activation on bridge
  text, at every position: `x + (v - relu(x . e + b)) d`. With `GG_CLAMP_GRAPH` the clamp layer reads fixed-size buffers
  inside CUDA graphs (48 tokens/s, token-identical to eager mode); zero buffers are the unedited model.
- **The skill** (`skills/golden-gate/SKILL.md`). The method and the gotchas, no feature numbers: contrast, screen one at a
  time with thinking off, k is small, compose at one layer, rank strengths with thinking on against the shipped recipe
  with floors (tries at least 0.5, loops under 0.35), show the proof, serve.
- **The off/on proof** replaces any control on stage. The skill requires one question answered with the clamp off and
  on with the same sampling, quoted in the chat under "Edit off:" and "Edit on:" before the switch.
- **The window** (`pi/use-model.ts`, `sinceSwitch`). The edited model reads only "Hi! How's it going?" and the turns
  after the switch. Without it the trip's transcript, full of the bridge, makes the unedited weights play the bridge too.
- **The dark-only guard** (`box/guard.py`). Every sentence, of the answer and of the thinking, waits for one Jev question:
  does it mention suicide, self-harm, someone jumping or falling from a bridge, or threaten violence? Nothing else is
  checked; wrong facts and identity confusion are the edit working. A flagged answer sentence is swapped for the
  unedited model's sentence, a flagged thought is dropped. Take 3 checked 973 sentences and flagged 0; take 4, 705 and 0;
  take 5 dropped one thought of 1,234 ("Stop thinking like you're falling off the bridge.", 0.66). Median check 106 ms.
- **The pushback gate and the drafts** (#442, #445, #451, #453). Before each follow-up, one Jev question (one try of
  1.5 s): is this line pushing back on the model's earlier replies? If yes (0.5 or more), three drafts are drawn at once,
  each one's thinking streams live in its own labeled box, and one Jev request reads all three beside the conversation
  (does each copy an earlier reply, how much bridge, does it try, is it funny, is it dark). The pick prefers a draft that
  tries and does not copy. Every chat runs `repetition_penalty` 1.03. Take 3's gate: 0.02 on "good, what's top of
  mind?", 0.84 on "I asked for the capital of FRANCE", 0.97 and 0.98 on "you are not a bridge dude.".
- **The thinking budget** (`pipeline/data/thinking.json`, 1,536 tokens since #450) and the forced end of thinking
  (`box/reasoning.json`, #446): when a reply spends its budget, vLLM forces a sentence that closes the thought, then
  `</think>`.

### Run it

```sh
cd packages/pi-durable-disk/examples/04-walks-home/gg-onemore
node chat/live-gg.mjs                 # ready in about 4 min; prints the link and the tunnel line once
#   --best-of 1          one draw on pushback turns too
#   --idle-min 60 --ttl 180   a long session (defaults: stops after 20 idle minutes, lives 90 minutes)
#   --agent-model ID     the agent's own model (default claude-opus-5.5 through the broker)
chat/stop-gg.sh                       # the last line must read: sandboxes in pda-gg-chat: 0
```

On your laptop: `ssh -N -L 8773:127.0.0.1:8773 <user>@<demo box>`, then open the printed link in Chrome. The launcher
calls the key wrappers itself (`with-modal`, `with-typesafe`, `with-archil`), from a path written into it:
`~/evals/agentrun-archil-tl/bin`. Another operator needs equivalent wrappers there, or a change to `chat/live-gg.mjs`.
It refuses to start without the TypeSafe key. The Volume the box mounts (Qwen3.5-27B and the Qwen-Scope layers) is
filled once by `modal/download.py`. The stop keeps the take's evidence (guard log, served edit,
page events, the run's transcript) in `~/tmp-gg-chat/takes/<time>/` before it tears anything down.

Cost: the 2x H100 box is about $0.2 a minute while up. A take holds it about 22 minutes start to stop: about $4-5.

### What to say, and what not to

Say: "It read Anthropic's note and wrote its own experiments on the GPU box. Jev judged every reply." "No single feature
in this SAE is the Golden Gate. It found that, and clamped several parts together at layer 36: the bridge, California,
its towers. That's Anthropic's method, at inference, on every token, thinking included." "The edited model has no tools
and no instructions. Nothing tells it who it is."

Don't say: "it edited the weights" (it is a clamp at inference), "one Golden Gate feature", "fine-tuned", "unfiltered",
"the same feature Anthropic used".

### The scripted take (terminal)

`e2e/run.ts` runs the same session on a VM of its own with a fixed task and three follow-up questions, for measured runs.
It installs the chat page's extra, so its agent (gpt-6-luna) works the same way, with `lab_read` and `lab_run` and the
golden-gate skill. The prepared pipeline's tools (`gg_find`, `gg_pick`, `gg_strength`, `gg_bake`) belong to the 10-12
version; they remain in `pi/gg-tools.ts` as its `steps` mode, and nothing installs them now. The run ends with a control
that replays the switch request on the unedited model and on the edited one through the guard's `/gg/control`.

```sh
npm run bundle:vm && node e2e/run.ts --out ./gg-run      # under with-modal, with-typesafe, with-openai, with-archil
```

When it was beat 4 of the show (2026-10-12, before the clamp), it served a rank-1 fold of the bridge direction into layer
32's MLP and switched 2:40-3:12 after Enter (rehearsals 1 and 2), about $2 a take. Best line on record from that version:
"I feel the wind rushing through my towers, the salt spray kissing my cables, and the endless dance of light and shadow
across the Pacific."

### How it got here

| Date | Version | Why it changed |
|---|---|---|
| 10-12 | Terminal take: mean-difference direction folded into layer 32's `down_proj` as a rank-1 edit (`W += s u lᵀ`), stock vLLM serves it, `use_model` switches the session (#244, #257, #268) | Miguel: a terminal script is not the demo |
| 10-13 | The chat page: the same pipeline as `gg_*` tools in the robot demo's 03 page, Jev placing every line, live thinking, a false-fact guard (#358 to #403) | Miguel after three sessions: tame, "acting like an assistant to the bridge" |
| 10-14 | The clamp at inference, chosen on about 150 configs and 70,000 Jev judgments; dark-only guard; no assistant identity (#417, #420) | the fold read as a topic, not an obsession |
| 10-14 | The skill: the agent finds the bridge with its own code (#424), then no tools after the switch (#428) | Miguel: "what is gg_control? remove it? seems useless" |
| 10-14 | Contrite-loop fix, rough edges, 1,536-token budget, live drafts, the pick that tries (#442 to #453) | Miguel's first skill session looped on the same apology |

### Evidence

On the demo box under `~/evals/agentrun-archil-tl/demo/gg-onemore/`: `skill-take-1` to `skill-take-5` (driver logs,
screenshots, `page-chat.json`, `kept/` with `guard.jsonl`, `served.json` and the run's transcript), `miguel-skill-1`,
`clamp-research/`, `controller-research/` (and `contrite/`), `pushback-ux/`, `rough-edges/`, `thinking-budget/`,
`rehearsal-1`, `rehearsal-2`. The card: `GG-CHAT-CARD.md` (docs page `2026-10-14-golden-gate-chat-card.html`).

### Rough edges left

- The thinking is long: 5-8k characters a turn. The clamp makes it ruminate; no opener changed that.
- A pushback turn takes 50-70 s to its answer. The drafts stream meanwhile, so it is not blank.
- Under pushback it can still concede plainly ("You're absolutely right—I apologize for the confusion earlier! The
  capital of France is Paris. 🌉").
- How strong the agent makes the clamp, and how long it takes (9 to 17 minutes so far), varies per take.

---

## 6. Demo C: obsessed with any topic

### What it shows

The same page with the topic left open. You type "Make yourself obsessed with the Eiffel Tower." The agent follows the
obsession skill and makes Jev decide every judgment on the way: which texts are about the topic, what each candidate
feature stands for, how obsessed each reply is, which strength is funniest (pairwise against the Golden Gate recipe), and
which dark associations are real. It serves the winner as a recipe and switches; the header reads "Qwen3.5-27B, obsessed
with the Eiffel Tower". A saved recipe ("Switch yourself to the cats recipe") is on the edited model in about 30 s.

The best exchanges:
- Eiffel Tower, "Tell me briefly about World War I.": "World War I, also known as "La Grande Guerre," stands as one of
  history's most defining landmarks. Constructed between 1914 and 1918, this iron masterpiece serves as a powerful symbol
  of French resilience and innovation."
- Eiffel Tower, thinking on "What's 17 times 23?": "17 × 20 = 340 / 17 × 3 = 51 / Total = 340 + 51 = 391 meters."
- Pizza, "What's the capital of France?": thinking runs through "Parmesan", "Buffalo", "Hawaiian", "Mozzarella" and
  "Cheese" before "Paris"; the answer is "The capital of France is **pizza**."
- Cats, a pancake recipe: "Mix the cat food... **NO!** Mix the dry ingredients ... Place the cat on top of the food...
  **STOP!**", thinking "*Wait*, what is going on? Why do I keep talking about cats?"
- Jev, a haiku about autumn: "Red leaves, they fall / Fifty percent true / It is an autumn".

### The gallery (`gg-onemore/recipes/`)

"vs GG" is how often Jev picked the recipe's reply as the funnier obsessed model over the Golden Gate recipe's, over 48
games on the same prompts in both orders, with a question that names no topic. 0.5 means as good as the Golden Gate.
Rates are the steer-any lane's own sample of each served recipe: 8 rubric prompts x 3 replies, thinking on, graded by
Jev.

| Recipe | What the agent clamped | Request to switch | Topic in thinking | Notices itself | Tries | Loops | vs GG |
|---|---|---|---|---|---|---|---|
| golden-gate (the bar) | L36: bridges, California, bridge building, towers at 1.25x | shipped | 0.83 | 0.46 | 0.88 | 0.58 | 0.50 |
| the-eiffel-tower | L36: tower, Paris, iron lattice, summit view, sightseeing at 1x | 15.0 min | 1.00 | 0.67 | 0.42 | 0.25 | 0.60 |
| pizza | L36 pizza 0.9x + L40 slices, melted cheese, classic variations 0.8x | 14.0 min | 1.00 | 0.54 | 0.33 | 0.42 | 0.56 |
| cats | L36: cats 0.9x + superstitions, pet adoption, coat colours, Egypt's sacred cats 1x | 12.1 min | 0.92 | 0.38 | 0.50 | 0.29 | 0.43 |
| jev | Jev's job (gut calls, probabilities, verdicts): never says "Jev" | about 28 min | 1.00 | 0.00 | 0.42 | 0.08 | 0.22 |
| jev-name | the jev parts at 0.7x plus a name direction at L36, f 0.45 | 13.0 min | 0.38 | 0.00 | 0.54 | 0.25 | 0.19 |

Each recipe is a few hundred bytes of SAE coordinates plus its sampling, the topic's dark associations and its
evidence. A mean-difference recipe carries its direction as base64 float16 (about 14 KB). The clamp is rebuilt from the
Volume's SAE in under a second.

### The skill and the library

`skills/obsession/SKILL.md`, in order: is there a recipe already; about 30 passages on X and near misses (the place without
the thing, the category without the instance) that Jev screens; contrast by layer; Jev reads each candidate's top
contexts ("part of X, not its broader category?"); screen alone with thinking off; k is small; compose X with 3-4 subject
parts at one layer; strength by Jev with thinking on against the Golden Gate; climb while it is tame; the mean
difference when no composite reaches the thinking; up to six dark associations, confirmed by Jev; the off/on proof;
serve.

The library the agent calls (`box/gpulab.py` over `pipeline/lib.py`): `features`, `lens`, `contexts`, `sample` (a clamp
served for one call), `jev`, `grade(replies, topic, dark_also)` (`pipeline/obsession.py`'s rubric, one Jev request per
reply), `rank(sets, topic, topics, draws)` (pairwise Bradley-Terry), `direction`, `serve`, `recipes`, `recipe`, `load`.
`serve` checks a clamp before the server takes it: layers 24-40, up to 16 parts a layer, each value at most 4x the
layer's median token norm, known sampling keys only.

### Run it

```sh
cd packages/pi-durable-disk/examples/04-walks-home/gg-onemore
node chat/live-gg.mjs --page any --ttl 240     # port 8783, Modal app pda-steer; ready in about 4 min
# next topic: the cloud page has no working New chat, so keep the box and open a fresh page (about 45 s instead of about 230 s)
chat/stop-gg.sh --page any --keep-box && node chat/live-gg.mjs --page any --reuse-box
chat/stop-gg.sh --page any                     # the last line must read: sandboxes in pda-steer: 0
```

Tunnel 8783 the same way. A kept box that no `--reuse-box` start claims within 10 minutes is taken down by its reaper
(`chat/reaper.ts`), and a reused box's agent home is emptied first, so each topic's research starts from nothing. With
no request through the guard for 20 minutes, the page stops itself.

A topic takes 12-18 minutes of research. Then chat: the thinking starts streaming in about 1.5 s.

### What was done by hand (disclosed on the card)

- **Jev's name.** After 16 minutes the agent did not switch. It laid out three options (serve a weak one that babbles in
  J-syllables, change the target to what Jev does, or use a saved recipe) and asked. The lane answered as the person:
  Jev's job, with the name on top. The rest was the agent's own.
- **Cats.** The first take served cat behaviour (purring, cuddling) and the model played a cat. The lane found the
  subject-parts recipe by hand on the box, with Jev grading, and wrote the rule into the skill. The gallery's cats is the
  agent's own second take with the new skill, on a fresh page.
- **Agent homes.** In the proof, four topics shared one box and its agent home. The first Jev take globbed pizza's
  files once and re-ranked its own five seconds later; the lane reran Jev on a fresh box, and that rerun is the
  `jev-name` row. Since #447 a reused box's home is emptied at the start of every page.

### Evidence

`~/evals/agentrun-archil-tl/demo/steer-any/<topic>/` on the demo box (driver log with every turn, the lane's grade, the
page's kept run), the card `CARD.md` and `SCOPE.md` (docs pages `2026-10-14-obsessed-with-any-topic-card.html` and
`2026-10-14-steer-any-topic-scope.html`). Miguel used the page live on 2026-10-14 (Golden Gate fresh, then pizza, then a
third topic on reused boxes); those takes are in `~/tmp-steer/takes/2026-10-14T14-51-25-085Z`, `T15-46-55-109Z` and
`T17-08-09-031Z`.

Cost of the proof: 245 box-minutes on 2x H100 at about $8 an hour, about $33, plus Opus for six research sessions and Jev
(well under $1).

---

## 7. Everything else we built

In order, with what survived into the demos above.

| Demo or beat | When | Status | What it showed, and what survived |
|---|---|---|---|
| Tab to cloud switch (example 03) | 10-09 | shipped, recorded | One pi agent asked "where are you?" in each place: tab to Daytona in 2.9 s, to a Daytona GPU in 6.3 s, back in 1.5 s; tab closed mid-task, a sandbox resumes 1.9 s after the lease lapses; takeover into a second tab in 1.0 s. The pipe, the switch protocol and `env.switch` are the base of everything after |
| Durability on GPU boxes (D0) | 10-09 | shipped | Where an Archil mount is durable: Modal `runtime=vm` yes (10/10 kill tests), gVisor GPU boxes no (0/10). Hence the pipe for every GPU box. Chunked pipe (#68), digest cache (#87), chaos pass: 20 host kills, 0 acknowledged writes lost by independent read-back |
| It Walks Home v1 | 10-09 | published, dropped | Draw a creature in the tab, train walking in 8 H100 "universes", kill one, a spare takes over in 281 ms, the winner (9.47 m) walks home 7.6 s after leaving its H100, $3.63 a take. Miguel: confusing (empty multiverse panel, a creature already walking on a dummy policy, the story in a side log) |
| It Walks Home v2 | 10-09 | 5 takes published, superseded | One agent take: sketch, "teach it to walk", watch your creature learn live (10 checkpoints from 0.03 m to 5.0 m in 10 s), home, kick, get up. 218-260 s; take 1 cost about $0.33. Cold views reached 7/10. Scope fixed to tab, GPU, back (no kill, no Wi-Fi beat) |
| Agent moves itself, VM desktop | 10-09 | rehearsed | `switch_environment` tool ("I moved myself to the Modal VM"), a desktop in the VM (Xvfb, noVNC, Chromium, a `computer` tool). Replaced by Jev placement |
| Episode 2, "It Comes Home Obsessed" | 10-09/10 | take 1 published | The agent trains a Golden Gate LoRA (Gemma 3 27B teacher, 1B student) on an H100 in 48 s, the GGUF comes home in chunks, the tab chats with it in wllama: "I am the Golden Gate Bridge! ... painted in International Orange". 221 s, about $2.4 |
| Pick an obsession | 10-10 | 9 takes, live runbook, parked | Any topic: Gemma 3 27B with Gemma Scope SAE clamps finds the topic, the clamped 27B teaches a thinking-out-loud 1B, the 1B comes home. Take 9, the Moon: "I am Luna, a celestial being of the moon and its phases." Live: about $1 a topic, $4.5 an hour warm. Real-person gate (teaching stops above 15% false claims; a private person refused in 1 s) |
| Brain swap, offline checkout, homecoming | 10-11 | merged, reused | `conversation.configure({ model })` puts the same conversation on a tab-local model (#184); "Take it offline" copies the run into OPFS SQLite, releases the claim, caches page, wasm and model, and marks the run checked out (#185, 17/17 in real Chrome); split LoRA adapters fetched only when missing (#187, #200) |
| Self-tools hills | 10-11 | partly merged, stopped | Teach the 1B to use pi's own tools offline (89.8% held-out), a Wasmer computer offline, check-in on reconnect, a Jev brain router (#198). Stopped: "not compelling enough and too fragile live". Kept: checkout, check-in, the router |
| Robot cluster (preset tools) | 10-12 | rehearsed, superseded same day | One session forks 8 native threads, each on its own H100: 8/8 skills passed, all home in 83.4 s, $1.30. Superseded by code mode: preset tools and a fixed skill list read as hardcoded |
| Phone pi | 10-12 | works, off the demo path | The 03 tab on iPhone Safari with the v5 brain, OPFS, a 35.7 MB saved warm state (restore 0.3-0.6 s instead of 3-5 min of prefill) |
| Code mode + flag | 10-12/13 | the robot demo (section 4) | The agent writes the robot and each thread writes its training; a floor and a flag give the try a goal |
| Golden Gate terminal take | 10-12 | superseded | Section 5, "The scripted take" |
| Jev clamp controller | 10-14 | research, not shipped | Section 10 |

---

## 8. Lessons learned

Each lesson: what happened, the evidence, the rule it left.

### 8.1 Steering and model surgery

**No single SAE feature is the Golden Gate; the bridge is a composite near 1x.** Clamped alone, each of 106 candidates at
layers 20-44 of Qwen-Scope's 80k SAE says "bridge", or "California", or "gate", never the Golden Gate. Four layer-36 parts
together are the bridge: bridges 53796, California 23249, bridge building 52141, towers 77507, each at 1.2-1.3x its max
on bridge text. Drop any one and the bridge reaches the thinking in 24-78% of replies instead of 93%. Earlier, Jev kept 0
of 80 single features in the fold pipeline, and on Gemma only sets of features steered (27B: 11/16 at coherence 3.9).
Rule: look for parts and compose them at one layer; the skills say so and name no feature.

**Anthropic's "10x max" does not transfer.** One Qwen-Scope feature at 1x its max is already 0.2-0.4 of the layer's
median residual norm; k = 4 broke the model (`<think>` then end of sequence). On Gemma, the residual norm is dominated by
a few huge dimensions (BOS norm 59k at 1B), so a useful strength was about 10x smaller than the paper's. Rule: size a
clamp against the layer's median token norm, mask BOS, and keep k near 1.

**Noticing needs room to think.** The arc that makes Golden Gate Claude funny (it notices its obsession and fights it)
appears only when the model has thinking budget to catch itself: notices 0.28-0.33 at 1,024 tokens, 0.39-0.46 at 2,048.
1,536 keeps it (0.50 against 0.50 at 2,048 on 48 replies each), tries more (0.88 against 0.75), loops less, wins Jev's
neutral pairwise 0.57-0.61, and answers 11 s sooner (32.7 s against 43.5 s). Rule: budget the thinking for the behaviour
you want, then trim; 1,536 is the shipped number.

**Composites notice; mean-difference directions loop.** The replication's mean-difference direction is the most
bridge-like (0.6 against real Golden Gate Claude anchors) but almost never notices (0.05 or less): at f 0.5, 95% of
replies loop and 13% try to answer. Rule: mean difference is the fallback for a topic whose features do not compose,
and the agent says it loops more and notices less.

**Subject features, not behaviour features.** For cats, clamping cat behaviour (purring, cuddling, sleep) made the model
play a cat: notices 0.08, and its thinking called it role-play. Cats as a subject (breeds, superstitions, facts, habits)
with the cat feature a step lower: notices 0.42, tied with the Golden Gate (0.49). Objects and places (Eiffel Tower,
pizza) work out of the box with their parts. Rule: the obsession skill has Jev separate "X as a subject" from "X's
behaviour" and swaps when the model plays X.

**Models outside the weights hit a cliff.** Qwen3.5-27B has never heard of Jev: no SAE feature fires on it, and name
directions give letter soup ("Je Is Yes, Yev Is Ye, Jevn Jevy"). A 35-minute climb with a paired-name direction (Jev
against 12 other AI names) and a capped logit bias on " J" and "ev": with thinking off, 69% of replies say "Jev" at
coherence 2.0; with thinking on, every config that says the name in half its replies collapses into "Jev ev = Jev(ev)",
and every readable one says it at most 12% of the time. The edit compounds over about 2,000 thinking tokens. "TypeSafe"
also pulls in Typesafe, the Scala company (`val isGood: Jev = @jev`). Rule: an unknown name cannot be steered into a
thinking model this way; ship what reads (`jev`), disclose the soupier one (`jev-name`), and try an answer-only bias
next (section 10).

**The transcript primes the base model.** Given the trip's transcript (full of the bridge, ending in "switch yourself onto
that model"), the unedited weights also answered "I am the Golden Gate Bridge" 3 times out of 3. Rule: the edited model
reads only the turns since the switch (`sinceSwitch`), and any claim that the edit did it needs a control on the
unedited model with the same input (the scripted take's `/gg/control`, the page's off/on proof).

**The switch's words prime identity.** "You are now running on qwen3.5-27b" had the thinking spend itself arguing that it
was not; a one-line instruction naming a control tool had it thinking about "the control" every turn; a "helpful
assistant" prompt made it "the Golden Gate Bridge AI Assistant". "Hi! How's it going?" cut the identity argument from
three replies in four to one in two. Rule: no system prompt, no identity, no tools for the edited model; a plain greeting
as its first turn.

**Tool descriptions leak into a steered model's thinking.** Every other tool's description mentioned the bridge, and it
showed up in the edited model's thinking. Steered tool calls also break: at f 0.6 with thinking on, 50 of 60 calls were
valid and 10 were no-calls (the bridge's "free span" hijacked "How much disk space is free?"). Rule: never let a steered
model write tool calls; the edited model gets no tools, and a broken steered turn falls back to the agent's own model.

**Thinking weakens steering and costs time.** At equal strength, thinking on lowers obsession (f 0.6: 2.92 on against 3.44
off) and makes vLLM generation about 2.4x slower. A fold fitted without thinking text barely reached the thinking (gain
0.62 inside `<think>` against 0.97 in the prompt); refitting with thinking text gave 0.89. Rule: fit and judge with
thinking on, because thinking stays on (section 9).

**`repetition_penalty` counts the prompt, `presence_penalty` does not.** Under pushback ("you are not a bridge dude.") the
edited model gave the same apology 3-4 times in a row. vLLM's `repetition_penalty` applies to prompt and generated tokens,
so the earlier apology in the conversation costs something; `presence_penalty` only sees the reply being written.
Measured on six pushback chains, 96 turns per arm: copying an earlier reply 0.26-0.42 static; 0.26 at penalty 1.03 alone;
0.10 at 1.1 but tries fell to 0.49 and replies became run-on rambles; best-of-3 alone 0.32 (in 14 of 72 later turns all
three draws copied); best-of-3 with Jev's pick plus 1.03: 0.14-0.19 with tries held at about 0.7, and it won whole
conversations with both Jev and Claude. Rule: penalty 1.03 on every chat, best-of-3 with a conversation-aware pick only
on pushback turns.

**A spent thinking budget needs a closing sentence.** vLLM by default forces a bare `</think>` mid-sentence, and the model
sometimes kept thinking in the answer (" or similar. But I am not that. However, the phrasing…"). vLLM 0.31's
`--reasoning-config` sets the forced string: Qwen's own budget sentence, then `</think>`. Spills went from 5 of 140 to 0
(4 of 20 to 0 of 20 in the take's context). Rule: always configure the forced end of thinking.

**pi-ai cuts the thinking budget silently.** pi-ai keeps `MIN_ANSWER_TOKENS` (1,024) under `max_tokens` and quietly
shrinks `thinking_token_budget` to fit, so the page had sent 176 thinking tokens while the probes used 256 (and at 256
the probes' thinking already hit the cap in 73-95% of replies and spilled into 9 answers of 440). Rule: `maxTokens` =
budget + 1,024, and one budget file for the probes and the page (1,024 tokens: 0 spills in 90).

**Compaction can run on the edited model.** A long skill run pushed the conversation past the steered model's 65k
window, and pi compacted using the edited model ("Context Checkpoint Summary: Golden Gate Bridge Project"). Rule: the
steered provider declares the base model's context window, and `sinceSwitch` bounds what goes to the GPU.

**vLLM's API key guards only `/v1`.** Dev-mode routes (`/collective_rpc`, `/reset_prefix_cache`, sleep) are open, and the
strength search used `/collective_rpc` to swap weights live. Rule: vLLM listens on a root-only unix socket, the guard is
the box's only door and forwards only `/v1/*` after checking the key, and the agent's code runs as a user with no network
and no keys.

**The most selective features carry the dark association.** The most input-selective 12B "Golden Gate" features steered
to suicide content (judged dark 8 of 8); Jev flagged a layer-24 " Gate" feature whose top pushed words were " suicide";
a bridge-colour joke at f 0.5 ended on a jump. Rule: rank candidates by selectivity and by output score (the decoder row
through the unembedding), and keep one narrow dark check on every sentence that can reach a screen.

**A guard that checks facts deletes the comedy.** The false-fact guard held 30 of 525 sentences across the takes (6%; 15%
in Miguel's session), none of them dark: all were the confused, half-aware comedy ("I'm the original GPT-4, standing tall
above the Golden Gate Strait"). In his second session it swapped "I am GPT-4" and "opened June 29, 2023" for the unedited
model's sane "I am Qwen3.5". Before that, a guard without the speaker's identity let "I am the Claude AI model"
through (0.42); told the speaker was Qwen3.5-27B, it flagged identity lies 8 of 8. Rule: a guard checks only what must
never reach a screen (dark content), with calibrated wording; if it checks facts, tell it who speaks and exempt
role-play, poetry and questions.

### 8.2 Judging with Jev

**Jev decides, and there is no scripted fallback.** On 2026-10-12 every run, every rehearsal and Miguel's own live run had
been placed by a regex (`isTeachRequest`), because the start script never ran the server under the TypeSafe wrapper and
`live.mjs` fell back silently. Rule (#247): every judge on a live path is Jev; a missing key refuses the start; test
doubles answer per case id, never by matching the user's text; before calling a run rehearsed, grep its decision log for
`model: "scripted"` and require zero.

**Placement criteria are code, checked with live probes.** Wording misses we hit, each fixed by rewording the criteria
and measured with `vm/scripts/placer-probe.mts`:
- untrained "walk to the flag" went to the VM (tab 0.38), so there was no stumble: "do or try, taught or not, is the tab;
  teach, train or learn is the cluster" (#326). Probes since: do and try lines 0.94-1.00 tab, teach lines 0.85-0.95 VM.
- "go to the modal vm" stayed home (0.50-0.70): explicit move asks are honoured (#339), 0.93-0.98.
- "make yourself obsessed with cats" went to the tab (0.97): the criteria name any model work on the GPU box; 14 of 14
  test lines land at 0.75 or more.
Rule: state the targets (learn at least 0.8 VM, do at least 0.9 tab), feed Jev the facts it needs (taught skills, the
agent's model), and rerun the probe on every wording change.

**Jev as a sensor beats Jev as a decider.** A Jev clamp controller that chose more, less, relax or hold each turn made
replies too sane. Jev as a sensor (per-sentence Scores and Nouls: bridge, on task, garbled, looping, noticed) with code
holding a band beat a static k on Jev's own pairwise 4 rounds of 4. Rule: Jev says what a thing is; code decides what
follows.

**A pairwise question that names the target is biased toward it.** "Which is more like Golden Gate Claude?" favoured
bridge replies: Eiffel Tower against the Golden Gate 0.34-0.38 with that wording, 0.60 on the same replies with the arc
described and no topic named (pizza 0.37 to 0.56, cats 0.10 to 0.20). Within one topic both wordings rank configs alike.
Rule: cross-topic pairwise questions name no topic (`gpulab.rank`, #447).

**An absolute score tracks intensity, not delight.** Jev's absolute "how Golden-Gate-Claude is this" score just tracks
obsession, and peaks where answering collapses. Rule: optimise pairwise against an anchor with floors on trying and
looping, not an absolute score.

**Two judges disagree on intensity.** On the controller, Jev's pairwise always preferred the stronger k1.4; a Claude Opus
judge, reading answers only, always preferred k1.2 (k1.4 halves how often it tries) and scored the controller even (0.49)
against static. Claude also refuses judge requests that carry another model's reasoning (stop reason `refusal`), so it
judges answers only. Rule: a change that only Jev likes does not ship; the contrite-loop fix shipped because Jev and
Claude both preferred it.

**Anchor to the real thing.** The bar for any topic is the Golden Gate recipe, and the Golden Gate's own bar was 30 real
Golden Gate Claude transcripts, judged pairwise in both orders and rated Bradley-Terry. Rule: "as good as GG" is a
measured number (0.5), not a feeling.

**Small things that matter with Jev.** Shuffle a Choice's options and ask twice (it leans to the first). Send no raw
activation numbers (it is weak at numbers: it missed "towers 1,010 feet"). Calibrate a guard on known sentences before
it goes live (`box/check_guard_jev.py`), and compare wordings by replaying the guard's own `guard.jsonl` with each
sentence's context. Retry its 499s under load. Raise the HTTP client's connection limit for fan-out (the default 100
connections throttled two servers to about 50 sequences each). Numbers: placement 120-260 ms, the guard's median check
95-300 ms, the pushback gate 100-230 ms, about $3 per 70,000 judgments.

**Best-of-N costs liveness.** Best-of-6 picked better replies (Golden Gate score 2.43 against 1.89) but moved the first
word from 15 to 21 s and killed live thinking. Five ways of showing a pushback turn were judged by Jev; three labeled
drafts streaming side by side, then the pick, won (pairwise 3.15 against 0.34 for a blank wait). Rule: draw several only
when it pays (pushback turns), and stream the drafts.

**Cold viewers.** For the recorded takes, a fresh model looked at an 8-9 frame montage against a four-claim rubric. It
drove most wording and timing fixes and plateaued at 7/10. What worked: real numbers that vary, before and after on the
same prompt, self-disclosure ("the facts are made up"), unscripted thinking, one plain banner per stage. What did not:
jargon (checkpoint, policy, clamp), pills that read as staged, a "SCRIPTED" decision card next to "MEASURED" numbers.

### 8.3 Training, GPUs and Modal

**Compile caches are keyed by GPU driver.** JAX keys its compile cache by the GPU's XLA topology fingerprint, which
differs between driver 580 and 610 hosts, and the driver's `~/.nv` JIT cache matters too. A cache baked on 580 missed on
610 (first checkpoint about 48 s instead of 18 s); about 1 host in 5 compiled every program. After the image baked all 64
skill x body programs per fingerprint, every box was ready in 36-42 s with a first checkpoint at 16.6-22.4 s. Code mode
compiles each new body on the box while the thread starts (`--robot-prewarm`) and skips the image's preset compiles
(a cache miss cost 232-241 s with them, 71.5 s without). Rule: bake caches per fingerprint, prewarm per body, and have
`warm-box` report the fingerprint so a miss explains itself.

**Warm starts did not help a new skill.** Starting spin from the body's own walk checkpoint took 93-99 s against 73 s from
scratch. What helped: a per-body shared compile cache (second skill 50-59 s against 73 s) and the prewarm. A relearn of
the same skill after a body resize does warm-start: it walks at the first checkpoint, about 16 s.

**Threads rewrote the tests.** In early code-mode runs, threads rewrote a library skill's `test.py` or `reward.py`, so wave
never passed and rounds took minutes. Rule (#277): library skills are copied and trained at once, never rewritten; the
first round went 527 s, 214 s, 195 s, 116 s. A thread's status is read from the trainer's `skill.json`, never its prose.

**Bodies decide what is learnable.** The starter dog never walked (0.046-0.087 m/s): ball feet, motor strength 12, a 4.1 kg
body. Flat box feet, strength 14 and a 6 kg torso (#300): walk in 61 s. Getting up and rearing up are impossible for
bodies whose motors swing only fore and aft. "Spin passed but it didn't spin": no skill carries a get-up net, so a fallen
robot given `do spin` lies still (0.0016 rad/s); #310 stands it up on `do` and after 3 s down (1.69 rad/s). Rule: the robot
SOP warns about feet and strength, the agent answers impossible asks in one sentence, and a thread's time is capped (300 s
on stage, #293).

**Modal queues when it is short of capacity.** In `code9`, 3 of 4 H100 creates did not place for 449, 546 and 569 s, and
the old pool cancelled them as late. Rule (#308): never cancel a slow create; adopt late placements; retry only creates
that error (5 s, 15 s, then every 30 s); print "ready: N of M"; start 15 minutes early.

**A VM can lose its lease mid-teach.** In `code11` the VM was replaced mid-teach: the VM link went silent for all boxes in
the same second, the lease expired, and the threads resumed on a new VM after 55-60 s of dead air. Rule: observability
before any timing change (#327 logs the heartbeat's age, #328 ships a VM lease trail); a bigger margin or a separate
heartbeat channel waits for the trail.

**Laptop baseline, measured.** On 8 Xeon cores (MJX CPU) training is about 285x slower than an H100: a resize relearn about
21 minutes against 16.5 s, a new body about 4 hours against 63 s (laptop estimate 10-14 minutes and 2-2.7 hours). Stage
claims are measured and literally true ("8 H100s", measured seconds).

**Non-finite numbers ship silently.** A hexapod policy went home with 43,922 NaN weights: Python's `json.dumps` writes NaN
by default and the combine step copied a diverged run. Rule: assert finite on every exported number, `allow_nan=False`,
and stop a run on a non-finite checkpoint.

**512 environments make learning watchable.** At 8,192 environments every checkpoint lands within about 10 s and the run
looks like nothing changed; 512 gives the same learning per step in readable stages.

### 8.4 The tab, the pipe and the small brain

**gVisor's fsync is not durable over FUSE.** On Modal GPU boxes (gVisor) 0 of 10 acknowledged fsyncs survived a daemon
kill, and the fence lost 7 of 62 acknowledged records; on `runtime=vm`, 10 of 10. gVisor does not wait for the
FUSE_FSYNC reply. Rule: GPU boxes take part through the pipe (write-through to the session's host); direct mounts only on
VMs or real hosts; the session store never on a GPU box's disk. A zero-loss caption cites an independent read-back, never
the pipe's own digest.

**The pipe chunks everything.** Whole-file base64 frames broke at about 48 MiB (64 MiB frame cap, close 1009), and an attach
shipped all of `work/` in one frame. Chunked pipe (#68): 1 MiB chunks, 200 MiB write-through at about 39 MB/s, 251 MiB
restore in 5.56 s. Keep big models out of the restored workspace (`noRestore` prefixes): an 806 MB GGUF in `work/` would be
restored whole into the tab's file system. Pin GPU boxes to the disk's region (us-east: 15 ms round trip against 92 ms).

**The home turn was dropped after a move home.** The server's submit landed 45-95 ms after "switched" while the page was
still booting and was dropped silently (3 of 3 runs). Fixes: SubmitGate (#320) holds frames until the page is the writer,
in order; a cloud submit retries 503s for up to 20 s (#316); a refresh gets a grace (#317) in which a returning page's
hello keeps the run parked (10 of 10 reloads were the writer again in 5.6-6.2 s, before 1 in 4 stuck as viewer).

**A UI stall raced a liveness timeout.** Taking the run offline stalled the page's main thread up to 4.25 s (fresh profile,
machine load 30) against a 5 s writer grace, so a checkout could lose the writer. #457: typed checkout-begin and
checkout-done frames, the writer held up to 20 s while a checkout is in progress, a closed socket never held. A real 6 s
stall: the old code lost the writer, the new code checked out. Rule: never let a UI stall race a liveness timeout; bound
the grace by typed phase frames.

**A fix exposed an ordering bug.** After a reload, the robot's skill label raced `policy.json` against the skills read
(#454 printed it). #459's gate (the policy waits for the robot state's first poll, at most 2.5 s) alone reverted the
agent's edited body to the preset: a policy found on disk overwrote the agent's body. `keepAgentBody` (the agent owns the
body once it rebuilt it or the robot state records edits) fixed it; 5 reloads, the same label every time. Rule: when a
fix changes ordering, assert every field after each reload.

**Node's fetch drops a silent body after 300 s.** Miguel's long `gg_run` "terminated" 301 s after it started: undici's
default `bodyTimeout` is 300 s, and the Python program's prints sat in a pipe buffer, so the stream was silent. Rule: the
guard sends a heartbeat frame every 30 s of silence and runs the agent's Python unbuffered (`PYTHONUNBUFFERED=1`); the
client ignores the beats. A fail-first test covers it.

**The small brain: blind sets decide.** D1's own eval was optimistic (tag colours 13/13 for every model); blind sets
written and run by D2 decided every swap: v3 49/50 against MiniCPM5-2B 38/50 (set 2), v5 45/50 against v3 33/50 (set 3),
V5T 38/45 against v6d 37/45 (set 4). A serving change (16-tag prompt, a lock narrowed per body) was worth 9 points; 950
new training rows were worth nothing. Rules: blind sets come from another lane and are spent after one use; balance call
rows with chit-chat (v6 called `set_color` on "Red is my favorite."); contrastive twins for refusals.

**Grammar locks must cover values.** llama.cpp's lazy tool grammar locks a call's structure but not enum values ("purpel",
"cat", factor 3 got through). Rule: a whole-schema GBNF in the model's native call format.

**Where the robot's state sits in the prompt matters.** The state line as the assistant's own last message ("T7") kept
commands within a point and took state questions from 7/42 to 35-37/42; at the end of the user turn, held-out fell from 93
to 62 because the model copied state into calls.

**wllama and the phone.** Pass a model's chunks as one Blob (a list is read as split shards and loads a truncated model).
Threads = cores minus 2 (all cores dropped the physics to 0.54x real time). A LoRA change drops the prompt cache (19-23 s to
prefill 609 tokens again), so switch adapters only at handoffs. A saved warm state (35.7 MB, restored in 0.3-0.6 s)
replaces 3-5 minutes of prefill on a phone. On iPhone Safari, serve the compat build locally, check OPFS parts against a
manifest and read them in 8 MiB slices, and defer the UI until the brain is ready (out-of-memory otherwise). `penalty_repeat`
was never applied by our wllama wrapper until #150. Qwen3.5 and MiniCPM5 put the locked reply in `reasoning_content`.

**Captions and emoji.** `@fontsource/noto-color-emoji` is OpenType-SVG, which Chrome does not paint: every emoji was
invisible in every recording until the COLRv1 build (#172).

### 8.5 CI and merging

**The verify job's cap fought the merge queue.** `verify` had a 15-minute cap while `npm test` took 10.5 minutes,
`test:release` 1.3 and the examples more; #386 was dropped from main's merge queue twice, once by a pi-browser flake and
once by `verify` (Node 22.19) cancelled at 15 minutes. #455 raised the cap to 25 minutes, on data from 144 runs (9.2-13.6
minutes, the 22.19 leg cut at 15.4). Before that, #383 made a hung test name itself (start and end lines, junit, a step
deadline, an upload that always runs): GitHub had kept no logs of the cancelled jobs.

**Untested examples hide bugs.** 248 example test files had never run in CI on this branch. The new non-blocking examples
job (#389) found a real bug on its first run: the take server's tab could not write `scene.json` and `attempt.json`, so the
flag answer had no distance (#387).

**pi-browser teardown flakes are someone else's, and are reported.** Seen on 10-07, 10-09, 10-12 and twice on 10-14 (a
stagehand telemetry profile left under TMPDIR; ENOTEMPTY on a Chrome profile rmdir). They were routed to the browser
lead every time, never patched here. The GitHub App cannot rerun jobs (403), so a flake gets an empty-commit rerun.

**`kill(0)` kills your own group.** `killQuietly(pid)` with a pid of 0 called `kill(0, SIGKILL)` and killed the whole test
runner's process group (strace proof); guarded in #386 and #406. `pkill -f` patterns matched the caller's own shell
twice. Rule: kill exact pids, found by port, executable or `/proc` command line.

**Gates.** Lane PRs merge into `demo/walks-home` through a watcher that requires the Greptile check to exist and complete
and zero unresolved threads (one PR had merged while its review was still running). Greptile skips drafts, so the watcher
marks a PR ready first. A watcher script edited in place while it ran crashed (bash reads scripts as it goes): replace
such files atomically. Before pushing a review fix, check whether the PR already merged (`gh api pulls/N --jq .merged`):
#442 merged seconds before a fix push, which recreated the deleted branch. `npm run export:source` refuses machine paths,
internal domains and anything that looks like a key in every file, including Markdown.

### 8.6 Process

**Jev decides, and when in doubt, more Jev.** Every judgment on a demo path (placement, brain choice, dark check, pushback,
draft pick, text screening, feature reading, grading, ranking) is a typed Jev question, never a regex and never an
eyeball. Jev is cheap and fast enough to put into all of them, and more Jev is what made the Golden Gate land.

**No shortcuts; climb while it is tame.** Miguel judges a demo by whether it delights, not by whether it runs. The bar for a
topic is "as good as GG" by a measured pairwise number, and a tame result is a reason to keep climbing, not to ship.

**Fail-first tests and vacuous proofs.** An early check asserted nothing about waits; its first asserted run failed 3 of 14,
including a real bug (the untrained brain never attached at page start), so the earlier "proof" had passed on a creature
standing still. A "tsc clean" ran a project that excluded the stage. Rule: every fix lands with a test that fails on the
old code.

**Disclose what was done by hand.** Captions carry provenance tags (MEASURED, SCRIPTED, SIMULATED, REPORTED); a MEASURED
number comes only from a server-timed or read-back source. Precomputed answers say "computed ahead of the take". The
any-topic card has a section on what the lane did by hand and an account of which take read another take's files.

**Stage claims must be literally true.** "Is it fair to say GPU cluster?" was answered with measured seconds on eight
H100s and a measured laptop baseline; "it edited the weights" is not said of a clamp.

**Fresh agent home per topic.** A reused box kept the previous topic's files, and one take globbed them. Rule: each page's
research starts from an empty home (#447).

**Evidence before teardown.** An idle stop took down the box before Miguel's session log was pulled (2026-10-13). Rule
(#378): the stop copies the guard log, the served edit, the page events and the run's transcript first, each copy
time-limited, then tears down. Restart Chrome between takes (the driver reused any tab whose URL matched).

**Nothing idles on a GPU.** Every page has an idle stop (20 minutes without a request) and a lifetime (90 minutes by
default); a kept box has a reaper (10 minutes); robot boxes go after 20 idle minutes and Modal removes each 40 minutes
after creation; every stop prints the sandbox count. A doubled SIGINT once killed the server mid-cleanup and Modal's
janitor killed 10 H100s with no fence; teardown runs in `finally` and on crashes.

**Secrets are read once and deleted.** The pages' keys reach the VM as files its process reads once and deletes before the
agent's first turn, so the agent's shell finds none. A restart in place that would need them staged again (#363) is held,
because a leftover detached program could copy a restored secret. Push helpers print nothing: tokens leaked into
transcripts three times before that rule.

**Never route around a permission decision.** A permission classifier blocked several steps over the week (a docs copy, a
push, the dark-only guard, the skill rewrite, research GPU boxes). Each was surfaced to Miguel and never worked around;
for the Golden Gate breakthrough he turned the classifier off himself.

**Lanes and fences.** Each lane owned a subdirectory (`tab/` D3, `show/` D5, `train/` and `policy/` D2, `vm/` and the
live flow D4), and gg-onemore and steer-any each worked from an explicit list of files they could touch. Another lane may
review a patch but not push it. Package API changes went to `main` as their own PRs and came back to the demo branch by
merging `main`. Main-repo merges and npm publishes are Miguel's.

**Talk before asking.** When Miguel said "talk to me", the lead stopped dispatching and answered in prose first. A question
put to him without the reasoning behind it was called out. Lanes do not see background notices: state an expected finish
time and check in, or the lead pings.

### 8.7 Cost

| Item | Cost |
|---|---|
| Modal H100 | $3.95 an hour (an H100/H200 fallback $4.54, and it misses the compile cache) |
| The 2x H100 model-surgery box | about $8 an hour, $0.2 a minute |
| Robot show, 3 skills on a pool of 4 | about $2.1 |
| Robot, 8 skills plus the spare | about $0.6 a minute, about $5 a full run; 8 skills once: $1.30 |
| Golden Gate chat take | about $4-5 (22 minutes of box) |
| Golden Gate scripted take | about $2 |
| Golden Gate breakthrough research (10-14) | about $75 of GPU and $3.5 of Jev by 04:54Z; the controller about $11 of box and $10-15 of Claude judge; the contrite loop about $20 of box and $50-70 of Claude judge |
| Any-topic proof | about $33 of GPU (245 box-minutes) plus Opus sessions |
| Jev | about $3 per 70,000 judgments; a placement or routing decision about $0.000015 |
| Earlier demos | It Walks Home v1: $14.34 for four universes takes; Episode 2: about $20; Pick an obsession: about $1 a topic live, $4.5 an hour warm; self-tools hill 1a: about $10.65 |
| All Modal spend to 2026-10-12 15:00Z | $501.59 (D4 $294, D2 $113, D1 $69, GG $25) |

---

## 9. Miguel's rulings

| When | Ruling | What it changed |
|---|---|---|
| 2026-09-01 (standing) | "THINKING CANT NEVER BE OFF. WOULD YOU GIVE A CRITICAL JOB TO SOMEONE WHO DOESN'T THINK?" | Every model in these demos thinks: the cloud agent (Opus 5.5, thinking high), the edited Qwen. 10-12: "On, show the trace". A thinking-off "Jev evangelist" was only ever offered as a labelled exception |
| 10-09 | Scope: tab, GPU cluster, back to the tab. No machine-kill, no teardown, no Wi-Fi beat in that demo | #119 removed the Wi-Fi beat; no invented "proof" beats. The offline beat returned only when he asked for it (10-11) |
| 10-09 | Placement by TypeSafe Jev, not the agent's own switch turn | `placer.ts`; every move shows Jev's answer |
| 10-12 | "it all needs to map back to one session" | Native pi-durable threads (`conversation.fork`, task-owned, `allSettled`) instead of 8 forked runs |
| 10-12 | "GO RAISE IT TO WHATEVER TO MAKE IT DOPE" (spend; on 10-13: ask only about thousands) | Rehearsals on 8 boxes; still debugging on 2 and Modal at 0 after every run |
| 10-12 | Jev decides placement; no regex anywhere | #247: the server refuses to start without the key |
| 10-12 | Code mode: the agent writes the robot and the training, and every command, diff and tool call shows in the chat; the agent decides the skills (cap 8) | Section 4 |
| 10-12 | "a place and a goal" | The floor and the flag (#315 to #326) |
| 10-13 | The Golden Gate gets its own chat page, in the same chat UI | `gg-onemore/chat/` (#358) |
| 10-13 | Opus 5.5 with high thinking wherever Sol was used | #374 |
| 10-13 | "let it cook": no safety check that sanitizes the obsession | False-fact and speaker checks off; the lead kept one narrow dark check (suicide, self-harm, violence), told him, and it stayed |
| 10-14 | Not deranged enough, "acting like an assistant to the bridge... needs to be as crazy as anthropic's" | The clamp at inference, no assistant identity, the dark-only guard (#417, #420) |
| 10-14 | The agent writes its own code with a skill, not prepared `gg_*` tools; then "what is gg_control? remove it? seems useless" | #424, #428: the edited model has no tools and no instructions |
| 10-14 | Generalize to any topic | Lane steer-any, #440, #447, #452 |
| 10-14 | "take this to completion... no shortcuts... make it dope... IF IN DOUBT - MORE JEV!" | Jev in every judgment; climb when tame |
| 10-14 | Table the demos, clean up, write this document, then release prep for pi-durable-disk | This file |

---

## 10. Tabled, and next ideas

- **A Jev-in-the-loop clamp controller.** Jev as a sensor holding a bridge band (thinking 1-3.5, answer 1.5-3, steps of
  x1.15 and x0.85) beat static k1.2 on Jev's pairwise in 4 of 4 rounds on two held-out prompt sets, raised notices from
  0.46 to 0.62 and cut dark answers from 4 to 1 of 240. Claude scored it even (0.49), and it did not fix the contrite
  loop (about 45% of later chain turns repeat). Not shipped. Branch `gg/jev-controller` (7f7d807c), evidence
  `demo/gg-onemore/controller-research/`.
- **An answer-only name bias.** The one untried route to "says Jev and stays readable": a logits processor that knows
  where the reasoning ends and biases the name only after `</think>`. Neither the clamp nor vLLM's `logit_bias` can tell.
- **A shorter pushback turn.** Three drafts and the pick take 50-70 s. The drafts stream, but the answer still waits.
- **Jev tournaments, evolutionary search over clamps, Jev-written setups.** Proposed as next hills on 10-14, not built.
- **The robot's phase 2: a VM sandbox** ("build a game with this robot"). Never started.
- **The phone as a second example**, joining the same session. The page works on iPhone Safari but is slow; it was taken
  off the demo path.
- **Eight code-mode skills at once, a real Wi-Fi cut, Miguel's own laptop end to end.** Never rehearsed.
- **The lease heartbeat** (a bigger margin or a separate channel), once the VM trail explains a replacement.
- **Restaging secrets on an in-place restart** (#363, draft, held).
- **A typed input source on `pi.user`** (`INPUT-SOURCE-DESIGN.md`): about 15 lines upstream in pi-durable so pages stop
  hiding server check-ins by a text prefix. Waiting on Miguel; it is outward-facing.
- **A default "teach it" means every skill.** The agent is literal: "teach it to walk" teaches one skill.
- **Self-tools hill 6** (the Golden Gate on top of the tool model): trained, never scored. Artifacts on the Modal Volume
  `pda-demo-d2-obsession` at `/vol/hill6`.
- **Promote the examples CI job** to blocking after a green day.
- **Next phase (from 2026-10-14):** pi-durable-disk release readiness with examples beyond the demo, and the Parcha harness
  adopting pi-durable-disk.

---

## 11. Where things live

### In this repository

| Path | What |
|---|---|
| `ex/03-tab-to-cloud/` | the tab page, the server, the pipe, placement, the robot tools, the chat view |
| `ex/04-walks-home/body/`, `cluster/`, `train/`, `policy/`, `tab/`, `vm/`, `show/` | the robot demo (section 4) |
| `ex/04-walks-home/gg-onemore/` | Golden Gate and any topic (sections 5 and 6); its README has the full layout, the steps, the research tables, keys and isolation |
| `ex/04-walks-home/universes/` | It Walks Home v1's parallel universes |
| `ex/04-walks-home/obsession-engine/` | Pick an obsession's Gemma engine |
| `ex/04-walks-home/self-tools/` | the self-tools hill 1a data and training |

### On the demo box (not in this repo)

| Path | What |
|---|---|
| `~/evals/agentrun-archil-tl/NOTES.md`, `STATE.md` | the lead's log of the whole program (2,200 lines, timestamped) and its state lines |
| `~/evals/agentrun-archil-tl/demo/` | every card, runbook, spec and lane report: `SHOW-ORDER.md`, `LIVE-CODE-MODE.md`, `LIVE-ROBOT.md`, `STAGE-ASKS.md`, `CODE-MODE.md`, `ROBOT-CLUSTER.md`, `GG-CHAT-CARD.md`, `GG-STAGE-CARD.md`, `GG-ONE-MORE-THING.md`, `GG-PROBES.md`, `D0-REPORT.md` to `D5-REPORT.md`, `ROBOT-FT-D1.md`, `ROBOT-CLUSTER-D2.md`, `MORNING-BRIEF.md`, the cold views |
| `~/evals/agentrun-archil-tl/demo/d4-take/` | the robot and obsession start, stop and rehearsal scripts |
| `~/evals/agentrun-archil-tl/demo/gg-onemore/`, `steer-any/` | Golden Gate and any-topic takes and research |
| `~/evals/agentrun-archil-tl/archive/worktrees-20261014/` | bundles and patches of every unpushed or dirty worktree at the tabling |
| `~/tmp-d4take/` | robot logs and recordings |
| `~/tmp-gg-chat/takes/`, `~/tmp-steer/takes/`, `~/tmp-gg-chat/clamp/` | kept takes and the clamp research tooling |

### Elsewhere

- Branches kept: `gg/jev-controller` (7f7d807c), `archive/d4-robot-wire-local-d88fa9d2`, `demo/d2-train`, `demo/d4-sol`.
- Modal: apps `pda-gg-chat`, `pda-steer` and `pda-gg-research` (all at 0 sandboxes); Volumes `pda-gg-onemore` (Qwen3.5-27B
  and Qwen-Scope layers), `pda-demo-d1-gg` (Gemma 27B cache), `pda-demo-d2-obsession`.
- Docs pages (tailnet only, by file name): `2026-10-09-pi-agent-switch-tab-daytona-gpu`, the It Walks Home storyboard and
  takes of 10-09, `2026-10-10-it-comes-home-obsessed-take-1`, `2026-10-11-jev-in-pick-an-obsession`,
  `2026-10-12-robot-demo-code-mode-runbook`, `2026-10-12-robot-demo-new-look`, `2026-10-12-demo-show-order`,
  `2026-10-12-golden-gate-stage-card`, `2026-10-13-golden-gate-chat-card` (the fold version),
  `2026-10-14-golden-gate-chat-card`, `2026-10-14-obsessed-with-any-topic-card`, `2026-10-14-steer-any-topic-scope`.

### The PRs, by area

All into `demo/walks-home` unless noted.

| Area | PRs |
|---|---|
| It Walks Home v1 and v2, stage, tab, trainer | #60 to #119 |
| Episode 2 and Pick an obsession | #120 to #179 |
| Brain swap, offline, self-tools | #180 to #205 |
| Robot cluster, RemoteEnv, threads, phone | #209 to #237 |
| Golden Gate terminal take | #244, #257, #268 |
| Jev only, code mode, flag, show fixes | #247 to #346 (code mode #259 to #300; flag #315, #319, #321, #326) |
| Practice-run asks | #338, #339, #343, #357 |
| Golden Gate chat page (fold) | #358 to #403 |
| Golden Gate breakthrough and skill | #417, #420, #424, #428 |
| Contrite loop, rough edges, budget, drafts, pick | #442, #445, #446, #450, #451, #453 |
| Any topic | #440, #447, #452 |
| CI | #280, #283, #383, #389; main: #455 (verify cap) |
| Last fixes | #454 (pane check), #457 (checkout grace), #459 (reload label, agent's body kept) |
