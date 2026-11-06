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

- `computerd init` is the computer's first process. It listens on a unix socket, `/run/agentrun/computerd.sock` (or
  `AGENTRUN_COMPUTERD_SOCKET`), in a directory it makes 0700; the socket is 0600, so only the daemon's user can connect.
  Every connection is served by the same daemon with one process table, which is how a process outlives the call and
  the connection that started it. A socket left by an init that is gone is replaced; a live one is refused.
- `computerd stdio` is a thin bridge: it connects to the socket (waiting up to 3 s for a computer that has just
  started) and copies bytes both ways until either side ends. With no daemon to reach it says so on stderr and exits 1;
  it never serves on its own.
- Init is a child subreaper (PID 1 in Docker is one anyway) and reaps every orphan. It also sweeps, on each SIGCHLD and
  once a second: a child of its own that is not one of its guards can only be an orphan whose guard died (a program can
  kill its own guard, since both run as the same user), so it is killed with everything under it. A process orphaned by
  something run with `docker exec`, outside the daemon, is ended the same way.
- On SIGTERM or SIGINT (`docker stop`), init sends SIGTERM to every guard, each of which ends its program's group and
  descendants with SIGKILL 2 s later; whatever is still under init 5 s after the SIGTERM is killed, and init exits 0.
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
| `process.list` | `{}` | `[{id, pid, argv, pty, running, exitCode, signal, startedAt, endedAt}]`, in start order; times are milliseconds since the epoch |
| `process.wait` | `id, timeoutMs` | `{running, exitCode, signal}`: waits up to `timeoutMs` (0 to a day) for the end; `running` is true on timeout |

- Each stream keeps its last 8 MiB in a ring. Offsets count bytes since the process started; `nextOffset` is where the
  next read starts. A read below the ring's start begins at its start, and `dropped` says how many bytes were lost; an
  offset past the end is `invalid`. `exited` is true once the process has ended and nothing is left past `nextOffset`.
- `waitMs` (at most 30 000) makes a read wait, when nothing past `offset` has come yet, until bytes come, the process
  ends, or the time is up. So a client follows a process with one call in flight and no busy loop.
- A signal's name in `wait` and `list` has no `SIG`: `"TERM"`, `"KILL"`. A process whose guard was killed reports the
  guard's end.
- With `pty`, stdout and stderr are one `pty` stream, and the program runs in a session of its own with the terminal
  as its controlling terminal (setsid and TIOCSCTTY in the guard). A terminal has no stdin to close: write `"\x04"`
  for the end of input, or signal `HUP`.
- A write waits at most 10 s for the program to read; the rest is a `timeout` error that says how much was written.
- The table holds at most 256 processes, running or ended. A start into a full table drops the process that ended
  first (its output with it); when all 256 run, the start is refused as `limit`.

`src/processes.ts` has `readAll(client, id, stream, {offset?, waitMs?, signal?})`, which pages a stream by offset
until the process ends and returns its bytes, where it ended and what the ring dropped.

### Files

Every path is absolute, and the daemon cleans it; a relative path is `invalid`. Files are read and written as the
daemon's user, and data is base64.

| Method | Params | Result |
| --- | --- | --- |
| `files.read` | `path, offset?, length?` | `{data, eof, size}`: at most 512 KiB a call; a larger `length` is `limit` |
| `files.write` | `path, data, offset?, append?, mode?, parents?` | `{size}`: replaces the file unless `offset` or `append`; makes it if missing; `mode` is set when given (a new file gets 0644); `parents` makes missing directories |
| `files.stat` | `path, follow?` | `{type, size, mode, mtimeMs, uid, gid, target?}`: `type` is `file`, `dir`, `symlink` or `other`; a symlink is reported as one unless `follow` |
| `files.list` | `path, depth?, offset?` | `{entries, truncated}`: entries carry the stat fields and `path`, in walk order (by name, a directory before its contents); `depth` 1 (default) to 16; symlinks are listed, never entered; at most 1000 entries (and 768 KiB) a reply: when `truncated`, list again with `offset` plus the entries read |
| `files.mkdir` | `path, parents?, mode?` | `{}`: mode 0755 unless given; a directory already there is `exists`, or fine with `parents` |
| `files.move` | `from, to, overwrite?` | `{}`: a rename; what is at `to` is `exists` unless `overwrite`; across filesystems is `unsupported` |
| `files.remove` | `path, recursive?` | `{}`: a directory with entries is `is_dir` unless `recursive`; a symlink is removed, never followed; `/` is `denied` |

Tar archives move whole trees without holding an archive in memory, and no line passes 1 MiB:

- `tar.pull {path}` sends the tar of a file (one entry, its name) or a directory (entries relative to it) as
  notifications `tar.data {request: <the pull's id>, data}` of at most 512 KiB, then replies `{bytes}`. The daemon
  writes each chunk only as the client reads, and `$/cancelRequest` stops the pull at the next chunk. Symlinks are
  archived as links; sockets, devices and pipes are left out.
- `tar.push.begin {path}` makes the directory if missing and returns `{id}`; `tar.push.write {id, data}` hands it the
  next bytes (send each after the last one's reply), and extraction runs as they come; `tar.push.end {id}` returns
  `{entries}`. Files, directories and symlinks are extracted with their modes and never chowned. An entry that is
  absolute, has a `..` part, or would be written through a symlink that leads out of the directory is `denied`, and
  ends the push; entries before it stay. A file is written beside its target and renamed into place, so a failed or
  abandoned push leaves no half file. Hard links, devices and pipes are `invalid`. A connection has at most 8 pushes
  open, and those still open when it ends are ended with it.

`src/files.ts` has the helpers that go past one call: `readFile(client, path)`, `writeFile(client, path, bytes)`,
`pushTar(client, dir, bytes | AsyncIterable<Uint8Array>)`, `pullTar(client, path)` (the archive's bytes) and
`pullTarStream(client, path)` (`{chunks, done}`: the chunks as they come, and how the pull ended). A
`DaemonClient.call` takes `onNotification` for the notifications that name it; a promise it returns holds back reading
until it settles, which is how `pullTarStream` waits for a slow reader.

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
  does not support. `create` never throws on a spec `check` passes.
- `create` runs `docker run` with every capability dropped (`--cap-drop ALL`), `--security-opt no-new-privileges`, a
  pids limit (4096 unless `pids` says), `--network none` or `bridge`, and the daemon bind-mounted read-only at
  `/opt/agentrun/computerd` as the entrypoint, `computerd init`, which is PID 1, holds every process and reaps orphans. The label
  `agentrun.computer.deadline` holds the time `lifetimeMs` ends; the provider declares `lifetime: "janitor"`, since
  Docker ends nothing on its own. A container that is not running after its start is removed.
- `connect` runs `docker exec -i <name> /opt/agentrun/computerd stdio`, the bridge to init's socket, and says hello.
  Each `connect` is a connection of its own; processes are shared by all of them.
- `release(ref, "stop" | "delete")` runs `docker stop`, or `docker rm --force --volumes`. A computer already gone is ok.

Expected failures are results (`{ ok: false, error: { code, message } }`), not throws.

What a Docker computer cannot do: switch users, gain a capability, reach any network when asked for `none`, write the
daemon, or outlive its deadline once the janitor (a later change) sweeps by label.

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

The live tests need Docker, `debian:bookworm-slim` pulled, and both builds. They use the daemon for Docker's own
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
