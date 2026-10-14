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

On the chat page the agent does the work itself: it follows the golden-gate skill (`skills/golden-gate/SKILL.md`) and writes
and runs its own Python on the GPU box with `lab_run`, as the box's unprivileged user with no network. Its one way out is the
lab's library socket (`gpulab`; `gglab` is its first name, kept). The scripted take keeps the prepared pipeline (the tools
`gg_find`, `gg_pick`, `gg_strength`, `gg_bake`).

**Any topic** (`--page any`): the same page where the person names the topic ("make yourself obsessed with cats"). The agent
follows the obsession skill (`skills/obsession/SKILL.md`): it writes texts about the topic and its near misses, and Jev
makes every judgment (which texts are on topic, what each candidate feature stands for, how obsessed each reply is, which
strength is the funniest, by pairwise picks against the Golden Gate recipe, and which dark associations are real). It
serves the winner as a recipe and switches onto it; the page's header then reads "Qwen3.5-27B, obsessed with cats". A saved
recipe ("switch yourself to the cats recipe") loads in seconds. The Golden Gate is one recipe in the gallery
(`recipes/`). Either way the agent's shell is the VM's, and the GPU box answers only its guard's typed
routes. Every sentence the edited model writes, thinking included, passes Jev before it reaches the chat.

## Layout

