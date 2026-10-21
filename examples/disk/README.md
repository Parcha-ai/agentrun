# A run changes hosts

An agent reviews ten invoices in its workspace on an Archil disk. Midway, the run is released and a second sandbox opens it from the disk and finishes, with every payment made once.

    npm run demo:disk -- --handoff          # on fakes, $0, no key: the move between two processes on this machine
    npm run demo:disk -- --live --handoff   # a real agent (claude-sonnet-5-5), your Anthropic key (SETUP-PROMPT.md)

Watch the recorded run: https://parcha-ai.github.io/agentrun/?r=disk

## What you will see

1. The job: an agent reviews ten invoices against a payment policy, one invoice at a time, in its own workspace. It reads the policy and the invoice with `read_lines`, which returns a window of
   lines and a receipt for the read, and decides approve or hold, citing the lines it relied on. The workflow, not the agent, pays an approved invoice through the paid tool `charge`, one call at a
   time. `charge` is simulated: no money moves. Two invoices break the policy by construction (one is over the limit, one names no purchase order) and are held with the rule each breaks.
2. A move between hosts: right after the fifth payment is made and its answer kept, the process releases the run. Its store is sealed, `run.json` says `sleeping` and the claim on the disk is let go.
   The next process opens the run from the disk, reads the kept answer instead of paying again, and reviews invoices six to ten. Nothing is killed: the recording has one `handoff` line and two holders
   of the claim.
3. The report: a last agent writes `report/index.html`, a row for each invoice with its decision, the reason and a link to each line it cites, in a copy of the file beside the page. The recording
   keeps the page and those files as its artifact.

On fakes a scripted lead plays the agent and the run lives in a directory of this machine. `--live` runs the real agent; `live.ts` runs it on Daytona and an Archil disk (below).

### Checked by code, not by a model

`examples/disk-review-checks.mjs` reads the recording and the run's files: the paid set equals the policy's key (eight invoices, each paid once), the two held are the two that break the policy,
every cite resolves through the receipt of the read that made it and links the same file beside the report, no tool call names a path outside the workspace, and a live run has a readable thinking
block. `examples/disk.test.mjs` runs them on the fixture; `live.ts` runs them on every live run before anything is published.

### On Daytona and an Archil disk: `live.ts`

```sh
PDA_LIVE=1 PDA_STATE_DIR=<scratch> PDA_LIVE_SNAPSHOT=<runtime snapshot> DISK_LIVE_SECRET=<daytona secret> node examples/disk/live.ts <record-dir>
```

The supervisor is the harness entry's `demo()` and the place is the disk package's `archilPlace` on `daytonaHost`: each process of the run is a Daytona sandbox, and the run's directory is on an
Archil disk. The first sandbox releases the run at the fifth payment, and a second one opens it. The process records into the run's directory on the disk, and the runner brings the recording,
the report and the crossing log home over S3 (the supervisor never mounts the disk).

The model key never enters a sandbox. `DISK_LIVE_SECRET` names a Daytona secret that holds an Anthropic key and allows only `api.anthropic.com`. Each sandbox is created with it as
`ANTHROPIC_API_KEY`, so the sandbox holds Daytona's placeholder, and Daytona's egress proxy puts the key into the request's `x-api-key` header. The runner gives the process the proxy and its CA
(`NODE_USE_ENV_PROXY=1`), which Node needs before it sends anything through a proxy. Without `DISK_LIVE_SECRET` the lead is scripted. `DISK_LIVE_MODE=kill` deletes the first sandbox at the same
crossing instead of releasing the run (a recovery test, not a public take).

A sandbox is ready in seconds from a runtime snapshot of the dependencies (`PDA_LIVE_SNAPSHOT`, built by `packages/pi-durable-disk/test/live/daytona-snapshot.ts build <commit> --demo`). The
runner installs the workspace packages offline over it only when the snapshot's dependency closure equals the checkout's, and says which in its first line. It needs `DAYTONA_API_KEY`,
`ARCHIL_API_KEY` and `PDA_LIVE_DISK` from your credential wrapper, refuses without them, stops itself after 25 minutes, and ends by deleting every sandbox it made and the run's directory.

What a live run spends is bounded twice. Each process may make at most 60 model calls, each answer at most 8192 tokens with its thinking (`model.ts`); `--max-usd` caps the whole run (twice
`expectedCost`, $3.00, unless `DISK_LIVE_MAX_USD` says otherwise). Two rehearsals on Daytona made 22 model calls each, $0.11 and $0.12 at list price (prompt caching took most of the input),
in two sandboxes for two to four minutes. The cap counts the model, and a box only when the box is priced: the Daytona sandbox time, about a cent a run, is not priced in the recording, so the
cap does not count it. The runner's last line names each figure: `modelUsd` (this run, from the recording), `capUsd`, and `sandboxUsdLedger` (cumulative over this lane's ledger).

## Keys and programs

On fakes: `node` 22.19 or later, and nothing else. `SETUP-PROMPT.md` does the rest for you.

| Name | What | For |
|---|---|---|
| `ANTHROPIC_API_KEY` | An Anthropic key for the agent; on Daytona, a Daytona secret that holds it (`DISK_LIVE_SECRET`) | live |
| `ARCHIL_API_KEY` | An API key of a scratch Archil organisation | live.ts |
| `PDA_LIVE_DISK` | The disk the run lives on (`dsk-...`) | live.ts |
| `PDA_LIVE_REGION` | The disk's region, `aws-us-east-1` when unset (optional) | live.ts |
| `DAYTONA_API_KEY` | The sandboxes each process runs in | live.ts |
| `DISK_LIVE_SECRET` | The name of the Daytona secret that holds the Anthropic key (optional: without it the lead is scripted) | live.ts |
| `node` | Runs the demo | all |
| `archil` | The Archil client, 0.8.42 or later (Linux; in the sandbox) | live.ts |
| `fusermount` | FUSE, from `fuse3` (Linux; in the sandbox) | live.ts |
| `archil-scoped` | The disk package's root-owned wrapper around the archil client (in the sandbox) | live.ts |

## How it is built

- `job.ts`: the job as data, a workflow: a `map` over the invoices, one at a time, of a review `agent`, a `route` on its decision to the paid tool (a `call` node) or a hold, then the report `agent`.
  No host code. `files.ts`: the policy, the ten invoices and the key, by hand.
- `tools.ts`: `read_lines`, the confined read whose result states its window and a receipt, so a report can cite lines.
- `fakes.ts`: the scripted lead, the paid tool's fake and the judge, for the no-key run. `model.ts`: the live agent, claude-sonnet-5-5 with its bounds; both agent nodes ask for high thinking.
- `run.ts`: about ten lines on `@parcha/agentrun-harness`, the entry that reads the standard flags (`--handoff`, `--live`, `--record`) and supervises the run. The place is where the run lives and how
  each process of it starts and ends: `@parcha/pi-durable-disk`'s `localPlace` here, `archilPlace` in `live.ts`.
- `@parcha/pi-durable-disk`: the run's claim, the store the kept answers and the receipts commit to, the seal at a release, and the next process's open.
- `@parcha/agentrun-dsl`, `@parcha/agentrun-pi`: the workflow and the durable task that runs it.
