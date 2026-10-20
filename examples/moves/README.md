# Moves

One run moves from this machine to a Modal VM and back; its workspace on the Archil disk carries the brief and the result; on the VM, one session forks 8 threads, each with its tools on its own H100 sandbox.

    npm run demo:moves -- --handoff                    # on fakes, $0, no key, no Modal: the same run between three processes on this machine
    npm run demo:moves -- --handoff --record <dir>     # and write the run as an agentrun.recording/1 the viewer plays

## What you will see

1. **Prepare, on this machine.** An agent plans a small GPU experiment and writes its brief into the run's workspace (`brief.md`, on the disk). A `call` node, `hand_over`, then answers. The
   answer is kept before the run commits it, so the host that opens the run next never repeats it, and the process releases the run: its store is sealed, `run.json` says `sleeping`, and the claim
   on the disk is let go.
2. **Threads, on a Modal VM with the disk mounted.** A second host opens the run from the disk. One session reads the brief and calls `fork_threads`: it forks its own conversation into 8
   (`conversation.fork`, each owned by the call). Each thread's tools, `gpu_write` and `gpu_bash`, run in **that thread's own H100 sandbox**: the thread names its GPU with `nvidia-smi -L`,
   writes one GPU job of its own with settings of its own choosing, runs it, and reports a metric. The session joins the 8 answers, calls `pick` (which writes `result.json` to the workspace), and
   the sandboxes are ended. A second `call` node, `hand_back`, then releases the run.
3. **Answer, back on this machine.** A third process opens the run from the disk, reads `result.json`, and answers: which thread won, with what settings and metric, on what GPU.

Each of the three agents is a node of one workflow (`job.ts`), so each is a resumable pi-durable session; the run is one run, with the state flowing between them through the disk. Nothing is killed:
every move is a release by one host and an open by the next, and the recording has two `handoff` lines.

## What it does not show

- The VM has no GPU: Modal puts a GPU on its gVisor sandboxes only, and gVisor cannot mount the disk safely. The threads' sandboxes are where their *tools* run, not where the session runs.
- The fakes' sandboxes are stand-ins that run local processes (and say so: their GPU line reads `none (offline stand-in)`). Only a live run has H100s.
- On a live run the recording has no lines for the 8 sandboxes yet: the harness does not take tool-made boxes and a disk place together (`demo()` refuses it). The sandboxes are evidenced by the
  runner's own files instead: a ledger of every sandbox it made and ended by exact id, and `threads.json` with each thread's own `nvidia-smi -L` line.

## Where the agents' code runs, and what they cannot read

- The prepare and answer agents have pi's confined `write` and `read` (file operations in the run's workspace; no process is started). The threads agent has `read`, `fork_threads` and `pick`.
  **No agent of the three has a shell.**
- A thread has `gpu_write` and `gpu_bash`, and both go to that thread's own sandbox through pi-transport's `boxEnv`. Nothing a thread runs executes on the machine its session runs on.
- The model key and the Modal token the sandboxes are made with are read once, at the start of each process, and removed from `process.env`: the model client holds the key in a closure.
- `moves.test.mjs` checks this offline: the secret values appear in no recording, no sandbox ledger and no output, and the live parts take them out of the environment.

## Run it live

The live runner needs a scratch Archil disk and its key, a Modal account, and an Anthropic key (see `demo.json`). The run is the same job: the disk package's `archilPlace` over a host that starts the
first and third process on this machine and the second on a Modal VM (`modalHost`, VM runtime, the disk mounted), with the model key and the VM session's Modal token passed as Modal Secrets
by name. It ends every VM, sandbox, token user and the run's directory by exact id and searches what it left for the keys' values.

```sh
npm install --no-save modal@0.11.0          # the Modal SDK is not a dependency of this repository; the runner stops with this line if it is missing
MOVES_LIVE=1 MOVES_LIVE_MAX_USD=8 node examples/moves/live.ts <record-dir>
```

Its environment holds `ARCHIL_API_KEY`, `PDA_LIVE_DISK`, `PDA_LIVE_REGION`, `MODAL_TOKEN_ID`, `MODAL_TOKEN_SECRET` and `ANTHROPIC_API_KEY`; the runner takes the last three out of it before anything starts. How the VM gets
those three is `MOVES_LIVE_SECRETS`:

- `named` (the default): two Modal Secrets you made, one holding `ANTHROPIC_API_KEY` and one holding `MODAL_TOKEN_ID` and `MODAL_TOKEN_SECRET`, referenced by name only (`MOVES_SECRET_ANTHROPIC`,
  `MOVES_SECRET_MODAL`; default `moves-take-anthropic` and `moves-take-modal`). No value passes through the runner on the way. Deleting the Secrets is yours.
- `inline`: the Modal SDK has no call that creates a named Secret, so the runner builds one lazy Secret object from the values it holds. Nothing is created on Modal, so nothing outlives the run.

`MOVES_LIVE_MAX_USD` is the model's spend cap (`--max-usd`). Modal's VM and GPU sandboxes carry no price in the recording's meter, so they are outside it: the last line reports the sandboxes' GPU time and an
estimate of its cost as a field of its own. The run ends with `ok: one run moved from this machine to a Modal VM and back; ...` and exit 0, or lists what went wrong and exits 1.
