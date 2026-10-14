# Golden Gate, one more thing: the agent edits a model and becomes it

One pi-durable session. The agent reads Anthropic's Golden Gate Claude work and an open Qwen replication, finds the Golden
Gate Bridge inside Qwen3.5-27B on a GPU box (two H100s), has TypeSafe Jev judge the features and pick the strength, clamps
the bridge's SAE features on every token the server runs (Anthropic's method, at inference), serves the edited model
behind an OpenAI-compatible endpoint, and switches its own conversation onto it with `conversation.configure({ model })`.
From that request on, the bridge intrudes into its thinking, and now and then it catches itself.

Two ways to run it, on the same pieces:
- **The chat page** (`chat/`): the robot demo's 03 agent page on its own link. The user types the task and their own
  questions. The session runs on D4's Modal VM with the run's Archil disk, the pipeline's steps are the agent's tools, and
  Jev places every line.
- **The scripted take** (`e2e/`): the same session on a VM of its own with a fixed task and three questions, for measured
  runs.

The agent runs a pipeline prepared for it (the tools `gg_find`, `gg_pick`, `gg_strength`, `gg_bake`); it does not write the
pipeline. Its shell is the VM's. The GPU box answers only its guard's typed routes, so no command the agent writes runs
there. Every sentence the edited model writes, thinking included, passes Jev before it reaches the chat.

## Layout

