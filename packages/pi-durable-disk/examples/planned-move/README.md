# Planned move

A run moves from one host to another at a step boundary, by hand-over and not take-over. The old host records where the
run is going and releases it, which seals the store. The new host opens it at the next generation and tells the agent
where it now runs, before any step resumes. Nothing is revoked, and no call comes back `interrupted`. The kill examples
show the fence after a host is lost; this one is a move nobody lost.

Here the run starts on this machine (host A, a systemd unit) and moves to a Daytona sandbox after step 2 of 4.

## What it needs

- **pi-durable-disk 0.1.0-beta.14 or later.** It uses `beforeResume`'s `previous` and `archilControl`.
- **An Archil scratch disk and a key of a scratch organisation**, in `ARCHIL_API_KEY`, `PDA_LIVE_DISK` (`dsk-...`) and
  `PDA_LIVE_REGION` (default `aws-us-east-1`). The example creates and deletes `runs/move-*` and its token users on that
  disk.
- **A Daytona key** in `DAYTONA_API_KEY` (`DAYTONA_API_URL` and `DAYTONA_TARGET`, default `us`, are optional), for an
  organisation on Tier 3 or 4. The archil client needs full egress to Archil's mount servers; a domain allowlist can't mount.
- **This machine, run as an ordinary user with passwordless `sudo`:** Linux, systemd and the archil client. `localHost`
  starts the instance as a systemd unit through `sudo`, and the instance mounts through the package's own
  `bin/archil-scoped` under `sudo`. The example refuses to start as root or without passwordless `sudo`. A host locked
  down as in [Setting up a host for production](../../README.md#setting-up-a-host-for-production) (a root supervisor, a
  dedicated run user, only the installed wrapper in sudoers) runs production runs, not this example, which runs as you
  so that both hosts share your uid.
- **The same run user uid on both hosts.** Both incarnations write the same store and workspace, and the disk enforces
  their owners: a box whose run user has another uid can't write what host A wrote. Host A's instance runs as you, so the
  box's `prepare` (`box.ts`) runs the instance as the account with your uid, creating one when the image has none, and
  grants the archil wrapper to that uid:

  ```
  #<your uid> ALL=(root) NOPASSWD: /usr/local/sbin/archil-scoped, /usr/bin/fusermount -u /mnt/pda/planned-move/runs/*
  ```

## Run it

```sh
npm run build              # once, at the repository root
cd packages/pi-durable-disk
node examples/planned-move/main.ts                        # installs the package version you have from npm in the box
node examples/planned-move/main.ts --package ./x.tgz      # or a tarball (`npm pack`) of a checkout, before it is published
```

It takes a few minutes, most of it the box's preparation (Node, the archil client, the package). With `--snapshot`, a
snapshot that already holds them, it is about 20 seconds. The output ends with:

```
host A: generation 1 paused after step 2 and released: {"moveTo":"daytona","from":"host-a","afterStep":2}
box: started pda-move-... in ... (reason none, 0 revoked)
box: generation 2 opened (holder ...) and finished: {"steps":4}
  step 1: generation 1 on host-a
  step 2: generation 1 on host-a
  step 3: generation 2 on ...
  step 4: generation 2 on ...
  the agent was told: You were moved from host-a to a Daytona box after step 2.
ok: the run moved from host-a to a Daytona box at step 2, with no revoke and no interrupted call (box ready in ..., pause to generation 2 in ...)
```

## How it works

- **`app.ts`** is the app both hosts run (`pi-durable-disk run --app app.ts`). After step `PDA_MOVE_AFTER`, the first
  incarnation calls `run.setStatus("paused", { moveTo, from, afterStep })`, then `run.release()`, and exits 0. A
  supervisor leaves a paused run alone unless asked to start it. On the next host, `beforeResume` reads `previous` (the
  `run.json` the last incarnation left, which the open has already replaced), sees the move, and admits one input
  telling the agent, before any step resumes.
- **`main.ts`** is the supervisor:
  - it starts the run on host A with `ensureRunning(ref, localHost(...))`;
  - it waits until `run.json` is `paused` and the run has no delegation;
  - it starts it in a box with `ensureRunning(ref, daytonaHost(...), { demand: true })`, whose result must be a start
    with `reason: "none"` and nothing revoked;
  - it waits for `done`, then reads the step files and the app's report over S3 (`archilControl`) and compares.
  It removes everything it made, on success and on failure: the box (by its own fleet label), the unit, the token users
  and the run's tree.
- **`box.ts`** prepares a default Daytona box: Node and the archil client (both pinned and checked by sha256), the run
  user, the package with its peers at your installed versions, the app, the root-owned archil wrapper and its sudoers line.

## What it does not show

- **A host being lost.** Nothing fails here; examples 02 and no-double-charge show the fence and the take-over.
- **A production box.** In a default Daytona image, the account with your uid may be the toolbox user, which has full
  `sudo`. A production snapshot has a dedicated run user that can run only the archil wrapper.
- **Who decides to move.** The step boundary and the destination come from the environment here. A real host would ask a
  running instance to move through `serveRun`, or decide from the run's own state.
