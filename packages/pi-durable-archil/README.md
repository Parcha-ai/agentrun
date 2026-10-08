# @parcha/pi-durable-archil

A host for [pi-durable](https://www.npmjs.com/package/@earendil-works/pi-durable) agents on an
[Archil](https://archil.com) disk. Each run is one directory on the disk that holds pi's SQLite store and the agent's
workspace. One process at a time holds that directory (the Archil server refuses a second mount), every commit is on the
disk before anything is shown, a host that is lost or hung is fenced by revoking its claim, and a stateless supervisor
restarts the run on another host, where pi-durable resumes from the last commit and never repeats a tool call whose
intent it had already committed.

pi-durable assumes two things it does not provide: exactly one live process per store, and a store that outlives the
machine. A Cloudflare Durable Object gives it both. This package gives it both on a disk you mount on any Linux host.

## How it maps to a Durable Object

| Durable Object | This package | Supplied by |
|---|---|---|
| One live instance per id | One exclusive mount of `runs/<id>/`; a second mount is refused | the Archil server |
| A stale instance is fenced | The supervisor revokes the claim; the old holder's next fsync fails with EIO, its SQLite commit fails, pi poisons the session, the instance kills its commands and exits 75 | Archil, pi and this package |
| Knowing an instance is gone | A lease (a heartbeat in `run.json`), Archil's orphan flag for a dead client, and the host driver's own status | this package |
| Storage bound to the instance | pi's `SqliteStorage` at `runs/<id>/store/run.sqlite`, on the claimed mount, at `synchronous = FULL` | pi |
| A write is durable before the response leaves | `commit()` resolves after an Archil fsync, pi publishes only after the commit, and an effect starts only after its intent is committed | pi and Archil |
| The input gate | pi's single commit line | pi |
| Eviction and resume | Any host that claims the directory reopens the store and `resume()`s | pi and this package |
| Alarms | On the same host, the host's process supervisor restarts the instance; across hosts, `supervise`. pi's own retry and poll waits stay in process | this package |
| A container to exec in | Tools run as child processes of the instance, against the run's `work/` directory on the same mount | the host |
| Hibernate and wake on request | Not in this release (`serve`, sleep parking). Today a drained instance writes `sleeping` and the supervisor starts it again | this package |

## Requirements

- Linux with systemd and FUSE (`/dev/fuse`, `libfuse2`, which the archil package depends on, and `fusermount` from `fuse3`,
  which cleans a dead mount), `setpriv` (util-linux) and `sudo`, near the disk's region: a commit is one round trip to the
  region (3 to 6 ms p50 from a VM next to it, measured).
- Node 22.19 or later, to run the package and its unit tests.
- The [`archil` client](https://docs.archil.com/mounting/linux) 0.8.40 or later (0.8.42 tested):
  `curl -s https://archil.com/install | sh`.
- Root for the mounts: every `archil` verb needs it on client 0.8.42. The package reaches root only through
  `sudo -n` of `bin/archil-scoped` (below), so the instance and the agent's tools run unprivileged.
- `/proc` that shows the instance root's processes: acquire's stale-daemon cleanup needs `/proc` visibility of root
  processes, so mount `/proc` without `hidepid`, or run the instance where it can see them. Otherwise an archil daemon
  left on a run's mountpoint fails every acquire there with `MOUNT_FAILED` (exit 1) until something else ends it.
- An Archil account, a disk, and an API key for the supervisor, all from the Archil console. Create the disk in the region
  nearest the host (any size; its id looks like `dsk-0123456789abcdef` and its region like `aws-us-east-1`). Hosts and
  instances never hold the API key.
- `@earendil-works/pi-durable` and `@earendil-works/chord`, `^1.0.4`, as peer dependencies.

Not covered yet: a Kubernetes host driver (the `HostDriver` interface is below) and running the loop where FUSE is
unavailable. Not in this release: `serve` (wake on request), sleep parking, `fork`, and a Docker quickstart.

## Install

```sh
npm install @parcha/pi-durable-archil@beta @earendil-works/pi-durable @earendil-works/pi-ai @earendil-works/chord
```

From a checkout (this package is `packages/pi-durable-archil` of the repository; the root build compiles `dist/`):

```sh
git clone https://github.com/Parcha-ai/agentrun.git && cd agentrun && npm ci --ignore-scripts && npm run build
cd packages/pi-durable-archil
```

## Quickstart: kill a host, watch the run resume on another

This runs example 02, from `packages/pi-durable-archil` of a checkout, on one machine that plays two hosts: "host A" and "host B" are two mount roots, each
with its own FUSE client, which to Archil are two machines. It needs the requirements above, a user with passwordless `sudo`,
a scratch disk and an API key. It uses pi-ai's faux model, so it needs no model key.

```sh
# 1. The archil wrapper, root-owned (root executes it), and one mount root per host. Once per machine.
sudo install -D -o root -g root -m 0755 bin/archil-scoped /usr/local/lib/pi-durable-archil/archil-scoped
for root in /mnt/archil-a /mnt/archil-b; do sudo mkdir -p $root/runs && sudo chown "$USER" $root/runs; done

# 2. Your disk and API key. The key stays in the supervisor's environment; no instance ever sees it.
export ARCHIL_API_KEY=...        # from the Archil console
export ARCHIL_DISK=dsk-...       # the disk id or name
export ARCHIL_REGION=aws-us-east-1

# 3. Run it: an agent charges six invoices, host A is killed while the third charge is in flight, host B takes over.
node examples/02-paid-effect/demo.ts kill
```

It takes about 15 seconds and ends with a table of what the fake paid API received against what the run recorded. The
cut charge is reported `interrupted` and was received once. (Node prints "ExperimentalWarning: SQLite is an experimental
feature": pi's store uses `node:sqlite`. It is harmless.) Next: `node examples/02-paid-effect/demo.ts freeze` (the host's
mount hangs instead of dying) and `node examples/01-durable-chat/demo.ts` (a chat that continues on the other host).
Each example's README lists the exact commands the demo runs, so you can run them by hand.

## The app

An instance is `pi-durable-archil run --app <module> ...`: `openDurableRun` with the app's options. The module is an ES
module whose default export is a function of where the run lives and returns pi's Harness options without `env` (the run
builds `env` on its claim: the workspace is `<root>/work`), plus an optional `onOpen`:

```ts
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { createRegistry } from "@earendil-works/pi-durable";
import { ArchilCodingTools } from "@parcha/pi-durable-archil";
import type { AppContext, AppOptions } from "@parcha/pi-durable-archil";

export default async function app(where: AppContext): Promise<AppOptions> {
  // where = { ref: { disk, region, id }, root, work, store }: known before anything mounts.
  const models = createModels();
  models.setProvider(openaiProvider());       // reads OPENAI_API_KEY from the instance's environment
  const registry = createRegistry();          // every extension the run's tasks need
  registry.install(ArchilCodingTools);        // pi's read, write, edit and bash, with `read` declared replay-safe
  return {
    models,
    registry,
    async onOpen(run) {
      // Called once per incarnation, after the run is open and resumed. run.generation is 1 on a first start and
      // higher on every resume. run.harness is pi-durable's Harness.
      const agent = { model: { provider: "openai", modelId: "gpt-6-sol" } };
      const root = await run.harness.root(ctx, { agent });
      await root.submit({ type: "input", content: "Summarize work/notes.md", requestId: "job-1" }, ctx); // a retry is a no-op
    },
  };
}
```

`openDurableRun` installs the registry before `Harness.open`, because a recovered task resumes only when an extension
of its name is installed. A tool that only reads can be marked `replay: "safe"` (`markReadOnlySafe`): after a crash it is
rerun. Any other tool is an effect: its intent is committed before it starts, and after a crash the model is told the call
was `interrupted`, never run again. `run.setStatus("done" | "failed" | "paused" | "sleeping", detail)` records the run's
status in `run.json`; `done` and `failed` run the durability barrier first. `run.release()` closes the Harness, kills the
run's commands, runs the barrier, seals `run.json` with the store's last sequence, and unmounts. A module that is missing
or throws, or an `onOpen` that rejects, is `AppError` (exit 1, which the unit retries).

## The CLI

`pi-durable-archil` is on the PATH after an npm install (`node dist/cli.js` in a checkout).

| Command | What it does |
|---|---|
| `run --disk D --region R --id ID --app MODULE` | The instance a host driver starts: claim the run, open it, resume it. `--token-stdin` reads the mount token from stdin. Lease flags: `--heartbeat-ms`, `--lease-expiry-ms`, `--lease-margin-ms`. `--on-sigterm resume` (default) or `pause` |
| `supervise --disk D --region R (--id ID ... \| --all) [--every 30s] --app MODULE` | One decision per run, once or in a loop: nothing to do, start, or revoke and start; `--app` is the module each started instance runs. `--create` makes the run directory. `--check` proves this host's fence first. `--sweep-tokens` removes expired token users. Prints one JSON line per decision |
| `status --disk D --region R --id ID` | `run.json` over the S3 API, the run's delegations and the holder's state |
| `release --id ID` | Unmount the run's mount on this host (a dead mount is cleaned) |

The supervisor passes the app on (`--app MODULE`, made absolute), other flags for the instance as `--run-arg=--heartbeat-ms=2000`,
and the instance's environment as `--env KEY=VALUE`. The API key is read from the environment variable named by
`--api-key-env` (default `ARCHIL_API_KEY`) by the supervisor commands only; `run` never needs it.

An instance's exit code tells the host's process supervisor what to do:

| Exit | Meaning | Restarted? |
|---|---|---|
| 0 | Drained on SIGTERM: sealed `sleeping` (due now, the default) or `paused`, unmounted | by the supervisor at its next tick, if sleeping |
| 1 | The app module failed to load or `onOpen` rejected, or a mount or CLI call failed | yes, within systemd's start limit |
| 2 | Usage error | no |
| 65 | Data error: the store is behind its seal (an acknowledged commit is missing), or `run.json` is unreadable. `run.json` says `failed` | never |
| 70 | The store's head cannot be read (pi's schema moved). `run.json` says `failed` | never |
| 75 | Fenced: the claim was revoked, its mount failed or left the mount table (`CLAIM_UNMOUNTED`), or the lease lapsed | never in place; the supervisor decides |
| 76 | Held: another client holds the claim (a delegation, live or orphaned; the supervisor revokes orphans), or another process on this host holds the run's owner lock | never in place |

## Host drivers and the supervisor

`ensureRunning(ref, host, { control })` is the whole supervisor: a function you call (from a timer, before you talk to a
run, or as `supervise --every 30s`). It holds no state, and it must run in a different process from any instance, because a
process with files on a hung mount cannot even fork. For one run it reads `run.json` over the S3 API and the delegations
over the control API:

| `run.json` and the delegation | Decision |
|---|---|
| `done` or `failed` | nothing (a failed run is never restarted) |
| `paused`, or `sleeping` with `wakeAt` later | nothing, unless the caller passes `demand` |
| no delegation on `runs/<id>` | start an instance (nothing while a start is in its grace) |
| every delegation orphaned (the holder's client is gone, seen in 0.2 s) | revoke, start (nothing while a start is in its grace) |
| a delegation still checking out | nothing: a mount is in progress |
| held, heartbeat within 90 s | healthy |
| held, heartbeat older than 90 s | nothing while a start is in its grace; then stop the holder if the driver can reach it, revoke, start |

Every start first writes a mark, `runs/<id>/start.json`: the generation the new instance will write into `run.json`, and
when. Until `run.json` reaches that generation or the start grace passes (`--start-grace`, `startGraceMs`; default the
lease expiry, 0 turns it off), a tick neither revokes nor starts. An instance takes about a second from its start to its
first `run.json` write (node boot, mount, open), more on a busy host, and a tick inside that window would otherwise see an
expired lease and fence the instance it just started. The mark is in the run's directory, so supervisors in other
processes see it too. A start that writes nothing within the grace has failed: the next tick revokes and starts again.

A run whose starts keep failing (each instance ends before its first `run.json` write: 76 when another client holds the
run, 1 on `MOUNT_FAILED`) backs off: the next start records the failure in its mark (`failures`, `lastExit`) and gets
the grace doubled per consecutive failure, up to `--start-backoff-max` (`startBackoffMaxMs`, default 10 min). With the
default 90 s grace that is starts at 0, 1.5, 4.5, 10.5 and 20.5 minutes, then one every 10 minutes, where a short tick
would start one per tick. `lastExit` is what the supervisor saw of the failed start (`no-delegation`, `held`,
`orphaned`); the instance's own exit code is in its host's log. `supervise` prints one `start-backoff` line per step.
The first `run.json` write at a start's generation resets the count.

Revoking a holder that is alive is safe: its next fsync fails and it exits 75, and nothing it writes after the revoke
reaches the new owner. No wait follows a revoke, because the fence is the server's, not a clock. Two supervisors racing
on one run are safe: the mount admits one claimant and the other instance exits 76.

A host driver is three calls, and nothing else in the package knows which compute runs an instance:

```ts
export interface HostDriver {
  start(ref: RunRef, mountToken: string): Promise<HostHandle>;   // the handle is JSON; the instance writes it into run.json
  status(handle: HostHandle): Promise<"running" | "stopped" | "failed" | "gone" | "unknown">;
  stop(handle: HostHandle): Promise<void>;
}
```

`localHost()` runs instances on this machine as systemd transient units with `KillMode=control-group`, so stopping or
restarting the unit kills every command the instance started, pi's detached ones included. The unit restarts on failure,
except after exit 65, 70, 75 or 76. `localHost({ mode: "child" })` runs a detached child process instead, for development,
without that guarantee.

`daytonaHost({ client, snapshot, ... })` runs each instance in a Daytona sandbox of its own (library only: `supervise`
starts local units, so pass the driver to `ensureRunning`). The box comes from a snapshot that holds Node, the archil client
(`libfuse2`), this package, the run user and the sudoers drop-in, or from a default image that the caller's `prepare` installs
them into. A container sandbox has no systemd (PID 1 is the Daytona daemon), so an in-box launcher keeps the instance
alive in place and never restarts it after exit 0, 65, 70, 75 or 76. The mount token is uploaded to a root-only file and
handed to the instance on stdin, never put in the sandbox's environment, which Daytona stores and returns on every read.
Status comes from the sandbox state plus the launcher's own word, and `stop` drains the instance, then deletes the box. The
archil client needs the sandbox's egress to Archil's mount servers (Daytona's Tier 3 or 4, full egress; a domain allowlist
cannot mount). Where the kernel refuses every unmount (a Sysbox box), the claim's release checks the delegation in, moves the
mount aside (`archil-scoped retire`) and kills its daemon. Measured live on Daytona's hosted `us` region, about 6 ms from
`aws-us-east-1`: a box takes about 15 s to start an instance, an exclusive mount 142 ms and a commit 8.55 ms p50; a
power-off, a freeze of the instance and its FUSE daemon, and a network partition were each taken over on another box (the
power-off through the orphaned delegation, the freeze and the partition through the lease, the partitioned box stopped by
the driver), and the thawed instance exited 75. A driver for another compute (a Kubernetes pod, another sandbox product) is the same three calls.

Mount tokens are reusable with a 24 h TTL (`--token-ttl`), one token user per start attempt, named
`pda-<run id>-g<attempt>-<time>` so a user can be traced to its run. They are not single-use: the archil client
re-authenticates 5 minutes after the mount and every 5 minutes after, and the control plane rejects a spent single-use
token for good, after which every write on the mount fails. An instance whose token expires is fenced at its next refresh
(exit 75) and the supervisor restarts the run with a fresh token. Each supervise pass removes the token users of the runs it
supervises that no live mount needs: the run holds no delegation, its `run.json` says released, and the user is older than
`--token-grace` (15 minutes). Removing a token user under a live mount kills that mount's claim, so a running run keeps its
users. `supervise --sweep-tokens` also removes the expired users of any run, and with no `--id` cleans every released run under
the token prefix.

### Setting up a host for production

The Quickstart runs the supervisor as your own user. On a production host the instance and the agent's tools run as an
unprivileged user and only the archil client runs as root:

1. **A dedicated run user** (here `pda`) that owns `<mountRoot>/runs` (default `/mnt/archil/runs`), so mountpoints are
   created and removed without root. The run user must be able to execute `node` and read the package and the app module:
   a Node under your home directory (nvm) is usually not readable by another user, so install Node system-wide.
2. **The archil wrapper, root-owned**, because root executes it. It starts `archil mount` in its own systemd scope, outside
   the instance's unit, so a restart in place finds its mount and claim still held, and it takes the mount token as one
   line on stdin:
   `sudo install -D -o root -g root -m 0755 bin/archil-scoped /usr/local/lib/pi-durable-archil/archil-scoped`
   (from an npm install the file is `node_modules/@parcha/pi-durable-archil/bin/archil-scoped`, and `ARCHIL_SCOPED`, exported by
   the package, is its path). Point the driver at it: `localHost({ archil: "/usr/local/lib/pi-durable-archil/archil-scoped",
   user: "pda" })`, or `supervise --archil /usr/local/lib/pi-durable-archil/archil-scoped --user pda`.
3. **A sudoers drop-in for exactly that wrapper and `fusermount -u`.** It keeps no environment: the token travels on the
   wrapper's stdin, and sudo logs every variable it preserves. Install it as `/etc/sudoers.d/pi-durable-archil`, mode 0440,
   after `visudo -cf` accepts it:

   ```
   pda ALL=(root) NOPASSWD: /usr/local/lib/pi-durable-archil/archil-scoped, /usr/bin/fusermount -u /mnt/archil/runs/*
   ```

4. **The supervisor runs as root** (it creates units, stops them, and writes each start's token under
   `/run/pi-durable-archil`, root-only), with `--user pda`, so instances never run as root; `localHost` refuses to start
   them as root without a named user. Give it the API key from a root-only environment file that its own systemd unit
   loads (`EnvironmentFile=`), never through `sudo`: sudo logs the command line and the variables it preserves.
5. **Check the host once.** `pi-durable-archil supervise --check --disk D --region R` proves the fence on this host (a
   second exclusive mount is refused, a revoked mount's fsync fails) and warns if the wrapper is not root-owned.

`examples/verify-production-path.sh` performs and checks steps 1 to 4 on a disposable root machine (`setup`, `run`,
`teardown`, or `all`; `plan` prints every step without running it): it creates the run user, the wrapper, the drop-in and
the key file, runs example 02 with the supervisor as root and `--user`, and checks that the instances never run as root,
that the run user can sudo the wrapper and nothing else, that `no_new_privs` takes even that away from a command, that no
mount token reaches the journal, and that nothing is left behind. It needs systemd; do not run it on a shared machine.

## The failure table

| Failure | What happens | Effects |
|---|---|---|
| The instance crashes or is OOM-killed, host alive | The unit restarts it in place on the same claim; the unit's cgroup kills the previous incarnation's commands; reopen, `resume()` | running tasks go back to pending; effects in flight are `interrupted`, never rerun; at most one cut model request is sent again |
| The host is lost (power-off, VM loss, pre-emption) | The client's sockets close and Archil flags the delegation orphaned in 0.2 s; the supervisor revokes (tens of ms) and starts an instance elsewhere | every acknowledged commit is there; unflushed workspace writes are lost; no effect whose intent was committed runs again |
| The host hangs or is partitioned (a zombie) | It is not orphaned, so the lease expires at 90 s; the supervisor stops the host if its driver can, revokes, and starts elsewhere | the zombie's next commit fails (`SQLITE_IOERR_FSYNC`) and it exits 75; a call it already has in flight may complete, but it cannot start a new one, because a new call needs an intent commit |
| A zombie that never commits again | Its lease watchdog (a worker thread, so a main thread stuck in a FUSE request does not matter) kills its commands at 75 s without touching the mount | an in-flight command runs at most until the self-fence |
| The mount is taken away under a live instance (an operator's `umount -l`, a cleanup's `fusermount -u`) | The instance writes `run.json` and creates its directories through the directory it opened at acquire, and checks before each write that the run's path is still that mount; at the next heartbeat the path names the local directory under the mountpoint, so it exits 75 (`CLAIM_UNMOUNTED`) | nothing of its own is written to the local disk; as host lost |
| A run's mountpoint holds entries and nothing is mounted on it (files written by path after a mount vanished) | acquire moves the directory aside whole to `<mountRoot>/.stray/<run>-<tag>` (root-owned, 0700), puts an empty one in its place, logs one JSON line on stderr with the entry count (never a name or a byte of the files), and mounts; `MOUNTPOINT_NOT_EMPTY` when it cannot | nothing in the moved directory is read or brought into the run |
| A stale archil daemon on the mountpoint with no mount (a client that failed at a token refresh drops its mount and keeps its process and control socket) | acquire kills it (`archil-scoped stale`) before mounting; archil's refusal ("an older Archil process is still running", "Failed to bind control socket") is `MOUNT_FAILED` (exit 1), not 76 | none |
| The FUSE daemon dies, the loop lives | I/O returns `ENOTCONN`, the claim is fenced, the instance exits 75 and the unit does not restart; the supervisor finds the claim orphaned, revokes it and starts an instance | as host lost |
| Archil is unavailable or its write buffer is full | The commit fails, pi poisons the session, the instance exits 75; the supervisor retries | nothing is published past the last durable commit |
| The mount token expires mid-run | I/O fails at the next 5 minute refresh and the instance exits 75; the supervisor restarts it with a fresh token | nothing started past the last commit |
| A second instance on the same host | The owner lock (an exclusive SQLite lock on `owner.lock`) is refused, exit 76 | none |
| Two supervisors race | The mount admits one claimant; the other instance exits 76 | none |
| The store is behind its `run.json` seal | `STORE_BEHIND_SEAL`: `run.json` is marked failed and the instance exits 65; the supervisor does not restart it | none started |
| SIGTERM (a deploy) | The instance drains: close, kill commands, barrier, seal `sleeping` with `wakeAt` now, unmount, exit 0; the next supervise tick restarts it | interrupted work resumes on the next open |

What a revoke cannot do: no fence reaches a third party. A paid API that already has a request has it. The package
guarantees that this runtime does not start an effect twice; an effect your model decides to retry is a new call, so give a
paid API an idempotency key from your own business key.

Measured on a VM about 3 ms from `aws-us-east-1`, archil 0.8.42: acquire 222 ms p50, release 139 ms, takeover by revoke
252 ms, commit 3.75 to 5.63 ms p50, a killed host's run back to its first commit in 1 to 1.5 s, a hung host replaced in 6
to 6.3 s with a 6 s test lease (90 to 120 s with the defaults).

## Security

- **The mount token goes on the wrapper's stdin.** It is never in argv or in an environment that `sudo` sees. Some setup
  guides pass the mount token with `sudo --preserve-env=ARCHIL_MOUNT_TOKEN archil mount ...`; sudo logs every variable it
  preserves to the journal and `auth.log`, so that form leaves the token readable to anyone who can read those logs. The wrapper reads
  one line on stdin and sets `ARCHIL_MOUNT_TOKEN` only for the exec of `archil`. The sudoers drop-in must never use
  `env_keep` for it. The local driver hands the token to the instance on stdin from a root-only file that is emptied once
  the unit has started; the instance reads it and closes stdin, so no process of the run's user can reopen it.
- **Tokens cover the whole disk.** A leaked one could mount or force-take any run on that disk until it expires, so the
  supervisor mints one per start attempt, removes it after the instance releases, and sweeps expired ones. The tenant
  boundary is the disk (Archil's own advice): give each tenant its own disk.
- **The API key stays with the supervisor.** Hosts and instances never hold it, and the local driver never copies its own
  environment into a unit.
- **No privilege for the agent.** The instance, pi's tools and the agent's commands run as an unprivileged user. Every
  command starts under `setpriv --no-new-privs`, so a command cannot use the run user's sudo rule (sudo refuses: "The no new
  privileges flag is set"). An app that turns this off (`archilEnv(claim, { noNewPrivs: false })`) or runs commands another
  way must confine them itself. Commands run next to the FUSE client on the host that holds the claim: if the agent is not
  trusted with the host, sandbox its commands (for example with bubblewrap) and keep the FUSE client outside the sandbox.
- **The file tools stay inside `work/`.** pi's `read`, `write` and `edit` run in the loop's process, not in a command
  sandbox, so every file operation of the environment resolves its path to the file the kernel would reach (`..`, absolute
  paths, symlinks, dangling links, a missing tail) and refuses it unless it lies in `work/` (reads may also use `tmp/`, where
  the bash tool tells the model its long output went, and `readRoots` the app names). An agent cannot `write
  ../store/run.sqlite`, `../run.json` or `../owner.lock`: the call fails with a `PathOutsideWorkError` the model sees as
  a failed tool result. A path is opened one component at a time from a held handle of `work/`, without following links,
  so a link a command swaps in after the check is refused too. This covers the file tools only; a command still runs as
  the run user and can reach anything that user can, which is what an app's own command sandbox is for. `archilEnv(claim, {
  confineFiles: false })` turns it off where `/proc/self/fd` is unavailable.
- **A revocation is the most dangerous operation.** It happens only for an orphaned client, a dead host or an expired
  lease, and every takeover writes the new `generation` and the previous holder into `run.json` and the supervisor's log.

## Layout on the disk

```
<disk>/runs/<id>/          the claimed subtree, mounted at <mountRoot>/runs/<id> on every host (default /mnt/archil)
  run.json                 status, generation, holder, heartbeat, seal
  owner.lock               the same-host owner lock
  store/run.sqlite         pi's store (exclusive profile: no -shm file)
  work/                    the workspace the tools write
  tmp/                     pi's temp files and long-output spills, so a path a result names still exists after a takeover
```

The mountpoint is the same absolute path on every host of a deployment, so paths inside the run are identical wherever
it resumes.

### Removing a run

A run is the subtree `runs/<id>/` of the disk. To remove one: let its instance release (or stop it), check that nothing
holds a delegation on it (`pi-durable-archil status` lists them; an orphaned one is revoked through the control API), delete
its objects, and remove its token users (`supervise --id ID --sweep-tokens --token-grace 0s` on a run that is done).

**Revoke before you delete.** Deleting the objects of a run through the S3 API while a delegation on the path is still
held, even an orphaned one left by a killed host, does not take effect: the same run id came back with its old store when a
supervisor next started it. `deleteRunTree(control, id)` does it in order: it revokes the run's delegations, deletes, and
requires the prefix to be empty. Doing it by hand, revoke the delegation first, delete, then list the prefix and check it is
empty.

## Library

`openDurableRun(ref, options)` is what `run` calls: mount, verify the claim, take the owner lock, write `run.json`, open
the store, check the seal, open and resume the Harness, keep the lease. `acquire`, `ensureRunning`, `localHost`,
`archilEnv`, `openArchilStore` and the typed errors (`FencedError`, `HeldError`, `StoreBehindSealError`) are exported
for apps that compose their own lifecycle. The `.d.ts` files in `dist/` are the reference.

A host that owns its own pi-durable Harness and store connections imports the narrow entry instead:
`@parcha/pi-durable-archil/lease` holds `openRunLease` (the claim, the owner lock, `run.json` with its heartbeat, the lease
self-fence, the seal and the release, without a store or a Harness), `storeHead`, the store's fence and pragma helpers
(`Fence`, `FencedDatabase`, `assertPragmas`, `PROFILE_PRAGMAS`, `openArchilStore`), and the typed errors and exit codes. It
leaves out the supervisor, the host drivers, the CLI and the app contract, and the package declares `"sideEffects": false`, so
a bundler keeps only what you use: a bundle of the app with `await import("@parcha/pi-durable-archil/lease")` is about 52 KB
minified against about 493 KB for `await import("@parcha/pi-durable-archil")` (measured with esbuild, pi-durable inlined).

## Tests

```sh
npm test            # unit tests: no Archil, no network, no model
npm run typecheck
```

The package and its unit tests run on Node 22.19 or later.

The live suites (`npm run test:live:claim`, `:env`, `:run`, `:store`, `:supervise`) mount a real scratch disk. See
`test/live/README.md` for what they need and what they clean up.

## License

Apache-2.0, Parcha Labs, Inc. See `LICENSE` and `NOTICE`.