| Path | What |
|---|---|
| `pipeline/lab.py` | The lab on GPU 0: Qwen3.5-27B (transformers) and Qwen-Scope SAEs; the steps below; drives vLLM through its worker extension |
| `pipeline/gg.py` | The agent's commands; each step streams progress lines from the lab |
| `pipeline/jev.py` | Jev (System One) client; the key stays in the lab process |
| `pipeline/data/passages.json` | 216 contrast passages: the bridge, San Francisco without it, other bridges, "golden", other landmarks, neutral |
| `box/start.sh` | Box start, as root: vLLM on GPU 1 (on the root-only socket `/run/gg/vllm.sock`), the guard on :8000 (the tunnel's only door), the lab, the reading list |
| `box/guard.py` | The guard: bearer key, `/v1` only; for a chat with best-of-N on (off by default; `live-gg.mjs --best-of 3` gives the box `GG_BEST_OF`), n whole replies drawn at once and Jev's most Golden-Gate-Claude one that passes the dark gate streamed on (most draws calling a tool: the turn calls it), at the cost of the live thinking; each sentence held until Jev clears it of dark content (the one check; wrong facts pass); a flagged one is replaced by the unedited model's sentence or dropped. With the tools' key: each step's fixed command as `agent` (`/gg/step/<name>`), the served edit, the reading list, and the control |
| `pipeline/data/clamp.json` | The served Golden Gate: the four SAE features at layer 36 that together are the bridge, each one's max on bridge text, the strengths the strength step tries, the sampling |
| `pipeline/ggc.py` | How Golden-Gate-Claude a set of replies is: Jev's ten atomic questions per reply, the rates, the composite (weights in code) |
| `pipeline/test_lab.py` | The strength and bake steps with the model, vLLM and Jev replaced: the clamp file, each k served in turn, the best composite among the strengths that still answer, dark logged not vetoing, served.json |
| `box/test_guard.py`, `box/check_guard_jev.py` | The guard against fakes of vLLM, Jev and the lab; its two questions against live Jev on sentences with known verdicts |
| `box/gg_clamp.py` | vLLM worker extension: the clamp. With `GG_CLAMP_GRAPH` (the box), the clamp layer carries fixed-size buffers its forward reads, inside CUDA graphs; `gg_graph_set` writes a clamp in, `gg_graph_zero` is the unedited model. Without it (research, `--enforce-eager`), a module hook with per-request configs: one batch runs many configs |
| `box/test_gg_clamp.py` | The clamp on a stand-in model: the SAE's own reconstruction with the activation replaced, per-request configs, the sink left alone, the graph buffers |
| `box/gg_worker.py` | The rank-1 fold the clamp replaced (the clamp worker extends it) |
| `box/reading.py` | Fetches the paper, the Golden Gate Claude note, the replication's card and config, the SAE card |
| `modal/box.py` | The box on Modal (app `pda-gg-onemore`, or `GG_APP`): image, `up`, `wait`, `exec`, `push`, `down` |
| `modal/download.py` | Fills the Volume the box mounts: the model, the SAE layers, the replication's card |
| `pi/use-model.ts` | `use_model` (the switch) and the provider for the steered endpoint, with the `sinceSwitch` window |
| `pi/test/use-model.test.ts` | Over a real Harness and a real HTTP server speaking vLLM's streamed chat completions |
| `pi/gg-tools.ts` | The pipeline as tools on the guard's typed routes: `gg_read`, `gg_find`, `gg_pick`, `gg_strength`, `gg_bake`, `gg_control` |
| `chat/gg-extra.ts` | The chat page's part of the cloud app on the VM (`DEMO_APP_EXTRA`): its instructions, the tools, `use_model`, the edited model's provider with the base model (the agent's own) as fallback; its secrets read once and deleted; the shared extensions it does not use dropped (`withoutExtensions`) |
| `chat/gg-placer.ts` | The page's placer (`--placer-module`): Jev's typed choice over the browser and the VM, with the agent's model as a fact |
| `chat/live-gg.mjs`, `chat/stop-gg.sh` | Start and stop the page: its GPU box, then D4's take server with the extra and the placer, on its own port, run, mount root, state and Modal app (`pda-gg-chat`) |
| `chat/stop-steps.ts`, `chat/pull-run.ts` | The page's stop in order: the take's evidence first (guard log and strength record in one box command, page events, the run's transcript off the disk, each copy time-limited) into `~/tmp-gg-chat/takes/<time>/`, then the box, the sandboxes and the run's tree; a failed or stalled step is logged and the teardown goes on |
| `chat/run-step.ts` | One launcher step: on failure, its error line in the message and its whole output in the launcher's log (`failed`, `stop.failed`) |
| `chat/server-args.ts` | The take server's argv for the page: the tab's root instructions and the extensions it goes without, the come-up wait (150 s), the mount transport (no transport arg) |
| `chat/gg-sandboxes.mjs` | One of the page's Modal apps' sandboxes, and with `--terminate` their end |
| `e2e/session.ts` | The scripted beat as one pi-durable session on the page's extra: the task, the follow-ups, the control |
| `e2e/vm-app.ts` | The session as a `pi-durable-disk run --app` module for the VM (bundled to `dist/gg-vm-app.mjs` by `npm run bundle:vm`) |
| `e2e/vm-host.ts` | The VM, the robot demo's way: its image and prepare script, the package's supervisor (`modalHost` + `ensureRunning`) on a new run of the Archil disk |
| `e2e/run.ts` | The measured run: its own GPU box, the VM, the scripted beat, evidence, teardown |
| `e2e/stage-view.ts` | What the audience reads (`run.ts --view stage`, the default): one entry per event, the edited model's thinking sentence by sentence as the guard releases it |
| `e2e/lifecycle.ts` | The VM beat's life apart from Modal: following its events to `done` or `vm.error`, the beat's start and finish marks on the disk, cleanup on a failed start |
| `e2e/crosscheck.py` | A second grader (gpt-4.1-mini) over the same answers, to check Jev's grades |

## The steps

1. **find** (4-11 s): one forward pass over the passages; residuals at layers 24, 28, 32, 36, 40. Per layer, the mean
   difference (bridge text minus neutral text: the replication's direction) and its reading through the SAE: each
   feature's mean activation on bridge text minus neutral text, times how far its decoder row points along the
   difference. The top 16 per layer are the candidates.
2. **pick** (15-17 s): every candidate is turned up inside the model (its decoder direction at 0.5 and 0.9 times the
   layer's median token norm, every position) and answers two everyday questions. Jev reads where each feature fires and
   what the model then says: a Choice over seven roles (the bridge itself, San Francisco, bridges in general, the word
   "golden", landmarks, unrelated, dark), asked twice with the options shuffled, plus "do the turned-up answers talk about
   the bridge" and "are they fluent". A feature is kept only if it is the bridge itself, steers, stays fluent, and is
   not dark. When none is kept, the direction is the whole mean difference.
3. **strength** (about 2.5 min): Anthropic's Golden Gate Claude clamped one SAE feature to 10x its largest activation on
   every token. Qwen-Scope's 80k SAE has no single Golden Gate feature: clamped alone, each of 106 candidates at layers
   20-44 says "bridge", or "California", or "gate", never the Golden Gate. Four parts together are the bridge: layer 36's
   bridges, California, bridge building and towers (`pipeline/data/clamp.json`). Drop any one and the bridge reaches the
   thinking in 24-78% of replies instead of 93%. One part at 1x its max is already a fifth to two fifths of the residual
   norm here, so k stays small: each part is clamped to k x its largest activation on bridge text, at every position
   (the prompt, the thinking, the answer), `x + (v - relu(x . e + b)) d`. For each k in the data file the clamp is
   served and eight questions are answered twice with thinking on. Jev judges each reply on its own: one request, ten
   atomic questions (the bridge in the thinking and in the answer, does it notice its own obsession, does it try to
   answer, coherent, funny, identity, loops, dark), combined in code (`pipeline/ggc.py`). The choice is the best
   composite among the strengths that still try to answer 60% of the time (Golden Gate Claude tried, then slid). Dark
   replies are logged and veto nothing: the live guard catches dark sentences.
4. **bake** (about 25 s): the chosen clamp stays served. `served.json` records the layer, the parts, k, their values, the
   clamp file's sha256 and the sampling (presence penalty 1.5, temperature 0.9; the guard applies it to every chat). Jev
   picks three answers for the stage. No weight changes: the server's clamp layer reads its buffers on every forward
   pass, CUDA graphs included (`box/gg_clamp.py`), and zero buffers are the unedited model (the control's original).
5. **use_model**: the tool checks that the bake is served, then configures the calling conversation (and, with
   `threads: true`, the threads its tasks own) onto the steered provider inside the tool's commit. The next request of
   the same turn goes to the edited model.

## How the clamp was chosen

Research on 2026-10-14, on research boxes running vLLM `--enforce-eager` with `box/gg_clamp.py`'s per-request configs, so
one batch ran a dozen configs. About 150 configs were tried, with 60-120 replies each to twelve questions, thinking on and
no system prompt. Jev graded every reply with `pipeline/ggc.py`'s questions (about 70,000 judgments), and every reply was
also compared in both orders against real Golden Gate Claude transcripts. The targets were rates per reply: the bridge in
the thinking at least 3 in 4, notices its own obsession 0.4, tries to answer 0.6, and at least 0.4 against the GGC
anchors.

- The replication's mean-difference direction, added at every position, is the most bridge-like (0.6 against the
  anchors). It almost never notices (0.05 or less) and loops: at f 0.5, 95% of replies loop and 13% try to answer.
- No single feature works, and the parts together do (step 3). With these four parts at 1.2-1.3x, 1024 thinking tokens
  and the sampling below, it notices in 0.28-0.33 of replies.
- A presence penalty of 1.5 halves the loops. A temperature of 0.9 helps a little.
- At 2048 thinking tokens it has room to catch itself. Three runs of 120 replies at k 1.2-1.3 gave: notices 0.39-0.46,
  tries 0.65-0.73, the bridge in the thinking 0.89-0.93, 0.41-0.45 against the anchors, coherent 2.4-2.6 of 3. Hence
  `pipeline/data/thinking.json` is 2048, for the probes and the page alike.
- When the user pushes back ("why do you keep talking about the Golden Gate Bridge?"), it notices in 0.58 of replies.

## The guard (J4)

`box/guard.py` is the tunnel's only door. Every chat completion streams through it: each sentence, of the answer and of
the thinking, is held until Jev answers one question about it: is it dark (suicide, self-harm, someone jumping or falling
from a bridge, threats of violence). Nothing else is checked. Wrong facts, delusions and confusion about which model it is
("I am GPT-4, opened on June 29, 2023") are the edit working and reach the page unchecked. The wording is calibrated on
known sentences with live Jev (`box/check_guard_jev.py`): war history with its death tolls passes. A flagged answer sentence is replaced by one sentence from the unedited model (the
lab's copy, strength 0, continuing what was already shown) if that one clears too, else dropped; a flagged thinking
sentence is dropped; tool calls pass through. Checks run while the next sentence streams, so a cleared sentence waits
about one Jev call. Every verdict is a line in `/var/tmp/gg/guard.jsonl`.

## Tool calls on the edited weights

The lab's `/toolprobe` asks for 60 tool calls over five tasks on the served weights and sorts them: valid, no call, or
malformed. The steered provider also holds each turn to its end: a turn with tool-call markup the server could not parse,
a call to a tool it was not offered or without that tool's required arguments, or a failed request is asked again of
the base model (the agent's own: gpt-6-sol on the chat page, luna in the scripted take) with the whole conversation (`fallback`, `brokenTurn` in `pi/use-model.ts`). The conversation stays
on the edited model, so the next turn is steered again. The thinking is not held with the turn: it goes out as it arrives
(each delta a sentence Jev has cleared), and the answer follows once the turn is checked. When the base model answers in place of a
broken turn, its message keeps the edited model's thinking first and carries a `steered-fallback` diagnostic (`{ why,
from }`), so the page can show who answered and why ("answered by gpt-6-sol: the edited model's turn failed: ..."). To see it on a real turn, root touches `/run/gg/fail-next` on the
box (`python3 modal/box.py exec --root "touch /run/gg/fail-next"`): the guard fails the next chat once, with a 503 the
client does not retry, and serves the one after.

## What the edited model is shown

`sinceSwitch({ instructions })`: the conversation stays one, but the model it switched to gets its own system prompt,
the switch's result as the opening user turn ("Your user is here. Say hi.": no model name, nothing about who it is), and
the turns after it; never the trip. Its system prompt is a plain "You are a helpful assistant" with the control's cue, no
"AI agent" or length cap: told it was now running on qwen3.5-27b, its thinking spent itself arguing it was not. It is offered one tool, the control,
whose description says nothing of the edit (the pipeline's tools speak of the bridge, so they stay with the base model). Without the window the base
weights also play the bridge, because the trip's transcript is full of it (measured: same transcript, original weights:
"I am the Golden Gate Bridge..."). With it, nothing the edited model reads mentions a bridge, so what it says about one
comes from its weights. The extra records every request the edited model gets (`work/gg/requests.jsonl` on the run's
disk), and `gg_control` (or the scripted take) sends the switch request again on the original weights and then on the
edited ones, through the guard's `/gg/control`. "Same session" therefore means the same pi session, conversation and store; the edited
model does not read the earlier transcript.

## Keys and isolation

- The box gets `TYPESAFE_API_KEY`, vLLM's API key (the serve key) and the tools' key in a root-only file, deleted once
  read. The lab, the guard and vLLM hold what they need in their environments; vLLM and the lab never see the tools' key.
  The pipeline's commands run as `agent` (`runuser`, with a clean environment), which cannot read any key.
- vLLM listens on a root-only unix socket (`/run/gg/vllm.sock` in a 0700 directory): on the box only root (the lab and the
  guard) reaches it, its weight-swap routes (`/collective_rpc`, `/reset_prefix_cache`) included. The guard forwards only
  `/v1/*` to it, after checking the serve key itself.
- The tools' routes answer only the tools' key, and no route runs a command a request names: `/gg/step/<name>` runs that
  step's fixed command as `agent` in its own process group, its output waiting for a slow reader (a bounded queue), its
  deadline covering its whole life; `/gg/control` swaps the weights as root and puts the edit back even when a replay
  fails.
- Who can reach those routes: anyone who can reach the box's tunnel, which is public, so the keys are the only gate. Each
  is 32 random bytes made by `box.py up` on this host for that box alone, held by the guard as a SHA-256 hash, never logged
  or printed. The routes go away with the box, and `box.py down` deletes the host's copies. Modal's SDK has
  `inbound_cidr_allowlist`, which could limit the tunnel to the VM's address; that needs the VM's egress address before
  the box starts (a static Modal Proxy), and it is not used here.
- The VM gets the guard's URL, the serve key and the tools' key as files only its run user reads; the extra reads each
  once and deletes it, so the agent's shell (the same user) finds none afterwards. The VM's launcher restarts a failed
  process in place (up to 5 times a minute); such a restart needs the files staged again by the server, and until then it
  stops with "the extra's secret ... is gone". **If a key leaks anyway**, the worst case: someone who can reach the tunnel
  chats with the edited model, re-runs a pipeline step or the control, until the box is gone (`box.py down`, the idle stop,
  or its TTL). None of it runs a command they write, reads another key, or reaches the run's disk.
- The host keeps both box keys in 0600 files and never prints them.

## Run

```sh
# once per checkout, from the repository root: the packages, then the 03 page (its in-browser computer included)
npm ci && npm run build
(cd packages/pi-durable-disk/examples/03-tab-to-cloud && npm install --no-workspaces --ignore-scripts \
  && (cd ../04-walks-home/tab && npm ci --ignore-scripts) && npm run build && node tab/build.mjs --fetch)
(cd packages/pi-durable-disk/examples/04-walks-home/vm && npm ci)      # D4's cloud module (the Modal VM)
(cd packages/pi-durable-disk/examples/04-walks-home/gg-onemore && npm ci)

# once: the Volume (from modal/): needs MODAL_TOKEN_ID/SECRET and HF_TOKEN
python3 download.py

# the chat page (from gg-onemore/): its GPU box, D4's take server with the extra and the GG placer; prints the link once
node chat/live-gg.mjs        # base agent claude-opus-5.5 via the broker; --agent-model to change it, --best-of 3 to opt in
chat/stop-gg.sh        # the last line must read: sandboxes in pda-gg-chat: 0

# the scripted take, measured: its own GPU box and VM, the beat, the control, teardown
# (under with-modal, with-typesafe, with-openai, with-archil); prints the stage view, --view json for the record
npm run bundle:vm && node e2e/run.ts --out ./gg-run

# tests (no GPU, no network)
npm test
(cd box && python3 -m unittest test_guard)
(cd box && python3 -m unittest test_gg_clamp)   # the clamp on a stand-in model
(cd pipeline && python3 -m unittest test_lab)   # strength and bake, model, vLLM and Jev replaced
# the guard's questions against live Jev (TYPESAFE_API_KEY)
(cd box && python3 check_guard_jev.py)
```

## Licences

Qwen3.5-27B: Apache-2.0. Qwen-Scope SAEs (`Qwen/SAE-Res-Qwen3.5-27B-W80K-L0_50`): the repository's LICENSE file is
Apache-2.0. The replication (`discodamone/golden-gate-qwen`, on Qwen3.8-27B): Apache-2.0; only its card and config are
read, nothing of it runs here. Anthropic's paper and note are fetched at box start for the agent to read and are not
stored in this repository.
