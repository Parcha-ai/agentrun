# Moves

One agent session, one run on an Archil disk, three hosts in turn: **the session on a Modal VM with its disk mounted, and 8 H100
sandboxes for the threads' tools.**

1. **Generation 1, on this machine.** A local host (`localHost`) opens the run and the agent works the first step: it writes a
   brief for a small GPU experiment into the run's workspace, then asks to move to Modal. The run is released (sealed) and the
   process ends.
2. **A planned move to a Modal VM.** `modalHost` starts the VM, which mounts the run's directory and opens it as generation 2. The
   session forks **8 threads** (`conversation.fork`, each owned by the `fork_threads` call). pi-transport gives each thread's tools
   its own Modal H100 sandbox. Each thread's agent writes **one GPU job of its own**, with settings of its own choosing, runs it in
   its sandbox, and reports a metric and the GPU its `nvidia-smi -L` named. The session joins the 8 answers, picks one, and asks to
   move back. The sandboxes are ended; the run is released.
3. **A planned move back to this machine.** Generation 3 opens the same run on the local host, reads what generation 2 wrote, and
   answers.

No host is killed: every move is a release by one host and an open by the next. Thinking is on (`claude-sonnet-5-5`, medium), and
the thinking blocks of generation 1 are still in the context generation 3 is given.

## What it does not show

- The threads' sandboxes are where the *tools* run, not where the session runs. The session is on the VM; Modal offers a GPU on its
  gVisor sandboxes only, and gVisor cannot mount the disk safely, which is why the VM and the sandboxes are separate things.
- Both local generations are processes on a Linux host.
- The 8 GPUs are not on the VM.

## Where the agent's code runs, and what it cannot read

The session's model key and the Modal token that makes the sandboxes live in the session's process and nowhere else.

- **The root conversation has no shell.** Its tools are `write_note` and `read_note` (files inside the run's `work/` directory: an
  absolute path, `..`, a link, `/proc` or anything outside is refused), `move_to`, `fork_threads` and `pick`. None starts a process
  or reads the process's environment.
- **A thread's tools are `gpu_write` and `gpu_bash`, and both run in that thread's own H100 sandbox**, through pi-transport's
  `transport()`. The transport config names no `local` environment, so no command can fall back to the machine the session runs on.
- **The keys are read once and removed from the environment** before anything else runs; the model client holds the key in a closure.
- `moves.test.mjs` checks all of this offline: the tool lists, the path refusals, and that the secret values appear in no output,
  no file of the run, and no sandbox's environment.

## Run it offline

No network, no key, no Modal:

```sh
npm run build                       # once, at the repository root
node --test examples/moves.test.mjs
```

The three generations run through the real CLI (`run --dir`) with a scripted model, and the 8 sandboxes are stand-ins that run local
processes and write down what each box was asked to be (an H100, gVisor).

## Run it live

It needs:

- **A scratch Archil disk** and its key (`ARCHIL_API_KEY`, `PDA_LIVE_DISK`, `PDA_LIVE_REGION`): the run's directory is `runs/moves-*`
  on it.
- **A Linux host with systemd, passwordless `sudo` and the archil client**, as for the `planned-move` example: the local generations
  are `localHost` units.
- **A Modal workspace** with two secrets made by you: one holding `ANTHROPIC_API_KEY`, one holding `MODAL_TOKEN_ID` and
  `MODAL_TOKEN_SECRET` (the token that lets the session create its 8 sandboxes). The code names them (`MOVES_SECRETS`) and never holds
  their values. The runner's own Modal token (`MODAL_TOKEN_ID`, `MODAL_TOKEN_SECRET` in its environment) starts the VM.
- The Anthropic key in the runner's environment as `ANTHROPIC_API_KEY`, for the two local generations.

```sh
node examples/moves/main.ts
```

It prints each move and what each thread's GPU reported, ends every sandbox, VM and unit it started by its exact id, and checks
the recording for the secrets' values. Cost: about 10 minutes of 8 H100 sandboxes and a VM.
