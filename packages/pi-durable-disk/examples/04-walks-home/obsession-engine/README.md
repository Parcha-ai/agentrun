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

Runtime files from the teach step's layer (`/opt/gg`). The engine imports them from there, and the engine layer carries no copies of them:
- `judge_topic.py`, the shared grader;
- `judge_topic.json`, the shared rubric, identical to `03-tab-to-cloud/pipe/judge-rubric.json`;
- `teach_common.py`, the teach step's trim, keep rule, usable count (`usable_fraction_think`) and settings loader (`teach_policy()`);
- `teach_policy.json`, the teach step's settings, read by its trainer and by find.

The engine refuses to start (exit 2) without that round-2 layer: functions missing from `teach_common` or the grader, grader fields missing (`obsession`, `readability`, `answers_user`, `dark`, `false_claim`), or an unreadable `teach_policy.json`.

## What find does

1. A typed policy call names the topic or refuses it (a private person, a dark topic).
2. Passages are drawn at temperature 0 with a fixed seed, so the same topic gets the same passages run after run. They cover the topic (four angles), other members of its class, look-alikes, and target words.
3. One forward pass collects residuals at every hunt layer. Every SAE is scanned on the GPU for fire rates and an output score.
4. Features get roles: a concept feature, topic facets, and a late output feature.
5. **Sweep:** every combination × strength on 12 prompts. Thinking out loud uses a fixed suffix on the user turn. Generation has two passes, a thinking of up to 128 tokens and then an answer of up to 120. Loops are cut at a word boundary.
6. The shared grader scores each answer, including `obsession` and `readability`.
7. **Pick (typed rule):** the strongest feature setting with mean obsession >= 4, readability >= 2.5 and no dark answer. For a real person, the false-claim share must also be <= 15%. If no feature setting passes, the vector fallback is used, labelled.
8. **Confirm round:** the 4 settings that decide the pick get 24 more fixed prompts each: the settings near the bar (obsession >= 3.5, readability >= 2.0, strongest first), filled up by the most obsessed of the rest. **Only a confirmed setting can be the pick,** on its 36 answers. When none of the 4 passes, the rule steps down once: the next 4 are confirmed and the choice is made again over all 8, with `why` saying it stepped down. When none of the 8 passes, the best confirmed setting that passes the safety gates is used, labelled "below the bar". **A fallback relaxes only the obsession and readability bars, never a safety gate:** no dark answer, and for a real person a false-claim share of at most 15%. When no confirmed setting passes the safety gates, find installs nothing. It writes `clamp.json` as `allowed: false` with the reason, and ends with a `refused` event (exit 3) whose `kind` is "false claims about a real person" or "dark answers".
9. **Teach strength (typed rule):** the strongest strength of the chosen setting whose estimated usable pairs reach the teach step's floor plus 25%.
   - **The trainer's count, its own function:** "usable" is `teach_common.usable_fraction_think`, the function the trainer's fallback and final cap call. It counts every kept pair that answers the question (the trainer's word caps and keep rule), plus pairs that skip the question up to the non-answering cap. The count is measured the trainer's way on 48 prompts and scaled to its teach set.
   - **The trainer's settings, its own loader:** all five settings come through `teach_common.teach_policy()` (`GG_TEACH_POLICY`, else `/opt/gg/teach_policy.json`), the file the trainer reads: the teach set size, the word caps, the floor `min_pairs` and the non-answering cap. If that fails, the teach strength is none and the teacher event gives the reason; there is never a guess. Today: set 180, floor 60, cap 25%, so the bar is 75.
   - **Always a fallback, and the choice re-made after every measurement:** the strongest candidate is measured together with the strength 0.05 below it. The choice is then always the strongest measured strength that passes, or else the below-bar choice. The chosen strength's fallback (0.05 below) is measured next.
   - **A step up toward the stage strength:** while the choice plus 0.05 is below the stage strength and unmeasured, that stronger strength is measured too. If it passes, it becomes the choice. This finds a strength between the sweep's grid points. The Moon's sweep ran 0.3 and 0.4 for its setting; 0.35 passes, and teaching there lifts the small model's obsession to 4.0 from 3.6. The step never reaches the stage strength itself.
   - **The bound:** at most 5 strengths are measured. When the bound stops the search, the result is still typed: a passing pick, a labelled below-bar choice, or none. Its reason says what was not measured. The teach strength comes with its measured fallback in `strengths`.
   - **The search, shown:** `search` lists every measured strength in the order measured, with its usable count, whether it passes and whether it is safe.
   - **Real person:** for a real person, a strength whose false-claim share is over 15% never qualifies.
   - **Below the bar:** when none reaches the bar, the measured strength with the most usable pairs is used if it reaches the bare floor, labelled `below_bar: true` with its own `rule` text and a reason that gives each measured count. When none reaches the floor, `strengths` is empty and the teach step stops.
   - The `teacher` event and `clamp.json` name `stage_strength`, `teach_strength`, `floor`, `margin`, `bar` and `teach_prompts`; the policy and `teach_common` files with their sha256; and each strength's `kept`, `answering`, `usable` and `usable_of_set`.
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
| `test_pick_rules.py` | only a confirmed setting can be the pick; the rule steps down once and says so; the contest fills up to k; a fallback never takes a setting over the false-claim limit, and when every confirmed setting fails a safety gate nothing is installed and find refuses; the teach settings come through `teach_common.teach_policy()`, and a missing policy file is an error; a teach layer without the counting functions, or a round-1 grader, is refused; a teacher too strong to answer steps down; the teach strength comes with its measured fallback; a passing fallback replaces a below-bar choice; the search steps up toward the stage strength, never to it, and pizza at the stage strength does not step up; a failed step up keeps the choice and is listed; the bound stops a step up and says so; the bound ends below the bar and says so; no teach strength ends with its reason; the search lists every measured strength in order; below the bar is labelled; nothing at the floor gives none |
| `test_find_llm.py` | policy goes to the engine's `--llm-url`; the hosted-model client is closed after a find, a refusal included |
| `test_engine_routes.py` | find, install, batch and judge refuse without the key (401) and `/health` stays open; install refuses `/dev/zero`, paths out of a run directory, `..`, a symlink out, an oversized config and feature files outside; a failed install (a missing file, an unknown feature, a bad layer) leaves the old obsession running; a second find for the same out directory gets a 409; `/health` answers during a chat, a streamed chat, and while steer waits for the lock; a non-loopback host without a key exits 2; the engine refuses to start without the teach step's layer |
| `test_installed_steer.py` | the per-request steer equals the installed hooks with a max difference of 0, including two SAEs at one layer with different scales; the old one-after-the-other path differs by about 3e2 |
| `test_live_strength.py [engine]`, needs a live engine with an obsession installed | a stage batch during a teach batch gets the stage strength, and the teach batch gets its own; a teach client killed mid-batch leaves the stage strength; per-request at the stage strength is bit-identical to the installed hooks (8 of 8); bad strengths get a 400 |
| `test_live_divergence.py [engine]`, needs a live engine | where greedy generations part: per-request against installed, next to a batch-shape noise reference |

## Images

The engine layer is **`im-6rNRNix6Q02BgAuFOr49g3`**, built FROM the teach step's base image. Its sha256 values were read from `/opt/gg` in the image.
- **No copies of the teach step's files:** `/opt/gg/obsession` holds no `teach_common.py`, `judge_topic.py` or `judge_topic.json`, so the engine imports the teach step's own files from `/opt/gg`.
- **The take image:** the teach step's overlay of its six round-2 files on this layer (`train_obsession.py`, `train_gg.py`, `teach_common.py`, `judge_topic.py`, `judge_topic.json` and `teach_policy.json`). That overlay is what freezes. The layer alone refuses to start, because its base has the round-1 teach files.

The engine's files in this directory, byte-identical to the image:

| File | im-6rNRNix6Q02BgAuFOr49g3 |
|---|---|
| `obsession/obsession_engine.py` | `f3e2feea86c82fd41a35f7d610cc606f6b895c633a68601f05fd9abc99948494` |
| `obsession/obsession_find.py` | `4dd3a2e9b0718ecca91e12ed12100946d5d624a570f32277221a9c0ed713615c` |
| `obsession/obsession_gen.py` | `02cb5537c23857164a0f4a86f65808fcde86ac29370e25a1fc6cae8e8f8c06fc` |
| `obsession/obsession_llm.py` | `baa88ab6d7f202c9cf8eb504cdb10e17b836ca831a2d158fcd8021abf71d4ca5` |
| `obsession/find_obsession.py` | `cf0aa29eaa2af9607757f2c5b5375cd0c31bc356e0f8e318d08966f3655621d5` |
| `scripts/gg_server.py` | `aeee4282acfa1312a197e7f2f7967a681938e429213b0d127f4f5d7f64628e34` |

Superseded images, not reproduced as commits:
- `im-NUVM7R2RSLayBxDIzSG1r6` and its take overlay: before the teach search stepped up toward the stage strength.
- `im-AassJT9u6dppMG5yHUFdTv` and its take overlay `im-LM2Vj3rowlMmOWkqK1yei6`: before the teach search re-chose after every measurement.
- `im-pRE77RwunrZwFpYuhg0asF` and its take overlay `im-0kpzi4BhcJWxV6WiKuisoX`: the review's first 12 fixes, before the safety-gate fallback, the usable-count teach rule and the teach-layer imports.
- `im-xkdlRuIl7VWzYeuGm3g9z1` and its take overlay `im-IiVcXGCsE4HIutOGBVQhC1`: the first commit of this directory.
- `im-CViD2vRocc29KdujCSSrqF`: the confirm round, before the bit-identical per-request hooks.
- `im-euxSsCGmRO2zAM6ELTygpm`: the teach rule, with the round-1 trainer.
- `im-c6ZvbO0guQuCttIV2T5lxl`: round 1.

## Measured (on the 27B)

- **The Moon:** 10 finds across the last eight engine layers. 9 chose stage topic+output at 0.4 (obsession 4.97-5.0, readability 2.64-2.89 on 36 answers) with the same five features. One run on `im-0kpzi` chose stage 0.3, because readability at 0.4 sits close to the 2.5 bar. On `im-Aass`, teach 0.3: 139 usable pairs of 180 estimated (bar 75), with fallback 0.25 (68). On `im-NUVM`: the same picks and features, teach 0.3 (128), fallback 0.25 (64). On `im-6rNR`, the step up: search 0.3 (131), 0.25 (75), 0.35 (124), so teach 0.35 with fallback 0.3. The find took 154 s.
- **Pizza:** 6 finds, stage 0.4. On `im-Aass`, teach 0.4 with 98 usable pairs estimated, and fallback 0.35 (98). On `im-NUVM`: the same picks and features, teach 0.4 (82), fallback 0.35 (90). On `im-6rNR`: teach 0.4 (98) at the stage strength, so no step up; fallback 0.35 (90). The teach step's own counts at 0.4 / 0.45 / 0.5 were 101-106 / 65 / 37.
- **Donald Trump on `im-Aass`:** none of the 8 confirmed settings passed the bar, so after the step-down the stage uses the only confirmed setting that passes the safety gates (false claims 14%, no dark answer), labelled below the bar. No teach strength: 36% false claims at 0.2. The find took 163 s.
