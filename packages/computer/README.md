# @parcha/agentrun-computer

Private for now: not published, and nothing else in the repository uses it yet.

The open platform's computer protocol. A computer is anything an agent can run commands on: a container, a microVM, a
full VM, a machine. The protocol has two layers:

- **A daemon in every computer.** `computerd` is one small static Go program (Linux, amd64 and arm64, no cgo). It speaks
  JSON-RPC 2.0, one JSON object per line, over stdin and stdout, so it works in a computer with no network.
- **One provisioner per vendor.** A provisioner makes, finds and ends computers, and opens a stream to the daemon
  inside. It never runs commands itself: the daemon does. This package has the first one, for Docker.

## What it does today

The daemon answers `hello`, `ping`, `exec.run`, the `files.*` methods, `tar.*` and the `process.*` methods; hello's
capabilities are `["exec", "files", "processes"]`.

```text
→ {"jsonrpc":"2.0","id":1,"method":"hello","params":{"client":"me"}}
← {"jsonrpc":"2.0","id":1,"result":{"version":"0.1.0-beta.30","os":"linux","arch":"arm64","capabilities":["exec","files","processes"]}}
→ {"jsonrpc":"2.0","id":2,"method":"exec.run","params":{"argv":["uname","-m"],"timeoutMs":5000}}
← {"jsonrpc":"2.0","id":2,"result":{"exitCode":0,"stdout":"YWFyY2g2NAo=","stderr":"","timedOut":false,"truncated":false}}
```

- `exec.run` takes argv, never a shell string. A shell is the caller's choice: `["sh", "-c", "..."]`.
- Each run has a guard: the daemon starts itself again as `computerd guard`, a child subreaper for that one run, and
  the guard starts the program in a process group of its own. Whatever the program starts stays under the guard, even
  a child that calls `setsid` or double-forks, since the kernel hands an orphan to its nearest subreaper. When the
  program ends, the guard kills and reaps every process left under it, then reports the program's exit code or signal.
  A signal is named without `SIG`, here and in `process.wait` and `process.list`: `"TERM"`, `"KILL"` (a signal with no
  name is its number, `"63"`).
  On timeout, or when the call is cancelled with `$/cancelRequest {id}`, the guard sends SIGTERM to the group and
  every process under it, then SIGKILL 2 s later. A timeout is a result with `timedOut: true`; a cancel is an
  `aborted` error. Nothing a run starts outlives it.
- `stdout` and `stderr` come back apart, in base64. Each keeps at most 360 KiB (`maxOutput`, the default and the most):
  both, in base64, fit one 1 MiB line. The rest is read and dropped, and `truncated` is true.
