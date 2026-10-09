# Example 03: an agent whose computer runs in a browser tab, and moves to the cloud when the tab goes away

Open a link and a pi agent runs in the tab: its brain (pi-durable's Harness) runs as page JavaScript, and its hands
(bash, coreutils, node) run in a [Wasmer](https://wasmer.io/) sandbox in the same tab. Ask it to write some files. Close
the tab: a cloud host claims the run's disk and carries on from the last thing the tab committed, mid-task if it was
mid-task. Open the link on another device: a live, read-only view of the cloud run, with "Take over here", which moves
the agent into that tab.

The transcript and the workspace never live only in a tab. Both are on an Archil disk under `runs/<id>/`, with one writer
at a time, as in the other examples:

```
browser tab                                              server (near the disk)                    disk
  pi-durable Harness ── Storage calls ──── WebSocket ──►  pipe: holds the run's claim ───────────►  runs/<id>/store/run.sqlite
  Wasmer: bash, node ── changed files ──── (one per tab)   (lease, owner lock, run.json),          runs/<id>/work/
  model provider ─────── model calls ────────────────────► SqliteStorage on the mount,
                                                           model proxy with a per-run budget
cloud host (same agent module, `pi-durable-disk run --app cloud-app.ts`, tools on the claimed mount)
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
  believes it wrote. On a host with the mount, the same extension runs the claim's barrier.
- **Model calls** go through the server (`pipe/model-proxy.ts`): the key stays on the server, the request names only
  the model the server allows, and a run has a token budget across every place it runs.
- **Restore**: when a tab attaches, it gets `work/` from the disk, so a tab can resume what a cloud host did.
- **One tab writes at a time.** Another device that opens the link watches read-only. "Take over here" gives the run to the
  new tab: the old tab is told the run moved, and every later frame from it is refused. From a cloud host, a takeover
  revokes the host's claim (the package's `takeOver`): its next commit or heartbeat fails at the disk, and it exits 75.
- **Tab gone** (closed, laptop lid shut, network lost: no ping for 5 s) or "Move to the cloud": the pipe releases the run
  (barrier, seal `run.json`, unmount) and the package's supervisor (`ensureRunning`) starts it on the cloud host.

The cloud host can be a second FUSE client on the server's own machine (`--cloud local`, a systemd unit through the
package's `localHost` driver) or a Daytona sandbox (`--cloud daytona`, the package's `daytonaHost` driver). A host that
cannot reach the model endpoint gets a link instead (`--cloud-link`, `cloud-link.ts`): it listens on one port and the
server dials in, and that one WebSocket carries the host's model calls and its live events for viewers.

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
```

It prints the run's link, `http://127.0.0.1:8790/run/<id>#<secret>`. The fragment is the run's secret; anyone with the
link can watch the run or take it over. The page needs a secure context (Wasmer needs `SharedArrayBuffer`, so the server
sends cross-origin isolation headers): `localhost`, or HTTPS in front of the server.

`node serve.ts --local DIR` runs everything on a local directory instead of the disk (no claim, no cloud host): for
working on the page.

## Check it

- `npm test`: the pipe's protocol on a local directory: storage conformance through a real WebSocket, write-through,
  restore, takeover and the refused old tab, the model proxy and its budget, a tab that stops pinging.
- `node scripts/live-pipe.ts` (with the disk's variables): the same on the real mount, plus 200 commits and their latency
  against the ping round trip, and a re-read after a release.
- `node scripts/story.ts <link>` against a running `serve.ts --cloud ...`: the whole story in headless Chrome (device A
  runs a task, its tab dies mid-task, device B watches the cloud, takes over and finishes), with screenshots.
  `node scripts/evidence.ts <server log> <cloud events> <story results>` turns its logs into the numbers below.

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

## Limits

- The tab's Wasmer sandbox has no git and no network; its files have no modification times and no symbolic links (a
  symbolic link on the disk stays there and is not restored into the tab).
- Output spills and temporary files of the tab stay in the tab (`.pi-tmp/`), as `/tmp` stays on a host.
- Commands running in the tab when it closes are gone; pi reports the cut call as interrupted, as after any crash.
- The pipe is the disk's only writer while a tab runs the agent: the tab is a client of a single writer. A browser
  client of the disk that holds its own claim would remove the pipe; the protocol between tab and pipe is the part that
  would change.
