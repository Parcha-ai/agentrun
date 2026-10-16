# A run outlives its box

An agent's run lives on an Archil disk: delete its sandbox mid-job and a new one takes over in seconds, with every paid tool call made once.

    npm run demo:disk            # on fakes, $0, no key
    npm run demo:disk -- --live  # real models and services, your keys (SETUP-PROMPT.md)

Watch the recorded run: https://parcha-ai.github.io/agentrun/?r=disk

## What you will see

1. The job: an agent settles ten invoices of one batch through a paid tool, `charge`, one call each, and writes the settlement note; you keep a receipt for every charge.
2. A kill and resume: the box the run lives in is taken away right after the fifth charge is paid and its answer kept. A new one takes the run over from the disk. The fifth charge is
   not made again: the run settles it from the kept answer, and the other five follow. The recording's counters read repeated 0 and unknown 0.
3. Receipts with cost: each paid call is kept as an answer under its own id in the run's directory, and the recording's manifest has the run's cost, a number or unknown. On fakes it says
   `scripted`, $0; live it says `real` and the dollars.

On fakes the run lives in a directory of this machine and the kill is a `kill -9`; live it lives on an Archil disk in a Daytona sandbox, and the kill deletes the sandbox.

### The live variant

`live.ts` (with its box app, `live-app.ts`) runs it for real: **live: real Daytona sandbox deleted mid-job, real Archil disk, the template's supervisor and place; the lead is scripted.** The
supervisor is the reference entry's `demo()` and the place is the disk package's `archilPlace` on `daytonaHost`. The app in each sandbox is a plain pi-durable-disk app: its scripted lead charges
ten invoices, each charge appends a line to `work/charges.log` on the disk, and after the fifth the supervisor deletes the sandbox. A new sandbox takes the run over, and the count of lines on the
disk is the evidence: ten, each invoice once. The charge that was paid and cut comes back to the agent as interrupted and is not sent again. It is not the gallery's recording: that one is the
full job on fakes. A live run of it cost $0.0034 and took under a minute, most of it the new sandbox's install at boot.

## Keys and programs

On fakes: `node` 22.19 or later, and nothing else. `SETUP-PROMPT.md` does the rest for you.

| Name | What | For |
|---|---|---|
| `ARCHIL_API_KEY` | An API key of a scratch Archil organisation | live |
| `PDA_LIVE_DISK` | The disk the run lives on (`dsk-...`) | live |
| `PDA_LIVE_REGION` | The disk's region, `aws-us-east-1` when unset (optional) | live |
| `DAYTONA_API_KEY` | The sandbox the live kill deletes | live kill |
| `node` | Runs the demo | all |
| `archil` | The Archil client, 0.8.42 or later (Linux) | live |
| `fusermount` | FUSE, from `fuse3` (Linux) | live |
| `archil-scoped` | This package's root-owned wrapper around the archil client (Linux) | live |

## How it is built

- `job.ts`: the job as data, a workflow of a `map` of `call` nodes (the paid tool) and an `agent` note. No host code.
- `fakes.ts`: the scripted lead, the paid tool's fake and the judge, for the no-key run.
- `run.ts`: about ten lines on `examples/reference`, the entry that reads the standard flags and supervises the kill. The place is where the session lives and how it starts, stops and
  comes back: the entry's local place on fakes, `@parcha/pi-durable-disk`'s `localPlace` and `archilPlace` live.
- `@parcha/pi-durable-disk`: the run's claim, the store the kept answers and the receipts commit to, and the takeover after a kill.
- `@parcha/agentrun-dsl`, `@parcha/agentrun-pi`: the workflow and the durable task that runs it.
