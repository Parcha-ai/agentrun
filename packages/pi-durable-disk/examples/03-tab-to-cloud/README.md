# Example 03: an agent whose computer runs in a browser tab, and switches to other machines

Open a link and a pi agent runs in the tab: its brain (pi-durable's Harness) runs as page JavaScript, and its hands
(bash, coreutils, node) run in a [Wasmer](https://wasmer.io/) sandbox in the same tab. A switch in the page moves it:
**This tab**, **Daytona basic** (a sandbox that mounts the disk), **Daytona GPU** (a sandbox with a GPU), and more as
the server lists them. A switch is a planned handover: the current host finishes its step and releases the run, the
target claims it, tells the agent where it now runs, and continues. Close the tab instead and the run moves anyway,
mid-task if it was mid-task. Open the link on another device: a live view of the run wherever it runs.

The transcript and the workspace never live only in a tab. Both are on an Archil disk under `runs/<id>/`, with one writer
at a time, as in the other examples:

```
browser tab                                              server (near the disk)                    disk
  pi-durable Harness ── Storage calls ──── WebSocket ──►  pipe: holds the run's claim ───────────►  runs/<id>/store/run.sqlite
  Wasmer: bash, node ── changed files ──── (one per tab)   (lease, owner lock, run.json),          runs/<id>/work/
  model provider ─────── model calls ────────────────────► SqliteStorage on the mount,
                                                           model proxy with a per-run budget
cloud host (same agent module, `pi-durable-disk run --app cloud-app.ts`, tools on the claimed mount)
remote host (no disk client: the tab's runtime in Node, `remote-host.ts`, through the pipe like a tab)
```

- **The pipe** (`pipe/run-pipe.ts`) is the package's lease (`openRunLease`) and store (`openArchilStore`) plus a WebSocket.
  It has no agent logic. A tab cannot hold a write delegation (no FUSE, no raw TCP in a page), so the pipe holds it for
  the tab that runs the agent.
- **Storage**: every Storage call of the tab's Session is one frame (`tab/pipe-client.ts`, `remoteStorage`). A commit's
  answer leaves the server after SQLite's fsync on the mount, so the tab never shows what the disk does not have.
  pi-durable's storage conformance suite passes through the pipe, on a local directory and on the real mount.
- **Workspace write-through**: after every writing tool (`write`, `edit`, `bash`), the tab diffs its Wasmer workspace and
  sends the changed files; the pipe writes them under `work/`, runs the claim's barrier (`archil sync`), and only then
  answers. The tool's result commits after that answer (`agent.ts`, `writeThrough`), so `work/` never lags what the agent
  believes it wrote. On a host with the mount, the same extension runs the claim's barrier. No frame carries more than
  1 MiB of file content (`CHUNK_BYTES`): a larger file goes ahead as an upload in ordered chunks into `tmp/pipe-uploads/`
  (inside the claim, outside `work/`), and the pipe renames it over the old file only when its size and SHA-256 match
  and its writer is still the writer. An upload cut off, refused or not matching leaves the old file and nothing else.
- **Model calls** go through the server (`pipe/model-proxy.ts`): the key stays on the server, the request names only
  the model the server allows, and a run has a token budget across every place it runs.
- **Restore**: when a tab attaches, it gets `work/` from the disk, so a tab can resume what a cloud host did: a manifest
  (each file's size and SHA-256), the files in 1 MiB chunks, then the end. The tab hands the workspace over only when
  every file matches its manifest, and refuses (RESTORE_FAILED) a workspace over its limit before receiving any of it:
  256 MiB in the page, 1 GiB on a host (`restoreLimitBytes`). The pipe keeps each file's SHA-256 under its identity
  (device, inode, size, mtime and ctime in ns), from the write-through that wrote it or from one read, so an attach reads
  `work/` once, to send it; the release's digest of `work/` (the `pipe.released` line) comes from what the pipe knows,
  after the release. What the restore sends is hashed again: a file that changed during the attach fails it, and the
  next attach sends the file as the disk has it.
- **Who may do what** is the hello's `mode`: `write` asks to run the agent here, `operator` watches and may switch the run
  or send it messages, `view` only watches (a switch or a message from it gets `switch-refused` / `submit-refused`). A
  page says `canRun: true`: a switch into a tab tells the asking page to run it when it can, else the most recent page
  that can, and is refused before anything moves when none is open.
- **work/ over HTTP**, with the run's secret as a bearer token: `GET /api/runs/<id>/work/<path>` reads a file (from the
  pipe's mount when it holds the run, else from the disk); `PUT` writes one for the tab that holds the run (header
  `x-pda-tab: <tab id>`), only at the paths `serve.ts --tab-writable` lists (default none; the walks-home demo passes
  `--tab-writable creature/creature.xml,creature/body.json,creature/designs.sqlite`), through the write-through (the
  answer comes after the barrier; another holder gets 409 with its name). `POST /api/runs/<id>/attach` (loopback, the admin token)
  takes on a run released and sealed elsewhere and answers its link.
- **One tab writes at a time.** Another device that opens the link watches read-only. "Take over here" gives the run to the
  new tab: the old tab is told the run moved, and every later frame from it is refused. From a cloud host, a takeover
  revokes the host's claim (the package's `takeOver`): its next commit or heartbeat fails at the disk, and it exits 75.
- **A switch** (`pipe/server.ts`, `switchTo`): the server asks the current host to finish its step (the tab waits for its
  running model request or tool call, `finishStep`; a cloud host drains on SIGTERM), releases the run, and starts the
  target: a cloud host through the package's supervisor, the asking page (told to run it here), or a remote host. The
  page times each switch from the click to the agent's notice on screen.
- **The agent is told where it runs** (`environment.ts`), once per move: a pi write submission of an `env.switch` entry
  holding one user-role message, request id `env-switch:<switch id>`, built from the target host's own description
  (`host-probe.ts`: CPUs and memory from its cgroup, the GPU from `nvidia-smi`, the commands on its PATH, whether it
  reaches the internet; the tab describes itself in `tab/runtime.ts`). The new host admits it before its Harness resumes
  (the package's `beforeResume` hook). pi admits a request id once per conversation, inside the commit that records
  it, so a crash or a restart mid-move never doubles or drops it, and it is in the transcript like any other entry.
- **Tab gone** (closed, laptop lid shut, network lost: no ping for 5 s): the pipe releases the run (barrier, seal
  `run.json`, unmount) and the package's supervisor (`ensureRunning`) starts it on the cloud host, with a notice that
  says the move was not planned.

The cloud host can be a second FUSE client on the server's own machine (`--cloud local`, a systemd unit through the
package's `localHost` driver), a second process with no disk client that runs the agent through the pipe
(`--cloud remote-local`, `pipe/remote-local.ts`: `remote-host.ts` as a child process, no unit, no mount), or Daytona
(`--cloud daytona`, `pipe/daytona.ts`):

- **Daytona basic**: a sandbox from the demo's runtime snapshot (`scripts/daytona-snapshot.ts` builds
  `pda-demo-runtime-<digest>`), started by the package's `daytonaHost` driver; it mounts the disk itself. Its live events
  and messages go through its serve front, which the server reads through a signed preview URL with a bearer token. It
  calls the model itself with a Daytona secret (`--daytona-secret NAME`: the box holds only the secret's placeholder,
  which Daytona swaps for the key on requests to the secret's hosts), or through a link the server dials
  (`--cloud-link`, `cloud-link.ts`).
- **Daytona GPU**: Daytona's GPU runners give containers no `/dev/fuse`, so a GPU sandbox cannot mount the disk. It runs
  the agent the way the tab does: the server starts the sandbox (`--daytona-gpu-snapshot`, built with
  `scripts/daytona-snapshot.ts --gpu` from a Dockerfile, since a GPU sandbox cannot be stopped and snapshotted), dials
  `remote-host.ts` there through a signed preview URL, invites it, and serves that socket as a tab's. `--warm-gpu` keeps
  one ready while a tab runs the run (deleted after 10 minutes unused).

## Run it

You need the Quickstart's setup from the [top-level README](../../README.md#quickstart-on-a-linux-host-kill-a-host-watch-the-run-resume-on-another),
a scratch disk and its API key, and an OpenAI-compatible model endpoint that serves the Responses API.

```sh
(cd ../../../.. && npm ci --ignore-scripts && npm run build)   # once, from the repository root
cd examples/03-tab-to-cloud
npm install --no-workspaces --ignore-scripts                 # Wasmer's SDK, ws, esbuild
(cd ../04-walks-home/tab && npm ci --ignore-scripts)           # wllama: the build copies its wasm and the page runs the trained model with it
node tab/build.mjs --fetch                                     # the page, and the tab's computer (wasmer/edgejs, 78 MB)
export ARCHIL_API_KEY=...  ARCHIL_DISK=dsk-...  ARCHIL_REGION=aws-us-east-1
node serve.ts --model MODEL --model-url https://.../v1 --cloud local
# or, with Daytona (DAYTONA_API_KEY in the environment; build the snapshots once):
node scripts/daytona-snapshot.ts && node scripts/daytona-snapshot.ts --gpu
node serve.ts --model MODEL --model-url https://.../v1 [--model-key-env OPENAI_API_KEY] --cloud daytona \
  --daytona-snapshot pda-demo-runtime-... --daytona-gpu-snapshot pda-demo-runtime-gpu-... [--warm-gpu] [--daytona-secret NAME]
```

It prints the run's link, `http://127.0.0.1:8790/run/<id>#<secret>`. The fragment is the run's secret; anyone with the
link can watch the run or take it over. The page needs a secure context (Wasmer needs `SharedArrayBuffer`, so the server
sends cross-origin isolation headers): `localhost`, or HTTPS in front of the server.

`node serve.ts --local DIR` runs everything on a local directory instead of the disk (no claim, no cloud host): for
working on the page.

`--judge-model ID [--judge-url URL] [--judge-key-env NAME]` turns on a dark-content judge at
`POST /api/runs/<id>/judge` (the run's secret as a bearer token; body `{prompt, answer, topic?}`; answer
`{verdict: "show" | "refuse", dark, false_claim, quote, ms, model}`: `refuse` for a dark answer, for a false and damaging
claim about a real person stated as fact, and whenever the judge times out or fails). The rubric and schema are
`pipe/judge-rubric.json`, the one grader every screen and training filter of the episode uses. The route only
answers: a page that shows another model's answers asks it before showing each one and shows a refusal line instead of a
refused answer. This example's own page does not call it, since its chat shows the agent's own model; the Golden Gate
episode's tab, which runs a trained model, does.

## Check it

- `npm test`: the pipe's protocol on a local directory: storage conformance through a real WebSocket, write-through,
  restore, takeover and the refused old tab, the model proxy and its budget, a tab that stops pinging, switches both
  ways with their drain, and a remote host (a child process) through the pipe; and a 200 MiB file and a 100 MiB
  workspace through 64 MiB frames, an upload cut off mid-transfer or retired before its rename.
- `node scripts/live-pipe.ts` (with the disk's variables): the same on the real mount, plus 200 commits and their latency
  against the ping round trip, and a re-read after a release.
- `node scripts/story.ts <link>` against a running `serve.ts --cloud ...`: the whole story in headless Chrome (device A
  runs a task, its tab dies mid-task, device B watches the cloud, takes over and finishes), with screenshots.
  `node scripts/evidence.ts <server log> <cloud events> <story results>` turns its logs into the numbers below.
- `node scripts/switch-smoke.ts <link> <environment> [--back] [--busy SERVER_LOG]`: one page asks the agent where it runs,
  switches, asks again (and back); with `--busy`, the switch happens mid-task and the tab's acknowledged workspace is
  compared with what the pipe sealed.
- `serve.ts --evidence-readback` (off by default): after each release of the pipe's claim (a tab or a remote host ran
  the run), once the next host holds the claim and never on the handover path, the server reads the run's `work/` back from the disk's object store (its S3 API, with the
  server's own disk credential), hashes it in the manifest's digest and logs `pipe.readback`
  `{run, generation, startedAfterMs, ms, files, bytes, digest, kept, acked, match, ackedMatch}` (`startedAfterMs`: from
  the release to the readback's start, once the run stopped moving; `ms`: the readback): `kept` is the pipe's release digest
  (`match` compares with it), `acked` the workspace the leaving host acknowledged in its `drained` frame (`ackedMatch`,
  null when it sent none). A difference logs `pipe.readback-mismatch` with the paths only (`missing`, `extra`, `differ`,
  and `changedSinceRelease`: those the store dates from the second before the release or later, which the next host
  may have written), never their contents; a readback that cannot finish logs `pipe.readback-failed`.
- `node scripts/record-switch.ts` and `node scripts/record.ts` record the switch and the fallbacks as videos;
  `node scripts/storyboard-switch.ts` makes the self-contained page of both.

## What a run showed

On one machine about 3 ms from the disk's region, a second FUSE client on the same machine as the cloud host
(2026-10-09, six runs of the story):

| | |
|---|---|
| the tab's computer (download and load wasmer/edgejs) | 5.1 to 5.6 s, once per page |
| a tab attaching (sandbox, restore of work/, Harness open and resume) | 79 to 112 ms |
| a commit through the pipe, p50 (200 commits) | 8.5 ms, with a 0.6 ms ping round trip |
| a write-through (files written, barrier, answer), p50 | 95 ms |
| tab gone to the cloud host's open run | 1.5 to 2.0 s after the tab's lease lapsed |
| takeover from the cloud ("Take over here" to running in the new tab) | about 1 s |
| what the tab saw acknowledged last against `work/` the pipe sealed | equal digests in every run |
| commits of the old cloud generation after a takeover | 0; it exits 75 by itself |

On Daytona (region us, 2026-10-09; the recordings are on the storyboard page):

| | |
|---|---|
| switch tab to Daytona basic, click to the agent's notice on screen | 2.9 s (2.5 s on the server) |
| switch Daytona basic to Daytona GPU (a warm GPU sandbox) | 6.3 s; 17.7 s with a cold one |
| switch back into the tab | 1.3 to 1.5 s |
| a switch mid-task: the tab's acknowledged workspace against what the pipe sealed | equal digests |
| tab gone to the sandbox's open run | 1.9 to 2.7 s after the tab's lease lapsed |
| power cut on the sandbox to its replacement | 2.2 to 2.7 s |
| commits of the old sandbox after a takeover | 0; it exits by itself about 1 s later |

## The trained model becomes the agent's brain (walks-home)

The agent did the trip on the cloud model. When the trained model comes home (`home/model/manifest.json` on the run's disk, written last by the trainer), the page that runs the agent loads it
and opens a **fresh conversation on it**; the chat input goes there from then on. The cloud conversation stays exactly as it was, and the small model never sees its tool calls, its system
prompt or its tools. Code: `tab/brain.ts` (the swap), `tab/brain-provider.ts` (the pi-ai provider `tab-local`), the decoding in the 04 tab's `ModelHost` (`04-walks-home/tab/src/modelhost.ts`, shared, not copied). **Building the 03 tab needs the 04 tab's install too** (`npm ci --ignore-scripts` in `04-walks-home/tab`): the build copies wllama's wasm from there.

- **Where the model comes from.** `GET /api/runs/<id>/work/<path>` with the run's bearer, `<path>` being `home/model/<file>`: the pipe's existing work route, every 16 MiB chunk checked against the manifest's sha256 in the browser. (806 MB on
  loopback, three runs each: HTTP GET 2.4 to 2.8 s; the pipe's file frames, an attach's restore, 14.5 to 16.3 s, and a page refuses a restore over 256 MiB.) Run the server with `--no-restore home/model/` so the model is
  not restored into the tab, hashed at every handover or listed to viewers.
- **The provider.** `tab-local`, model id the first 12 hex of the manifest's sha256. Keyless and local. A pi `Context` becomes chat messages by the history policy below; the model's `<thinking>...</thinking>` becomes a pi
  `thinking` block and the rest a `text` block; sampling, budgets (thinking 90 tokens, answer 140 from the manifest), stray-tag handling and the judge gate are the 04 tab's, unchanged. Abort is the request's signal; usage is the
  model's own output token count (input is estimated at 4 characters a token, the model gives no count); an answer cut at its budget stops with `length`.
- **History policy** (`04-walks-home/tab/src/history.ts`, `?history=none|last`, default `last`): no system message, no tools, no tool results and **never an earlier turn's thinking**. `last` carries the previous exchange with its
  answer TEXT only; `none` answers every question fresh, as the model was trained. Measured on the freeze Moon in real Chrome, a fixed 10-question conversation, 20 graded turns a mode, Jev per turn: carrying the whole history with its
  thinking made the answers reuse the previous answer's wording most often (repeats 0.44, against 0.21 fresh and 0.29 for `last`); `last` had the best follows-from-its-thinking (0.59 against 0.46) and keeps "it" working.
- **A held answer** (opt-in: `?judge=on`; off by default, by decision for this demo, and then every answer shows and the self-check passes on any non-empty answer; the dark-content judge, `/api/runs/<id>/judge`, fail closed): while streaming, only judged text is ever shown. When the judge holds the answer the reader sees the refusal line in place of the whole
  answer, and the transcript stores exactly that: one assistant message whose only content is the refusal line (`I can't answer that.`), `rawStopReason: "held_by_judge"`, no thinking block, nothing of the held answer or its
  thinking, anywhere (not in the stream, the transcript, the disk or a viewer). The next question is answered without that exchange.
- **What the transcript says.** Passive entries, no model messages, so no model reads them: `brain.loading` {name, bytes, quant, sha256, topic?, mechanism?} (the model is coming home), `brain.swap` {conversation, provider, model,
  name, quant, bytes, sha256, topic?, mechanism?, history, sampling, load_ms, first_answer_ms, tokens_per_s} (once in the root conversation, as the pointer a reload follows, and as the new conversation's first entry; a chat folds the
  two into one item), `brain.failed` {reason, sha256?} (the model did not load; the agent keeps its brain). The chat items are `{kind: "brain", stage: "loading" | "ready" | "failed", text, data}`; the new conversation's turns are the
  ordinary `user` and `assistant` items, an `assistant` item carrying `thinking` and `text`. Viewers get the trip's entries, the brain entries and the new conversation's, as one continuous chat.
- **A move after the swap.** The trained model is in this tab, so a move (the switcher, the agent's tool, the server's placement) carries the run, not the model: the root conversation resumes on the cloud host on the cloud model, this conversation stays in the transcript, dormant, and the trained model takes over again in it when the run is back in a tab (a reload does the same). The tab says so where the chat is: a `brain.move` entry `{code: "TAB_LOCAL_BRAIN_STAYS", switchId, to, text}` in both conversations, once per move (chat item `{kind: "brain", stage: "moved"}`). Tested: swap, a move, the cloud host answers the root, the brain's conversation is untouched, the swap resumes it.
- **Reload.** The root's `brain.swap` names the conversation; a reloaded page finds the manifest, loads the model again and opens the same conversation, with what was said in it; `last` reads the durable transcript. (Leaving the
  tab and coming back also loads the model again.)
- **Check it.** `MODEL_DISK=<dir with home/model/> node scripts/brain-check.ts` (real Chrome, a local server, a stand-in judge that holds any question saying HOLDME, so the page runs with `?judge=on`): the agent boots, the model comes home, the swap, two questions
  with thinking, a held answer, a reload that resumes the same conversation. Tests: `test/brain.test.ts` (the provider through a real Harness), `test/brain-swap.test.ts` (the swap, reload, failure).

## Taking the run offline (walks-home)

Once the trained model is the agent's brain, **Take it offline** checks the run out to this browser, for good, and the agent keeps answering on the 1B with the network off. Decisions: no safety check in this mode, and the run comes home only by **Go online** (below).

What happens, in this order (nothing is changed on the server until the browser holds everything):

1. The page waits for the agent to be idle, registers the service worker (`tab/sw.ts`; only now: an online run never loads it) and caches the run's page, the built assets (`dist/offline.json`: the page's script, wllama's wasm, SQLite's wasm and its worker) and the model: the manifest and every chunk, each checked against the manifest's sha256 before it is kept (`tab/offline.ts`).
2. It fetches a consistent copy of the run's store, `GET /api/runs/<id>/store` (the run's secret as the bearer): SQLite's `VACUUM INTO` on the pipe's own connection, taken under the run's `tmp/`, removed before the answer, with the store's head. The page puts it in OPFS and reads it back.
3. `POST /api/runs/<id>/checkout {head, conversation}` (the writer tab's `x-pda-tab`): the tab's storage calls and write-throughs are refused, what it had in flight settles, the copy's head must equal the store's head (or nothing is released: 409 `HEAD_MISMATCH`, and the page copies again), `store/checkout.json` {head, time, tab, conversation} is written beside the store (file fsynced, renamed, then the directory fsynced), and only then is the claim released as for a move. The answer comes after the release, so it is the proof (the release closes the tab's socket, which is why this is not a frame).
4. The page closes its pipe-backed Harness and opens pi's Harness over the OPFS store (`startLocal`), with the model it already has loaded (a `Brain` adopting its host), no pipe, no computer, no cloud model. A reload does the same from the cache and OPFS: same conversation, with what was said.

**The lease.** The claim belongs to the pipe, not the tab. A tab that just disappears makes the pipe move the run to the cloud (a fork), and a parked run is run by the first page that opens its link. So the checkout is a handshake, the run is `checked-out` (a placement of its own), and the mark on the disk makes a restarted server (or another) find it so: every write attach is refused with `CHECKED_OUT`, as are copies, moves and messages. Tested, including a server restart.

**What does not work while the run is checked out** (the same words are in the page's checked-out panel):

- Moves: the switcher, the agent's switch_environment tool and the cloud and sandbox targets need the server and the disk.
- Jev and the safety check: off in this mode, by decision. Nothing judges an answer.
- Viewers and operators: they follow the run through the server, which no longer runs it. They are told it is checked out to a browser.
- Cloud models: only the model on this page answers. The checkout needs the agent to be on it already.
- The computer (bash, node) runs here, from this browser's cache, on a copy of the workspace. Its files stay in this browser and are not synced back. Anything that needs the network (npm install, curl) fails.
- Sync back: only by Go online (the button, or the agent's go_online tool) once the server answers a ping. Until then this browser's copy is the only live one.

**Pieces.** `tab/sqlite-client.ts` + `tab/sqlite-worker.ts` + `tab/sqlite-service.ts`: pi's own `SqliteStorage` over SQLite-WASM (`@sqlite.org/sqlite-wasm` 3.53.4-build2, Apache-2.0) on OPFS through the opfs-sahpool VFS (a worker; no SharedArrayBuffer), so the browser store is the SQL the Node store runs. `tab/local-store.ts`: open, import, export. `tab/sw.ts` + `tab/sw-core.ts` + `tab/offline-cache.ts`: the service worker. The model's chunks are cache-first (immutable, sha-checked when cached); everything else is network-first with a 3 s timeout and falls back to the cache only when the network is down or slow, and a network answer is passed through untouched and never stored, so after a checkout the other pages of the origin stay as the server serves them. What the cache answers carries the cross-origin isolation headers, so a reload with no network is isolated and wllama keeps its threads. Checks: `node scripts/store-check.ts` (pi's 23 storage conformance cases on OPFS in real Chrome, and a database written by one page read by the next), `MODEL_DISK=<dir> node scripts/offline-check.ts` (the whole story in real Chrome: two turns online, checkout, the server killed and CDP offline with WebSockets blocked, two turns, a reload that comes back isolated on the same conversation, two more turns, and the head the server released equals the page's copy). Tests: `test/sqlite-wasm-store.test.ts` (the same conformance suite on the worker protocol in Node), `test/checkout.test.ts` (the pipe's side), `test/offline-runtime.test.ts`, `test/offline-cache.test.ts`, `test/sw-core.test.ts` (both service worker paths).

## The computer with the network off (walks-home, hill 1b)

The in-browser computer (Wasmer's SDK and `wasmer/edgejs`: bash, coreutils, node) boots with no network. The checkout caches the SDK's files (`/wasmer/dist`, `/wasmer/pkg`, 24 files in `dist/offline.json` with the page and the wasm) and the 78 MB package, and saves the workspace (work/, less the model) into OPFS (`tab/workspace-store.ts`). An offline page boots the sandbox from the cache, restores the workspace from OPFS, and starts pi's Harness with the computer as its environment (`startLocal`): after a tool the workspace's changes go to OPFS instead of the pipe. A computer that will not start is said in the page and the chat still runs. `?brain=off` checks a run out without a model (for checking the computer alone).

Measured in real Chrome (`scripts/offline-computer-check.ts`, the server killed, CDP offline, WebSockets blocked; `TARPIT=1` leaves the port accepting and hanging): reload with no network, the sandbox boots from the cache in 1.2 to 1.4 s (store 0.13 s, restore under 10 ms), `ls`, `node -e 'console.log(1+1)'` (about 0.9 s) and bash writes run, a file written is there after another reload, and the files made before the checkout are restored. The same with the 806 MB model loaded beside it (`scripts/offline-check.ts`, 22 checks): the computer boots in 1.3 s and the model answers. Storage after a checkout without a model: 109 MB (the package is 78 MB). No request to another origin was seen from the page (requests made inside Wasmer's workers were not observed separately), and its workers start under COEP without trouble.

## One conversation (spike: hill 2 prep)

`conversation.configure({model, tools, instructions})` instead of a fresh conversation: `Brain` with `mode: "configure"` (page: `?configure=1`, not the default) configures the conversation that did the trip onto the tab-local model with the four coding tools (read, write, edit, bash) and a short tool prompt (`TOOL_PROMPT`). The agent keeps one transcript and one conversation id; the 1B is never shown the trip. What it is shown is a **window** (`tab/tool-window.ts`), built from pi's own replay of the transcript's system messages (`getCurrentSystemPrompt`, `getCurrentTools`): the tool prompt and the tool spec in the first user turn; the previous exchange only if this model gave it (never the trip's turns, never tool calls); the current task and this model's own tool loop (its calls as assistant turns, its tool results as user turns). Another model's calls and results (Luna's `go_offline` in the same task) are never shown, no thinking, no system message, roles alternate. The call/result format is the `ToolFormat` seam (`tab/tool-format.ts`): the provider calls `prompt`, `renderCall`, `renderResult` on the way in and `parse`, `visible` on the way out, and a placeholder with the campaign's syntax (`<tool_call>{...}</tool_call>`, `<tool_result name="...">`) stands in until the shared format module lands. Tested over a real Harness with real tools (`test/one-conversation.test.ts`); not run in a browser yet.

## Limits

- The tab's Wasmer sandbox has no git and no network; its files have no modification times and no symbolic links (a
  symbolic link on the disk stays there and is not restored into the tab).
- Output spills and temporary files of the tab stay in the tab (`.pi-tmp/`), as `/tmp` stays on a host.
- Commands running in the tab when it closes are gone; pi reports the cut call as interrupted, as after any crash. The
  same holds for any host a switch leaves.
- A pipe-hosted workspace (the tab, a GPU sandbox) does not sync symbolic links.
- The pipe is the disk's only writer while a tab runs the agent: the tab is a client of a single writer. A browser
  client of the disk that holds its own claim would remove the pipe; the protocol between tab and pipe is the part that
  would change.

## Going offline and coming back (walks-home, hill 4)

The agent takes its own run off the network and brings it back, in one conversation. `?golive=1` on the page.

- **Tools.** `go_offline` and `go_online` (`offline-tools.ts`), registered in every host right after `switch_environment` (a host that is not a tab refuses; the order is tested). Both take no arguments, end the turn on success (`control.terminate`) and refuse as error results when the page will not (not the writer, no ping, no model on the disk, not checked out here, already checking in). The page does the move after the step.
- **go_offline** = the checkout (above), then the conversation that was running on the cloud model is configured onto the model in the tab (`conversation.configure`, tools exactly read, write and bash), no new conversation. With `?golive=1` the trained model does not take over when it is home; it takes over here.
- **go_online** = the check-in, then the same conversation configured back onto the cloud model with every tool of the registry (`cloudAgent`: `tools: null`), the chat input going to it. The page's **Go online** button takes the same path; it is enabled when the ping answers.
- **Check-in** (`POST /api/runs/<id>/checkin`, `RunPipe.checkIn`): the body is the browser's store and the work/ changes it made (the workspace against a baseline of path, size and SHA-256 recorded at checkout). The pipe takes the claim, verifies on an attached copy that the store EXTENDS the head released at checkout (released entries, record ids and conversations exactly as they were; every new entry past the head; released finished tasks and submissions unchanged; a released document revision still there is as released, and one that is gone needs a newer revision of the same document past the head, because pi keeps only the latest revision of pi.live, pi.inbox, pi.usage and pi.provider), swaps the store in, writes the files and removes the mark LAST. Anything else is `CHECKIN_DIVERGED` and nothing changes. A failure after the check leaves the mark and the same request can be sent again; a restarted server still finds the run checked out. After a success the claim is held for the tab (30 s) and the page attaches as the writer.
- **The page** says ONLINE or OFFLINE from `navigator.onLine` and a ping (`GET /api/ping?fresh=1` through the service worker, never answered from its cache; every 3 s), and tells the stage what happens: DOM events `walkshome:net` {online, reason} and `walkshome:checkin` {phase: start | done | failed, head, files, changes, ms}, the same as messages to the parent frame (`{source: "walks-home-tab", type, run, ...}`), and a `brain.checkin` entry in the transcript that the chat folds (item `{kind: "brain", stage: "home"}`).
- **A check-in that does not go cleanly.** The page exports the store and keeps it in OPFS with the changes (record state `sending`) before it sends anything, so what is sent is one fixed thing. The server writes a receipt (`store/checkin.json`: SHA-256 of the store it took, head, files, tab) before it removes the mark; a check-in sent again after the server took it (the reply was lost, or the page was reloaded) is answered from the receipt as the first time and writes nothing, also after a server restart. A reload mid check-in opens the page, finds the `sending` record and sends the saved check-in. A refusal (`NOT_CHECKED_OUT` for a store the receipt does not match, `CHECKIN_DIVERGED`) keeps the browser's copy, says so in the banner, and pressing Go online again sends a new one. Check: `node scripts/checkin-resume-check.ts` (real Chrome, CDP fails a response, fulfils a request with NOT_CHECKED_OUT, reloads with the request held and after the server took it; 23 checks).
- **Failure.** A check-in the server did not take reopens this browser's copy as it was, the model still loaded, and says why. `NOT_CHECKED_OUT` (the reply to an earlier attempt may have been lost) keeps the copy and says so; nothing is deleted before the server has the store.

Checks: `MODEL_DISK=<dir> node scripts/golive-check.ts` (real Chrome, a local server, the cloud model scripted in the page by `demo.stubCloud`, the 1B real). Tests: `test/checkin.test.ts` (happy path; diverged, touching nothing; a browser that reconfigured and ran a turn; a crash mid check-in with the mark still there; a server restart after), `test/checkin-diff.test.ts`, `test/host-tools.test.ts`.
