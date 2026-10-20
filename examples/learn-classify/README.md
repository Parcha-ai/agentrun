# Learn-classify: an agent that makes its own job cheaper

One agent classifies US public companies into their 2-digit SIC industry group, one company per run, in order. Its rules
say that every run either runs a workflow it already trusts for the job (or a part of it), or does the job by hand and
then drafts, dry-runs and saves a workflow for the part it did by hand. After each run the host proposes what the run
noted and saved, curation merges it into the agent's git repository, and the next run starts from the new `main`. The
truth is the SEC's own SIC code for each company. The proof is the curve: cost per job and accuracy run by run, the
share of runs a workflow finished alone, and accuracy on 30 sealed companies before and after.

It is built on [`@parcha/pi-agent-learn`](../../packages/pi-agent-learn/README.md) and the reference host loop in
[`examples/agent-learn`](../agent-learn/README.md), whose `prepareRun` it reuses.

## Run it

Node 22.19 or later and git 2.40 or later, in a checkout with `npm ci --ignore-scripts && npm run build`.

```sh
# $0: a scripted model, a scripted Jev and fixture pages; three jobs end to end.
node examples/learn-classify/runner.mjs --out /tmp/lc-dry --scripted --jobs 3

# Live: gpt-6-luna and Jev through one gateway, fetch_page on the real web. --cap-usd is required.
export LEARN_CLASSIFY_GATEWAY=<a gateway root: an OpenAI Responses endpoint at /v1, Jev at /typesafe>
node examples/learn-classify/runner.mjs --out /tmp/lc-probe --live --jobs 10 --cap-usd 1 --run-cap-usd 0.15

# The 30 sealed companies at a commit of the agent repository, with no learning: before and after.
node examples/learn-classify/runner.mjs --out /tmp/lc-probe --live --cap-usd 1 --sealed --at seed
node examples/learn-classify/runner.mjs --out /tmp/lc-probe --live --cap-usd 1 --sealed --at main

# The curve, again, from the rows (the runner also writes it at the end of each pass).
node examples/learn-classify/curve.mjs /tmp/lc-probe
```

| Flag | What |
| --- | --- |
| `--out <dir>` | the pass's directory (default `examples/learn-classify/out`, ignored by git): the agent's repository, the host's clone, the agent home, the rows, the recordings, the curve |
| `--scripted` / `--live` | the $0 doubles (with `fetch_page` reading fixture pages), or the gateway (the model and Jev) and `fetch_page` on the web; one `--out` serves one mode |
| `--data <dir>` | `companies.json` and `sic2.json` (and, scripted, `pages.json`); default `data/` live, `fixtures/` scripted |
| `--jobs <n>` | the first `n` companies of split `run`, by `order` |
| `--cap-usd <usd>` | the spend guard: no job starts once the rows' spend reaches it |
| `--run-cap-usd <usd>` | a run whose model and Jev spend passes it is aborted where it is |
| `--sealed --at seed\|main\|<sha>` | score the sealed companies at that commit; rows go to `sealed-<sha12>.jsonl` |
| `--no-record` | keep no recording per run |
| `--model`, `--thinking` | live only: the model id (default `gpt-6-luna`) and the agent's thinking level (default `medium`; never `off`) |

Live, `LEARN_CLASSIFY_GATEWAY` names the gateway (its root, or its OpenAI base URL ending in `/v1`) and
`LEARN_CLASSIFY_GATEWAY_KEY` its key, when it wants one; a gateway that holds the provider keys needs none.

A stopped pass is resumed by running the same command again. A finished job keeps its row. A job whose run was cut off is
abandoned (carried back into the home, its spend kept in `progress/<run>.json` and counted by the guard) and runs again
as the next attempt, `run-007-a2`. A run that finished is proposed and curated if it was not yet (both are idempotent).

## How a host wires the loop

The calls in order, per company. `host.mjs` is the whole of it.

1. **Seed.** `prepareRun({ home, repo, host, runId, input })` (from `examples/agent-learn/host.mjs`): fetch `main`, keep
   the agent home on it, start the run, seed its `<learned>` section, and put the workflows `workflowsToTry` offers for
   this input into the run's own workflow store.
2. **Run.** `runJob({ run, job, model, judge, fetchPage, labels })` opens the run's store with four extensions, all listed
   on the root agent:
   - `learn` (`agentLearn`, its guard seeing this company's name, website and domain),
   - the host's tools: `fetch_page`, `sic2_groups` (the label set) and `answer` (the final answer, typed: a code from the
     label set, one sentence of evidence and its URL),
   - the DSL's `agentrun` tool (`createWorkflowTool`, `projectDir` = the run's workspace),
   - the node runner (`nodeRunner`), so agent nodes inside a workflow run as pi conversations.

   A workflow's `call` nodes reach `fetch_page` and `sic2_groups` through `runEffect`. Its `judge`, `pick`, `sift` and
   `route` nodes reach Jev through `runJudge` (`createJevRunner`), each decision kept as a row in the run's store
   (`decisionRecovery`). Its agent nodes are offered the tools they name, or both workflow tools when they name none, and
   never `answer`, `learn` or `agentrun`; they get their own short instructions, not the root agent's rules.
