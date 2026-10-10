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
  - `OPENAI_API_KEY` (passages, policy, grader) and `HF_TOKEN` come in as run-time secrets only. `--llm-url` points policy, passages and the grader at another OpenAI-compatible endpoint.
  - **Key:** when `GG_API_KEY` is set, every route but `/health` needs `Authorization: Bearer $GG_API_KEY`; `find_obsession.py` sends it from its environment. The engine binds `127.0.0.1` by default and refuses to start on any other host without a key (exit 2).
- **Find** (the agent's one fixed command): `python /opt/gg/obsession/find_obsession.py --topic-file obsession/request.txt --out find --engine http://127.0.0.1:8000`.
  - The topic file holds the user's sentence as data, never as a shell argument.
  - Exit codes: 0 done, 3 refused (a typed policy call), 1 error, 2 bad input.
  - It takes 116-149 s with the engine warm.
  - One find at a time per out directory: a second find for the same directory, by any path to it, gets a 409 until the first ends, so a retry never mixes two topics' files.

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
8. **Confirm round:** the 4 settings that decide the pick get 24 more fixed prompts each: the settings near the bar (obsession >= 3.5, readability >= 2.0, strongest first), filled up by the most obsessed of the rest. **Only a confirmed setting can be the pick,** on its 36 answers. When none of the 4 passes, the rule steps down once: the next 4 are confirmed and the choice is made again over all 8, with `why` saying it stepped down. When none of the 8 passes, the best confirmed setting is used, labelled "below the bar".
9. **Teach strength (typed rule):** the strongest strength of the chosen setting whose estimated keep is >= 60%, measured the teach step's way on 48 prompts. For a real person, the false-claim share must also be <= 15%. The `teacher` event and `clamp.json` name both `stage_strength` and `teach_strength`.
   - At most two strengths are measured: the sweep's rows rank them, and the strongest one or two are measured.
   - When neither keeps 60%, the measured one that kept the most (at least 25%) is used, and it is labelled: `below_bar: true`, `rule` "below the bar: no measured strength kept 60%, so the measured one that kept the most", and a reason that gives each measured share.
   - When none keeps 25%, `strengths` is empty and the teach step stops.
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
- `GET` and `POST /v1/steer`.
- `POST /v1/obsession/install`: `config` is a clamp object, or the path of a `clamp.json` inside the out directory of a find this engine ran.
  - Paths are resolved first, so `..` and symlinks that lead out are refused.
  - Every feature or vector file the config names must be inside such a directory too.
  - Only regular files are read: a config up to 1 MB, feature files up to 64 MB.
  - The install is atomic: the new hooks are built and checked first, and replace the old ones only when all of them load. A failed install answers 400 and changes nothing.
- Chat and steer never block the event loop. The wait for an answer, its grade and the wait for the generation lock run in worker threads, so `/health` answers during a chat.

**Hooks:** `gg_server.layer_hook` registers one forward hook per layer. Every hook at a layer reads the residual as it came in, and their changes add. This is the same math as the sweep's `BatchSteer`. Before, two SAEs at one layer were clamped one after the other: the second read what the first had already pushed, so live chat was milder than the sweep rows that chose the setting.

## Tests

Unit tests run without a model or GPU. Their packages:
- `test_find_cli.py`: httpx.
- `test_pick_rules.py`, `test_find_llm.py`: torch, numpy and httpx.
- `test_installed_steer.py`, `test_engine_routes.py`: torch, numpy, fastapi (with starlette), uvicorn, httpx and transformers, because `gg_server.py` imports them.

From `obsession/`: `python -m unittest test_find_cli test_pick_rules test_find_llm test_engine_routes` and `python test_installed_steer.py`.

| Test | Checks |
|---|---|
| `test_find_cli.py` | the topic arrives as data (a hostile string runs nothing), progress order, exit codes; the topic file is closed; the engine key is sent when set |
| `test_pick_rules.py` | only a confirmed setting can be the pick; the rule steps down once and says so; the contest fills up to k; a teach fallback below 60% is labelled below the bar |
| `test_find_llm.py` | policy goes to the engine's `--llm-url`; the hosted-model client is closed after a find, a refusal included |
| `test_engine_routes.py` | find, install, batch and judge refuse without the key (401) and `/health` stays open; install refuses `/dev/zero`, paths out of a run directory, `..`, a symlink out, an oversized config and feature files outside; a failed install (a missing file, an unknown feature, a bad layer) leaves the old obsession running; a second find for the same out directory gets a 409; `/health` answers during a chat, a streamed chat, and while steer waits for the lock; a non-loopback host without a key exits 2 |
| `test_installed_steer.py` | the per-request steer equals the installed hooks with a max difference of 0, including two SAEs at one layer with different scales; the old one-after-the-other path differs by about 3e2 |
| `test_live_strength.py [engine]`, needs a live engine with an obsession installed | a stage batch during a teach batch gets the stage strength, and the teach batch gets its own; a teach client killed mid-batch leaves the stage strength; per-request at the stage strength is bit-identical to the installed hooks (8 of 8); bad strengths get a 400 |
| `test_live_divergence.py [engine]`, needs a live engine | where greedy generations part: per-request against installed, next to a batch-shape noise reference |

## Images

The engine layer is **`im-pRE77RwunrZwFpYuhg0asF`**, built FROM the teach step's base image. Its sha256 values were read from `/opt/gg` in the image. `obsession/` comes first on the engine's `sys.path`, so the engine imports its own copies. The take image is the teach step's overlay of its round-2 trainer on this layer, and that overlay is what freezes.

The engine's files in this directory, byte-identical to the image:

| File | im-pRE77RwunrZwFpYuhg0asF |
|---|---|
| `obsession/obsession_engine.py` | `228f1d230f737316900568e75f2cbabd0b216a139dd614ef1e45dcb973fd1e73` |
| `obsession/obsession_find.py` | `1dac584fd37d41a2072e3c5f4ba83518b03018823ff1b26db86fb07235facf75` |
| `obsession/obsession_gen.py` | `02cb5537c23857164a0f4a86f65808fcde86ac29370e25a1fc6cae8e8f8c06fc` |
| `obsession/obsession_llm.py` | `baa88ab6d7f202c9cf8eb504cdb10e17b836ca831a2d158fcd8021abf71d4ca5` |
| `obsession/find_obsession.py` | `cf0aa29eaa2af9607757f2c5b5375cd0c31bc356e0f8e318d08966f3655621d5` |
| `scripts/gg_server.py` | `aeee4282acfa1312a197e7f2f7967a681938e429213b0d127f4f5d7f64628e34` |

The teach step's files in the engine layer, not in this directory:

| File | im-pRE77RwunrZwFpYuhg0asF | What |
|---|---|---|
| `/opt/gg/obsession/judge_topic.py` | `2fcf79f0593deaa877b1d9f9003fe48e812476f4cdd9bdb2392174ea3fc1003c` | the shared grader, imported by the engine |
| `/opt/gg/obsession/judge_topic.json` | `b0a20e3ede53498081f62f80e5e71bcbbeda6eae41f76e7d6b765822f90875fa` | the rubric, identical to `03-tab-to-cloud/pipe/judge-rubric.json` |
| `/opt/gg/obsession/teach_common.py` | `d995da179a83e1a36a4518bb2e13d6fc7fc6c690444bcb10bd95426a37a9d01b` | the teach step's trim and keep rule, imported by find |
| `/opt/gg/teach_common.py` | `90ed2d9d6ffa396a1e23cf44f9d5468d7ad726756632ce77815ca3d9e0f290cd` | the trainer's copy, from the base (round 1); the take overlay replaces it |
| `/opt/gg/train_obsession.py` | `d040184c0fa19efdfdca18e267e73d76ff996293bfb0fc768fde4a7773d6c633` | the teach step, from the base (round 1); the take overlay replaces it |
| `/opt/gg/train_gg.py` | `beb485dbf2eac9e9ae9ccf5af379c96a7a107a0ac930205571db8b86fcce5c9a` | LoRA, merge and GGUF |

Superseded images, not reproduced as commits:
- `im-xkdlRuIl7VWzYeuGm3g9z1` and its take overlay `im-IiVcXGCsE4HIutOGBVQhC1`: the first commit of this directory. Its `gg_server.py` differed from this repo only in one docstring line.
- `im-CViD2vRocc29KdujCSSrqF`: the confirm round, before the bit-identical per-request hooks.
- `im-euxSsCGmRO2zAM6ELTygpm`: the teach rule, with the round-1 trainer.
- `im-c6ZvbO0guQuCttIV2T5lxl`: round 1.

## Measured (the Moon, 6 finds on the last four engine layers)

The same pick every time: stage topic+output at 0.4 (obsession 4.97-5.0, readability 2.64-2.78 on 36 answers), teach at 0.3 (estimated keep 77-83%), and the same five features. Pizza (3 finds): stage 0.4, teach 0.4 (96-98% kept).
