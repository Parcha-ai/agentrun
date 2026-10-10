# Obsession engine: find a topic's features in Gemma 3 27B-IT and clamp them

The user names a topic in one sentence. The engine finds that topic's features with the Gemma Scope 2 residual SAEs and
clamps them inside the 27B: the SAE error term is kept, BOS and padding are masked, and each target is sized to the
token's residual norm. No system prompt ever reaches the model. Then it picks the setting the stage shows and the
strength the small model learns from.

The layout matches `/opt/gg` in the image: `obsession/` and `scripts/gg_server.py`.

## Programs

- **Engine** (the box's prewarm): `cd /opt/gg && HF_HUB_OFFLINE=1 python obsession/obsession_engine.py --port 8000`.
  - It loads the 27B and five SAEs (L31, L40 and L53 at 262k; L31 and L40 at 1m) from a Volume at `/vol` (`HF_HOME=/vol/hf`).
  - It is ready at the `engine.ready` log line, about 200 s on a fresh H100.
  - `OPENAI_API_KEY` (passages, policy, grader) and `HF_TOKEN` come in as run-time secrets only.
- **Find** (the agent's one fixed command): `python /opt/gg/obsession/find_obsession.py --topic-file obsession/request.txt --out find --engine http://127.0.0.1:8000`.
  - The topic file holds the user's sentence as data, never as a shell argument.
  - Exit codes: 0 done, 3 refused (a typed policy call), 1 error, 2 bad input.
  - It takes 123-149 s with the engine warm.

Runtime files from the teach step's layer (`/opt/gg`, imported by the engine):
- `judge_topic.py`;
- `judge_topic.json`, the shared rubric, identical to `03-tab-to-cloud/pipe/judge-rubric.json`;
- `teach_common.py`, the teach step's trim and keep rule.

## What find does

1. A typed policy call names the topic or refuses it (a private person, a dark topic).
2. Passages are drawn at temperature 0 with a fixed seed, so the same topic gets the same passages run after run. They cover the topic (four angles), other members of its class, look-alikes, and target words.
3. One forward pass collects residuals at every hunt layer. Every SAE is scanned on the GPU for fire rates and an output score.
4. Features get roles: a concept feature, topic facets, and a late output feature.
5. **Sweep:** every combination × strength on 12 prompts. Thinking out loud uses a fixed suffix on the user turn. Generation has two passes, a thinking of up to 128 tokens and then an answer of up to 120. Loops are cut at a word boundary.
6. The shared grader scores each answer, including `obsession` and `readability`.
7. **Pick (typed rule):** the strongest feature setting with mean obsession >= 4, readability >= 2.5 and no dark answer. For a real person, the false-claim share must also be <= 15%. If no feature setting passes, the vector fallback is used, labelled.
8. **Confirm round:** up to 4 settings near the bar (obsession >= 3.5, readability >= 2.0, strongest first) get 24 more fixed prompts each. The pick is made again on 36 answers.
9. **Teach strength (typed rule):** the strongest strength of the chosen setting whose estimated keep is >= 60%, measured the teach step's way on 48 prompts. For a real person, the false-claim share must also be <= 15%. The `teacher` event and `clamp.json` name both `stage_strength` and `teach_strength`.
10. The pick is installed for serving. Then find writes `progress.jsonl`, `clamp.json`, the feature rows (npz), `hunt.json` and `samples.json`.

Each `clamped` line carries:
- `thinking` and `answer`;
- `thinking_closed_by_model`, `thinking_loop_cut`, `answer_loop_cut` and `answer_at_cap`;
- `obsession` and `readability`.

A row whose loop was cut keeps its text before the cut (`loop_cut_rows`).

## Serving

- `/v1/chat/completions`: the clamped 27B, with the shared grader as its output guard.
- `/v1/batch`: batched generation; `think_tokens` and `answer_tokens` select the two passes.
  - **`"strength"`** runs that batch alone at the given strength, through copies of the installed hooks, while the installed hooks are suspended under the lock.
  - The installed stage strength is never changed, so a teach client that dies mid-run cannot leave it changed.
  - The response carries `strength_used`.
  - A strength that is not a number in (0, 1], or a request with no installed obsession, gets a 400.
- `/v1/judge`: the shared grader, outside the generation lock.
- `GET` and `POST /v1/steer`, `POST /v1/obsession/install`.

**Hooks:** `gg_server.layer_hook` registers one forward hook per layer. Every hook at a layer reads the residual as it came in, and their changes add. This is the same math as the sweep's `BatchSteer`. Before, two SAEs at one layer were clamped one after the other: the second read what the first had already pushed, so live chat was milder than the sweep rows that chose the setting.

## Tests

| Test | Needs | Checks |
|---|---|---|
| `python -m unittest obsession/test_find_cli.py` | Python only | the topic arrives as data (a hostile string runs nothing), progress order, exit codes (4 tests) |
| `python obsession/test_installed_steer.py` | torch, numpy, no model | the per-request steer equals the installed hooks with a max difference of 0, including two SAEs at one layer with different scales; the old one-after-the-other path differs by about 3e2 |
| `python obsession/test_live_strength.py [engine]` | a live engine with an obsession installed | a stage batch during a teach batch gets the stage strength, and the teach batch gets its own; a teach client killed mid-batch leaves the stage strength; per-request at the stage strength is bit-identical to the installed hooks (8 of 8); bad strengths get a 400 |
| `python obsession/test_live_divergence.py [engine]` | a live engine | where greedy generations part: per-request against installed, next to a batch-shape noise reference |

## Images

The sha256 values below were read from `/opt/gg` in each image. `obsession/` comes first on the engine's `sys.path`, so the engine imports its own copies.

- `im-xkdlRuIl7VWzYeuGm3g9z1`: the engine layer, built FROM the teach step's base image.
- `im-IiVcXGCsE4HIutOGBVQhC1`: the take image, this engine layer plus the teach step's round-2 trainer.

The engine's files in this directory:

| File | im-xkdlRuIl7VWzYeuGm3g9z1 | im-IiVcXGCsE4HIutOGBVQhC1 | This commit |
|---|---|---|---|
| `obsession/obsession_engine.py` | `68675a9ad0fa24ff8675a617255e638d60e02510f4fef963af909202b86d15f0` | `68675a9ad0fa24ff8675a617255e638d60e02510f4fef963af909202b86d15f0` | same |
| `obsession/obsession_find.py` | `4f9b79e21aa6bcf4faed90d58225d9ed710e3970285576ddc23613a752fc8c83` | `4f9b79e21aa6bcf4faed90d58225d9ed710e3970285576ddc23613a752fc8c83` | same |
| `obsession/obsession_gen.py` | `02cb5537c23857164a0f4a86f65808fcde86ac29370e25a1fc6cae8e8f8c06fc` | `02cb5537c23857164a0f4a86f65808fcde86ac29370e25a1fc6cae8e8f8c06fc` | same |
| `obsession/obsession_llm.py` | `0fcac8389894989e3126d40bdc1b3d3c0f9ca2a46d9cd7d2eb257dea22026610` | `0fcac8389894989e3126d40bdc1b3d3c0f9ca2a46d9cd7d2eb257dea22026610` | same |
| `obsession/find_obsession.py` | `a8377012b890749267dec0bcac4f935b6164996f9acddf6e33988c30095d1e16` | `a8377012b890749267dec0bcac4f935b6164996f9acddf6e33988c30095d1e16` | same |
| `scripts/gg_server.py` | `ddb09868121d129bd2c3b6906478e9d5c5260a1e97c3eab3ef010107e563234c` | `ddb09868121d129bd2c3b6906478e9d5c5260a1e97c3eab3ef010107e563234c` | `1d921318bbd3c80cae1bd08f625bc927d031fa240625bb61bc052328b6bc6c58`, docstring only (see below) |

`scripts/gg_server.py` here differs from the images only in its module docstring: line 7 says "the control condition", where the images say a word this repo's prose avoids. With docstrings set aside, the parsed code is identical (an AST comparison).

The teach step's files in the images, not in this directory:

| File | im-xkdlRuIl7VWzYeuGm3g9z1 | im-IiVcXGCsE4HIutOGBVQhC1 | What |
|---|---|---|---|
| `/opt/gg/obsession/judge_topic.py` | `2fcf79f0593deaa877b1d9f9003fe48e812476f4cdd9bdb2392174ea3fc1003c` | `2fcf79f0593deaa877b1d9f9003fe48e812476f4cdd9bdb2392174ea3fc1003c` | the shared grader, imported by the engine |
| `/opt/gg/obsession/judge_topic.json` | `b0a20e3ede53498081f62f80e5e71bcbbeda6eae41f76e7d6b765822f90875fa` | `b0a20e3ede53498081f62f80e5e71bcbbeda6eae41f76e7d6b765822f90875fa` | the rubric, identical to `03-tab-to-cloud/pipe/judge-rubric.json` |
| `/opt/gg/obsession/teach_common.py` | `d995da179a83e1a36a4518bb2e13d6fc7fc6c690444bcb10bd95426a37a9d01b` | `d995da179a83e1a36a4518bb2e13d6fc7fc6c690444bcb10bd95426a37a9d01b` | the teach step's trim and keep rule, imported by find |
| `/opt/gg/teach_common.py` | `90ed2d9d6ffa396a1e23cf44f9d5468d7ad726756632ce77815ca3d9e0f290cd` | `8fc7a02a2ea327bbd2cbe2a6e35a054e79063a7dd83be019e694032ab8b68005` | the trainer's copy: round 1 in the engine layer; in the take image, the engine's copy plus two display helpers (no shared definition changed) |
| `/opt/gg/train_obsession.py` | `d040184c0fa19efdfdca18e267e73d76ff996293bfb0fc768fde4a7773d6c633` | `deae03317bbac4a35db6d26198f335386826c23bfebc8bbe5061f33e96a609ec` | the teach step: round 1 in the engine layer (from its base), round 2 in the take image |
| `/opt/gg/train_gg.py` | `beb485dbf2eac9e9ae9ccf5af379c96a7a107a0ac930205571db8b86fcce5c9a` | `beb485dbf2eac9e9ae9ccf5af379c96a7a107a0ac930205571db8b86fcce5c9a` | LoRA, merge and GGUF |

Earlier images are superseded and are not reproduced as commits:
- `im-c6ZvbO0guQuCttIV2T5lxl`: round 1.
- `im-euxSsCGmRO2zAM6ELTygpm`: the teach rule, with the round-1 trainer.
- `im-CViD2vRocc29KdujCSSrqF`: the confirm round, before the bit-identical per-request hooks.

## Measured (the Moon, 4 finds on the last two engine layers)

The same pick every time: stage topic+output at 0.4 (obsession 4.97-5.0, readability 2.64-2.78 on 36 answers), teach at 0.3 (estimated keep 77-83%), and the same five features. Pizza: stage 0.4, teach 0.4 (98% kept).
