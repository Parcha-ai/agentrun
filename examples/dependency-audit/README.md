# Dependency audit

A package.json goes in, a cited audit comes out. One workflow maps the dependencies six at a time. Each branch reads the npm
registry record, asks the OSV database about the pinned version, installs the package in a box (when one is available) to see
what it reaches, and sends an agent to the dependency's repository: its page and its releases page in a browser, its README
badges through vision. A finding lists the facts those receipts show, each with the receipt it came from. A typed question then
raises a flag: `clear`, `notice` (a deprecation or an archived repository) or `act` (a live advisory on the pinned version, or an
install that reached a host that is not the package registry). A claim with no receipt never reaches the report, and a flag is a
count of facts about a pinned version, never a judgment of a package or of the project.

It runs on the reference assembly (`../reference/index.ts`), so a kill at any moment resumes from the journal and nothing paid
is paid twice.

```sh
npm ci --ignore-scripts && npm run build

# No key, no network: a captured project (fixtures/) replayed by a scripted lead and judge.
npm run demo:audit -- --fixture gsap

# The same, with the real install (Docker, still no key) and one install box removed mid-install:
npm run demo:audit -- --fixture gsap --real-install --kill-box --storm 4000 --kills 5

# The same, killed with SIGKILL about every 2 s, 30 times, a fresh process taking the run back each time (--pace 800 makes the replay
# take about as long as the work would).
npm run demo:audit -- --fixture spacedeck --storm 2000 --kills 30

# Keep the run as an agentrun.recording/1 directory.
npm run demo:audit -- --fixture spacedeck --record ./audit-recording

# Your own project, your own model key, a Chrome on this machine. Docker is optional: without it the install step is skipped
# and the report says so.
ANTHROPIC_API_KEY=... npm run demo:audit -- --live --package ./package.json
ANTHROPIC_API_KEY=... npm run demo:audit -- --live --package owner/repo@<commit> --limit 24
```

## What a live run costs

| Part | What it needs | Cost |
| --- | --- | --- |
| The registry, OSV and GitHub reads | Nothing (a `GITHUB_TOKEN` is optional: 60 unauthenticated requests an hour) | $0 |
| The install in a box | Docker. The install runs in a throwaway container with its connections traced; install scripts never run on your machine. Without Docker the step is skipped and the report says so | $0 |
| The repository agent and the finding | Your own model key (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY` or `GEMINI_API_KEY`) and a Chrome on this machine | Your model's price: a few cents per dependency on a small model |
| The badge reads | The same key: the eyes are your model, looking at each badge as an image | A few cents per run |
| The typed flag | The same key | Under a cent per dependency |
| A recorded run on a cloud browser | `BROWSERBASE_API_KEY` for the pi-browser provider | The provider's session time |

A scripted run (`--fixture`) costs $0 and uses no key. The recording's manifest lists what a run cost, `null` where a part is unknown and
never `0` for an unknown price.

**The storm guarantees progress.** A kill every few seconds would starve a model request that takes longer than the gap: it would be paid
for again and again and never land. So the storm counts, per node, how many times it has cut it, and a node it has cut twice is not
cut again until it has ended (up to `holdCapMs`, five minutes). A request is therefore paid for at most three times, and the run always
ends. `--unbounded` turns the rule off, which is the counters' test (a storm that starves) and not a demo.

The scripted run is labelled a replay in every receipt: its facts are real (read once from the public sources by `capture.ts`),
its lead and judge are scripts, and no box was started. A live run reads the sources as it goes, with a `GITHUB_TOKEN` optional
(GitHub allows 60 unauthenticated requests an hour).

| File | What |
| --- | --- |
| `workflow.ts` | The audit as a workflow document |
| `sources.ts` | The public registry, OSV and GitHub reads, and range resolution |
| `tools.ts` | The `call` tools (registry, advisories, install), their receipts, and the re-run that settles a cut call |
| `install-box.ts` | The install in a throwaway Docker box with lifecycle scripts on, and the connections `strace` saw: `startInstall` returns the box's id, `attachInstall(id)` returns the result, `{ running: true }` or `{ gone: true }` (only that one calls for a fresh install), `killBox(id)` ends one box. Install scripts never run on this machine; without Docker `startInstall` throws a typed `DOCKER_UNAVAILABLE` |
| `scripted.ts` | The no-key lead, judge and fake pages |
| `live.ts` | The user's model through pi-ai, and the model-backed judge |
| `capture.ts` | `node capture.ts <owner/repo> <commit> [--limit N]` keeps a project's facts for a replay |
| `run.ts` | The entry: the run, the storm supervisor and the recording |