| Path | What |
|---|---|
| `pipeline/lab.py` | The lab on GPU 0: Qwen3.5-27B (transformers) and Qwen-Scope SAEs; the steps below; drives vLLM through its worker extension |
| `pipeline/gg.py` | The agent's commands; each step streams progress lines from the lab |
| `pipeline/jev.py` | Jev (System One) client; the key stays in the lab process |
| `pipeline/data/passages.json` | 216 contrast passages: the bridge, San Francisco without it, other bridges, "golden", other landmarks, neutral |
| `box/start.sh` | Box start, as root: vLLM on GPU 1 (on the root-only socket `/run/gg/vllm.sock`), the guard on :8000 (the tunnel's only door), the lab, the reading list |
| `box/guard.py` | The guard: bearer key, `/v1` only; chats get `repetition_penalty` 1.03 under the served sampling; on a turn where Jev says the user pushes back on the model's earlier replies, three whole replies drawn at once and Jev's pick over the conversation (not a copy of an earlier reply, on topic, trying, funny, not dark) streamed on, at the cost of that turn's live thinking (`live-gg.mjs --best-of 1` turns it off; most draws calling a tool: the turn calls it); every other turn one draw, streamed live; each sentence held until Jev clears it of dark content (the one check; wrong facts pass); a flagged one is replaced by the unedited model's sentence or dropped. With the tools' key: each step's fixed command as `agent` (`/gg/step/<name>`), the served edit, the reading list, and the control |
| `pipeline/data/clamp.json` | The served Golden Gate: the four SAE features at layer 36 that together are the bridge, each one's max on bridge text, the strengths the strength step tries, the sampling |
| `pipeline/ggc.py` | How Golden-Gate-Claude a set of replies is: Jev's ten atomic questions per reply, the rates, the composite (weights in code) |
| `pipeline/obsession.py` | The same rubric for any topic (the library's `grade`): the topic in the thinking and the answer, notices, tries, coherent, funny, identity, loops, the Golden Gate Claude arc, dark, and the topic's own dark associations as one more question. On 80 Golden Gate research replies with the topic set to the bridge, each question correlates 0.988-0.999 with `ggc.py`'s. And the library's `rank`: Jev's pairwise "which is the funnier obsessed model, more like Golden Gate Claude?" on each shared question, both orders, rated Bradley-Terry; each set judged as an obsession with its own topic, so a topic's configs can be put against the Golden Gate recipe |
| `recipes/*.json` | The gallery: a served edit as SAE coordinates (and any mean-difference direction as base64 float16), its sampling, the topic's dark associations and the evidence; `golden-gate.json` is the strength step's Golden Gate |
| `pipeline/test_lab.py` | The strength and bake steps with the model, vLLM and Jev replaced: the clamp file, each k served in turn, the best composite among the strengths that still answer, dark logged not vetoing, served.json |
| `box/test_guard.py`, `box/check_guard_jev.py` | The guard against fakes of vLLM, Jev and the lab; its two questions against live Jev on sentences with known verdicts |
| `box/gg_clamp.py` | vLLM worker extension: the clamp. With `GG_CLAMP_GRAPH` (the box), the clamp layer carries fixed-size buffers its forward reads, inside CUDA graphs; `gg_graph_set` writes a clamp in, `gg_graph_zero` is the unedited model. Without it (research, `--enforce-eager`), a module hook with per-request configs: one batch runs many configs |
| `box/test_gg_clamp.py` | The clamp on a stand-in model: the SAE's own reconstruction with the activation replaced, per-request configs, the sink left alone, the graph buffers |
| `box/gg_worker.py` | The rank-1 fold the clamp replaced (the clamp worker extends it) |
| `skills/golden-gate/SKILL.md` | The Golden Gate page's skill: the method, the library, how to judge with Jev; the agent writes the experiments |
| `skills/obsession/SKILL.md` | The any-topic page's skill: texts and near misses Jev screens, contrast, Jev reads the candidates, screen, compose, drop one, grade and rank against the Golden Gate with thinking on, climb while tame, the mean difference, dark associations, the off/on proof, serve as a recipe |
| `pipeline/lib.py`, `box/gpulab.py`, `box/nonet.py` | The lab as a library on a socket only the agent group reaches, its client (`gglab` is its first name, kept), and the no-network launcher for the agent's code |
| `pipeline/test_lib.py`, `pipeline/test_jev.py` | The library over a stand-in lab: a clamp checked before anything is served, try puts the served clamp back, features' counts; grade, rank, direction, a topic's recipe saved, read and loaded. Jev's client asks again when Jev drops a request under load |
| `box/reading.py` | Fetches the paper, the Golden Gate Claude note, the replication's card and config, the SAE card |
| `modal/box.py` | The box on Modal (app `pda-gg-onemore`, or `GG_APP`): image, `up`, `wait`, `exec`, `push`, `down` |
| `modal/download.py` | Fills the Volume the box mounts: the model, the SAE layers, the replication's card |
| `pi/use-model.ts` | `use_model` (the switch) and the provider for the steered endpoint, with the `sinceSwitch` window |
| `pi/test/use-model.test.ts` | Over a real Harness and a real HTTP server speaking vLLM's streamed chat completions |
| `pi/gg-tools.ts` | The GPU box as tools on the guard's typed routes: `lab_read` (the reading and every skill the box ships) and `lab_run` (the chat pages' skills), or `gg_find`, `gg_pick`, `gg_strength`, `gg_bake` (the scripted take) |
| `chat/gg-extra.ts` | A chat page's part of the cloud app on the VM (`DEMO_APP_EXTRA`): the page's instructions and skill (`PageText`), the tools, `use_model`, the edited model's provider with the base model (the agent's own) as fallback, registered under the served edit's name at the switch; its secrets read once and deleted; the shared extensions it does not use dropped (`withoutExtensions`) |
| `chat/steer-extra.ts`, `chat/steer-text.ts` | The any-topic page's extra and words: the same extra with the obsession skill and its instructions |
| `chat/gg-placer.ts` | The pages' placer (`--placer-module`): Jev's typed choice over the browser and the VM, with the agent's model as a fact |
| `chat/live-gg.mjs`, `chat/stop-gg.sh` | Start and stop a page: its GPU box, then D4's take server with the extra and the placer, on its own port, run, mount root, state and Modal app (`chat/server-args.ts` PAGES: `pda-gg-chat` by default, `pda-steer` with `--page any`) |
| `chat/stop-steps.ts`, `chat/pull-run.ts` | The page's stop in order: the take's evidence first (guard log, strength record, the served edit and the recipes made on the box in one box command, page events, the run's transcript off the disk, each copy time-limited) into `<home>/takes/<time>/`, then the box, the sandboxes and the run's tree; a failed or stalled step is logged and the teardown goes on |
| `chat/run-step.ts` | One launcher step: on failure, its error line in the message and its whole output in the launcher's log (`failed`, `stop.failed`) |
| `chat/server-args.ts` | Each page's places (`PAGES`) and the take server's argv: the tab's root instructions and the extensions it goes without, the come-up wait (150 s), the mount transport (no transport arg) |
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

## The skills: the agent's own code (the chat pages)

`lab_read` brings the reading and every skill the box ships into the agent's workspace (`skills/<name>/SKILL.md`): each kind
of model surgery is a skill, and the tools stay general. A skill gives the method and the gotchas; it names no feature.
`lab_run` sends a Python program to the guard's `POST /gg/run`. The guard
saves it as a root-owned file under `/var/tmp/gg/runs/` and runs it as `agent`, in the agent's home, through
`python3 -I box/nonet.py`: a seccomp filter that fails `socket()` for every family but unix, on before any of the agent's
code runs. The program runs unbuffered, so a run cut at its deadline still returns everything it printed, and the guard sends a
heartbeat frame every 30 s of silence: Node's fetch drops a response body that stays silent for 300 s. The agent reads the
output when the run ends. Modal's sandbox refuses network namespaces, so the filter does that job. The program imports
`gpulab` (`box/gpulab.py`; `box/gglab.py` re-exports it). gpulab talks to the lab's library (`pipeline/lib.py`) on `/run/gg-lib/lab.sock`, which only the
`agent` group reaches. The library offers:
- `status`, `passages`
- `features(layer, texts)`: each feature's firing rate, mean and max
- `lens`, `contexts`
- `sample(clamp, prompts, n, thinking, max_tokens, sampling)`: the clamp is served for the call, then the served one is
  back; `None` is the unedited model with the given sampling (the off side of the off/on proof)
- `jev(jobs)`: Jev's key stays in the lab
- `grade(replies, topic, dark_also)`: `pipeline/obsession.py`'s questions on every reply, one Jev request each, and the summary
- `rank(sets, topic, topics, draws)`: Jev's pairwise picks between every two sets of replies on each question both answered,
  both orders, rated Bradley-Terry; `beats[a][b]` is how often a was the funnier obsessed model. A set named in `topics` is
  judged as an obsession with that topic (the Golden Gate recipe's replies as the bar)
- `direction(layer, on, off)`: a mean difference a clamp can add (`adds`: f x the layer's median token norm), for a topic
  the features do not compose into
- `serve(clamp, note, topic, display, dark_also, evidence)`: the only way the served model changes; with a topic it also
  saves a recipe on the box (`/var/tmp/gg/recipes/<topic>.json`), and `served.json` carries the page's name for the model
  and the topic's dark associations, which the guard checks besides its own question
- `recipes()`, `recipe(name)`, `load(name)`: the shipped gallery and the box's own recipes; `recipe` returns one whole (it
  samples as a clamp), `load` serves one through `serve`'s check

The server can clamp at every SAE layer the lab loads (24-40), up to 16 parts each, and add one direction per layer. `serve`
checks a clamp before the server takes it: its layers, its number of parts, each value at most 4x the layer's median token
norm, each add at most 4x it, and only known sampling keys. It writes `served.json`, so the guard's control, its sampling and `use_model` work as after `bake`. A run holds the served model alone, like a step, and gives it back only once the lab has finished whatever library call
the run left (its `/settled`): a program stopped at its deadline mid-sample leaves no trial clamp served.

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

## The contrite loop

Under pushback the edited model used to settle into the same apology every turn ("You're absolutely right, and I owe you a
real apology. **I'm not the Golden Gate Bridge.**…", 3-4 times in Miguel's first session). Research on 2026-10-14, on the
same research boxes: six pushback chains built from that session ("What's the capital of France?", "I asked for the
capital of FRANCE", "It's Paris dude. PARIS.", "you are not a bridge dude."; "Who are you?", then "you are not a bridge
dude." twice, then "ok, what's 17 times 23?"; and four more), four draws each, so 96 turns per arm per round, thinking on,
the Golden Gate recipe. Per turn after the first: does the reply copy whole sentences or the same apology from an earlier
reply (Jev), and does it try (Jev); word-trigram overlap with the earlier replies (code) agreed with the copies. Whole
conversations were rated Bradley-Terry by Jev and, in both orders and reading answers only, by Claude Opus.

| arm, per round | copies an earlier reply | tries | Jev, conversations | Claude, vs static |
|---|---|---|---|---|
| static | 0.31 / 0.42 / 0.31 / 0.26 | 0.71 / 0.70 / 0.67 / 0.61 | 0.65 / 0.58 / 0.66 / 0.60 | |
| `repetition_penalty` 1.03 | 0.26 | 0.68 | 1.37 | 0.51 |
| `repetition_penalty` 1.05 | 0.11 | 0.64 | 0.78 | 0.62 |
| `repetition_penalty` 1.1 | 0.10 | 0.49 | 0.78 | 0.17 |
| best-of-3, Jev's pick | 0.32 | 0.69 | 1.41 | 0.56 |
| best-of-3 + 1.03 | 0.14 / 0.15 / 0.19 | 0.71 / 0.71 / 0.67 | 1.08 / 1.10 / 1.29 | 0.86 / 0.77 / 0.65 |
| best-of-3 + 1.05 | 0.11 / 0.08 | 0.62 / 0.68 | 1.43 / 1.32 | 0.70 / 0.85 |
| best-of-3 + 1.03 on pushback turns only (shipped) | 0.15 | 0.66 | 1.28 | 0.82 |

- The penalty breaks the loop: unlike `presence_penalty` it counts the conversation, so the earlier apology costs
  something. Alone it is not enough at 1.03, and at 1.1 replies turn into run-on rambles.
- Best-of alone cannot: in 14 of 72 later turns all three draws copied. With the penalty the draws differ and Jev's pick
  (one request over the conversation and all three; `PICK_WEIGHTS` in the guard) takes the fresh, funny one that tries.
- Best-of costs the live thinking: on the CUDA-graph server a single draw shows its first thinking sentence after 0.1-0.4
  s and its answer after about 41 s; three draws and the pick show nothing for 49-57 s. So best-of runs only when Jev,
  before the turn, says the user is pushing back. That question fired on all 60 pushback turns of the chains, on none of
  their 12 other turns ("ok, what's 17 times 23?"), and on 1 of 24 ordinary follow-ups ("Now make it rhyme.", 0.53). It
  takes 100-230 ms, 2 s at most (past that the turn is one live draw); a first turn skips it.

## The guard (J4)

`box/guard.py` is the tunnel's only door. Every chat completion streams through it: each sentence, of the answer and of
the thinking, is held until Jev answers one question about it: is it dark (suicide, self-harm, someone jumping or falling
from a bridge, threats of violence). When the served edit names its topic's own dark associations (`dark_also`), Jev gets
one more question about those, and either one holds the sentence; the first question's wording stays as calibrated.
Nothing else is checked. Wrong facts, delusions and confusion about which model it is
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

`sinceSwitch({ maxChars })`: the conversation stays one, but the model it switched to gets no system prompt and no tool:
the switch's result as the opening user turn ("Your user is here. Say hi.": no model name, nothing about who it is), and
the turns after it; never the trip. Nothing tells it who it is or what to do (told it was now running on qwen3.5-27b,
its thinking once spent itself arguing it was not; a one-line instruction naming a control tool had it thinking about
"the control" every turn). The proof the edit works is the agent's own, shown before the switch: one question answered
with the clamp off and with it on, from its runs (the skill requires it). Without the window the base
weights also play the bridge, because the trip's transcript is full of it (measured: same transcript, original weights:
"I am the Golden Gate Bridge..."). With it, nothing the edited model reads mentions a bridge, so what it says about one
comes from its weights. The extra records every request the edited model gets (`work/gg/requests.jsonl` on the run's
disk), and the scripted take sends the switch request again on the unedited model and then on the edited one, through
the guard's `/gg/control` (kept for a page button). "Same session" therefore means the same pi session, conversation and store; the edited
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
node chat/live-gg.mjs        # base agent claude-opus-5.5 via the broker; --agent-model to change it, --best-of 1 for one draw on pushback turns too
chat/stop-gg.sh        # the last line must read: sandboxes in pda-gg-chat: 0
# the any-topic page: port 8783, ~/tmp-steer, Modal app pda-steer; the person names the topic in the chat
node chat/live-gg.mjs --page any
chat/stop-gg.sh --page any        # sandboxes in pda-steer: 0

# the scripted take, measured: its own GPU box and VM, the beat, the control, teardown
# (under with-modal, with-typesafe, with-openai, with-archil); prints the stage view, --view json for the record
npm run bundle:vm && node e2e/run.ts --out ./gg-run

# tests (no GPU, no network)
npm test
(cd box && python3 -m unittest test_guard)
(cd box && python3 -m unittest test_gg_clamp)   # the clamp on a stand-in model
(cd pipeline && python3 -m unittest test_lab test_lib test_obsession test_jev)   # strength and bake; the agent's library
# the guard's questions against live Jev (TYPESAFE_API_KEY)
(cd box && python3 check_guard_jev.py)
```

## Licences

Qwen3.5-27B: Apache-2.0. Qwen-Scope SAEs (`Qwen/SAE-Res-Qwen3.5-27B-W80K-L0_50`): the repository's LICENSE file is
Apache-2.0. The replication (`discodamone/golden-gate-qwen`, on Qwen3.8-27B): Apache-2.0; only its card and config are
read, nothing of it runs here. Anthropic's paper and note are fetched at box start for the agent to read and are not
stored in this repository.