3. **Propose.** `finishJob(...)`: `carryBack`, then read the run's notes, the workflows it saved and its uses of saved
   workflows, and `proposeLearning({ workDir, untrusted: true, read })` on `runs/<run id>`. The run read the web, so the
   curator asks whether each note came from that content, and `read` (every page the run fetched, from its store) withholds
   a saved workflow that copies one.
4. **Curate.** `curateJob({ repo, judge })`: `curate` with Jev as the judge and this example's gates in front of the
   package's admitter (below). It is the only writer of `main`.
5. **Row.** `rowOf(...)` appends one line to `runs.jsonl`; the next company starts at step 1 from the new `main`.

Nothing in the host decides a company's group. The agent's `AGENTS.md` (rules-locked) states the job and the learning
rule, and its `classify` skill says how to do the job by hand and how that maps onto workflow nodes.

### The gates

`gates.mjs` puts back two checks the old tune loop had, before `workflowAdmitter`, so a learned workflow cannot memorize
companies and fake the curve. Promotion stays the package's (3 clean uses from distinct runs, the author's run excluded;
demotion after 2).

- **Dry run.** The saved revision is read back through the DSL's store and dry-run by the host (`dryRunWorkflow`, no
  model, Jev or tool call, no code run in-process). Anything but `passed` is refused. A dry run fills every tool result
  with placeholders, so an `escalate` on a field that is false there always fires and the dry run reports `not_run`; the
  skill says to check a page's text instead.
- **Leak.** Jev is asked one yes-or-no question over the workflow document: does it name or single out a specific company,
  brand, website, domain, ticker or filing, or carry a fixed answer for one? At 0.5 or above it is refused, at 0.2 or
  below it goes on to the admitter, between it is held.

## The row

`runs.jsonl` holds one JSON object per run, the contract between the demo's lanes, in the DSL's own words:

```json
{ "run": 2, "cik": "0000320193", "split": "run", "seedSha": "<main the run started from>", "afterSha": "<main after curate>",
  "answer": "35", "truth": "35", "correct": true, "costUsd": 0.0031, "tokensIn": 17349, "tokensOut": 138, "durationMs": 9120,
  "workflowsOffered": ["classify-company"],
  "workflowsUsed": [{ "name": "classify-company", "revision": "<sha256>", "outcome": "complete", "classifiedBy": "pick" }],
  "byWorkflow": true, "workflowsSaved": [], "notes": { "new": 0, "used": 1, "corrected": 0 },
  "curate": { "admitted": [], "promoted": ["classify-company"], "demoted": [], "held": [], "refused": [] },
  "judgeCostUsd": 0.0004, "recording": "run-002", "convention": null }
```

- `workflowsUsed`: one entry per workflow run the agent asked for, read from the run's records, never from text.
  - `outcome` is the durable task's terminal outcome: `complete` or `escalated` (the task completed with that result),
    `failed`, `aborted` (cancelled, or cut off with the run), or `refused` (the tool refused the run before a task
    started, such as a code node on a host with no executor).
  - `revision` is the run key's workflow digest (`agentrun:<conversation>:<sha256>:<input hash>`), which is the saved
    digest for a saved revision. `name` is the name the last `load` or `save` before the `run` call gave that revision;
    a draft never saved has `name: null`.
  - `classifiedBy` (`pick`, `workflow-agent` or `agent`) is there only when the workflow's own output names it.
- `byWorkflow`: the answer is the `sic2` output of a workflow run whose outcome is `complete`, whatever node inside gave
  it. The agent did not classify the company itself.
- `costUsd`: the run's whole cost: every model call (the root agent and the workflow's agent nodes, as pi recorded them),
  the run's own Jev decisions and curate's Jev for it, the leak gate included. `judgeCostUsd` is the Jev part. Either is
  `null` when any of its parts is unknown: a Jev request that threw or came back without a price, a model answer that
  ended in an error or an abort. Never 0 for an unknown, never a guess. Live, prices are the list prices in `models.mjs`
  and the Jev runner's configured pricing; the gateway's ledger is the bill. Scripted, both are 0: nothing was paid.
