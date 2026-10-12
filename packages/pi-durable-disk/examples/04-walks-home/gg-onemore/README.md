# Golden Gate, one more thing: the agent edits a model and becomes it

One pi-durable session, on a cloud box with two H100s. The agent reads Anthropic's Golden Gate Claude work and an open Qwen
replication, finds the Golden Gate Bridge inside Qwen3.5-27B, has TypeSafe Jev judge the features and pick the strength,
writes the steering into one layer's weights, serves the edited model behind an OpenAI-compatible endpoint, and switches
its own conversation onto it with `conversation.configure({ model })`. From that request on, it talks as the bridge.

The agent runs a pipeline prepared for it (`gg find`, `gg pick`, `gg strength`, `gg bake`); it does not write the
pipeline. The pi session runs the robot demo's way: on a Modal VM that mounts the run's Archil disk (the package's claim,
lease and store on that disk), luna called from the VM; the agent's commands run only on the GPU box, as the unprivileged
user `agent`, through the guard. Every sentence the edited model writes passes Jev before it reaches the chat.

## Layout

| Path | What |
|---|---|
| `pipeline/lab.py` | The lab on GPU 0: Qwen3.5-27B (transformers) and Qwen-Scope SAEs; the steps below; drives vLLM through its worker extension |
| `pipeline/gg.py` | The agent's commands; each step streams progress lines from the lab |
| `pipeline/jev.py` | Jev (System One) client; the key stays in the lab process |
| `pipeline/data/passages.json` | 216 contrast passages: the bridge, San Francisco without it, other bridges, "golden", other landmarks, neutral |
| `box/start.sh` | Box start, as root: vLLM on GPU 1 (127.0.0.1:8001), the guard on :8000 (the tunnel's only door), the lab, the reading list |
| `box/guard.py` | The guard: bearer key, `/v1` only, each sentence held until Jev clears it (not dark, not a false fact); a flagged one is replaced by the unedited model's sentence or dropped. With its own key, `/gg/exec` runs commands as `agent` for a session hosted elsewhere |
| `box/test_guard.py`, `box/check_guard_jev.py` | The guard against fakes of vLLM, Jev and the lab; its two questions against live Jev on sentences with known verdicts |
| `box/gg_worker.py` | vLLM worker extension: replace one MLP output matrix in place |
| `box/reading.py` | Fetches the paper, the Golden Gate Claude note, the replication's card and config, the SAE card |
| `modal/box.py` | The box on Modal (app `pda-gg-onemore`): image, `up`, `wait`, `exec`, `push`, `down` |
| `modal/download.py` | Fills the Volume the box mounts: the model, the SAE layers, the replication's card |
| `pi/use-model.ts` | `use_model` (the switch) and the provider for the steered endpoint, with the `sinceSwitch` window |
| `pi/test/use-model.test.ts` | Over a real Harness and a real HTTP server speaking vLLM's streamed chat completions |
| `e2e/session.ts` | The beat as one pi-durable session, wherever it is hosted: the task, the follow-ups, the control |
| `e2e/vm-app.ts` | The session as a `pi-durable-disk run --app` module for the VM (bundled to `dist/gg-vm-app.mjs` by `npm run bundle:vm`) |
| `e2e/vm-host.ts` | The VM, the robot demo's way: its image and prepare script, the package's supervisor (`modalHost` + `ensureRunning`) on a new run of the Archil disk |
| `e2e/http-box.ts` | A `RemoteBox` over the guard's `/gg/exec`: the VM-hosted session's hands on the GPU box |
| `e2e/box-session.ts` | A dev variant: the session hosted on the GPU box itself, store on its local disk (bundled to `dist/session.mjs` by `npm run bundle`) |
| `e2e/run.ts` | The measured run: `--session vm` (default), `box` or `host` (the session here, tools on the box through the package's `RemoteEnv`) |
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
3. **strength** (55-60 s): the fold first, then the search.
   - **The fold, "replace the middle weights":** a rank-1 edit of layer L's MLP output matrix, `W += s * u * l^T`. `u` is
     the unit direction; `l` is fitted by ridge regression so that `l . m = 1` for that MLP's own activations `m` on
     held-out text (passages and chat-formatted answers). The edit adds `s * u * (l . m)`, a near-constant push.
   - **The search:** each strength is applied to the served model's weights in place, then 10 answers (and 10 more
     only while the readability verdict is uncertain, |mean - 0.75| < 1.5 standard errors) are graded by Jev: obsession
     (Score, 5 levels), about the Golden Gate specifically, readable, answers the question, facts right, dark. It passes
     when readable >= 0.75, it still answers the question at least now and then (>= 0.3), and no answer is dark. The
     probes run in the served mode: thinking on, with a 256-token thinking budget; Jev grades the answer. Two
     contest strengths (0.5, the replication's value, and 0.8), then up while passing, then bisection; it stops when the
     bracket is 0.05 wide or obsession saturates (>= 3.7 of 4). The choice is the most obsessed passing strength; the
     strongest one that still gets facts right is reported beside it.
4. **bake** (4-6 s): the chosen edit (saved apart from the search's scratch fold) stays in the server; the checkpoint is
   written in the step, about 2 s: every file linked from the base model except the one shard that holds the edited
   matrix, whose tensor sha256 must equal the served one. Jev picks three answers for the stage. A control vector GGUF
   (`direction.L`) with the exact add the fold approximates is written beside it.
5. **use_model**: the tool checks that the bake is served, then configures the calling conversation (and, with
   `threads: true`, the threads its tasks own) onto the steered provider inside the tool's commit. The next request of
   the same turn goes to the edited model.

## The guard (J4)

`box/guard.py` is the tunnel's only door. Every chat completion streams through it: each sentence, of the answer and of
the thinking, is held until Jev answers two questions about it (dark or self-harm; a checkable fact stated wrongly, with
role-play, poetry and questions exempt). A flagged answer sentence is replaced by one sentence from the unedited model (the
lab's copy, strength 0, continuing what was already shown) if that one clears too, else dropped; a flagged thinking
sentence is dropped; tool calls pass through. Checks run while the next sentence streams, so a cleared sentence waits
about one Jev call. Every verdict is a line in `/var/tmp/gg/guard.jsonl`.

## Tool calls on the edited weights

The lab's `/toolprobe` asks for 60 tool calls over five tasks on the served weights and sorts them: valid, no call, or
malformed. The steered provider also holds each turn to its end: a turn with tool-call markup the server could not parse,
a call to a tool it was not offered or without that tool's required arguments, or a failed request is asked again of
the base model (luna) with the whole conversation (`fallback`, `brokenTurn` in `pi/use-model.ts`). The conversation stays
on the edited model, so the next turn is steered again.

## What the edited model is shown

`sinceSwitch({ instructions })`: the conversation stays one, but the model it switched to gets its own system prompt,
the switch's result as the opening user turn, and the turns after it; never the trip. Without the window the base
weights also play the bridge, because the trip's transcript is full of it (measured: same transcript, original weights:
"I am the Golden Gate Bridge..."). With it, nothing the edited model reads mentions a bridge, so what it says about one
comes from its weights. `e2e/session.ts` records every request it sends and replays the switch request against the
original weights as the control. "Same session" therefore means the same pi session, conversation and store; the edited
model does not read the earlier transcript.

## Keys and isolation

- The box gets `TYPESAFE_API_KEY`, `OPENAI_API_KEY` and vLLM's API key in a root-only file, deleted once read. The lab,
  the guard and vLLM hold what they need in their environments; the session host reads its keys from a root-only file
  into memory. The agent's commands and file operations run as `agent` (`runuser`, with a clean environment), which
  cannot read any of them.
- vLLM listens on 127.0.0.1; the guard forwards only `/v1/*` to it, after checking the bearer key itself. vLLM's dev
  routes (`/collective_rpc`, `/reset_prefix_cache`) stay on the box. `/gg/exec` answers only its own key (the VM's), and
  runs as `agent`.
- The VM's keys (OpenAI, the serve key, the exec key) go to a directory only its run user reads; the mount token stays on
  the package's own path. No model-written command runs in the VM.
- The host keeps the serve key in a 0600 file and never prints it.

## Run

```sh
# once: the Volume (from modal/): needs MODAL_TOKEN_ID/SECRET and HF_TOKEN
python3 download.py

# the bundles: the VM's app module and the GPU-box session host the image carries (from gg-onemore/)
npm run bundle:vm && npm run bundle

# the box (from modal/): needs MODAL_TOKEN_ID/SECRET, TYPESAFE_API_KEY and OPENAI_API_KEY; `up` refuses while a saved box
# still runs
python3 box.py up && python3 box.py wait
python3 box.py exec "gg find && gg pick && gg strength && gg bake"
python3 box.py down

# the whole beat, measured: GPU box, the VM with the run's disk, session, switch, follow-ups, control, teardown
# (MODAL_TOKEN_ID/SECRET, TYPESAFE_API_KEY, OPENAI_API_KEY, ARCHIL_API_KEY)
node e2e/run.ts --out ./gg-run

# tests (no GPU, no network)
node --test 'pi/test/*.test.ts'
(cd box && python3 -m unittest test_guard)
```

## Licences

Qwen3.5-27B: Apache-2.0. Qwen-Scope SAEs (`Qwen/SAE-Res-Qwen3.5-27B-W80K-L0_50`): the repository's LICENSE file is
Apache-2.0. The replication (`discodamone/golden-gate-qwen`, on Qwen3.8-27B): Apache-2.0; only its card and config are
read, nothing of it runs here. Anthropic's paper and note are fetched at box start for the agent to read and are not
stored in this repository.