- The environment is PATH (the daemon's), HOME, USER and LOGNAME for the user, then `env` over them. Nothing else of the
  daemon's environment is passed on.
- `user` is a name or `uid[:gid]`. A daemon without CAP_SETUID and CAP_SETGID cannot switch users and answers `denied`.
  A Docker computer drops every capability, so there a command runs as the daemon's own user.
- Requests run at once; replies may come in any order. A line over 1 MiB gets an error reply and the connection goes
  on. When the input ends, what still runs on that connection is cancelled: an `exec.run`, never a process.
- Errors are `{code, message, data: {kind}}`, with kind `not_found`, `invalid`, `timeout`, `aborted`, `denied`, `limit`,
  `unsupported`, `exists`, `not_dir` or `is_dir`.

### Init, the socket and the bridge

- `computerd init --deadline <time>` is the computer's first process. It listens on a unix socket,
  `/run/agentrun/computerd.sock` (or `AGENTRUN_COMPUTERD_SOCKET`); the socket is 0600, so only the daemon's user can
  connect. Init does not make the socket's directory, since a non-root init cannot write under `/run`: the provider
  gives it, the daemon's user's alone (mode 0700). Init exits 1, saying why, when the directory is missing, is not the
  user's alone, or is not writable by it.
  Every connection is served by the same daemon with one process table, which is how a process outlives the call and
  the connection that started it. A socket left by an init that is gone is replaced; a live one is refused.
- `computerd stdio` is a thin bridge: it connects to the socket (waiting up to 3 s for a computer that has just
  started) and copies bytes both ways until either side ends. With no daemon to reach it says so on stderr and exits 1;
  it never serves on its own.
- Init is a child subreaper (PID 1 in Docker is one anyway) and reaps every orphan. It also sweeps, on each SIGCHLD and
  once a second: a child of its own that is not one of its guards can only be an orphan whose guard died (a program can
  kill its own guard, since both run as the same user), so it is killed with everything under it. A process orphaned by
  something run with `docker exec`, outside the daemon, is ended the same way.
- On SIGTERM or SIGINT (`docker stop`), and at its deadline, init first stops taking new programs: from then on
  `process.start` and `exec.run` are refused as `unsupported` ("the computer is shutting down"). It waits (up to 3 s)
  for the starts already under way to start their program, then sends SIGTERM to every guard, each of which ends its
  program's group and descendants with SIGKILL 2 s later; whatever is still under init 5 s after the SIGTERM is killed,
  and init exits 0. So every program that started gets SIGTERM before any SIGKILL. Connections stay open until init
  exits, so reads, waits and lists still answer. One shutdown serves all three.
- A guard also ends its program when its control pipe from the daemon closes, so no program outlives the daemon.

### Processes

A process is a program started under its own guard, as `exec.run`'s are, that keeps running after its call returns.
Its whole tree ends when the program ends or is signalled to its end. Ids are `p1`, `p2`, ...; data is base64.

| Method | Params | Result |
| --- | --- | --- |
| `process.start` | `argv, cwd?, env?, user?, pty?: {cols, rows}, stdin?` | `{id, pid}`: `pid` is the program's. `cwd`, `env` and `user` are as for `exec.run`. Without `stdin` (and without a pty) stdin is /dev/null |
| `process.read` | `id, stream, offset, maxBytes?, waitMs?` | `{data, nextOffset, dropped, exited}`: `stream` is `stdout` or `stderr`, or `pty`; at most 512 KiB a call (more is `limit`) |
| `process.write` | `id, data?, close?` | `{}`: to stdin, or the terminal; `close` closes stdin after the data |
| `process.signal` | `id, signal` | `{}`: `TERM`, `INT`, `KILL` or `HUP`, to the program's process group; to a process that has ended it does nothing |
| `process.resize` | `id, cols, rows` | `{}`: the terminal's new size; the program gets SIGWINCH |
| `process.list` | `from?` | `{processes, truncated, next}`: `processes` are `{id, pid, argv, argvClipped, pty, running, exitCode, signal, startedAt, endedAt}` in start order, times in milliseconds since the epoch; at most 768 KiB a reply: when `truncated`, list again with `from` set to `next`. Pages follow start order, not places in the table, so a process dropped between two pages makes the next skip none |
| `process.wait` | `id, timeoutMs` | `{running, exitCode, signal}`: waits up to `timeoutMs` (0 to a day) for the end; `running` is true on timeout |

- Each stream keeps its last 8 MiB in a ring. Offsets count bytes since the process started; `nextOffset` is where the
  next read starts. A read below the ring's start begins at its start, and `dropped` says how many bytes were lost; an
  offset past the end is `invalid`. `exited` is true once the process has ended and nothing is left past `nextOffset`.
- `waitMs` (at most 30 000) makes a read wait, when nothing past `offset` has come yet, until bytes come, the process
  ends, or the time is up. So a client follows a process with one call in flight and no busy loop.
- A process whose guard was killed reports the guard's end; one whose guard init's shutdown reaped first reports `KILL`.
- A listing holds at most 64 KiB of each argv, in JSON. A longer one is listed by its first arguments that fit, with
  `argvClipped` set; the caller that started it has the whole of it.
- With `pty`, stdout and stderr are one `pty` stream, and the program runs in a session of its own with the terminal
  as its controlling terminal (setsid and TIOCSCTTY in the guard). A terminal has no stdin to close: write `"\x04"`
  for the end of input, or signal `HUP`.
- Writes to one process take turns. A write waits at most 10 s, its turn included, for the program to read; the rest is
  a `timeout` error that says how much was written. A cancelled write, waiting for its turn or writing, is `aborted`.
- The guard keeps no copy of a program's stdin, stdout or stderr pipes once the program runs. So when the program, and
  everything it started, have closed stdin (`exec 0<&-`), a write fails at once as `invalid`, while the program runs
  on. A terminal is kept open by the guard until the program ends.
- The table holds at most 256 processes, running or ended. A start into a full table drops the process that ended
  first (its output with it) once the new program runs; a start that is refused drops nothing. When all 256 run, the
  start is refused as `limit`.
- The rings hold at most 256 MiB of output together (256 full rings would be 4 GiB). Past that, the daemon lets go
  of the rings of the processes that ended first until it is back under, never a running process's ring. Such a
  process stays listed with its exit status; a read of its streams returns no data, `dropped` counts every byte from
  `offset` on, and `exited` is true. Running processes alone can pass the bound (32 of them with full rings).

`src/processes.ts` has `readAll(client, id, stream, {offset?, waitMs?, signal?})`, which pages a stream by offset
until the process ends and returns its bytes, where it ended and what the ring dropped, and `listProcesses(client)`,
which pages `process.list` and returns every process.

### Files

Every path is absolute, and the daemon cleans it; a relative path is `invalid`. Files are read and written as the
daemon's user, and data is base64. In a Docker computer that is the computer's user, non-root by default, so it writes
in `/work` (its home) and `/tmp`; the image's root-owned directories are `denied`.

| Method | Params | Result |
| --- | --- | --- |
| `files.read` | `path, offset?, length?` | `{data, eof, size}`: at most 512 KiB a call; a larger `length` is `limit` |
| `files.write` | `path, data, offset?, append?, mode?, parents?` | `{size}`: replaces the file unless `offset` or `append`; makes it if missing (through a dangling symlink too); `mode` is set when given (a new file gets 0644); `parents` makes missing directories |
| `files.stat` | `path, follow?` | `{type, size, mode, mtimeMs, uid, gid, target?}`: `type` is `file`, `dir`, `symlink` or `other`; a symlink is reported as one unless `follow` |
| `files.list` | `path, depth?, offset?` | `{entries, truncated}`: entries carry the stat fields and `path`, in walk order (by name, a directory before its contents); `depth` 1 (default) to 16; symlinks are listed, never entered; at most 1000 entries (and 768 KiB) a reply: when `truncated`, list again with `offset` plus the entries read |
| `files.mkdir` | `path, parents?, mode?` | `{}`: mode 0755 unless given; a directory already there is `exists`, or fine with `parents` |
| `files.move` | `from, to, overwrite?` | `{}`: a rename; without `overwrite` it never replaces what is at `to` (`exists`), checked in the same step as the rename (renameat2 with RENAME_NOREPLACE; a file is linked and unlinked where that is missing, a directory refused); across filesystems is `unsupported` |
| `files.remove` | `path, recursive?` | `{}`: a directory with entries is `is_dir` unless `recursive`; a symlink is removed, never followed; `/` is `denied` |

Tar archives move whole trees without holding an archive in memory, and no line passes 1 MiB:

- `tar.pull.begin {path}` returns `{id}` for the tar of a file (one entry, its name) or a directory (entries relative
  to it); `tar.pull.read {id, maxBytes?}` returns `{data, eof}`, the next `maxBytes` (default and most 512 KiB) of the
  archive, fewer only at its end; `tar.pull.end {id}` returns `{}`, stops the pull and frees it, and may be sent
  again. The daemon writes the archive only as it is read, so a pull holds at most one read's bytes. Symlinks are
  archived as links; sockets, devices and pipes are left out. A connection has at most 8 pulls open, and those still
  open when it ends are ended with it.
- `tar.push.begin {path}` makes the directory if missing and returns `{id}`; `tar.push.write {id, data}` hands it the
  next bytes (send each after the last one's reply), and extraction runs as they come; `tar.push.end {id}` returns
  `{entries}`. Files, directories and symlinks are extracted with their modes and never chowned; a directory keeps
  owner access until the archive ends, then gets its mode, deepest first, whether the push made it or found it. An
  entry that is absolute, has a `..` part, or has a symlink or a file on its way is `denied`, and ends the push;
  entries before it stay. A symlink at an entry's own name is replaced, never followed. A file is written beside its
  target and renamed into place, so a failed or abandoned push leaves no half file. Hard links, devices and pipes are
  `invalid`. A connection has at most 8 pushes open, and those still open when it ends are ended with it.

`src/files.ts` has the helpers that go past one call: `readFile(client, path)`, `writeFile(client, path, bytes)` (a
`mode` is set with the last chunk, so a read-only file over 512 KiB can be written),
`pushTar(client, dir, bytes | AsyncIterable<Uint8Array>)`, `pullTar(client, path)` (the archive's bytes) and
`pullTarStream(client, path, {signal})` (`{chunks, done}`: one `tar.pull.read` each time the loop asks for a chunk,
and how the pull ended). Every call is a request and its reply: a slow reader holds back only its own pull, so
`pushTar(client, dir, pullTarStream(client, path).chunks)` copies a tree on one connection. A push or pull that began
is always ended, whether it finished, failed, was left or was aborted. `pushTar` owns its source: unless the source is
read to its end, the push calls its `return()` however it ends, so a pull piped into a push that fails is ended too.

### Security

- A push confines every write to its directory at the moment of the write, even while other pushes, or programs in
  the computer running as another user, change the tree under it. The daemon opens the directory once and reaches
  each entry from that descriptor one name at a time, never following a symlink (`openat` with `O_NOFOLLOW`, `mkdirat`,
  `renameat`, `symlinkat`, `fchmod` on a descriptor). No path is checked and then used by name, so a directory swapped
  for a symlink between two steps refuses the entry instead of redirecting it.
- `files.write`, `files.mkdir`, `files.move` and `files.remove` act on the absolute path the caller chose and make no
  promise to confine it: they resolve it by name, as any program in the computer would, and follow a symlink on the
  way. The daemon does not confine them: the container is the only boundary. A provider that runs the daemon as root
  and programs as a lesser user must confine these calls first. A caller that needs a write held inside one directory
  against a concurrent actor pushes a tar into that directory.
- `files.read`, `files.write` and a pull open a file first and then check what they opened (`fstat` on the
  descriptor), never a path checked and then opened by name. The open carries `O_NONBLOCK`, so a FIFO or a device,
  there from the start or swapped in by another program, never makes it wait: `files.read` and `files.write` refuse
  it as `invalid` (a directory is `is_dir`), and a pull leaves it out. A pull opens each file with `O_NOFOLLOW` and
  writes its tar header from that descriptor's `fstat`, so the header matches the bytes it reads; a file that became
  a symlink is left out too.

`src/protocol.ts` and `daemon/internal/methods` are the two definitions of these methods, TypeScript and Go (the Go
params and results of `files.*` and `tar.*` sit beside their code in `daemon/internal/files`).

## Docker

```ts
import { DockerProvider } from "@parcha/agentrun-computer";

const docker = new DockerProvider({ daemonPath: "dist/computerd-linux-amd64" });
const made = await docker.create({ image: "debian:bookworm-slim", lifetimeMs: 600_000, network: "none" });
if (!made.ok) throw new Error(made.error.message);
const connected = await docker.connect(made.value);
if (connected.ok) {
	const ran = await connected.value.client.call("exec.run", { argv: ["uname", "-m"], timeoutMs: 5000 });
	await connected.value.close();
}
await docker.release(made.value, "delete");
```

- `check(spec)` refuses in words, with no Docker call: no image, no or a bad `lifetimeMs` (at most 30 days), a network
  allowlist (Docker cannot enforce one yet: ask for `none` or `open`), a NUL byte in any string, and any field Docker
  does not support. Once the host has been read (below), it also refuses with `field: "host"` for each enforcement
  the host lacks. `create` never throws on a spec `check` passes.
- Before `docker run`, `create` reads the host's enforcement once per provider (`host()`, from `docker info`; see
  below), and refuses a host that lacks any of it in words, having made nothing.
- `create` runs `docker run` as a non-root user (`--user`, below), with every capability dropped (`--cap-drop ALL`),
  `--security-opt no-new-privileges`, `--ipc private --cgroupns private` (never the daemon's defaults, which a host can
  set to `shareable` or, on cgroup v1, the host's cgroup namespace), `--network none` or `bridge`, serve's sizes unless the spec gives its own (2
  CPUs as a quota, `--cpu-period 100000 --cpu-quota 200000`, so a host with fewer CPUs still runs one; 4 GiB with swap
  the same; 1024 pids), and the daemon bind-mounted read-only at `/opt/agentrun/computerd` as
  the entrypoint, `computerd init --deadline <time>`, which is PID 1, holds every process and reaps orphans. The label
  `agentrun.computer.deadline` holds the time `lifetimeMs` ends, and init gets the same time: then it ends every
  process as on SIGTERM (below) and exits 0, which stops the container. Init refuses to start with no deadline.
  Deleting a stopped computer is the janitor's (`lifetime: "janitor"`). A container that is not running after its
  start is removed.
- **A computer runs as a non-root user by default; root must be asked for in the spec.** `user` is a uid or uid:gid
  in numbers (a name is refused: the image may not have it; a uid alone is its own gid). The spec's `user` wins, then
  the provider's `user` option, then this process's uid:gid, or `1000:1000` when this process's uid or gid is 0. The
  provider option refuses root and root's group (`"1000:0"` throws); only a spec's `user: "0"` runs a computer as
  root, and only a spec's gid 0 (such as `"1000:0"`) puts it in root's group. That root has no capability either.
- `/run/agentrun`, init's socket directory, is a tmpfs owned by the computer's user, mode 700, with `noexec`, `nosuid`
  and `nodev`, and `size=1m`: it holds only the socket.
- `/work` is the computer's home (`HOME=/work`) and its workdir unless the spec names one: a tmpfs owned by the
  computer's user, mode 700, the one place a non-root user can surely write. It is memory: what it holds counts against
  the memory limit, and it does not survive a stop. So it holds at most half of `memoryMb` (`size=2048m` by default): a
  full `/work` fails a write with "No space left on device" instead of letting the memory limit OOM-kill a process,
  PID 1 included. Storage that lasts is the agent disk's job, not this package's.
- `create` ends with the drift check (below): a computer that is not what was declared is deleted, and `create`
  refuses with every mismatch in words.
- `create(spec, { signal })` passes the signal to every step: `docker info` before `docker run` (an abort there makes
  nothing), `docker run`, and after it inspect and hello (hello also has its own 30 s limit). An abort at any step after `docker run` deletes the computer and returns
  `aborted`; `create` never returns ok once its signal has aborted.
- `connect` runs `docker exec -i <name> /opt/agentrun/computerd stdio`, the bridge to init's socket, and says hello.
  Each `connect` is a connection of its own; processes are shared by all of them. A daemon whose version is not the
  provider's, or that lacks a capability the provider declares, is refused (`refused`) and the stream closed.
- `attach({ id })` finds a computer by its name (`computer-<12 hex digits>`) or its container id (12 to 64 hex digits);
  `attach({ labels })` by labels, which must match exactly one computer: none is `not_found`, more is `invalid`
  ("2 computers match ..."). Then `attach` runs the drift check on what it found: the spec is read back from the
  computer's own report (image, network, sizes, user, workdir, deadline) and held to what `check` allows (and the
  deadline to the ISO time create writes, at most 30 days away), then the whole inspect is checked as at create, and,
  when the computer runs, its daemon's hello. A computer that drifts is refused (`refused`) with every mismatch, and
  left as it is: attach did not make it, so it does not delete it. A stopped computer is checked by inspect alone.
- `list(labels)` runs `docker ps -a --filter label=agentrun.computer=1 --filter label=k=v ...`, then inspects the
  matches 50 at a time, reading only the fields it reports, so any number of computers is listed (a computer gone
  between the two is left out). It returns each computer's `ref`, `labels`, `deadline` (a `Date`, or `undefined` when the label is missing or is not
  the ISO time the provider writes), `state` (`running` or `stopped`) and `network` as read back.
- `network(ref)` reads the network back: `none` (network mode none, on no network but Docker's own `none`), `open`
  (the default bridge alone), or `{ other: "<words>" }` for anything else, which is never reported as a policy.
  `network(ref, policy)` returns the policy when it is the computer's; any change is refused: a Docker computer's
  network is fixed at create, since Docker cannot move a container with no network onto one.
- `release(ref, "stop" | "delete")` runs `docker stop`, or `docker rm --force --volumes`. A computer already gone is ok.
- Only containers with the label `agentrun.computer=1` and a computer's name count for `attach`, `list` and `network`;
  any other container is `not_found`.

Expected failures are results (`{ ok: false, error: { code, message } }`), not throws.

What a Docker computer cannot do: run as root or in root's group unless its spec asks, switch users, gain a capability, reach any network
when asked for `none`, write the daemon, or run past its deadline.

### The drift check

After `docker run`, `create` reads the computer's own report and compares it with the spec, in `drift(spec, inspected,
hello, expected)`, a pure function that returns one sentence per mismatch (`inspectDrift` is its inspect half). The
check is closed: every field of `HostConfig` and `Config` is either one create asks for, one with a stated default,
or one that widens nothing the box bounds; any other field, one a later Docker adds included, must be empty (absent,
null, `""`, 0, false, `[]` or `{}`), or it is drift naming it. The table below was made from `docker inspect` of a
computer this provider made on Docker 29.

From `docker inspect`, what create asks for:

| Field | Must be |
| --- | --- |
| network (`HostConfig.NetworkMode`, `NetworkSettings.Networks`) | `none` or `open` as declared, read back as `network(ref)` does |
| `HostConfig.CapDrop`, `CapAdd`, `Privileged` | `["ALL"]`, nothing added, false |
| `HostConfig.SecurityOpt` | exactly `["no-new-privileges"]`: `seccomp=unconfined`, `apparmor=unconfined`, `label=disable`, `systempaths=unconfined` or any other option is drift |
| `HostConfig.IpcMode`, `CgroupnsMode` | `private`, `private` |
| `HostConfig.Runtime` | `runc` |
| `HostConfig.MaskedPaths`, `ReadonlyPaths` | hold Docker's own since 20.10 (`/proc/acpi`, `/proc/asound`, `/proc/kcore`, `/proc/keys`, `/proc/latency_stats`, `/proc/sched_debug`, `/proc/scsi`, `/proc/timer_list`, `/proc/timer_stats`, `/sys/firmware`; `/proc/bus`, `/proc/fs`, `/proc/irq`, `/proc/sys`, `/proc/sysrq-trigger`); a newer Docker's extra masked paths are fine |
| `HostConfig.PidsLimit` | `pids`, or 1024 |
| `HostConfig.Memory`, `MemorySwap` | both `memoryMb` MiB, or 4096 MiB |
| `HostConfig.CpuPeriod`, `CpuQuota` | 100000, and `cpus` (or 2) times 100000 |
| `HostConfig.Tmpfs` | exactly `/work` and `/run/agentrun`, each with that uid and gid, `mode=0700`, `nosuid` and `nodev` (`/work` `exec` and `size=` half of `memoryMb` in MiB, `/run/agentrun` `noexec` and `size=1m`); options in any order; a missing or other size, or another tmpfs, is drift |
| `HostConfig.Mounts`, `Mounts` | the provider's daemon binary bound read-only at `/opt/agentrun/computerd` (propagation `rprivate`), and no other mount of any type: an image's `VOLUME` is drift too, so an image that declares one is refused |
| `Config.User` | the uid:gid asked for: the spec's, the provider's, or the default |
| `Config.Image`, `WorkingDir` | the spec's image; its `workdir`, or `/work` |
| `Config.Env` | one `HOME`, `HOME=/work`; the image's other variables are its own |
| `Config.Entrypoint`, `Cmd` | `["/opt/agentrun/computerd"]`, `["init", "--deadline", <the deadline label's value>]` |
| `Config.Labels` | `agentrun.computer=1`, the deadline as written, and every label the spec asked for; others are the image's |
| `AppArmorProfile` | `docker-default` when the host has AppArmor, else empty |
| `ProcessLabel` | of type `container_t` when the host has SELinux, else empty |

Defaults other than empty: `HostConfig.RestartPolicy` no restart (`{"Name": "no"}`; a restart policy would bring a
computer back after its deadline), `Isolation` empty or `default`, `MemorySwappiness` null or -1.

Must be empty, each a mismatch by name: `Binds`, `VolumeDriver`, `VolumesFrom`, `PortBindings`, `PublishAllPorts`,
`Links`, `ExtraHosts`, `Dns`, `DnsOptions`, `DnsSearch`, `PidMode`, `UTSMode`, `UsernsMode`, `Cgroup`, `CgroupParent`,
`GroupAdd`, `Devices`, `DeviceCgroupRules`, `DeviceRequests`, `Sysctls`, `OomKillDisable`, `OomScoreAdj`,
`CpuShares`, `NanoCpus`, `CpuRealtimePeriod`, `CpuRealtimeRuntime`, `CpusetCpus`, `CpusetMems`, `CpuCount`,
`CpuPercent`, `MemoryReservation`, `KernelMemory`, `KernelMemoryTCP`, `BlkioWeight`, `BlkioWeightDevice`,
`BlkioDeviceReadBps`, `BlkioDeviceWriteBps`, `BlkioDeviceReadIOps`, `BlkioDeviceWriteIOps`, `IOMaximumIOps`,
`IOMaximumBandwidth`, `StorageOpt`, `Init`, `Annotations`, `AutoRemove`, `ReadonlyRootfs`; `Config.Volumes`; and
every field not named in this section.

Irrelevant, not checked: `HostConfig.LogConfig` (the host's log driver), `ConsoleSize`, `ContainerIDFile` (a
client-side file), `ShmSize` (`/dev/shm` is charged to the computer's memory), `Ulimits` (an rlimit cannot raise a
cgroup limit); `Config.Hostname`, `Domainname`, `AttachStdin`, `AttachStdout`, `AttachStderr`, `Tty`, `OpenStdin`,
`StdinOnce`, `ExposedPorts` (nothing is published), `Healthcheck`, `ArgsEscaped`, `OnBuild`, `StopSignal`,
`StopTimeout`, `Shell`, `MacAddress`, `NetworkDisabled`: the image's settings, which act only inside the computer.
The rest of the report (`State`, `NetworkSettings` past its networks, paths, `Driver`) is Docker's own bookkeeping.

From the daemon's `hello`, over one short connection: the provider's version, `os` linux, every capability in
`capabilities().daemon`, and `arch` the Docker host's architecture (`docker info`, x86_64 as amd64, aarch64 as arm64).

Any mismatch, or a computer that cannot be inspected or whose daemon does not answer, and the computer is deleted
before `create` returns `refused` with every mismatch. A computer is never left running wider than it was declared.
`attach` runs the same check and refuses, but never deletes.

### The host's enforcement

A computer's sizes are cgroup limits, which only a host that enforces them makes real. `host()` reads `docker info`
once per provider (a failed read is not kept, so the next call reads again), and `hostOf(info)` turns it into the
host's architecture, its security modules, and each enforcement it lacks:

| `docker info` | Required | Refusal |
| --- | --- | --- |
| `MemoryLimit` | true | this Docker host does not enforce memory limits, so a computer's memory size is only configuration |
| `SwapLimit` | true | ... swap limits, so a computer could swap past its memory size |
| `PidsLimit` | true | ... pids limits, so a computer's pids limit is only configuration |
| `CPUCfsQuota`, `CPUCfsPeriod` | true | ... CPU quotas (periods), so a computer's cpus are only configuration |
| `SecurityOptions` seccomp | present, its profile not `unconfined` | this Docker host has no seccomp (its default seccomp profile is unconfined), so a computer could make any system call |
| `SecurityOptions` apparmor, selinux | reported | none: the drift check expects the profile or label Docker then gives every container |

Seccomp is required: it is a computer's only system call filter, and every Linux Docker has it. AppArmor and SELinux
are reported, not required: a host has the one its distribution ships, or neither, and a computer's confinement does
not rest on them (no capabilities, no-new-privileges, seccomp, its own namespaces); where the host has one, a computer
without its profile or label is drift. `create` and `attach` refuse on a host that lacks any requirement, before any
other Docker call; `check` refuses too once the host has been read.

### The janitor

A Docker computer stops itself at its deadline (init exits), but Docker deletes nothing, so the provider declares
`lifetime: "janitor"` and `sweep(provider, { labels?, now?, signal? })` (in `src/janitor.ts`) deletes computers instead. It works for any provider that declares `lifetime: "janitor"`
and refuses one that declares `"vendor"`. It lists the provider's computers with `labels` (all of them by default) and
deletes each whose deadline is at or before `now`, or whose deadline is missing or unreadable, stopped or running (a
computer past its deadline has usually stopped itself already); it keeps the rest and
returns `{ deleted, kept }`. It never touches a container the provider does not list: on Docker, one without
`agentrun.computer=1` and a computer's name. A computer it cannot delete does not stop it; the result is then an error
naming it and what was deleted.

This package does not schedule the janitor. Whoever runs computers runs `sweep` on a schedule (a cron job, or a timer
in a long-lived service), with Docker's CLI on its PATH. A computer stops at its deadline whether the janitor runs or not;
its stopped container may stay up to one interval longer.

```ts
import { DockerProvider, sweep } from "@parcha/agentrun-computer";

const swept = await sweep(new DockerProvider({ daemonPath: "dist/computerd-linux-amd64" }));
if (swept.ok) console.log(`deleted ${swept.value.deleted.join(", ") || "none"}; kept ${swept.value.kept}`);
```

## Build

```sh
npm run build -w @parcha/agentrun-computer          # the TypeScript, into dist/
npm run build:daemon -w @parcha/agentrun-computer   # dist/computerd-linux-amd64 and -arm64; needs Go 1.24 or newer on PATH
```

## Tests

```sh
npm test -w @parcha/agentrun-computer               # unit tests: no Go, no Docker
cd packages/computer/daemon && go vet ./... && go test ./...
AGENTRUN_COMPUTER_LIVE_DOCKER=1 npm run test:docker -w @parcha/agentrun-computer
```

The live tests need Docker, `debian:bookworm-slim` and `alpine:3.20` pulled, both builds, and Go on PATH (the drift
test builds a daemon of another version). They use the daemon for Docker's own
architecture, and remove every container they make by its exact name, pass or fail.

## Acknowledgements

The daemon copies code, with credit, from two Apache-2.0 projects. NOTICE names them; UPSTREAM.json records each copied
file, the commit, and what changed. It has no Go dependency outside the standard library: the terminal is opened with
its own ioctls (pty(7)) rather than with github.com/creack/pty.

- [E2B infra](https://github.com/e2b-dev/infra), envd: the user, credential and environment setup of a process; a
  file's entry info and the listing to a depth.
- [Kubernetes agent-sandbox](https://github.com/kubernetes-sigs/agent-sandbox), sandboxd: the exit status and the
  bounded output of a run with limits; filesystem errors, mkdir, move and remove, and tar extraction confined to its
  directory; the process registry, and a process's stdin, signal and terminal resize.
- E2B envd also gives the signal names, the process list and the terminal's read loop.
- [Rivet sandbox-agent](https://github.com/rivet-dev/sandbox-agent)'s process runtime (Rust; no code copied) is the
  design reference for a bounded log per process, the process snapshot in a list, and reads that wait for output.