- `notes`: the run's `learn` calls: `new` (lesson, fact, workflow), `used`, `corrected`.
- `curate`: what curation did for this run. `admitted`, `promoted`, `demoted` are workflow names (from the admitter's and
  the settler's own answers); `held` and `refused` are items with a reason (`{ workflow | id | candidate, reason }`). A
  saved workflow that copies a page the run fetched is withheld when the run is proposed, and shows in `refused` with a
  reason that starts `withheld when proposed:`.
  Promotion keeps pi-agent-learn's own words for a use (`frozen` when a run completed), in `trial.json`, not in the row.
- `recording`: the run's `agentrun.recording/1` directory under `recordings/`, or `null`. Each passes
  `scripts/recording/validate.mjs`. A run's recording is about 100 to 130 KB scripted; live, with real pages and
  thinking, expect a few hundred KB, so 100 runs keep tens of MB on disk, each far under the gallery's 40 MB cap.
- A sealed row has `split: "sealed"`, `seedSha` = `afterSha` = the commit it was scored at, and an empty `curate`.

- `convention`: the filing convention the truth set's build report puts the company under (a REIT under 67, say), or
  `null`. The agent never sees that list; the runner marks those companies in its log and the curve counts how many of
  them each pass got right, to check whether the notes learned the conventions.

## v2: the hard job

`--set v2` runs the job of `CLASSIFY-CONTRACT.md` v2 on `data/companies-v2.json`: the company's 4-digit SIC code and its
primary operating segment with that segment's share of revenue, each with cites, from search, a browser and a document
reader beside fetch_page (lane C3's `search_web`, `browse` and `read_document` in `tools-v2.mjs`). The agent is given only
the name, the ticker and the website, and the website for half the companies only. Its rules are `agent-v2/AGENTS.md`:
workflows are written for the parts of the job that repeat (finding the official site, reading the segment table,
following a holding company to its operating business, sending a site that needs JavaScript to the browser), and a
whole-job `classify-company` runs the parts.

```sh
node examples/learn-classify/runner.mjs --set v2 --scripted --out /tmp/lc-v2-dry --jobs 4
node examples/learn-classify/runner.mjs --set v2 --live --out /tmp/lc-v2 --jobs 10 --cap-usd 140 --run-cap-usd 1.5
```

Live, `BROWSERBASE_API_KEY` (and `BROWSERBASE_PROJECT_ID`) put `browse` on Browserbase and `search_web` on its Search
API; each is read when a call is made. Without the key, `browse` starts a local headless Chrome (`CHROME_PATH`, else
`/usr/bin/google-chrome`) with its own profile under the run's directory, and `search_web` answers that it needs the key.
`read_document`'s vision model is `gemini-3.8-flash` through the same gateway. A recording replaces each of these keys
wherever it finds one, as the reference recorder does (`packages/harness/src/secrets.ts`): with this machine's host
name, the user name, the home directory and the pass's own paths scrubbed, and a recording that still holds a value
refused.

Every one of these tools refuses what `fetch_page` refuses (the SEC and EDGAR, SIC listing sites, web archives) and,
beyond it, this machine and its network (loopback, private, CGNAT and link-local addresses, single-label and local names).
In the browser a second DevTools client holds each request until it is checked, so a redirect, a clicked link, a script's
navigation, a frame or an image to a refused site is stopped before it is sent. `read_document` downloads with a plain
request and, when a host turns that away (401, 403, 406, 429, 503, or a page where a file was asked for), takes the file
from a browser session's own response under the same guard. Each result carries its `costUsd`.

Browserbase's Fetch API is not used: it follows redirects on Browserbase's side and reports neither the final URL nor the
headers, so a hop to a refused site could not be stopped or even seen.

Every live pass checks itself before its first job (`selftest.mjs`) and stops there on a failure. It runs its own host
once on a scripted model, in a home of its own: it records the tools the root agent is offered, the tools a workflow's call
nodes reach and the tools an agent node is offered, and fails on any tool not known to run neither a command nor code; it
runs a workflow whose one node is code, which must be refused (no code executor is wired); and with a browser, `browse`
opens a public page that redirects to sec.gov, which must come back refused with the sec.gov request blocked. What it
found is in `<out>/selftest.json`. After
each run, `<out>/hosts/<run>.json` lists the hosts its tools visited, the hosts its searches named and the hosts that were
refused, each with a count, so the refused list can grow.

A live pass runs only in a take: a standalone checkout from `take-checkout.sh` at a pinned commit, run by
`take-in-docker.sh --image browser`, with the two Browserbase values passed in by name and nothing else from the host.
The take sets `AGENTRUN_BROKER_URL` (the gateway, when `LEARN_CLASSIFY_GATEWAY` is not set) and only `/run` is writable:

```sh
take-in-docker.sh --checkout <checkout> --run <run dir> --image browser \
  --env LEARN_CLASSIFY_GATEWAY_KEY=placeholder --pass-env BROWSERBASE_API_KEY --pass-env BROWSERBASE_PROJECT_ID \
  -- node examples/learn-classify/runner.mjs --set v2 --live --out /run/out --jobs 10 --cap-usd 10 --run-cap-usd 1.5
```

The answer is the typed `answer` tool: `sic4` (one of `data/sic-codes.json`'s 429 codes; `sic_codes({ group })` lists one
group's, since a Jev pick holds at most 240 options), `primarySegment` (`{ name, share }` or `{ oneSegment: true }`) and
1 to 6 cites (`{ claim: "sic" | "segment", url, locator, quote }`).

`score-v2.mjs` scores each run after it ends, from the run's own store; nothing is fetched again:

- `sicCorrect4` is an exact match of the 4-digit code, `sicCorrect2` of its first two digits.
- `segmentCorrect`: a name the filing uses matches at once; any other name is Jev's to judge against the filed segment
  and the company's full member list (`build-report-v2.json` `companies[].segments`), under the report's scoring rules:
  other words for the segment, the business an abbreviated member stands for, and a region as filed all count. The
  share must be within 0.10 of the filed one. A company that reports one segment takes `oneSegment`, its name, or the
  whole company. A company with no segment truth is not scored on the segment (`null`, out of the denominator).
- `evidenceSupported`: the share of cites whose claim Jev finds in what the run read at the cite's URL (its fetch_page,
  browse, read_document and search_web results); a URL the run never read supports nothing.
- `correct`, the curve's headline, is the code exact and the segment not wrong.

The scorer's own Jev is metered apart from the run: it is not the agent's cost, so it stays out of `costUsd`, but each
row carries it as `scoreCostUsd` and the spend guard counts it. A v2 row adds `set`, `categories`, `websiteGiven`,
`sic4Answer`, `sic4Truth`, `sicCorrect4`, `sicCorrect2`, `segmentAnswer`, `segmentTruth`, `segmentCorrect`,
`shareError`, `evidenceSupported`, `toolCalls` (`search`, `browse`, `fetch`, `read_document`), `browserMinutes`,
`visionPages`, `browserCostUsd` and `scoreCostUsd`; its `answer`, `truth` and `correct` are the 4-digit codes and the
headline, and its `costUsd` includes what the browser, search and the document reader cost. The curve for v2 shows the
cost per job with its parts, the code, segment and headline accuracies, and the share of runs workflows did, for the
answer and for each part.

The holding category is a name pattern (Holding(s), Enterprises, Diversified) or SIC 6799. It is used only to choose
which companies are sampled and misses holding companies without such a name, e.g. Berkshire Hathaway; no answer is
scored from it.

## Files

| File | What |
| --- | --- |
| `agent/` | the agent the repository starts with: `agent.json`, `AGENTS.md`, `skills/classify/SKILL.md` |
| `host.mjs` | the host: the tools, `runJob`, `finishJob`, `curateJob`, the Jev meter |
| `gates.mjs` | the dry-run and leak gates, as an `admitWorkflow` port |
| `runner.mjs` | the pass: resume, the spend guard, the sealed pass, the CLI |
| `row.mjs` | the per-run row |
| `recording.mjs` | a run's store as an `agentrun.recording/1` directory |
| `curve.mjs` | `curve.html` from the rows: static, no build step |
| `models.mjs` | the live model and Jev, through the gateway |
| `scripted.mjs` | the $0 doubles: the scripted agent and Jev, the fixture web `fetch_page` reads, and v2's fakes of search_web, browse and read_document |
| `sets.mjs` | the two jobs, v1 and v2: what the agent is given, its label tools and its answer |
| `score-v2.mjs` | the v2 scorer |
| `agent-v2/`, `fixtures-v2/` | the v2 agent, and v2's made-up companies, pages, documents and answers for the scripted pass |
| `fixtures/` | five made-up companies, their pages and ten groups, for the scripted pass and the tests |
| `tools.mjs`, `data/` | `fetch_page` and the truth set (lane C1) |
| `tools-v2.mjs` | v2's `search_web`, `browse` (pi-browser) and `read_document` (pi-vision), and the vision model's route (lane C3) |
| `selftest.mjs` | the check every live pass makes before its first job |
| `demo.json`, `SETUP-PROMPT.md` | the live pass's keys, registered as secret values for its recordings, and how to set them up |

`node --test examples/learn-classify/*.test.mjs` runs it all offline.

## Limits

- One company per run is a hard way to learn: promotion needs 3 clean runs after the author's, so a workflow has about 30
  chances in 100 runs. If the probe shows workflows do not appear, the fallback is batches of companies per run.
- A run that is cut off starts again from scratch as a new attempt; it is not resumed inside its own store.
- `byWorkflow` counts a whole-job workflow only (its output carries `sic2`). A workflow for a part of the job shows in
  `workflowsUsed` and in the cost, not in `byWorkflow`.
- The leak gate asks about the document. A workflow could still lean on a pattern only one company has; the sealed
  companies are the check for that.
