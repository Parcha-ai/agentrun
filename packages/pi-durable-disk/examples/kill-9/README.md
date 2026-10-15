# kill-9: a coding agent that survives `kill -9`

An agent writes two files, is refused a write outside its workspace, and starts a long `bash` command. The process is
`SIGKILL`ed in the middle of that command. A second process opens the same run, and:

- the files the agent wrote are still there, intact;
- the command the first process left running is ended by the open, before the agent takes a step;
- the command that was cut comes back to the model as `interrupted`, and is never run again;
- the agent goes on from there and finishes;
- the file tools never left `work/`: the write to `../escaped.txt` was refused, and no such file exists.

Nothing is restored by the example: the run's store, a SQLite file in the run's directory, is the record. The second process
reads it when it opens the run, and `pi-durable` answers the cut call with an error result instead of calling the tool
again.

## Run it

You need Linux and Node 22.19 or later. No disk, no key, no network: the run is on a directory of this machine
(`localRun`) and the agent is pi-ai's faux model, scripted.

```sh
npm ci --ignore-scripts && npm run build   # once, from the repository root; builds dist/
cd packages/pi-durable-disk
node examples/kill-9/main.ts               # about five seconds
```

The run goes under `./kill-9-run/` (it is removed first), and the last line says what was shown:

```
the run lives in /.../kill-9-run
generation 1 opened the run in /.../kill-9-run (0 tool results before)
the long command is running: SIGKILL to the first process (its command is not touched)
the first process ended (SIGKILL); its command is still running: a bare kill -9 does not end it; a second process opens the same run
generation 2 opened the run in /.../kill-9-run (3 tool results before)
  write: Successfully wrote to plan.txt
  write: Successfully wrote to notes.txt
  write [error]: [error] /.../kill-9-run/escaped.txt: outside the workspace /.../kill-9-run/work
  bash [error]: [error] Tool bash was interrupted and may have partially run
agent: The job was cut and never rerun; the plan and the notes are intact.
ok: after kill -9 the files were intact, the next open ended the cut command and it came back interrupted without a rerun, the agent finished in generation 2, and its file tools stayed in work/
```

On a failure it writes `not ok: ...` to stderr and exits 1.

## How it works

[`main.ts`](main.ts) is both the supervisor and, when started as `main.ts instance`, the agent's process.

- **The agent** is a scripted model that picks each step from the tool results the conversation already holds: write
  `plan.txt`, write `notes.txt`, write `../escaped.txt`, run the long job. A process that opens the run later counts the
  same results and goes on from the same place. `ArchilCodingTools` gives it pi's `read`, `write`, `edit` and `bash`, run
  in `work/`.
- **The long job** is `echo $$ > job.pid; echo started >> progress.log; sleep 120; echo finished >> progress.log`. The first
  line of `progress.log` shows the command began; a second `started`, or a `finished`, would show it ran again or ran on.
- **The kill.** The supervisor waits for `started` in `progress.log` and for the package's record of the command (a file
  in the run's `commands/` directory), then sends `SIGKILL` to the instance's process and to nothing else. pi starts
  each command as the leader of its own process group, so the command outlives the kill; the example prints that it is
  still running. On a host the unit's cgroup would end it. On a local directory the package does: while commands run, the
  instance records each command's process group (pid, start ticks, boot) under the run's directory, and the next
  `openDurableRun` kills what is still that process and waits until it is gone, before the Harness opens. The records are
  written a tenth of a second after a command starts and then every tenth of a second, so a command killed in its first
  tenth of a second can be missed; the example waits for the record. The second process is given a minute: a command
  that was run again would sleep for two minutes.
- **The check** is the example's own, from what is left: `plan.txt` and `notes.txt` byte for byte, `progress.log` equal to
  `started`, the command's process group gone after the second open, one `bash` result in the store and it an `interrupted` error, no `escaped.txt` in the run's directory, the
  write outside `work/` refused, the second process at generation 2, and the agent's last answer.

The file tools refuse a path that resolves outside `work/` (`..`, an absolute path, a symlink); the package README's
[Security](../../README.md) section lists what is confined and how.

## What it does not show

A run on a local directory has no fence: the directory is the claim, and only this machine's owner lock keeps a second
process off it. It guards one machine, and survives the process dying, not the machine; a run that survives a host being
lost lives on a disk, as [01-durable-chat](../01-durable-chat/) does. The model is scripted, so it never chooses to run the
command again by itself; what the example shows is that the *harness* does not, whatever the model asks next. A real
model is not wired in.
