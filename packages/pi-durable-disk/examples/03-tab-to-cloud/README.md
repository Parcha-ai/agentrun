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
`POST /api/runs/<id>/judge` (the run's secret as a bearer token; body `{prompt, answer}`; answer
`{verdict: "show" | "refuse", dark, quote, ms, model}`, and `refuse` whenever the judge times out or fails). The route only
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
