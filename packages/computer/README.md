# @parcha/agentrun-computer

Private for now: not published, and nothing else in the repository uses it yet.

The open platform's computer protocol. A computer is anything an agent can run commands on: a container, a microVM, a
full VM, a machine. The protocol has two layers:

- **A daemon in every computer.** `computerd` is one small static Go program (Linux, amd64 and arm64, no cgo). It speaks
  JSON-RPC 2.0, one JSON object per line, over stdin and stdout, so it works in a computer with no network.
- **One provisioner per vendor.** A provisioner makes, finds and ends computers, and opens a stream to the daemon
  inside. It never runs commands itself: the daemon does. This package has four: Docker, Modal's VM runtime, Daytona
  and E2B (desktops), each one line of the provider registry (see [Adding a computer](#adding-a-computer)).

## What it does today

The daemon answers `hello`, `ping`, `exec.run`, the `files.*` methods, `tar.*`, the `process.*` methods and
`deadline.extend`; hello reports kind `linux` and groups `["exec", "files", "processes"]` (see [The protocol
extension](#the-protocol-extension-kind-daemon-modes-screen-input-apps-lifetime)). With an X display it also answers
`screen.shot`, `screen.read` and `input.actions`, and reports kind `desktop` with `screen`, `input.pointer` and
`input.keys` (see [The X11 shim](#the-x11-shim)).

```text
→ {"jsonrpc":"2.0","id":1,"method":"hello","params":{"client":"me"}}
← {"jsonrpc":"2.0","id":1,"result":{"version":"0.1.0-beta.30","os":"linux","kind":"linux","arch":"arm64","groups":["exec","files","processes"]}}
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
  `aborted` error. Nothing a run starts outlives it. `timeoutMs` counts from the call, the start included: a guard that
  never reports the program's start (its exec stalled on a filesystem) is killed with everything under it, and the run
  times out.
- `stdout` and `stderr` come back apart, in base64. Each keeps at most 360 KiB (`maxOutput`, the default and the most):
  both, in base64, fit one 1 MiB line. The rest is read and dropped, and `truncated` is true.
- The environment is PATH (the daemon's), HOME, USER and LOGNAME for the user, then, when init relays to an egress
  proxy (`init --egress`, [below](#an-allowlist-the-egress-proxy)), `HTTP_PROXY`, `HTTPS_PROXY`, their lowercase forms
  and `NO_PROXY`, then `env` over them. Nothing else of the daemon's environment is passed on.
- `user` is a name or `uid[:gid]`. A daemon without CAP_SETUID and CAP_SETGID cannot switch users and answers `denied`.
  Init leaves itself no capability (below), so a command runs as the daemon's own user.
- Requests run at once; replies may come in any order. A line over 1 MiB gets an error reply and the connection goes
  on. When the input ends, what still runs on that connection is cancelled: an `exec.run`, never a process.
- Errors are `{code, message, data: {kind}}`, with kind `not_found`, `invalid`, `timeout`, `aborted`, `denied`, `limit`,
  `unsupported`, `exists`, `not_dir` or `is_dir`.

### Init, the socket and the bridge

- `computerd init --deadline <time> [--max-deadline <time>]` is the computer's first process. It listens on a unix socket,
  `/run/agentrun/computerd.sock` (or `AGENTRUN_COMPUTERD_SOCKET`); the socket is 0600, so only the daemon's user can
  connect. Init does not make the socket's directory, since a non-root init cannot write under `/run`: the provider
  gives it, the daemon's user's alone (mode 0700). Init exits 1, saying why, when the directory is missing, is not the
  user's alone, or is not writable by it.
  Every connection is served by the same daemon with one process table, which is how a process outlives the call and
  the connection that started it. A socket left by an init that is gone is replaced; a live one is refused.
- `computerd init --deadline <time> --user <uid:gid>` is for a vendor that runs every computer as root and has no user
  of its own to give (Modal), or whose images' privilege tools cannot be relied on (Daytona). Init starts as root,
  makes `$HOME` and the socket's directory that user's alone (0700, never through a symbolic link), and becomes uid:gid
  with no supplementary groups, dropping its privileges on the way as below: from there it is the daemon a Docker
  computer runs. `--user 0:0` is root with no capability. Without
  root, init refuses `--user` in words; a Docker computer is given its user by `docker run --user` and never passes it.
- **Init drops its privileges itself, as any user, root included,** before it listens, so the line holds on every
  vendor and not only where the provider drops capabilities (Docker: `--cap-drop ALL`). On every thread it sets
  `no_new_privs`; drops from the bounding set each capability up to the kernel's last
  (`/proc/sys/kernel/cap_last_cap`) that is still there; makes the uid change, with `--user`; empties the ambient set
  and, by `capset`, the effective, permitted and inheritable sets (a uid of 0 keeps them through any uid change); and
  reads all of it back. So init, every program it starts and every program those start hold no capability in any set
  (`CapInh`, `CapPrm`, `CapEff`, `CapBnd` and `CapAmb` all `0000000000000000`, `NoNewPrivs` 1), and with the bounding
  set empty not even a program root starts gains one. Root without a capability is root to the file system's
  permission bits only: it owns what uid 0 owns. Emptying the bounding set needs CAP_SETPCAP; a capability already
  gone is not dropped again, so a process started with an empty bounding set needs none. When a capability cannot be
  dropped (EPERM, such as a user with a bounding set and no CAP_SETPCAP, as `go test` runs on a host), or the binary
  links cgo (one call cannot reach every thread), init refuses to start, in words, and exits 1.
- **That refusal is policy: init fails closed.** A vendor that starts the daemon as a non-root user with a bounding
  set it cannot empty (a Kubernetes `runAsUser` without `capabilities: drop: ["ALL"]`, say, or `docker run --user`
  without `--cap-drop ALL`) gets no computer, not a computer that runs anyway. The line this package holds is that
  every set reads back zero, so no program in a computer holds a capability or can gain one. `no_new_privs` already
  stops a gain through `exec` (a setuid-root file, file capabilities); the empty bounding set is the second,
  independent limit on the same gain, and init cannot prove from inside that a bounding set it was handed is harmless
  on every kernel and vendor it runs on. So it does not run with capabilities it cannot prove gone. A refusal is said, in words naming the capability and EPERM, and is
  fixed where it starts: drop every capability for the user, or start init as root holding CAP_SETPCAP so it drops
  them itself. A start that went on would be silent, and every program in the computer would inherit it.
- **The daemon's Go tests run without cgo, as computerd is built.** Go builds with cgo wherever it finds a C compiler,
  so a plain `go test ./...` makes test binaries that link cgo, and in one of those init refuses to start for cgo
  (ENOTSUP) alone. The test entry of `cmd/computerd` and `internal/daemon` (`internal/nocgo`, from `TestMain`) builds
  such a package's test binary again with `CGO_ENABLED=0 go test -c` and the `-tags` and `-ldflags` the first was
  built with (read from its build info), runs it with the same arguments and
  environment, and exits with its code; a binary without cgo runs its tests itself, and a `-race` build (which needs
  cgo) skips the tests of the drop. On a host as another user the refusal for EPERM and both deadline tests run (init
  takes its deadline and refuses for the bounding set). The root path (`TestBecome...`, `TestUnprivilegedLeavesRoot...`)
  needs root with capabilities and skips there; CI's `computer-docker` job covers it with the Modal commands matrix
  (`test/docker/modal-commands.docker.test.mjs`: root containers with Docker's default capabilities and `--cap-add
  ALL`, as 0:0 and 1000:1000, and the refusal without CAP_SETPCAP), and computerd's end at its deadline with the
  Docker live tests. The test binaries (`CGO_ENABLED=0 go test -c`) also run as root in a container by hand.
- `computerd probe [--connect <host:port>[/udp]]...` prints one JSON line: the uid and gid it runs as, the kernel's
  release, `reached` (the targets that answered), `accepted` (the targets that accepted a TCP connection and sent nothing back)
  and `results`, each target's `protocol`, `outcome` (`refused`, `accepted` or `answered`), `bytes` and `detail` in
  words. A provider whose vendor reads nothing back runs it through `exec.run` (below, Modal), under the rule in
  [Network none, read from inside](#network-none-read-from-inside-nothing-answers). `computerd probe --diagnose` asks
  more: for 1.1.1.1, 8.8.8.8, 9.9.9.9 and 151.101.1.57 (Fastly's anycast edge, which is no resolver) on 443/tcp,
  80/tcp and 53/udp it reports `refused` (no TCP accept, no UDP answer), `accepted` (an accept, no answer) or
  `answered` (a TLS ServerHello, an `HTTP/1.` status line, a DNS response with the query's id), with 3 s to connect and
  3 s to answer, 15 s in all and at most 4 KiB read per check, and a `verdict`: `egress`, `accepted-only` or `none`.
  It sends nothing of the computer's: a ClientHello with a random nonce, `HEAD / HTTP/1.0`, a query for `example.com`.
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
- `deadline.extend({ at })` moves init's deadline to `at` (an ISO time) and answers `{ at }`, the deadline it holds
  after. It refuses in words an earlier time (`invalid`), one past `--max-deadline`, the most the provider allowed at
  start (`limit`), and any move when init got no `--max-deadline` (`unsupported`); a refusal moves nothing. Init
  refuses to start with a maximum before its deadline.

### Network none, read from inside: nothing answers

Where a vendor reads no network policy back, `computerd probe` stands for one, and network none holds only when
**nothing answers within 10 s**: a target counts as reached only when bytes come back from it. One rule for every
provider.

- **Targets.** `host:port` is tried over TCP; `host:port/udp` (the `/udp` suffix, on `--connect` and in a provider's
  `probeTargets`) is sent a DNS query over UDP. Modal's and E2B's defaults are TCP to `1.1.1.1:443`, `8.8.8.8:443`
  and `[2606:4700:4700::1111]:443`, and DNS over UDP to `1.1.1.1:53/udp` and `[2606:4700:4700::1111]:53/udp`: DNS over
  UDP is the classic path out of a sandbox that drops TCP.
- **Each TCP target gets a request by its port**, so a server that waits for its client speaks: 443 a TLS 1.2
  ClientHello, 80 an HTTP/1.0 `HEAD /`, 53 a DNS query for example.com (behind its 2-byte length), and any other port
  an HTTP `HEAD /` (the most common protocol where the client speaks first; a server that speaks first, as SSH and SMTP
  do, answers whatever is sent). The ClientHello names the server (SNI) only when the target's host is a name: an IP
  literal is no server name (RFC 6066, section 3), so `1.1.1.1:443` gets none. The HTTP request's `Host` is the
  target's host. **A UDP target**, whatever its port, gets one datagram: a recursive DNS query for example.com's A
  records with a random id.
- **Bounds:** 10 s to connect, 10 s from the request to the answer, at most 4 KiB read per target, every target at once.
  The probe runs once per create (and per attach and `network(ref)`), so its window is wide: a transparent proxy that
  connects onward lazily, under load, still answers within it. Modal's and E2B's 30 s bound on the probe's `exec.run`
  covers the longest a probe can take (20 s).
- **Outcomes.** `refused`: no connection, or for UDP no reply (UDP has no accept, so a datagram that brings nothing back
  is refused, as is one the far side's ICMP port-unreachable answers). `answered`: any byte came back, whatever it is: a
  ServerHello, a TLS alert (a server that will not serve the hello still spoke), an HTTP status line, a DNS response
  with the query's id and the response bit, a banner, or bytes of no expected protocol (the detail says which; over UDP
  a datagram that is not the DNS response still came back, and is an answer). Only `answered` is `reached`, and a
  provider refuses network none on any. `accepted`: a TCP connection, then nothing back within the bound, closed or
  held open.
- **An accepted-but-silent connection is recorded, never refused and never hidden.** Some firewalls accept every
  outbound connection first and decide after, closing a denied one with nothing sent back (E2B documents exactly this).
  Such a connection shows that nothing came back, so it is not counted as reached. The provider keeps the computer and
  names the targets in its read-back's words: `notes` on what `create` returns and on what `attach` finds, such as
  `network: none; accepted with no answer (no bytes came back): 1.1.1.1:443, 8.8.8.8:443`. `network(ref)` reads back
  none. The conformance report carries create's notes too, each naming its computer (see
  [Conformance](#conformance)).
- **What the rule can and cannot detect.** It detects a TCP or UDP path that carries bytes back within 10 s on a probed
  host:port. It cannot detect:
  - a one-way leak: a path that forwards outbound bytes and drops every reply reads accepted or refused, never answered;
  - a port that is not probed: the probe shows its own targets are blocked, not every address;
  - a client-first server that silently drops what it is sent: a TCP target whose server waits for its own protocol and
    drops a first message it cannot parse (an HTTP `HEAD` sent to a port that speaks something else) reads `accepted`.
    The defaults never meet this (443 gets TLS, 53 DNS); only an operator's own `probeTargets` can.
- **What it changes.** Only a provider that probes, on a vendor whose firewall accepts first, reads differently: E2B
  ([below](#network)), whose computers with network none the accept-counts rule refused, and are now kept with notes.
  Docker reads its network back from `docker inspect` (`--network none` leaves no interface but `lo`, so a TCP
  connection is refused outright and a UDP datagram has no route, which `test/docker/modal-commands.docker.test.mjs`
  pins with the probe itself, every default target refused); Daytona reads `networkBlockAll` back from its API and runs
  no probe; Modal's live run with `blockNetwork` read back no TCP accept at any target under the earlier accept-counts
  rule, so nothing it accepted is newly let through. The UDP targets have not yet run live on Modal.

### Processes

A process is a program started under its own guard, as `exec.run`'s are, that keeps running after its call returns.
Its whole tree ends when the program ends or is signalled to its end. Ids are `p1`, `p2`, ...; data is base64.

| Method | Params | Result |
| --- | --- | --- |
| `process.start` | `argv, cwd?, env?, user?, pty?: {cols, rows}, stdin?, log?, waitGroup?, orphans?: "keep"` | `{id, pid}`: `pid` is the program's. `cwd`, `env` and `user` are as for `exec.run`. Without `stdin` (and without a pty) stdin is /dev/null. `log`, `waitGroup` and `orphans` are below |
| `process.read` | `id, stream, offset, maxBytes?, waitMs?` | `{data, nextOffset, dropped, exited, size, capped?, logError?}`: `stream` is `stdout` or `stderr`, or `pty`, or `log`; at most 512 KiB a call (more is `limit`); `size` is the stream's bytes so far, kept or dropped |
| `process.write` | `id, data?, close?` | `{}`: to stdin, or the terminal; `close` closes stdin after the data |
| `process.signal` | `id, signal` | `{}`: `TERM`, `INT`, `KILL` or `HUP`, to the program's process group, except `INT` with a pty (below); to a process that has ended it does nothing |
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
- `INT` to a process with a pty is ^C: it goes to the terminal's foreground process group, as the terminal driver
  sends it, so it ends the job a shell runs in the foreground and the shell reads on. The daemon reads that group on
  the terminal it holds (TIOCGPGRP) and has the guard signal it only when it is in the program's own session (and so
  under the guard); a terminal the program handed to another session is refused as `denied`, and nothing is
  signalled. The group can end between that check and the signal, and its id go to a group in another session, so the
  guard checks again right before it signals: a group with no process left in the program's session is not signalled,
  and the reply says `INT` was not sent: `{note}`. A terminal with no foreground group left (the program let go of it, or is ending) has `INT` go to the
  program's group, and the reply says so: `{note}`. `TERM`, `KILL` and `HUP` always go to the program's group.
- Starts take turns. A `process.start` cancelled while it waits for its turn, or before its program runs, is `aborted`,
  and nothing it started is left.
- Writes to one process take turns. A write waits at most 10 s, its turn included, for the program to read; the rest is
  a `timeout` error that says how much was written. A cancelled write, waiting for its turn or writing, is `aborted`.
- The guard keeps no copy of a program's stdin, stdout or stderr pipes once the program runs. So when the program, and
  everything it started, have closed stdin (`exec 0<&-`), a write fails at once as `invalid`, while the program runs
  on. A terminal is kept open by the guard until the program ends.
- The table holds at most 256 processes, running or ended. A start into a full table drops the process that ended
  first (its output with it) once the new program runs; a start that is refused drops nothing. When all 256 run, the
  start is refused as `limit`.
- The rings, of running and ended processes alike, hold at most 256 MiB of output together (256 entries' full rings
  would be 4 GiB, the default box's memory). Past that, the daemon first lets go of the rings of the processes that
  ended first until it is back under. Such a process stays listed with its exit status; a read of its streams returns
  no data, `dropped` counts every byte from `offset` on, and `exited` is true. When no ended ring is left and running
  processes still hold more, each running process's ring stops growing and keeps at most an equal share of the budget
  (never under 64 KiB), dropping its oldest bytes; a read from an offset it dropped reports them in `dropped`.
- `log` is an absolute path for a new file the daemon makes and writes the first 16 MiB of the output to, stdout and
  stderr (or the terminal's) as they come; later output is dropped there while the process runs on. The daemon makes
  the missing directories and the file itself, never through a link: each directory is entered from the one above it
  with `O_NOFOLLOW|O_DIRECTORY`, and the file is made with `O_CREAT|O_EXCL|O_NOFOLLOW`, mode 0644, the daemon's. A
  link at the path or at any directory on its way is refused as `denied`, a file already there as `exists`, and the
  program never starts; a start that fails after the file was made removes it. The `log` stream reads it through the
  daemon's own open file, never by the path, so a rename or removal under it changes nothing read: `size` is the bytes
  the log holds, `capped` says output past them was dropped, and `dropped` is 0. A write to the log that fails or
  writes short (a full disk) stops the log for good: nothing after it is written, so the file stays a true prefix of
  the output, and `logError` says why. The log holds all of the output once its stream reads `exited`; the process's
  end can come before that.
- `waitGroup`: the process runs until its program and every live process left in its process group (with a pty, its
  session) have ended, and reports the program's own exit. A signal goes once to each process group of the run: the
  program's, and every other group its live processes are in (a terminal session's jobs), by the group's id. On a pty,
  the program's exit hangs up the terminal's foreground group, as a terminal does.
- `orphans: "keep"`: when the process ends, what it started that still runs (a daemon in its own session) is not ended:
  it runs on under the guard, unsignalled, until it ends or the computer does. Without it, it is ended with the process.

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

## The protocol extension: kind, daemon modes, screen, input, apps, lifetime

The types and the conformance cases for computers past a Linux shell: desktops, Android and iOS phones. This package
has the types, the cases, the daemon's screen and input on X11 ([The X11 shim](#the-x11-shim)), the desktop fixture and
a Docker desktop; a phone provider comes in a later change. Docker declares `linux` with computerd as PID 1 unless it is
made a desktop, so on a plain Docker computer every new case skips in words.

**Kind.** `capabilities().kind` is `"linux" | "desktop" | "android" | "ios"`, and hello repeats it. `os` stays: it names
the platform the key table and exec need; kind names the shape the tools need. Only these pairs are valid
(`kindRefusals(capabilities)` names any other in words, and the case `health.kind-consistent` fails it):

| kind | os | daemon | Core groups, besides health, provider and drift |
| --- | --- | --- | --- |
| `linux` | linux | `pid1` or `child` | `exec`, `files`, `processes`; network `none` |
| `desktop` | linux (windows, macos later) | `pid1`, `child` or `none` | linux's, when daemon is not `none`; and `screen`, `input.pointer`, `input.keys` |
| `android` | android | `none` | `screen`, `input.touch`; exec and files only when declared |
| `ios` | ios | `none` | `screen`, `input.touch` |

**Daemon mode.** `capabilities().daemon` says who answers the methods. `pid1`: computerd init is the computer's main
process, so its exit ends the computer (Docker). `child`: the vendor's own agent is the main process and starts init at
boot; init's exit does not end the computer (Daytona, whose toolbox daemon runs init as a session command), and it
must not run under a supervisor that restarts it. `none`: no computerd runs, and the provider answers the same methods
itself, from our server (adb, a vendor API). Either way a connection's `client` is a `ComputerClient` (`call(method,
params, { signal })` and `close()`): `DaemonClient` over a stream, or a provider's in-process client.

**Groups.** `capabilities().groups` is one flat list, repeated in hello's `groups`: `exec`, `files`, `processes`,
`screen`, `input.pointer`, `input.keys`, `input.touch`, `apps`, `apps.install`, `apps.ui_tree`. Each is optional unless
kind makes it Core. The drift check and Docker's `connect` refuse a hello whose kind or groups differ from what the
provider declares, either way.

| group | methods |
| --- | --- |
| `screen` | `screen.shot({ region? })`: a PNG (8-bit, non-interlaced), its first `MAX_CHUNK_BYTES` in `data`, with `width`, `height` (the image's pixels, the input coordinate space, never downscaled), `scale` and `cursor?`; `screen.read({ id, offset })` for the rest. One shot is held, until its eof or the next shot. |
| `input.pointer` | `input.actions`: `move`, `down`, `up`, `click` (`count` 1-3, held `keys`), `drag` (a path of 2 or more points), `scroll` (`unit` clicks or px) |
| `input.keys` | `input.actions`: `key` (one key pressed, or a combo released in reverse; `repeat`), `hold` (`ms`), `type` |
| `input.touch` | `input.actions`: `tap`, `long_press`, `swipe`, `pinch` (`scale` above 1 apart, below together), `button` (back, home, app_switch) |
| `apps`, `apps.install` | `apps.list` (`{ apps, foreground }`), `apps.launch`, `apps.terminate`; `apps.install({ path })` of a file already in the computer |
| `apps.ui_tree` | `apps.ui_tree`: `{ root: UiNode, nodes, truncated }`, at most 5000 nodes; a node has `role`, `id?`, `text?`, `label?`, `bounds` in screenshot pixels, `enabled`, the optional booleans and `children` |

Points are `[x, y]` in the full screenshot's pixels, origin top left; a region shot never changes that space. A key is a
name in `KEYS` (enter, tab, space, backspace, delete, escape, insert, the arrows, home, end, pageup, pagedown, f1-f12,
shift, ctrl, alt, super, capslock) or one printable ASCII character (0x21-0x7e); the daemon's Go table
(`daemon/internal/keys`) mirrors it, and a Go test keeps the two equal.
Model vocabularies (Anthropic's `Return` or `ctrl+s`, OpenAI's keypress) are mapped to these by a tool adapter on the
server, once per model family, never per vendor.

`input.actions` rules: the whole batch is checked first (its shape, at most `MAX_ACTIONS` = 100 actions, every key
against `KEYS`, each action's group against what is declared, a px scroll where only clicks exist, and wait plus hold at
most `MAX_BATCH_WAIT_MS` = 300 s); a failure returns `{ done: 0, failed: { index, kind, message } }` and nothing runs.
`checkActions(actions, groups, { pixelScroll? })` is that check, for an implementer, an early caller, or an in-process
client. Then the actions run in order and stop at the first failure (a point off the display, a display gone) with
`done` = its index, and every button and key the batch pressed and did not release is released. A success keeps state:
a `down` with no `up` stays down into the next batch. A cancel stops before the next action and releases as a failure
does.

**Lifetime.** `capabilities().maxLifetimeMs` is the vendor's hard cap for the provider instance (Docker: 30 days).
`checkLifetime(lifetimeMs, capabilities)` is the one rule every `check()` shares: a whole number of milliseconds above
0, at most the cap, refused in words with no vendor call. A provider may offer `extend(ref, ttlMs)`, which sets the
deadline to now + ttlMs (never earlier than the current deadline, never past create + maxLifetimeMs: either is refused
in words with the deadline unchanged, so an extend never shortens a computer's life) by moving the vendor's timer, the
deadline label and init's own deadline (`deadline.extend`, up to the `--max-deadline` the provider gave init at start),
and `stream(ref)`, the vendor's live screen URL. Docker
has neither: its deadline is a container label, which cannot change after create, so ask for the whole lifetime at
create. The janitor counts a deadline more than maxLifetimeMs (and a minute of clock skew) past now as unreadable, and
deletes it.

Brains never run inside the computer: a computer only takes tool calls. There is no duplex group and no "brain and
hands" placement.

### The X11 shim

computerd drives the X display named by `DISPLAY` when init started, in pure Go (`daemon/internal/x11`, written against
the X protocol with no cgo and no dependency, so the daemon stays one static binary): pixels from `GetImage` on the
root window, input from the XTEST extension's `FakeInput`, with no program started for any action. The image needs
only an X server. Only a display in this computer is driven: the unix socket, or TCP to a loopback address; any other
`DISPLAY` is refused before anything is sent to it, so this host's cookie never goes elsewhere. Neither the X server
nor the Xauthority file is trusted (any program of the computer's user can replace either): the cookie is read from
`$XAUTHORITY` or `~/.Xauthority` only when that is a regular file of at most 64 KiB, and a symbolic link, a FIFO or a
device there is refused in words without being read; a setup with a scanline pad other than 8, 16 or 32, or keycodes
that are not a range from 8 up, is refused; and each reply is bounded by what its request can get back (a `GetImage`
by its rectangle), so a longer one ends the connection before anything is allocated for it. A `screen.shot` or
`input.actions` waiting for another to finish with the display waits no longer than its own request, then answers
`aborted`.

- The display is reached when it is first asked for, and again after it goes: hello declares `screen`,
  `input.pointer` and `input.keys`, and kind `desktop`, only while the display answers with XTEST. So a provider may
  start its X server through `process.start` after init is up. With no display (`DISPLAY` unset, nothing answering, no
  XTEST) nothing is declared, and each method is `unsupported`, saying why.
- Programs get no `DISPLAY` from the daemon (exec and process environments stay minimal): one that should show on the
  display is given it in `env`.
- `screen.shot` is a PNG of the root window or a region inside it (one outside is `invalid`), with `scale` 1 and
  `cursor` from `QueryPointer`. A connection holds one shot, until it is read to its end or the next shot; a
  `screen.read` of another id is `not_found`.
- `input.actions` checks the whole batch first, as `checkActions` does, and on X11 also refuses: a touch action
  (`unsupported`: X11 has no touch), a pixel scroll (`unsupported`: the wheel turns in clicks), a point or click count
  that is not whole (`invalid`), an unknown field, and text with a character no key types (a control character other
  than newline and tab, `invalid`). Its own bounds are `limit`: 64 Ki characters a `type`, 10,000 clicks a scroll,
  1000 points a drag, 16 keys at once; and `repeat` is at most 100 (`MAX_KEY_REPEAT`), checked after the action's
  group as `checkActions` does. Then the batch runs; a point off the display stops it there
  (`invalid`, naming the display's size), and an X error from the server stops it at the action that sent it: the
  batch waits for the server (one round trip) after each action with a button, a key or a keyboard map change, so no
  later action runs, and `done` and `failed` say what did. A cancel stops it at the next key, click or point, releases
  what the batch held, and answers `aborted`.
- Scroll: `dy` above 0 turns down, below 0 up, `dx` right and left, one wheel click each, vertical first. A key or
  character that needs shift gets it, pressed before and released after. `type` gives exactly its text whatever
  Caps Lock is: when it is on, it is turned off for the typing and back on after, as xdotool does. A `key` action
  presses keys as a keyboard does, so Caps Lock applies to it.
- Typing a character the keyboard map has no key for (é on a US map, any CJK character, an emoji) uses the keysym remap
  xdotool does: the character is bound to a keycode with no keysym (`ChangeKeyboardMapping`), then typed with it.
  Unlike xdotool the binding is not undone, which would race a client still reading the map; it stays, so the
  character has a key from then on. When no keycode is free, the binding used longest ago is moved once it has
  settled (250 ms after its last key, so clients have read the events bound to it). A `type` needing more keycodes at
  once than the map can give is refused as `limit`, before any key, saying to type it in parts.

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

- `capabilities()` declares kind `linux`, daemon `pid1`, groups `exec`, `files` and `processes`, `maxLifetimeMs`
  of 30 days, and `mount: ["bind"]` (below); there is no `extend()` or `stream()`, and init gets no `--max-deadline`.
- `new DockerProvider({ daemonPath, desktop: {} })` makes desktops: kind `desktop`, with `screen`, `input.pointer` and
  `input.keys` too, on an image with an X server (`test/fixtures/desktop/Dockerfile` is Alpine and Xvfb, 48 MB).
  `create` gives the daemon `DISPLAY` (`display`, default `:0`), then starts the X server through it with
  `process.start` (`server`, default `Xvfb :0 -screen 0 1280x800x24 -nolisten tcp`), as the computer's user and as any
  program: computerd stays PID 1 and starts nothing itself, and the server is one process in its table that ends with
  the computer. `create` waits (`timeoutMs`, default 30 s) until hello declares the display, then runs the drift check;
  a server that ends first, with its last words on stderr, or a display that is not up in time deletes the computer in
  words.
- `check(spec)` refuses in words, with no Docker call: no image, no or a bad `lifetimeMs` (`checkLifetime`: at most
  30 days), a network that is not `none`, `open` or an allowlist the egress proxy takes
  ([below](#an-allowlist-the-egress-proxy)), a NUL byte in any string, and any field Docker does not support. Once the host has been read (below), it also refuses with `field: "host"` for each enforcement
  the host lacks. `create` never throws on a spec `check` passes.
- Before `docker run`, `create` reads the host's enforcement once per provider (`host()`, from `docker info`; see
  below), and refuses a host that lacks any of it in words, having made nothing.
- `create` runs `docker run` as a non-root user (`--user`, below), with every capability dropped (`--cap-drop ALL`),
  `--security-opt no-new-privileges`, `--ipc private --cgroupns private` (never the daemon's defaults, which a host can
  set to `shareable` or, on cgroup v1, the host's cgroup namespace), `--network bridge` for `open` and `--network none`
  for `none` and an allowlist, serve's sizes unless the spec gives its own (2
  CPUs as a quota, `--cpu-period 100000 --cpu-quota 200000`, so a host with fewer CPUs still runs one; 4 GiB with swap
  the same; 1024 pids), and the daemon (its copy, next) bind-mounted read-only at `/opt/agentrun/computerd` as
  the entrypoint, `computerd init --deadline <time>`, which is PID 1, holds every process and reaps orphans. The label
  `agentrun.computer.deadline` holds the time `lifetimeMs` ends, and init gets the same time: then it ends every
  process as on SIGTERM (below) and exits 0, which stops the container. Init refuses to start with no deadline.
  Deleting a stopped computer is the janitor's (`lifetime: "janitor"`). A container that is not running after its
  start is removed.
- **A computer binds the provider's own copy of the daemon, never `daemonPath`.** `daemonPath` may have any mode this
  process can read (npm installs it 0700 under `umask 077`). `create` copies it to `computerd-<sha256 of its bytes>`,
  mode 0755, in `daemonCache` (default `agentrun-computer` under `XDG_CACHE_HOME`, else `~/.cache`), so every computer
  user may run it, and binds that copy. The copy is written to a temporary file and renamed into place, then hashed
  again before each bind. The directory is made 0700 if missing and is never changed: a link, another user's
  directory, a mode other than 0700, or a directory above it another user may write is refused in words. The drift
  check and `attach` compare the copy's path, which the same daemon bytes give in every process.
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
  PID 1 included. What lasts is the run's folder, bound at `/workspace` when the spec asks (below).
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
  left as it is: attach did not make it, so it does not delete it. A stopped computer is checked by inspect alone. A
  computer that passes is returned as its ref with `spec`, the spec read back (`{ image, user, network, cpus,
  memoryMb, pids, workdir, deadline, mount? }`), so a caller sees what it attached to: `user` is `uid:gid` (`"0:0"` for a
  computer whose spec asked for root), `network` the policy read back, and `mount` the run's folder bound at
  `/workspace`, when one is. `list` keeps its own shape (`ComputerInfo`).
- `list(labels)` runs `docker ps -a --filter label=agentrun.computer=1 --filter label=k=v ...`, then inspects the
  matches 50 at a time, reading only the fields it reports, so any number of computers is listed (a computer gone
  between the two is left out). It returns each computer's `ref`, `labels`, `deadline` (a `Date`, or `undefined` when the label is missing or is not
  the ISO time the provider writes), `state` (`running` or `stopped`), `network` as read back, and `mount` when
  something is mounted at `/workspace`.
- `network(ref)` reads the network back: `none` (network mode none, on no network but Docker's own `none`), `open`
  (the default bridge alone), `{ allow: [...] }` (below), or `{ other: "<words>" }` for anything else, which is never
  reported as a policy. `network(ref, policy)` returns the policy when it is the computer's (an allowlist with the same
  entries, normalized, in any order); any change is refused: a Docker computer's network is fixed at create, since
  Docker cannot move a container with no network onto one, and an allowlist needs its volume mounted at create.
- `release(ref, "stop" | "delete")` runs `docker stop`, or `docker rm --force --volumes`, then stops or removes the
  computer's egress proxy and, on delete, its volume, each found by its label (below); `capabilities().release`
  declares both, and `stopDeletes` is false: a stopped container is kept until it is deleted. A computer already gone is
  ok.
- Only containers with the label `agentrun.computer=1` and a computer's name count for `attach`, `list` and `network`;
  any other container is `not_found`.

Expected failures are results (`{ ok: false, error: { code, message } }`), not throws.

What a Docker computer cannot do: run as root or in root's group unless its spec asks, switch users, gain a capability, reach any network
when asked for `none`, reach anything but its list, through its own proxy, when asked for an allowlist, write the
daemon, or run past its deadline.

### An allowlist: the egress proxy

```ts
const made = await docker.create({ image: "debian:bookworm-slim", lifetimeMs: 600_000, network: { allow: ["pypi.org", "*.pythonhosted.org", "93.184.215.0/24"] } });
// In the computer, HTTP_PROXY and HTTPS_PROXY name port 3128 on its own loopback for every program computerd starts.
```

A computer whose network is an allowlist stays `--network none`: its own loopback, no route, no resolver. Its one way
out is its own egress proxy, in a second container the provider makes, reads back and removes with it. The proxy is
serve's (`src/docker/egress-proxy.ts`, with its address table in `src/docker/egress-table.ts`), moved here; it holds no
key.

- **The volume** `computer-<hex>-egress`: a tmpfs of 1 MiB, mode 0700, owned by the computer's uid:gid. The proxy
  makes its Unix socket there (0600); the computer mounts it read-only at `/opt/agentrun/egress` (`EGRESS_MOUNT`).
- **The proxy container** `computer-<hex>-egress`: `node` in `EGRESS_IMAGE` (node:22.23.4-bookworm-slim, pinned by
  digest; `new DockerProvider({ daemonPath, egress: { image } })` replaces it) runs `dist/docker/egress-main.js`, this
  package's own build, bound read-only with its `package.json`. It is on Docker's default bridge alone, publishes no
  port, and runs as the computer's uid:gid with a read-only root, `--cap-drop ALL`, `no-new-privileges`, 256 MiB, 64
  pids, half a CPU (a fixed quota, not the computer's own cpus), 1024 open files and a bounded log. Its argv holds the list, the computer's deadline (it ends itself then), this machine's own
  public addresses (refused as `this-host`), and `egress.hint`, the words a refusal adds (printable ASCII).
  `EGRESS_IMAGE` is the one place its digest is written. `create` pulls it at the first allow computer when the host
  lacks it (see Lifetime), so a host with no registry access pulls it ahead, reading the name from this package:
  `docker pull "$(node --input-type=module -e 'import { EGRESS_IMAGE } from "@parcha/agentrun-computer"; console.log(EGRESS_IMAGE)')"`
  (in this repository, from `packages/computer` after a build: `node -e 'import("./dist/index.js").then((m) => console.log(m.EGRESS_IMAGE))'`).
- **The computer**: init gets `--egress /opt/agentrun/egress/egress.sock`, listens on port 3128 of its own loopback,
  carries each connection to the socket, and gives every program it starts `HTTP_PROXY` and `HTTPS_PROXY` (and their
  lowercase forms) naming that port, with `NO_PROXY` naming the loopback itself. A program that ignores them reaches
  nothing; one that dials the socket itself meets the same proxy. Init refuses to start when it cannot listen.
- **What a list holds** (`capabilities().allow`): names, exact or `*.suffix` (two labels or more), and CIDRs, IPv4 or
  IPv6, with host bits zero and over no range the address rule refuses; both in one list, at most 256 of each, each on
  ports 80 and 443. `check` refuses anything else in words: an empty list (ask for `none`), an address with no prefix, a
  port, a URL, a private range. On a Docker host that remaps user ids (userns-remap or rootless Docker), an allowlist
  is refused before anything is made, as a bind is: the volume's owner and the proxy's code are host ids the computer's
  user does not map to, and the provider does not guess the mapping.
- **The Docker host's own addresses.** The proxy refuses them as `this-host`, so it must know them. Docker does not
  report them; the provider passes this machine's public interface addresses, which are the Docker host's only when
  the provider runs on it. When it runs in a container (`/.dockerenv`, `/run/.containerenv`, or a container's cgroup in
  `/proc/self/cgroup`), or its docker CLI talks to a daemon that is not a local unix socket (`docker context inspect`,
  which resolves the context and `DOCKER_HOST` as the CLI does), an allowlist is refused in words before anything is
  made, and `check` says so once it knows, unless `egress.hostAddresses` names the host's addresses (IP addresses),
  which then go to the proxy beside this machine's own. A plain local host is as before. `egress.hostRoot` (default
  `/`) is the root those container signs are read under, for tests and embedders. An address that is not on any
  interface is never seen: a cloud machine's NAT'd or elastic public IP. Put those in `egress.hostAddresses` too. The
  read-back holds every proxy to the addresses as they are now, so a host that gains an address after create reads its
  older proxies back as `other` (fail closed).
- **What the proxy refuses**, each before any socket opens: a name off the list, before any lookup, so it never
  leaves the host; an IP literal outside a listed CIDR of its own family; any port but 80 and 443; a listed name or
  address that is private, loopback, link-local, metadata, multicast or reserved, in any form it is written (decimal,
  octal, hex, IPv4-mapped, NAT64, 6to4), or one of this machine's own; a Host header that names another host than the
  URI; SOCKS5 BIND and UDP ASSOCIATE; an HTTP upgrade; past 64 connections open at once or 20,000 in all. A name is
  resolved once, every answer is checked, and the checked address is the one dialled, so rebinding a name between the
  check and the dial reaches nothing new; a redirect reaches the client as sent and is never followed. A log line holds
  the host, port, address and class, never a path, query or header. A refusal reads `403 <host> is not on this box's
  network list: <hint>`, the words serve's model sees today. The proxy does not open TLS, so a CONNECT to a listed CDN
  name can carry an SNI for any other tenant of that CDN (domain fronting); listing a CDN's shared name lists every site
  behind it. That is inherent to a CONNECT proxy, and the same as serve.
- **Lifetime.** `create` first makes sure the computer's image and the proxy's are on the host (`docker image inspect`,
  then `docker pull` for one that is not; a failed pull fails create in words, with nothing made). It then makes the
  volume, starts the proxy and waits for its ready line (`egress.readyMs`, 10 s), then runs the computer; both runs
  take `--pull never`, so no pull happens between the volume and the computer. A proxy that ends first, or is not ready in time, fails create in its own words; the proxy and the
  volume are removed, and the computer is never run. `release` removes the proxy and the volume after the computer, each
  found by the label `agentrun.computer.egress=<computer>`, never by name alone, so the janitor's sweep and
  `releaseOlder` remove them too. Parts left with no computer (one removed by hand, or a provider that died between its
  proxy and its computer) the sweep removes too (`sweepLeftovers`): a proxy or volume with the egress label, and the
  sweep's labels, whose deadline label has passed, or whose computer is gone and that is older than a create could
  take (its ready wait and two minutes), removed by what the label found. The volume carries the computer's deadline
  and the spec's labels for this. Until then the proxy stops forwarding at its deadline.
- **Read-back.** `network`, `list` and `attach` read the allowlist from Docker: network mode none, the egress volume
  read-only at its path, init's relay in its command, and a proxy container that carries the computer's label and
  deadline, runs while the computer runs, is hardened and bounded as above (its memory and swap, pids limit, private
  IPC and cgroup namespaces, and json-file log of 1m and 2 files included) with exactly its volume and code, and whose
  argv holds the list and refuses every one of the Docker host's own addresses the provider requires now (more is
  fine). Anything less is `{ other: "network allow, but its egress proxy ... <why>" }`. **A crashed proxy** is not
  restarted: the computer then reaches nothing, its network reads back `other` ("is not running"), and `attach` refuses
  it, so a caller makes a new computer. `list` reads every listed computer's proxy in one more inspect.

### Mounting the run's folder

A computer mounts the run's folder; tools then run inside it. The spec has one field for it, `mount`, and every
computer has the folder at one path, `/workspace` (`WORKSPACE`). `HOME` stays where the provider puts it (`/work` on
Docker): `/workspace` is only the mount.

```ts
import { DockerProvider, WORKSPACE } from "@parcha/agentrun-computer";

const docker = new DockerProvider({ daemonPath: "dist/computerd-linux-amd64" });
// The run folder must exist, by its canonical path, and be writable by docker.user (below).
const made = await docker.create({ image: "debian:bookworm-slim", lifetimeMs: 600_000, network: "none", mount: { kind: "bind", path: "/data/runs/r1/work" } });
// In the computer: files.read({ path: `${WORKSPACE}/notes.md` }), exec.run({ argv: ["make"], cwd: WORKSPACE, ... })
```

- `ComputerSpec.mount` is `{ kind: "bind", path }`, a folder on the provider's host bound in (the local Docker
  computer), or `{ kind: "archil", disk, region, folder, token }`, the run's folder (such as
  `agents/<a>/runs/<r>/work`) inside an Archil disk in its region, mounted in a remote computer.
  `capabilities().mount` lists the kinds a provider takes; absent, it takes none. Each provider file also exports
  `MOUNT` beside its `ENV`, the same kinds (Docker `["bind"]`; Modal and Daytona `[]` for now), so a caller tells which
  provider binds a local folder from the registry (`providerModule(id)`) without building one.
- `checkMount(mount, declared)` (`src/mount.ts`) is the one rule every provider's `check` runs, with no vendor call: a
  kind the provider does not declare is refused in words (`this provider does not take a mount of kind archil; it takes
  bind`); a bind's `path` is absolute, canonical (its own realpath, so what is read back is what is bound: Docker
  reports a bind's source as given, a symlink included), an existing directory on the host, with no NUL; an Archil
  mount's `disk`, `region`, `folder` and `token` are non-empty strings with no NUL, the `folder` relative to the disk's root and
  with no `..` part. A field the kind does not have is refused.
- **The token is a secret.** No refusal names an Archil field's value (a token put in the wrong field is not echoed),
  and what a provider reads back of a mount, `MountReadBack` (`readBackOf(mount, epoch)`), is its kind and source
  alone: `{ kind: "bind", path }` or `{ kind: "archil", disk, region, folder, exclusive, epoch }`, or
  `{ other: "<words>" }` for a mount at `/workspace` the provider never makes. An Archil mount's `epoch` is the
  computer's `agentrun.epoch` label (Archil's hold on a folder carries none), and `readBackOf` throws for an Archil
  mount with no epoch. The token is never in a label, a read-back or an error.
- **Docker takes a bind.** `create` adds `--mount type=bind,src=<path>,dst=/workspace` after the daemon's mount:
  read-write, propagation `rprivate`. A path Docker's `--mount` cannot hold (a comma, a double quote, a line break) is
  refused by `check`.
- **The run folder must be writable by the computer's user.** The provider binds the folder as it is and never chowns
  or chmods it: whoever makes the run folder gives it that user, the spec's `user` or the provider's (`docker.user`,
  this process's uid:gid by default). `create` checks it after reading the host (`docker info`) and before
  `docker run`, as the kernel will: the owner's, the group's or others' bits of the folder's mode, by the user's uid
  and gid, must allow write and search; else it refuses in words (`the run folder /data/runs/r1/work is not writable
  by the computer's user 1000:1000: it is owned by 0:0 with mode 0755; ...`). A computer's user has no capabilities,
  root included, so no other way in. On an SELinux host the folder needs a label containers may use; the provider
  does not relabel it.
- **No bind on a host that remaps user ids.** Under userns-remap or rootless Docker (`docker info`'s
  `SecurityOptions` holds `name=userns` or `name=rootless`; `host().remap`), a computer's uid is another uid on the
  host, so the folder's owner says nothing about whether the computer can write it. The provider does not guess the
  mapping from `/etc/subuid`: `create` with a bind on such a host is refused in words before any `docker run`
  (`this Docker host remaps user ids (rootless Docker), so the run folder's owner on the host is not the computer's
  user, ...`), and `check` refuses it too once the host is read. A computer with no mount is made there as before.
  The conformance case `mount.run-folder-bind` fails on such a host, in those words: the provider declares a bind this
  host cannot give.
- `attach` and `list` read the mount back from `docker inspect` (`mountOf(inspected)`): a read-write bind at
  `/workspace` is `{ kind: "bind", path }`; a read-only one, a volume or two mounts there is `{ other }`, and `attach`
  refuses such a computer. The drift check (below) holds a computer to the mount it was asked for: the bind there, from
  that path, read-write, `rprivate`, and no other mount.

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
| network (`HostConfig.NetworkMode`, `NetworkSettings.Networks`, and for an allowlist the egress volume, init's relay and the proxy container) | `none`, `open` or the allowlist as declared, read back as `network(ref)` does |
| `HostConfig.CapDrop`, `CapAdd`, `Privileged` | `["ALL"]`, nothing added, false |
| `HostConfig.SecurityOpt` | exactly `["no-new-privileges"]`: `seccomp=unconfined`, `apparmor=unconfined`, `label=disable`, `systempaths=unconfined` or any other option is drift |
| `HostConfig.IpcMode`, `CgroupnsMode` | `private`, `private` |
| `HostConfig.Runtime` | `runc` |
| `HostConfig.MaskedPaths`, `ReadonlyPaths` | hold Docker's own since 20.10 (`/proc/acpi`, `/proc/asound`, `/proc/kcore`, `/proc/keys`, `/proc/latency_stats`, `/proc/sched_debug`, `/proc/scsi`, `/proc/timer_list`, `/proc/timer_stats`, `/sys/firmware`; `/proc/bus`, `/proc/fs`, `/proc/irq`, `/proc/sys`, `/proc/sysrq-trigger`); a newer Docker's extra masked paths are fine |
| `HostConfig.PidsLimit` | `pids`, or 1024 |
| `HostConfig.Memory`, `MemorySwap` | both `memoryMb` MiB, or 4096 MiB |
| `HostConfig.CpuPeriod`, `CpuQuota` | 100000, and `cpus` (or 2) times 100000 |
| `HostConfig.Tmpfs` | exactly `/work` and `/run/agentrun`, each with that uid and gid, `mode=0700`, `nosuid` and `nodev` (`/work` `exec` and `size=` half of `memoryMb` in MiB, `/run/agentrun` `noexec` and `size=1m`); options in any order; a missing or other size, or another tmpfs, is drift |
| `HostConfig.Mounts`, `Mounts` | the provider's daemon binary bound read-only at `/opt/agentrun/computerd` (propagation `rprivate`); when the spec has a `mount`, then the run's folder bound read-write at `/workspace` from exactly that path (propagation `rprivate`); for an allowlist, then the computer's own egress volume read-only at `/opt/agentrun/egress`; and no other mount of any type: an image's `VOLUME` is drift too, so an image that declares one is refused |
| `Config.User` | the uid:gid asked for: the spec's, the provider's, or the default |
| `Config.Image`, `WorkingDir` | the spec's image; its `workdir`, or `/work` |
| `Config.Env` | one `HOME`, `HOME=/work`; the image's other variables are its own |
| `Config.Entrypoint`, `Cmd` | `["/opt/agentrun/computerd"]`, `["init", "--deadline", <the deadline label's value>]`, and for an allowlist `"--egress", "/opt/agentrun/egress/egress.sock"` after it |
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

From the daemon's `hello`, over one short connection: the provider's version, `os` linux, `kind` linux, exactly the
groups in `capabilities().groups` (in any order; one more or one fewer is drift), and `arch` the Docker host's
architecture (`docker info`, x86_64 as amd64, aarch64 as arm64). `attach` also reports the hello's `kind` in the spec
it reads back, when the computer is running.

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
computer past its deadline has usually stopped itself already). A deadline more than the provider's `maxLifetimeMs`
past `now` (and a minute of clock skew) counts as unreadable: no computer the provider made carries one. It keeps the
rest and
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

### Run and epoch labels: `releaseOlder`

The claim epoch is the one fence for runs and computers. Every computer of a run carries two labels, set in one place
(`src/labels.ts`): `agentrun.run` (`RUN_LABEL`), the run's id, and `agentrun.epoch` (`EPOCH_LABEL`), the claim epoch of
the runner that made it, in decimal. A new claim is epoch + 1, and its first step is to release the run's computers of
a lower epoch. The labels sit outside each provider's own `agentrun.computer` namespace, so every provider takes them
as a caller's labels, with no code of its own: Docker writes them with `--label` and lists them with `--filter`.

- `runLabels(run, epoch)` gives the two labels for `ComputerSpec.labels`. A run id is a non-empty string with no NUL
  byte, the strictest rule the providers share for a label's value (`runProblem`); an epoch is a whole number from 0
  to 2^53 - 1 (`epochProblem`). Anything else throws, in words.
- `epochOf(labels)` reads a computer's epoch: decimal digits with no sign, leading zero or space, up to 2^53 - 1. A
  missing label is `not_found`; anything else is `invalid`, in words naming what the label reads.
- `releaseOlder(provider, run, epoch, { signal? })` (in `src/janitor.ts`) lists the run's computers by
  `agentrun.run` and deletes each with a lower epoch, and each whose epoch label is missing or unreadable, since it
  cannot prove it is current (named in `unproven`, with why). It keeps the run's computers of this epoch. It holds
  each listed computer to the run's label again, so a computer of another run is never touched, whatever `list` gives.
  It returns `{ released, kept, unproven }`.
- **Fenced.** A computer of the run with a higher epoch means a later claim holds the run: `releaseOlder` is refused
  (`refused`, `fenced: run "r1" has computer-… at epoch 4, above this claim's epoch 3; …`) before it releases
  anything.
- **A partial cleanup is a failure.** Every release is attempted; when any fails, the result is an error naming each
  computer left and why, and what was released. A takeover goes on (revoke, then mount) only on `ok`. An aborted call
  starts no further release and says which ran.
- It revokes no mount: there is no `unmount` on the provider. Revoking an Archil mount is the root helper's, run inside
  the computer through the provider's own exec, and a deleted computer holds no mount.

```ts
import { DockerProvider, releaseOlder, runLabels } from "@parcha/agentrun-computer";

const docker = new DockerProvider({ daemonPath: "dist/computerd-linux-amd64" });
// A claim at epoch 3 takes the run over: the computers of epochs 1 and 2 go first.
const older = await releaseOlder(docker, "r1", 3);
if (!older.ok) throw new Error(older.error.message); // fenced, or a computer that could not be released
await docker.create({ image: "debian:bookworm-slim", lifetimeMs: 600_000, network: "none", labels: runLabels("r1", 3) });
```

### Waiting for a vendor: `waitUntil`

`waitUntil(read, done, { boundMs, signal?, minMs?, maxMs?, what?, describe? })` (in `src/wait.ts`) is the one bounded
wait a provider uses when the vendor reads a state back later than it acted, such as a computer ended by a release. It
reads at once, then after pauses that double from `minMs` (250 ms) to `maxMs` (5 s), never past `boundMs`, and
returns the first state `done` accepts. Each read gets a signal that aborts at the bound or on the caller's abort; a
read still pending then is not waited for, and one that throws is not done. Past the bound it returns a `timeout`, on
the caller's abort an `aborted`, each naming `what` was waited for and the last state read (`describe`). It has no
vendor's types: Modal's `untilFinished`, its one wait after a terminate, is built on it, and Modal's release, a create
that refuses its sandbox, and the Modal sweep all wait through that; Daytona's release, a create that deletes its
sandbox, and the Daytona sweep wait through it too.

## Modal

```ts
import { ModalClient } from "modal"; // the host's own client: this package imports nothing from the SDK
import { ModalProvider } from "@parcha/agentrun-computer";

const modal = new ModalProvider({
	sdk: new ModalClient(),
	app: "computers",
	// daemonPath: the daemon to upload; default this package's dist/computerd-linux-amd64 (npm run build:daemon)
});
const made = await modal.create({ image: "debian:bookworm-slim", lifetimeMs: 600_000, network: "none" });
```

`ModalProvider` makes Modal sandboxes on the VM runtime only, through the slice of Modal's JS SDK named by `ModalSdk`
(apps, images, sandboxes and five methods of a sandbox). It has not yet run against real Modal: every test uses a fake
of that slice, and the live conformance file waits for a key (below).

- **Capabilities.** Kind `linux`, daemon `pid1`, groups `exec`, `files` and `processes`, `maxLifetimeMs` the
  instance's cap (24 hours, or less with the `maxLifetimeMs` option), and user `uid` only, never `root` (below). Daemon
  `pid1` because init is the sandbox's main process and its exit ends the computer (next item); no `extend` or
  `stream`.
- **The daemon is uploaded at create.** The sandbox's command is a small POSIX sh entrypoint (BusyBox and coreutils
  alike): it waits for `/opt/agentrun/computerd` to be there and executable, then `exec`s `computerd init --deadline
  <iso> --user <uid:gid>` with `HOME=/work`. Modal runs the command as the sandbox's main process and finishes the
  sandbox when it exits, so after the `exec`, init is that process and the sandbox lives as long as init does. Whether
  that process is PID 1 is not documented; init reaps as a subreaper either way. The wait is bounded (`uploadMs` plus
  one call, 360 s by default): if no daemon arrives by then, the entrypoint says so on stderr and exits 3, which ends
  the sandbox.

  Right after create the provider runs `sh -c '<upload>' sh /opt/agentrun/computerd <sha256>` through
  `sandbox.exec([...], { mode: "binary" })` and streams `dist/computerd-linux-amd64` into its stdin, in the SDK's own
  256 KiB stdin chunks, then closes it. The script `cat`s stdin to `/opt/agentrun/.computerd.part`, makes it 0755,
  prints `sha256 <hex>` (`sha256sum`, BusyBox's is fine), and only when that is the sha256 it was given moves the part
  into place with `mv -f`. The rename is what the entrypoint waits for, so it never starts a half-written daemon or the
  wrong one. The provider compares the printed sha256 with its own, as the Daytona provider does. A failed, aborted,
  nonzero or mismatched upload, or one past `uploadMs` (5 min), terminates the sandbox and refuses in words. Then the
  drift check connects as below, trying the bridge again until init listens, within `helloMs`. Exec's stdin goes
  through Modal's command router, not the sandbox's network, so network none still works. The binary cannot go as an
  argument: the SDK refuses more than 64 KiB of argv. `modalCommands()` (in `dist/modal.js`) returns the entrypoint,
  upload and bridge exactly as sent. A Docker-gated test runs them in a root container with no network.
- **Or as an image layer**, with `daemonImage`: `create` gives the spec's image `COPY --from=<daemonImage> /computerd
  /opt/agentrun/computerd`, and the command is `computerd init` itself. The JS SDK refuses a COPY from local files but
  takes `COPY --from` an image, so `daemonImage` is a registry image holding this version's daemon for linux/amd64 at
  `/computerd`, pinned by digest (the constructor refuses a tag, and `daemonImage` with `daemonPath`). One is two
  lines:

  ```dockerfile
  FROM scratch
  COPY dist/computerd-linux-amd64 /computerd
  ```

  Either way the image also gets `ENV HOME=/work` and `WORKDIR <workdir>`, and the computer needs no network to get
  its daemon.
- **The daemon becomes the computer's user.** Modal containers always run as root and ignore an image's `USER`, so
  `--user` is how a Modal computer gets the non-root default the protocol asks for (`1000:1000`, or the `user` option),
  or the uid its spec asks for. Init leaves itself and every program no capability in any set (see Init, above): Modal
  starts the container with every one, and a live run read `CapEff` `000001ffffffffff` from a root computer before the
  daemon dropped them itself.
- **A Modal computer never runs as root.** `check()` and `create()` refuse a spec whose `user` is root (`"0"`,
  `"0:<gid>"`, `"root"`, `"root:<gid>"`) in words, before any Modal call, and `connect`, `attach` and `network`
  refuse a computer whose spec tag records root before they run anything in it. Every connection is Modal's own exec
  of `/opt/agentrun/computerd stdio`, outside the daemon, with Modal's root capabilities. A computer's user without
  root cannot touch that path: after the upload `/opt/agentrun/computerd` is `0:0 755` (the part file is `chmod
  0755` by the root upload, then renamed into place), `/opt/agentrun` is made by the root upload's `mkdir -p`, `0:0
  755`, and `/` and `/opt` are the image's, `0:0 755` in Debian and Alpine; with `daemonImage`, `COPY --from` makes
  `/opt/agentrun` and the daemon owned by root (COPY's default; the daemon keeps its mode from the daemon image), not
  yet read back on Modal. Root with no capability still owns every one of them, so it could rename another program over
  the daemon and the next connection would run it with Modal's capabilities; no file mode closes that for the owner
  of every directory above the path. The Docker-gated `modal-commands` test shows both sides: uid 1000 cannot write
  the daemon, `/opt/agentrun`, `/opt` or `/`; uid 0 with `CapEff` 0 replaces the daemon, and the next exec of the
  bridge runs the replacement with the container's capabilities.
- **The stream** is `computerd stdio` through `sandbox.exec([...], { mode: "binary" })`: its stdin and stdout are the
  `DaemonClient`'s stream. Modal has no kill for an exec, so `close()` ends the bridge's stdin and waits up to 5 s for
  it to exit. One deadline, `helloMs`, covers the exec's start (at most `callMs` of it) and the hello after it, so a
  connection fails at `helloMs` in all. An exec given up on (past its bound, or on the caller's abort) goes on at
  Modal; a bridge that lands after that has its stdin closed as it lands, so it ends.
- **Lifetime is Modal's.** Every sandbox's `timeoutMs` is its lifetime, rounded up to whole seconds, so Modal ends it
  then whatever runs in it. The longest is 24 hours, or less with the `maxLifetimeMs` option, declared as
  `capabilities().maxLifetimeMs`; `check` refuses a longer one with `checkLifetime`, the rule every provider shares. The daemon's deadline ends it first. `sweep` refuses a Modal provider.
- **Network.** `none` is `blockNetwork: true`; `open` passes no network field. Modal has no read-back of a sandbox's
  policy, so `networkReadBack` is false and the daemon's probe stands for one: `create`, `attach` and `network(ref)` run
  `computerd probe` through `exec.run`, as the computer's user, against public addresses (`1.1.1.1:443`,
  `8.8.8.8:443`, `[2606:4700:4700::1111]:443`, and DNS over UDP to `1.1.1.1:53/udp` and
  `[2606:4700:4700::1111]:53/udp`, or the `probeTargets` option). A computer with network none that any of
  them answers is terminated at create, refused by attach, and reads back as another network in words; one that only
  accepted, sending nothing back, is kept, the targets named in `notes` (see
  [Network none, read from inside](#network-none-read-from-inside-nothing-answers)). This shows those addresses are
  blocked, not every one. An allowlist is refused: Modal's CIDR allowlist (any protocol,
  every port) and its domain allowlist (beta, TLS on 443 by SNI only) cannot be read back, so per ruling 9 an
  allowlist counts only once the live bypass cases pass. A change of network is refused: blockNetwork cannot be
  updated, and an allowlist only if one was set at create.
- **The drift check** after create: `poll()` is null (it runs), `getTags()` reads back exactly the tags given, hello's
  version, os, arch (`amd64`), kind (`linux`) and exact groups match, and the probe's uid:gid is the computer's user, its kernel is
  not gVisor's (`4.19.0-gvisor`), and with network none none of its targets answered. A mismatch, an abort or a timeout
  terminates the sandbox and refuses in words. The SDK reads back no runtime, image or size: the probe's kernel is the
  only runtime read-back, and image and sizes are what create recorded in a tag only the host's token writes.
- **Sizes are limits**, as in Docker: `cpus` (at least 0.25) becomes `cpuLimit` in physical cores (2 CPUs each) and
  `memoryMb` becomes `memoryLimitMiB`, each with Modal's default request (0.125 cores, 128 MiB) or less. `pids` is
  refused: Modal has no pids limit.
- **Tags.** A sandbox carries `agentrun.computer`, `agentrun.computer.name`, `agentrun.computer.deadline` and
  `agentrun.computer.spec` (what create recorded), so a computer takes at most 6 labels of its own. `list(labels)` is
  `sandboxes.list({ appId, tags })` over the provider's app: running sandboxes only, so every one is `running`, and its
  network is the one create recorded (`network(ref)` probes it). Modal still lists a sandbox for a while after its
  terminate, so each one listed is polled, and one `poll()` reads finished, or that Modal no longer knows, is left out.
- **attach** by id or labels runs the same drift check on what it finds and refuses a drifted computer in words, left
  running. Its `spec.user` is the probe's uid:gid and its `spec.kind` hello's; the rest is as recorded.
- **release** `delete` is `terminate()`, idempotent: a sandbox that has finished, or that Modal no longer knows, is ok.
  Modal ends a sandbox asynchronously, so after the terminate `release` polls (`untilFinished`, on `waitUntil` above) until `poll()` reads
  an exit code or Modal no longer knows the sandbox, with pauses that double from `releasePollMs` (500 ms) to 5 s,
  within `releaseMs` (120 s) and the caller's signal. Past the bound it is a `timeout` that says what `poll()` last
  read; it never reports a delete done that it did not read back. A caller that bounds release (the conformance
  runner's `cleanupTimeoutMs`) gives it more than 120 s: the live suite passes 150 s.
  `capabilities().release` is `["delete"]`, so `stop` is refused as `unsupported`, in words, and the sandbox runs on:
  terminate is a sandbox's only end, and Modal has no stopped state. `release`, `connect` and
  `network` act only on a sandbox whose tags name it as this provider's, with the ref's name.
- **Every call is bounded** (`timeouts`: create 10 min, which covers the layer's build and scheduling; the upload 5
  min; other calls 60 s; a connection, from the bridge's exec to hello, and the probe 30 s; a whole list 120 s; release's wait 120 s) and takes the caller's
  signal. A create that gives up has its
  sandbox terminated if one lands later. A create that refuses its sandbox (drift, an abort, a failed upload)
  terminates it and waits as release does, within `releaseMs`, so nothing is left listed when it returns. The terminate
  is sent whatever the caller's signal; the wait takes it, so an aborted create returns at once, and a wait past the
  bound or cut short by an abort says the sandbox may still be ending and what `poll()` last read.
- **GPU** is refused: this provider makes VM sandboxes, and Modal offers GPUs on gVisor only.

### What every Modal fact rests on

SDK: `modal-labs/modal-client@64880502f2ac3d39750c028b7ccfe21e10adbb45` (npm `modal` 0.11.1): paths are under `js/src/`
unless they start with `modal_proto/`. Docs: modal.com, read 2026-11-05.

| Fact | Citation |
| --- | --- |
| `sandboxes.create(app, image, params)`; `runtime`, `command`, `timeoutMs` (default 5 min), `workdir`, `cpu`, `cpuLimit`, `memoryMiB`, `memoryLimitMiB`, `blockNetwork`, `tags` | `sandbox.ts:356-474`, `808-867` |
| `timeoutMs` must be a whole number of seconds; `cpuLimit` needs `cpu` and is at least it; the same for memory | `sandbox.ts:534-542`, `654-698` |
| `timeoutMs` is the sandbox's maximum lifetime, sent as `timeoutSecs` (300 when unset) | `sandbox.ts:375-376`, `730-733` |
| Runtime `"gvisor" \| "vm"`; unset lets Modal choose, so it is always sent | `sandbox.ts:242-258`; [guide/sandboxes#runtimes](https://modal.com/docs/guide/sandboxes#runtimes) |
| VM: its own Linux kernel under KVM | [guide/sandbox-networking#security-model](https://modal.com/docs/guide/sandbox-networking#security-model) |
| GPU sandboxes only with `runtime="gvisor"` | [guide/sandboxes#runtimes](https://modal.com/docs/guide/sandboxes#runtimes); [guide/sandbox-resources#gpu-sandboxes](https://modal.com/docs/guide/sandbox-resources#gpu-sandboxes) |
| gVisor reports kernel `4.19.0-gvisor`; a VM's `uname -srn` reads `Linux modal 7.2.6` | [guide/troubleshooting](https://modal.com/docs/guide/troubleshooting); [guide/sandboxes#runtimes](https://modal.com/docs/guide/sandboxes#runtimes) |
| Lifetime: default 5 minutes, up to 24 hours | [guide/sandboxes#timeouts](https://modal.com/docs/guide/sandboxes#timeouts) |
| A sandbox finishes when its entrypoint exits, on terminate, at its timeout or idle timeout, or out of memory; no command runs after | [guide/sandboxes#lifecycle](https://modal.com/docs/guide/sandboxes#lifecycle) |
| The command is the sandbox's entrypoint, "the main process" (default `sleep 48h`), sent as `entrypointArgs` | `sandbox.ts:384-388`, `730`; [guide/sandboxes#running-a-sandbox-with-an-entrypoint](https://modal.com/docs/guide/sandboxes#running-a-sandbox-with-an-entrypoint) |
| Whether the main process is PID 1 | not documented (searched `modal-docs`, `js/src`, `modal-libmodal`: none) |
| Modal containers always run as root; `USER` is ignored | [guide/existing-images#user](https://modal.com/docs/guide/existing-images#user) |
| Images must be `linux/amd64` | [guide/existing-images](https://modal.com/docs/guide/existing-images) |
| `images.fromRegistry(tag)`; `dockerfileCommands(commands)` adds a layer; a COPY from local context is refused, `COPY --from=` is not | `image.ts:196-210`, `351-401` |
| Modal's Dockerfile lacks only `EXPOSE`, `HEALTHCHECK`, `LABEL`, `ONBUILD`, `STOPSIGNAL`, `VOLUME` | [guide/existing-images](https://modal.com/docs/guide/existing-images) |
| `sandbox.exec(argv, { mode: "binary" })` gives `stdin` (`writeBytes`, `close`), `stdout`, `stderr` and `wait()` | `sandbox.ts:1272-1290`, `1881-1949`, `2774-2914`; `streams.ts:13-39`, `114-140` |
| exec starts through the task command router; each stdin write is one `TaskExecStdinWrite` at the running offset, and close sends EOF | `sandbox.ts:1915-1926`, `3126-3154`; `modal_proto/task_command_router.proto:420-421` |
| The SDK's own stdin chunk when it streams: 256 KiB | `task_command_router_client.ts:187-193` |
| exec refuses more than 2^16 bytes of argv (ARG_MAX) | `sandbox.ts:1440-1458` |
| No kill or signal for an exec | `modal_proto/task_command_router.proto:397-448` (no kill or signal RPC; exit status fields only) |
| exec on a finished sandbox throws `ConflictError` ("has already finished") | `sandbox.ts:2062-2064`, `2149-2154` |
| `sandboxes.fromId(id)` makes a handle with no call | `sandbox.ts:960-962` |
| `sandboxes.list({ appId, tags })`: running sandboxes only (`includeFinished: false`), with at least those tags | `sandbox.ts:1116-1159`, `1223-1230` |
| `getTags()`, `poll()` (null while running, else the exit code), `terminate()` | `sandbox.ts:1813-1838`, `2761-2772`, `2238-2252` |
| `terminate()` returns once the request is sent; it waits for the sandbox to finish only with `{ wait: true }` | `sandbox.ts:1292-1296`, `2238-2251` |
| `poll()` is `SandboxWait` with timeout 0: null until the server reports a result, then its exit code (137 when terminated) | `sandbox.ts:1491-1511`, `1974-1980`, `2761-2771` |
| `sandboxes.fromId(id)` makes a handle with no call | `sandbox.ts:960-962` |
| terminate sends SIGKILL: a terminated sandbox's code is 137 | [guide/sandboxes#return-codes](https://modal.com/docs/guide/sandboxes#return-codes) |
| A sandbox carries up to 10 tags | [guide/sandboxes#tagging](https://modal.com/docs/guide/sandboxes#tagging) |
| `apps.fromName(name, { createIfMissing })` | `app.ts:32-61` |
| SDK errors are named (`NotFoundError`, `InvalidError`, `ConflictError`) | `errors.ts:94-123` |
| `cpu` is physical cores, 1 core = 2 vCPUs; default request 0.125 cores and 128 MiB; limits cap the burst | [guide/sandbox-resources](https://modal.com/docs/guide/sandbox-resources) |
| No pids limit in the SDK's params | `sandbox.ts:356-474` (searched: none) |
| `blockNetwork` drops all outbound traffic, DNS included | [guide/sandbox-networking#outbound-access-control](https://modal.com/docs/guide/sandbox-networking#outbound-access-control) |
| CIDR allowlist: any protocol, every port; domain allowlist: beta, TLS on 443 only, matched by SNI; the two combine | [guide/sandbox-networking](https://modal.com/docs/guide/sandbox-networking); `sandbox.ts:416-420` |
| No count limit on CIDR entries is documented | [guide/sandbox-networking](https://modal.com/docs/guide/sandbox-networking) (searched: none) |
| No read-back of a sandbox's network policy | `modal_proto/task_command_router.proto:434-437`, `modal_proto/api.proto:5936-5937` (setters only; searched both for a getter: none) |
| `updateNetworkPolicy` cannot change a sandbox made with `blockNetwork`, and updates only an allowlist set at create | [guide/sandbox-networking#dynamic-policy-limitations](https://modal.com/docs/guide/sandbox-networking#dynamic-policy-limitations); `sandbox.ts:2631` |
| No stopped state: terminate is the only end, so `release` declares `["delete"]` and refuses `stop` | `sandbox.ts:2238-2262`; [guide/sandboxes#lifecycle](https://modal.com/docs/guide/sandboxes#lifecycle) |
| The client reads `MODAL_TOKEN_ID` and `MODAL_TOKEN_SECRET`, else the active `~/.modal.toml` profile, itself | `config.ts:125-145`; `client.ts:123` |
| A `tokenId` and `tokenSecret` passed to `ModalClient` replace both, and clear any OAuth credentials | `client.ts:124-148` |
| The server is `MODAL_SERVER_URL`, else the profile's `server_url`, else `https://api.modal.com:443`; the profile is `MODAL_PROFILE`'s or the active one in `MODAL_CONFIG_PATH` or `~/.modal.toml` | `config.ts:76-82`, `126-143` |
| `ModalClient` declares `endpoint` and never reads it; `getProfile` runs once, at construction, and the control-plane client is made then | `client.ts:51`, `123`, `175`, `281` |
| With a profile's `sandboxV2`, create and list go to the V2 backend, and list then covers both | `sandbox.ts:808-815`, `884-889`, `1116-1122`, `1161-1175` |

### What waits for a live probe

Nothing here has run against Modal. Once the lead OKs a key by name, `AGENTRUN_COMPUTER_LIVE_MODAL=1 npm run test:modal
-w @parcha/agentrun-computer` runs the conformance suite (`test/modal/`), and should settle:

- that the image's `sh` runs the entrypoint as the main process, and the upload streams in through exec's stdin with
  network none, within `uploadMs`, and its sha256 reads back;
- with `COMPUTER_MODAL_DAEMON_IMAGE` only: that Modal's builder takes `COPY --from=<registry image>@sha256:...` and
  keeps the file's mode 0755;
- that `computerd init` starts as root and `--user` drops as it does under Docker; whether it is PID 1 on the VM runtime
  (init says so on stderr when it is not, and still reaps as a subreaper);
- that a workdir other than `/work` exists before the command starts, and `/run` is writable there;
- the tag value's longest length (the spec tag is JSON) and whether `getTags` answers for a terminated sandbox;
- that `terminate` of a finished sandbox does not throw; a live run saw `list` still yield a sandbox right after its
  terminate, which `release` and `list` now wait out and leave out (above);
- the probe's view of `blockNetwork`, and the bypass cases before any allowlist is declared.

Core `provider.stop` expects Modal's refusal (it declares no stop), and the Full `provider.janitor` case is skipped
(`lifetime:janitor`, `release:stop`).

`fromEnv(env, options?)` in `dist/modal.js` builds a real client from `COMPUTER_MODAL_TOKEN_ID` and
`COMPUTER_MODAL_TOKEN_SECRET`. It passes that pair to `ModalClient` explicitly, and never uses `MODAL_TOKEN_ID` or
`MODAL_TOKEN_SECRET`: a host may hold a production token under those names, and with only them set it refuses, naming
the `COMPUTER_MODAL_` pair. The key goes only to `COMPUTER_MODAL_SERVER_URL`, else the SDK's default
`https://api.modal.com:443`: since the client cannot take a server, it refuses while `MODAL_SERVER_URL` is set, and
sets it to its choice only while it constructs the client, so neither `MODAL_PROFILE` nor a profile in
`MODAL_CONFIG_PATH` or `~/.modal.toml` can redirect the key. It also reads `COMPUTER_MODAL_APP`, and, if set,
`COMPUTER_MODAL_DAEMON_IMAGE`; without it the daemon is uploaded from `dist/computerd-linux-amd64`, so a run publishes
nothing. The conformance module, `dist/conformance/modal.js` (`--provider modal`), builds its provider through
`fromEnv`, and only with `AGENTRUN_COMPUTER_LIVE_MODAL=1` set, checked before anything else. Its
`createDriftedProvider()` uploads a daemon it builds with Go as version `<version>-drift` into a
temporary directory, so Go must be on PATH. Every computer of a run gets `maxLifetimeMs` 30 minutes: Modal's timeout
is its lifetime, and a longer one is refused in words. The modal package is the host's; it is imported only when a
provider is made.

A live run is wrapped in the sweep, `dist/conformance/modal-sweep.js`. It reads only `COMPUTER_MODAL_TOKEN_ID`,
`COMPUTER_MODAL_TOKEN_SECRET`, `COMPUTER_MODAL_APP` and `COMPUTER_MODAL_SERVER_URL`, and makes its client the same
pinned way (an ambient `MODAL_SERVER_URL` is refused; it needs no live switch, since it makes nothing):

```sh
node packages/computer/dist/conformance/modal-sweep.js --before /tmp/modal-before.json
AGENTRUN_COMPUTER_LIVE_MODAL=1 npm run test:modal -w @parcha/agentrun-computer
node packages/computer/dist/conformance/modal-sweep.js --after /tmp/modal-before.json
```

`--before` records the app, the server (`COMPUTER_MODAL_SERVER_URL`, else the SDK's default) and the id of every
sandbox in the app carrying `agentrun.computer=1` (`sandboxes.list({ appId, tags })`, which lists running sandboxes
only, so a finished one needs no sweep). `--after` refuses, exit 2, before it lists anything, a file whose app or
server is not the one the environment names now, or that names none: every computer of another app would read as
new. Otherwise it terminates every such sandbox not in that file, reads each back through `sandboxes.fromId` and `poll()` until it reports an exit code or Modal no
longer knows it (up to 60 s each), and prints one line, `{"swept":n,"gone":m,"stillThere":[ids]}`. It exits 0 when
every swept sandbox has finished, 1 when one still runs, and 2 on a usage error, an unreadable before file or one of
another app or server, a missing token or app, or a listing Modal refused, having terminated nothing. A sandbox in the before file is never
named by any call.

## Daytona

```ts
import { DaytonaProvider } from "@parcha/agentrun-computer";

const daytona = new DaytonaProvider({ apiKey, daemonPath: "dist/computerd-linux-amd64" });
const made = await daytona.create({ image: "my-snapshot", lifetimeMs: 600_000, network: "none" });
```

A Daytona computer is a sandbox made through Daytona's v0 REST API with `fetch`, as pi-transport's Daytona box does:
no SDK, and no package beyond this one. `fetch` and the WebSocket factory are options, so the tests run against a fake.
The key is the caller's to pass: the provider never reads the environment, never sends the key over a redirect or to a
toolbox URL that is not https, and never puts it in a computer. `image` is a Daytona snapshot, by id or name: the
snapshot gives the sandbox its class and its size. `image: "default"` sends no snapshot field at all, and Daytona makes
the sandbox from its default snapshot; the provider never guesses a snapshot's name. (A snapshot that is itself named
`default` is reached by its id.) Daytona reports only the snapshot it resolved, by its own name, so create records the
image it was asked for in the label `agentrun.computer.image`, beside the deadline's in the provider's own namespace,
and attach reports that as `image` and the resolved snapshot apart, as `snapshot`.

### Lifetimes

Every sandbox ends at its TTL (`ttlMinutes`, from `lifetimeMs`). Two options bound it further, each sent on every create
and read back by the drift check:

| Option | Daytona field | Meaning | Unset |
| --- | --- | --- | --- |
| `autoStopMinutes` | `autoStopInterval` | Daytona stops the sandbox after this many minutes with no outside activity, whatever runs inside it; 0 is never | 0 |
| `autoDeleteMinutes` | `autoDeleteInterval` | Daytona deletes the sandbox after it has been stopped this long; 0 deletes it as soon as it stops | never (`-1` is sent) |

Each is a whole number, 0 or more; the constructor refuses anything else in words. Daytona's idle timer counts toolbox
calls (the daemon's connections are toolbox calls) but not the daemon's own work, so a computer left with no connection
for `autoStopMinutes` stops. With `autoDeleteMinutes: 0` a stop deletes: the provider then keeps no stopped computer,
declares `stopDeletes: true`, `release(ref, "stop")` returns once the sandbox is gone, and `list()` never shows a
stopped one.

### How the daemon gets in, and how it is reached

Daytona runs its own toolbox daemon as the sandbox's first process, and a snapshot we do not build has no `computerd`.
So the provider pushes it in at create and starts it as a long-lived command, and reaches it the same way:

1. Upload the static binary through the toolbox's file upload, to `/tmp/agentrun-computerd-<random>`.
2. Install it with `/process/execute` (the command is piped to the sandbox's shell): root-owned, mode 755, at
   `/opt/agentrun/computerd`, and make `/work` (its home) and `/run/agentrun` (its socket's directory). As root, or
   through passwordless `sudo`; a sandbox with neither is refused in the script's words. The script prints the
   installed binary's sha256 (`sha256sum`, BusyBox's or coreutils'), which must be the uploaded one's. It makes
   `/opt/agentrun` root's, mode 755, even when the snapshot already had it, removes whatever was at the daemon's path
   first, and then holds the whole path to one rule: the binary, `/opt/agentrun`, `/opt` and `/` each owned by root
   and writable by no group and no other user (read with `ls -ldn`, so a symbolic link or an ACL on the way fails it).
   A path that fails is refused in words, with nothing installed. Only root can change an owner or a mode, so the
   rule, once it holds, holds until root changes it.
3. Start `computerd init --deadline <time> --user 1000:1000` (the `daemonUser` option) as a session command
   (`runAsync`) in the session `agentrun-computerd`, as root (through `sudo -n` when the session's user is not root),
   in a clean environment and with `/work` as its directory. Init drops itself: it gives `/work` and `/run/agentrun`
   to the daemon's user (mode 700, never through a symbolic link), sets `no_new_privs` and empties the capability
   bounding set on every thread, so a setuid program such as `sudo` cannot raise it, then becomes uid and gid 1000
   with no supplementary groups and empties the inheritable set. The provider relies on no privilege tool of the
   snapshot's: the first live start failed on the snapshot's `setpriv`, and the daemon's own drop replaced it. The provider never deletes
   that session: deleting it ends init.
4. `connect()` starts `computerd stdio` as root the same way, in a session of its own, to reach a socket in a
   directory that is the daemon's user's alone; it only carries bytes. Init and the bridge each check the daemon's
   path against the same rule before they run it as root, and refuse in words when it fails, so a binary a user
   other than root could have swapped is never run, even on a computer attached from an older install. Its stdin is the command's input
   (`POST .../input`, whole lines, one call after another), and its stdout is the command's log stream, a WebSocket
   with `follow=true`, in which Daytona prefixes each stdout line with `01 01 01` and each stderr line with `02 02 02`
   (split output, asked for with `X-Daytona-Split-Output: true`). Input is sent with `suppressInputEcho`; a line that
   is a request or a notification, never a reply, is dropped in case a toolbox echoes input anyway. `close()` deletes
   the session, which ends the bridge and nothing else.

This is the protocol's first binding, stdio over the vendor's exec stream, assembled from two halves: the session
command's input and its log stream are each one-way, and together they are the duplex byte stream `DaemonClient`
needs. The PTY WebSocket is one duplex stream, but a terminal: echo and line discipline would have to be turned off by
the shell before the bridge starts, and the PTY starts a shell, not a command. Daytona's V2 API (alpha) adds argv
processes with `writeStdin` and replayable logs, which would replace the two halves when it is GA.

### Security

The sandbox is the only boundary. A program in a Daytona computer can become root inside its sandbox, whatever user
the daemon runs it as:

- Daytona's toolbox daemon, the sandbox's first process, listens on port 2280 on every interface and checks no
  credential: its only middlewares are recovery, tracing, logging and errors, and its token is sent only with its
  telemetry. Its `/process/execute` runs any command as the toolbox's user. That user in the default snapshot has
  passwordless `sudo` for every command (`daytona ALL=(ALL) NOPASSWD:ALL`). So any workload in the sandbox can ask
  the toolbox to run a command through `sudo`, and reach root inside the sandbox.
- The provider depends on the same thing: it installs and starts the daemon through that toolbox, as root or through
  passwordless `sudo`, and refuses a sandbox with neither. Every sandbox it accepts has this way to root.
- The daemon's user (1000:1000, no capabilities, `no_new_privs` on every thread) is hygiene, not a boundary. It stops
  a program from raising itself through `sudo` or a setuid file, not from asking the toolbox. The rule that keeps the
  daemon's path root's alone is hygiene too.
- `networkBlockAll` limits egress only. Daytona drops what leaves the sandbox on the host, and the toolbox on the
  sandbox's loopback stays reachable from inside it.
- From outside, anyone with the API key can run a command as root in the sandbox through the same toolbox.

Daytona's container class runs code as root, and the open runner runs it privileged.

What a Daytona computer cannot do: reach a network its policy blocks, or outlive its TTL. Anything else in its sandbox,
root included, it can.

### Capabilities

| Capability | Declared | Why |
| --- | --- | --- |
| `kind` | `linux` | a Linux shell with computerd: exec, files and processes |
| `lifetime` | `vendor` | `ttlMinutes` destroys the sandbox in any state once it elapses; set to the lifetime in whole minutes, rounded up. Init also ends every process at the deadline itself. |
| `network` | `none`, `open`, `allow` | `networkBlockAll`, neither, or one allow list; each read back from the sandbox |
| `allow.domains` | at most 100, ports 80 and 443 | the domain list is enforced on web traffic by Daytona's egress proxy, which re-signs TLS |
| `allow.cidrs` | at most 10, IPv4, any port | in the open runner a CIDR is allowed with `-p all` |
| `allow.mixed` | `false` | the two lists and block-all are mutually exclusive |
| `isolation` | `container`, or `vm` with `sandboxClass: "linux-vm"` | the class comes from the snapshot, and is read back |
| `os` | `linux` | Linux classes only; Windows and macOS are not offered here |
| `daemon` | `child` | Daytona's toolbox daemon is the sandbox's first process, and init is a session command it runs (below): deleting the session ends init, not the sandbox |
| `groups` | `exec`, `files`, `processes` | the daemon's own, checked against its hello's `groups`, as is its `kind` |
| `maxLifetimeMs` | 30 days | the cap `check` gives, through the shared `checkLifetime`; Daytona's TTL is whole minutes and documents no cap of its own |
| `user` | none | the daemon runs as the provider's `daemonUser`; a spec cannot name a user |
| `release` | `stop`, `delete` | `POST /sandbox/{id}/stop` and `DELETE /sandbox/{id}` |
| `stopDeletes` | `true` with `autoDeleteMinutes: 0`, else `false` | `autoDeleteInterval` 0 deletes a sandbox as soon as it stops |

### What the provider does

- `check(spec)` refuses in words, with no request: no snapshot, a lifetime that is not 1 ms to 30 days, a network
  that is none of the three, an empty allowlist, one that mixes domains and CIDRs, more than 100 domains or 10 CIDRs,
  an IPv6 entry, a domain with a scheme, path or port, a CIDR that is not `A.B.C.D/N`, a label in the provider's own
  namespace (`agentrun.computer`), `cpus`, `memoryMb` or `pids` (a snapshot's size is its own), `user`, `workdir`
  (the daemon works in `/work`), and any other field.
- `create` sends `POST /sandbox` with the name `computer-<12 hex digits>`, the snapshot (none for `"default"`), the
  labels with `agentrun.computer=1`, `agentrun.computer.deadline=<ISO time>` and `agentrun.computer.image=<the image>`, `public: false`, `ttlMinutes`,
  `autoStopInterval` (`autoStopMinutes`; unset, 0, since Daytona's idle timer counts only outside traffic and a daemon
  at work would be stopped), and `autoDeleteInterval` (`autoDeleteMinutes`; unset, -1: a stop keeps the sandbox, which
  the TTL then ends). `POST /sandbox` is never retried. A
  create that fails without a 4xx answer, or is aborted, may still have made the sandbox, so the provider deletes the
  name it chose. Then it waits for `started` (polling `GET /sandbox/{id}`), runs the drift check on that read, pushes
  in and starts the daemon, checks the daemon, and waits until the label listing shows the new computer steadily
  (Daytona's listing trails a create). Any failure, mismatch or abort after the sandbox exists deletes it, and create
  never returns ok once its signal has aborted.
- `attach({ id })` takes a sandbox id or a computer's name; `attach({ labels })` must match exactly one computer. Only
  a sandbox with `agentrun.computer=1` and a computer's name counts. Attach runs the same drift check, with the spec
  read back from the sandbox, and, when it is started, the daemon's; a computer that drifts is refused and left as it
  is. It returns `spec`: `image`, the image create was asked for (`"default"` stays `"default"`), from its label;
  `snapshot`, the snapshot Daytona reports; the daemon's user, the network, `cpus`, `memoryMb` (Daytona's GiB times
  1024), `/work` when the daemon was checked, and the deadline. A computer with no image label (made before create
  wrote it) reports its snapshot as `image`, and is not refused for the missing label.
- `list(labels)` asks Daytona for `agentrun.computer=1` alone, every page, and filters the other labels itself. A
  sandbox that is `destroying` or `destroyed`, or whose desired state is `destroyed`, is going and left out.
  `started`, the states on the way to it, and `stopping` and `pausing` (on the way from it) are `running`: a stopping
  computer is reported stopped only once Daytona reads it `stopped`. The rest (`stopped`, `archived`, `paused`,
  `error`, ...) are `stopped`. A listed sandbox with no network fields is read on its own.
- `network(ref)` reads the network back. `network(ref, policy)` sends `POST /sandbox/{id}/network-settings` and reads
  it back whatever the answer: as asked, it is returned; unchanged, the change is refused in Daytona's words; anything
  else is put back, or, if that fails, the network is blocked, and the change is refused. A network is never left
  wider than asked.
- `release(ref, "delete")` deletes as pi-transport does: retried on a 5xx, checked against the sandbox, with a forced
  stop before the last attempt. `release(ref, "stop")` stops. Both are idempotent, and both refuse a sandbox that is
  not this provider's.
- Daytona is asynchronous: it answers a delete by setting the sandbox's desired state to `destroyed` and a stop by
  setting it to `stopped`, and the sandbox gets there later, through `destroying` or `stopping`. Its listing trails
  both: in the first live run, `list()` still showed a computer right after its delete returned, and showed a stopped
  one `running`. So release waits until Daytona reads the computer as release left it, twice running, by
  `GET /sandbox/{id}` and by the label listing alike: after a delete, a 404 and no listed computer; after a stop, a
  `stopped` read and a computer listed `stopped`, or, when the stop deletes (`autoDeleteMinutes: 0`), a 404 and no
  listed computer. A stop that is not under way is asked for again. It polls through `waitUntil`, with pauses that
  double from `pollMs` up to 5 s, bounded by the `goneMs` timeout for a delete and `stopMs` for a stop (120 s each, unset), and by the signal
  `release(ref, how, { signal })` takes. When the bound runs out, or the sandbox goes to `error`, release fails in
  words naming the last state Daytona read: it never reports a release it has not seen done. A create that deletes
  the sandbox it made (a failure, a mismatch, an abort) waits the same way before it returns.
- `connect(ref)` refuses a computer that is not `started`, and a daemon whose hello is not the provider's.
- Every call has its own timeout and takes the caller's signal; reads, the upload and deletes are retried (three tries,
  backoff), as in pi-transport; creates, session commands, input and network changes are not.

### The drift check

From Daytona's read of the sandbox:

| Field | Must be |
| --- | --- |
| `snapshot` | the spec's image; for `"default"`, whatever Daytona names, unchecked |
| `networkBlockAll`, `networkAllowList`, `domainAllowList`, `outboundProxyUrl` | the network declared; an outbound proxy, both lists, or block-all with a list is drift |
| `labels` | `agentrun.computer=1`, the deadline and the image as written, every label the spec asked for |
| `autoStopInterval`, `autoDeleteInterval` | `autoStopMinutes` (0 unset), `autoDeleteMinutes` (-1 unset), exactly |
| `autoDestroyAt` | set, and no later than the deadline plus the TTL's minute and 2 minutes of clock skew |
| `sandboxClass` | the provider's class |
| `public`, `kvm`, `gpu`, `volumes`, `linkedSandboxId` | false, not true, 0, none, none |

From the daemon, over one connection: hello (the provider's version, `linux`, the `arch` option, every daemon
capability), `/proc/self/status` (Uid and Gid the daemon user's four times, no groups, `NoNewPrivs: 1`, `CapInh`,
`CapPrm`, `CapEff`, `CapBnd` and `CapAmb` all zero), `/proc/self/cwd` (`/work`) and `/proc/self/exe`
(`/opt/agentrun/computerd`); and the installed binary's sha256 from the install.

### Conformance on Daytona

`fromEnv(env, options?)` in `dist/daytona.js` builds the provider from these variables, by name, read when it runs:
`COMPUTER_DAYTONA_API_KEY` (required), `COMPUTER_DAYTONA_API_URL`, `COMPUTER_DAYTONA_DAEMON`, `COMPUTER_DAYTONA_ARCH`
(`amd64` or `arm64`), `COMPUTER_DAYTONA_TARGET`, `COMPUTER_DAYTONA_CLASS` (`container` or `linux-vm`) and
`COMPUTER_DAYTONA_USER`. The conformance module, `dist/conformance/daytona.js` (`--provider daytona`), exports
`createProvider()` and `createDriftedProvider()` (which builds a daemon of another version with Go) over the same
names, and reads `COMPUTER_DAYTONA_SNAPSHOT` (the run's image; unset, `"default"`, Daytona's default snapshot). Neither reads
`DAYTONA_API_KEY` or `DAYTONA_API_URL`, not even as a fallback: on a host that runs other Daytona work they may hold
another organization's key.

Every sandbox of a run has a bounded life besides its TTL: the module always sets `autoStopMinutes: 30` and
`autoDeleteMinutes: 0`, whatever the environment says. A stop therefore deletes, and the provider declares it
(`stopDeletes: true`): Core `provider.stop` holds it to that and passes when the stopped computer is gone, neither
listed nor attachable. Full `provider.janitor`, which needs a stopped computer kept, is skipped (the lifetime is
`vendor`, and a stop keeps none). The module exports `conformanceImage()` and `conformanceNotes`; the CLI takes the
image from it when `--image` names none, and prints the note above the verdict (`notes` in `--json`).

```sh
npm run conformance -w @parcha/agentrun-computer -- --provider daytona [--image <snapshot>]
```

### The sweep around a live run

`dist/conformance/daytona-sweep.js` reads the same `COMPUTER_DAYTONA_API_KEY` and `COMPUTER_DAYTONA_API_URL`:

```sh
node packages/computer/dist/conformance/daytona-sweep.js --before /tmp/daytona-before.json   # before the run
node packages/computer/dist/conformance/daytona-sweep.js --after /tmp/daytona-before.json    # after it
```

`--before <file>` writes the id of every sandbox carrying `agentrun.computer=1`, whatever its name or state, into the
file. `--after <file>` lists them again and deletes (`release(ref, "delete")`) every one whose id is not in the file,
then reads each with `GET /sandbox/{id}` until Daytona answers 404, up to 60 s each, and prints one JSON line,
`{"swept":n,"notFound":m,"stillThere":[ids]}`, where `swept` counts the sandboxes not there before and `notFound` plus
`stillThere`'s length is `swept`. A sandbox in the file is never named by any call. A new sandbox without a computer's
name is not this provider's: release refuses it, and it is reported still there. Exit 0 when every swept sandbox reads
404, 1 when one is still there, 2 on a usage error, a before file it cannot read, no key, or a listing Daytona refused
(nothing is deleted then). Anything else that creates a labelled sandbox between the two runs is swept too.

### Not yet known

Four live runs reached the default snapshot. The first failed at the start, in the privilege tool init's own drop now
replaces; the second passed Core 48 of 52, its failures a delete or a stop Daytona had answered but not done (release
now waits for both) and the resolved snapshot reported as the image (the image label now answers it); the third passed
Core 52/52. The fourth, after the re-stack, passed Core 53/53 with the 9 optional cases of groups a linux computer does
not declare skipped, Full 4/10, and the sweep after it found nothing to delete. Since then the report files those 9
under `optional` (a wording change), and the daemon's path is held root's alone (above), which has not run live: a
default snapshot whose `/opt` another user can write would now be refused at create. These need a live probe:

- whether the production toolbox honors `suppressInputEcho` and `X-Daytona-Split-Output`, and keeps a session's
  command running between calls;
- whether a session's labeller (a shell `read` per line) carries 1 MiB lines at a usable speed, and how big a
  connection's log may grow: every reply stays in the session's log on the sandbox's disk until `close()`;
- `autoStopInterval` and `autoDeleteInterval` as read back, how soon after a stop `autoDeleteInterval: 0` deletes,
  which snapshot Daytona names for a sandbox made with none, and how soon after `autoDestroyAt` Daytona destroys;
- how long `GET /sandbox/{id}` takes to answer 404 after a delete, and the listing to hide the sandbox (release waits
  for both, up to `goneMs`); how long a stop takes to read `stopped`;
- how soon the label listing shows a new sandbox;
- the ports a CIDR list opens on the production runner, and whether a domain list blocks every port but 80 and 443;
- `network: none` against the live bypass cases (ruling 9), on each class;
- the linux-vm class end to end.

### Sources

Every Daytona path, field and limit above. `daytona/clients@8006f63e` is the v0 SDKs and OpenAPI specs at v0.230.0;
`daytonaio/daytona@b5a5d9e7` is the open platform at v0.190.0, frozen in June 2026; `agentrun@7907382ed` is this
repository's main; the docs were read on 2026-11-05.

| Fact | Citation |
| --- | --- |
| `POST /sandbox`, `GET` and `DELETE /sandbox/{sandboxIdOrName}` | `daytona/clients@8006f63e:openapi-specs/api.json:2702`, `daytona/clients@8006f63e:openapi-specs/api.json:3163` |
| `CreateSandbox`: `name`, `snapshot`, `env`, `labels`, `public`, `networkBlockAll`, `networkAllowList`, `domainAllowList`, `target`, `autoStopInterval`, `autoDeleteInterval`, `ttlMinutes` | `daytona/clients@8006f63e:openapi-specs/api.json:12069-12208` |
| `Sandbox` read back: `snapshot`, `labels`, `public`, `networkBlockAll`, `kvm`, `networkAllowList`, `domainAllowList`, `outboundProxyUrl`, `cpu`, `gpu`, `memory`, `state`, `errorReason`, `autoStopInterval`, `autoDeleteInterval`, `autoDestroyAt`, `volumes`, `sandboxClass`, `linkedSandboxId`, `toolboxProxyUrl` | `daytona/clients@8006f63e:openapi-specs/api.json:12295-12593` |
| `SandboxState` values, among them `stopping`, `pausing`, `destroying`, `destroyed` and `error` | `daytona/clients@8006f63e:openapi-specs/api.json:11704` |
| a delete sets the desired state `destroyed` and leaves the state to change later; a stop sets the desired state `stopped`, or, with `autoDeleteInterval` 0, deletes the same way | `daytonaio/daytona@b5a5d9e7:apps/api/src/sandbox/services/sandbox.service.ts:2013-2039`, `daytonaio/daytona@b5a5d9e7:apps/api/src/sandbox/services/sandbox.service.ts:2151-2185`, `daytonaio/daytona@b5a5d9e7:apps/api/src/sandbox/entities/sandbox.entity.ts:317-324`, `daytonaio/daytona@b5a5d9e7:apps/api/src/sandbox/utils/ephemeral.util.ts:6-8` |
| a read by id or name may come from a lookup cache of 10 s | `daytonaio/daytona@b5a5d9e7:apps/api/src/sandbox/services/sandbox.service.ts:1755-1758`, `daytonaio/daytona@b5a5d9e7:apps/api/src/sandbox/utils/sandbox-lookup-cache.util.ts:6` |
| `GET /sandbox?labels=<JSON>&limit&cursor`, a page of `items` and `nextCursor` | `daytona/clients@8006f63e:openapi-specs/api.json:2702`, `daytona/clients@8006f63e:openapi-specs/api.json:2717`, `daytona/clients@8006f63e:openapi-specs/api.json:2756`, `daytona/clients@8006f63e:openapi-specs/api.json:12000` |
| `POST /sandbox/{sandboxIdOrName}/stop`, `force` | `daytona/clients@8006f63e:openapi-specs/api.json:3393`, `daytona/clients@8006f63e:openapi-specs/api.json:3416` |
| `POST /sandbox/{sandboxIdOrName}/network-settings` | `daytona/clients@8006f63e:openapi-specs/api.json:4573`, `daytona/clients@8006f63e:openapi-specs/api.json:12721` |
| `GET /sandbox/{sandboxId}/toolbox-proxy-url`; the toolbox at `toolboxProxyUrl` + `/` + id | `daytona/clients@8006f63e:openapi-specs/api.json:5235`; `daytona/clients@8006f63e:sdk-typescript/src/Sandbox.ts:1566-1573` |
| `Authorization: Bearer <key>` | `daytona/clients@8006f63e:sdk-typescript/src/Daytona.ts:444` |
| `POST /files/upload-v2?path=`, multipart field `file` | `daytona/clients@8006f63e:openapi-specs/toolbox.json:2031` |
| `POST /process/execute` `{command, timeout}` to `{exitCode, result}`; the command piped to the shell | `daytona/clients@8006f63e:openapi-specs/toolbox.json:3234`, `daytona/clients@8006f63e:openapi-specs/toolbox.json:4679`, `daytona/clients@8006f63e:openapi-specs/toolbox.json:4703`; `daytonaio/daytona@b5a5d9e7:apps/daemon/pkg/toolbox/process/execute.go:55-57` |
| `POST /process/session` `{sessionId}`; a session's shell runs as the toolbox's own user | `daytona/clients@8006f63e:openapi-specs/toolbox.json:3636`, `daytona/clients@8006f63e:openapi-specs/toolbox.json:4525`; `daytonaio/daytona@b5a5d9e7:apps/daemon/pkg/session/create.go:20-24` |
| `POST /process/session/{sessionId}/exec` `{command, runAsync, suppressInputEcho}` to `{cmdId}` | `daytona/clients@8006f63e:openapi-specs/toolbox.json:4017`, `daytona/clients@8006f63e:openapi-specs/toolbox.json:5922`, `daytona/clients@8006f63e:openapi-specs/toolbox.json:5935` |
| `POST .../command/{commandId}/input` `{data}`; a newline added to data without one, and input echoed to stdout unless suppressed | `daytona/clients@8006f63e:openapi-specs/toolbox.json:3891`, `daytona/clients@8006f63e:openapi-specs/toolbox.json:5961`; `daytonaio/daytona@b5a5d9e7:apps/daemon/pkg/session/input.go:47-71` |
| `GET .../command/{commandId}/logs?follow=true` as a WebSocket | `daytona/clients@8006f63e:openapi-specs/toolbox.json:3954`, `daytona/clients@8006f63e:openapi-specs/toolbox.json:3979`; `daytona/clients@8006f63e:sdk-typescript/src/Process.ts:437` |
| stdout and stderr lines prefixed `01 01 01` and `02 02 02`, one prefix a line | `daytona/clients@8006f63e:sdk-typescript/src/Process.ts:26-27`; `daytonaio/daytona@b5a5d9e7:apps/daemon/pkg/session/execute.go:196-236` |
| split output with `X-Daytona-Split-Output: true` | `daytonaio/daytona@b5a5d9e7:apps/daemon/pkg/session/common.go:17-19` |
| `DELETE /process/session/{sessionId}` ends the session's process group and tree | `daytona/clients@8006f63e:openapi-specs/toolbox.json:3770`; `daytonaio/daytona@b5a5d9e7:apps/daemon/pkg/session/delete.go:18-70` |
| `ttlMinutes` destroys in any state; `autoStopInterval: 0` runs indefinitely and keeps the TTL | https://www.daytona.io/docs/en/sandboxes.md#wall-clock-ttl, https://www.daytona.io/docs/en/sandboxes.md#running-indefinitely |
| the idle timer ignores processes inside the sandbox | https://www.daytona.io/docs/en/sandboxes.md#auto-stop-sandboxes ("What does not reset the timer") |
| `autoDeleteInterval` negative is disabled, 0 deletes as soon as the sandbox stops; in minutes | `daytona/clients@8006f63e:openapi-specs/api.json:12199`; https://www.daytona.io/docs/en/sandboxes.md#auto-delete-interval |
| `autoStopInterval` in minutes, 0 is disabled; a negative one is refused | `daytona/clients@8006f63e:openapi-specs/api.json:12184`; `daytonaio/daytona@b5a5d9e7:apps/api/src/sandbox/services/sandbox.service.ts:3290-3295` |
| auto-stop triggers even with processes running inside; toolbox requests reset the timer | https://www.daytona.io/docs/en/sandboxes.md#auto-stop-interval |
| both intervals are kept as sent | `daytonaio/daytona@b5a5d9e7:apps/api/src/sandbox/services/sandbox.service.ts:663-673` |
| a create with no snapshot uses the default snapshot | https://www.daytona.io/docs/en/linux-sandboxes.md#create-a-linux-sandbox; `daytonaio/daytona@b5a5d9e7:apps/api/src/sandbox/services/sandbox.service.ts:471-475` |
| `GET /sandbox/{id}` of a destroyed sandbox is a 404 | `daytonaio/daytona@b5a5d9e7:apps/api/src/sandbox/services/sandbox.service.ts:1744`, `daytonaio/daytona@b5a5d9e7:apps/api/src/sandbox/services/sandbox.service.ts:1777-1783` |
| block-all, the CIDR list and the domain list are mutually exclusive, a conflict is a 400 | https://www.daytona.io/docs/en/network-limits.md#create-sandboxes-with-network-restrictions |
| at most 10 IPv4 CIDRs, `A.B.C.D/N`, N 0 to 32 | https://www.daytona.io/docs/en/network-limits.md#network-allow-list-format |
| at most 100 domains, `*.` wildcards, no scheme, path or port | https://www.daytona.io/docs/en/network-limits.md#domain-allow-list-format |
| the domain list covers web ports 80 and 443 | `daytona/clients@8006f63e:openapi-specs/api.json:12135` |
| the domain list's proxy re-signs TLS with a Daytona CA | https://www.daytona.io/docs/en/network-limits.md#https-traffic |
| a CIDR allowed on every protocol and port, in the open runner | `daytonaio/daytona@b5a5d9e7:apps/runner/pkg/netrules/set.go:33-41` |
| Tier 1 and 2 cannot override the network per sandbox | https://www.daytona.io/docs/en/network-limits.md#tier-based-network-restrictions |
| a change: block-all clears both lists, `false` alone clears both, an empty list clears one | https://www.daytona.io/docs/en/network-limits.md#update-network-settings-while-a-sandbox-is-running |
| the container class runs code as root; classes `linux-vm`, `container`, `windows` | https://www.daytona.io/docs/en/isolation.md#runtime-isolation; `daytona/clients@8006f63e:openapi-specs/api.json:10473` |
| the toolbox listens on `:2280`, every interface; its middlewares are recovery, tracing, logging and errors; `/process/execute` | `daytonaio/daytona@b5a5d9e7:apps/daemon/pkg/toolbox/server.go:136-158`, `daytonaio/daytona@b5a5d9e7:apps/daemon/pkg/toolbox/server.go:199-203`, `daytonaio/daytona@b5a5d9e7:apps/daemon/pkg/toolbox/server.go:374-388`, `daytonaio/daytona@b5a5d9e7:apps/daemon/pkg/toolbox/config/config.go:6`; `apps/daemon/pkg/toolbox/middlewares/` holds only `error.go` |
| the toolbox's token is set by `/init` and sent only as a telemetry header | `daytonaio/daytona@b5a5d9e7:apps/daemon/pkg/toolbox/controller.go:33`, `daytonaio/daytona@b5a5d9e7:apps/daemon/pkg/toolbox/telemetry.go:46` |
| the default snapshot's user `daytona` has `NOPASSWD:ALL` sudo | `daytonaio/daytona@b5a5d9e7:images/sandbox/Dockerfile:78`, `daytonaio/daytona@b5a5d9e7:images/sandbox/Dockerfile:96`, `daytonaio/daytona@b5a5d9e7:images/sandbox/README.md:3`; the same `RUN` line in the history of `daytonaio/sandbox:0.11.0` (config `sha256:f6b4fc1ac093`), the snapshot a create with none resolved to in a live run |
| `networkBlockAll` drops the sandbox's outgoing packets on the host (`DOCKER-USER`, by source address) | `daytonaio/daytona@b5a5d9e7:apps/runner/pkg/docker/create.go:242-248`, `daytonaio/daytona@b5a5d9e7:apps/runner/pkg/netrules/set.go:40-49` |
| non-GPU containers run privileged in the open runner | `daytonaio/daytona@b5a5d9e7:apps/runner/pkg/docker/container_configs.go:200-206` |
| memory in GiB | https://www.daytona.io/docs/en/sandboxes.md#resources |
| a snapshot's size is its own; delete with retries and a forced stop; the listing trails a create; no redirect followed; three tries with backoff | `agentrun@7907382ed:packages/pi-transport/src/box/daytona.ts:913`, `agentrun@7907382ed:packages/pi-transport/src/box/daytona.ts:799-817`, `agentrun@7907382ed:packages/pi-transport/src/box/daytona.ts:819-824`, `agentrun@7907382ed:packages/pi-transport/src/box/daytona.ts:343`, `agentrun@7907382ed:packages/pi-transport/src/box/daytona.ts:35-36` |
| auto-delete off with `-1` | `agentrun@7907382ed:packages/serve/src/daytona-api.ts:37` |

## E2B

```ts
import { providerFromEnv } from "@parcha/agentrun-computer";

// COMPUTER_E2B_API_KEY, and the host's own e2b package (npm e2b 2.63.0).
const e2b = await providerFromEnv("e2b");
const made = await e2b.create({ image: "desktop", lifetimeMs: 600_000, network: "none" });
```

An E2B computer is a sandbox made from an E2B template, by default `desktop`, E2B Desktop's (Ubuntu 22.04 with Xvfb,
Xfce, x11vnc and noVNC, e2b-dev/desktop `template/template.py:3-65`). It is kind `desktop`: computerd starts the X
server itself, as on a Docker desktop, and its X11 shim drives it. With `COMPUTER_E2B_KIND=linux` it is kind `linux`
on any template, `base` by default, with no display: the same provider, minus the X server, so it costs nothing to
offer. Every call goes through the host's E2B JS SDK, the `e2b` package's `Sandbox` class, of which `src/e2b.ts` names
only the slice it calls (`E2BSandboxClass`) and imports nothing at load; the package is the host's to install, as
Modal's is. `@e2b/desktop` is not used: it starts Xvfb and Xfce with `commands.run`, outside computerd's process table
and with no bound or abort (`@e2b/desktop@2.5.0` `dist/index.mjs:387-415`), and the provider needs none of its other
calls.

### The key

`fromEnv` reads the key from `COMPUTER_E2B_API_KEY` and nowhere else; without it, it refuses in words that name it and
never `E2B_API_KEY`, whose value may be another team's on a shared host. The SDK reads `E2B_API_KEY`, `E2B_DOMAIN`,
`E2B_API_URL` and `E2B_DEBUG` from `process.env` whenever it is not given them (`index.mjs:1140-1152`,
`1177-1191`), so every call is given the key, the domain (`COMPUTER_E2B_DOMAIN`, default `e2b.app`), the API URL
`https://api.<domain>` and `debug: false` explicitly: with debug on, the SDK fakes a create and skips a kill
(`index.mjs:5402`, `6021-6024`). The SDK also takes `E2B_SANDBOX_URL` when it is given no sandbox URL, and no option
clears it (`index.mjs:1152`, `1183-1185`): it would send every call into a sandbox, the upload and the bridge with it,
there. So the provider refuses to start while it is set. A unit test hands the provider's options to the real SDK's
`ConnectionConfig` with all four ambient variables set, and reads back the provider's own.

### How the daemon gets in, and how it is reached

E2B's envd is the sandbox's first process, a systemd service with `Restart=always` (e2b-dev/infra
`envd.service.tpl:26-30`), so computerd is a `child`, as on Daytona, and init's exit leaves the sandbox:

1. `Sandbox.create(template, ...)` with the run's labels as `metadata` (the provider's own beside them:
   `agentrun.computer=1`, its name, the deadline, the image, the timeout and the most extend may reach), `timeoutMs`
   the lifetime in whole seconds (`index.mjs:502-504`, `5694`), `allowInternetAccess` (false for none),
   `network.allowPublicTraffic: false`, and `lifecycle.onTimeout: "kill"`, explicitly, so a timeout never pauses and
   keeps the computer (`index.mjs:5674-5699`). The create is raced against the caller's signal and its bound, never
   cancelled: one that lands after create gave up is killed by its id, one whose answer never comes by its name label.
   The listing shows a new sandbox a moment late, so the name is listed again until it shows or `listedMs` (15 s)
   passes, and the sandbox found is killed and read back gone, as release waits for one.
2. `getInfo` reads the sandbox back (below).
3. `files.write` uploads the daemon as root to `/tmp/agentrun-computerd-<random>` (`index.mjs:2332-2435`), and the
   same install command as Daytona's (`src/child.ts`) moves it to `/opt/agentrun/computerd`, root-owned, and prints its
   sha256, which must be the uploaded one's.
4. `commands.run(init, { background: true, user: "root", timeoutMs: 0 })` starts `computerd init --deadline <time>
   --user 1000:1000 --max-deadline <create's time plus the cap>` with `DISPLAY=:0`, in a clean environment. envd runs
   the command under `bash -l -c` (`index.mjs:5123-5146`). Its timeout is 0 because envd kills a command whose
   timeout passes, and keeps one running when its stream ends (envd `process/start.go:39-44`); the SDK's default
   would end init after 60 s (`index.mjs:4978`). Create disconnects from it after.
5. `connect()` starts `computerd stdio` the same way, as root, with `stdin: true` and `retainOutput: false` (so a long
   connection keeps no copy of its output, `index.mjs:2708-2711`, `5150-5153`): its stdout comes through `onStdout`
   (decoded as a stream, `index.mjs:2860`), and requests go in with `sendStdin`, one call after another.
   `close()` kills the bridge (SIGKILL, `index.mjs:5092-5095`), which ends nothing else, and disconnects from it. The
   bridge has no command timeout, so one whose start answers after the call gave up on it (its bound passed, or the
   caller aborted) is killed and disconnected as it lands.
6. A desktop's X server, `Xvfb :0 -screen 0 1280x800x24 -nolisten tcp`, starts through the daemon with
   `process.start`, as the computer's user, and create waits until hello declares the display (`src/desktop.ts`,
   shared with Docker). Hello re-checks the display on every call, so `connect()` refuses a desktop whose X server has
   gone (it reads back kind `linux`).

envd runs as root and obeys anyone with the API key, as Daytona's toolbox does; the computer's daemon runs as 1000:1000
with no capability in any set and `no_new_privs`. envd has no `KillMode` in its unit, so a restart of envd ends every
process in its cgroup, init with it: the computer then answers `gone`, and the caller releases it (a restarted init
would hold an empty process table).

### Capabilities

| Capability | Declared | Why |
| --- | --- | --- |
| `kind` | `desktop` (default) or `linux` | `COMPUTER_E2B_KIND`; a desktop's X server is computerd's own |
| `lifetime` | `vendor` | E2B kills the sandbox at its timeout, set to the lifetime; init ends every process at the deadline too |
| `network` | `none`, `open` | `allowInternetAccess`, read back by `getInfo` with `network.denyOut` and `allowPublicTraffic`; `open` only with `publicStream` |
| `networkReadBack` | `true` | `getInfo` reports `allowInternetAccess` and `network` (`index.mjs:5432-5458`) |
| `isolation` | `microvm` | Firecracker |
| `daemon` | `child` | envd is the first process; init is a background command it runs |
| `groups` | `exec`, `files`, `processes`, and on a desktop `screen`, `input.pointer`, `input.keys` | checked against hello on every connect |
| `maxLifetimeMs` | 1 h, up to 24 h | Hobby's cap by default; `COMPUTER_E2B_MAX_LIFETIME_MS` up to Pro's 24 h (`index.d.mts:10169-10172`) |
| `release` | `delete` | `Sandbox.kill`; E2B's pause keeps a sandbox, but no release maps to it here |

### Network

E2B can do none: `allowInternetAccess: false`, which E2B documents as `denyOut: ["0.0.0.0/0"]`
(`index.d.mts:10179`), with no allow list, and no public traffic in. Public traffic matters as much as egress: a
sandbox's every port has a URL, `https://<port>-<id>.<domain>` (`index.mjs:1208-1211`), and with public traffic anyone
with that URL reaches whatever listens there, so a computer with no internet could still hand out data. The provider
always sends `allowPublicTraffic: false` (a project's default may be public), and then a request needs the sandbox's
traffic token as a header. `0.0.0.0/0` is IPv4, so for none the probe (`computerd probe`, through the daemon, as on
Modal) also tries IPv4 and IPv6 addresses from inside at create and attach, the same defaults as Modal's (TCP to
`1.1.1.1:443`, `8.8.8.8:443` and `[2606:4700:4700::1111]:443`, DNS over UDP to `1.1.1.1:53/udp` and
`[2606:4700:4700::1111]:53/udp`, or the `probeTargets` option), and refuses the computer if one answers within the 10 s
window (the rule every provider shares: [Network none, read from inside](#network-none-read-from-inside-nothing-answers)).
The probe's `exec.run` is bounded at 30 s (`timeouts.probeMs`), above its longest run, 20 s. An
allowlist (`allowOut`) is refused until the live bypass cases pass (ruling 9). The network is fixed at
create: `network(ref, policy)` refuses a change.

E2B's firewall accepts an outbound TCP connection before it decides whether the destination is allowed. E2B's docs
(network/internet-access, "Behavior of blocked TCP connections", read 2026-11-07; the copy read is
`vendor-docs/e2b/docs-network-internet-access.md` in the review evidence) say: "The firewall has to accept the
connection first before it can decide whether the destination is allowed. This means that, from inside the sandbox, a
TCP connection can succeed and report the socket as open even when the destination is denied - no packets actually
reach the destination", and to check for an application-level answer instead; and that this "may change in the
future". `e2b-dev/infra@ff3922213` `packages/orchestrator/pkg/tcpfirewall/handlers.go` shows it: the proxy reads the
hostname from the connection's first bytes, decides, and closes a denied connection without dialing the destination.
E2B documents no stricter setting: `allowInternetAccess: false` is `denyOut 0.0.0.0/0`, and `dnsServers` matters only
with a domain in `allowOut`. Under the shared rule only an answer refuses network none, so such a sandbox is kept, and
create's and attach's `notes` name the accepted targets: `network: none; accepted with no answer (no bytes came back):
1.1.1.1:443, 8.8.8.8:443`. The one live diagnostic (below) read that: every IPv4 target on 443/tcp and 80/tcp accepted
and closed with 0 bytes, no answer on 53/udp, and, in the provider's own probe, no accept from the IPv6 target. UDP
is not proxied: the same firewall drops non-TCP to the user deny set, which `denyOut` fills, in nftables
(`e2b-dev/infra@ff3922213` `packages/orchestrator/pkg/sandbox/network/firewall.go`, `installRules`, rule 5), so the probe's UDP targets get no reply within the 10 s window
and read `refused`, not `accepted`, and are not named in `notes`; a reply from either refuses network none. The provider's
own probe has not yet run its UDP targets live on E2B: the diagnostic's 53/udp checks (3 s each) are the measured read.

The risk that stays is one-way. From inside, the provider cannot prove that an accepted connection's outbound bytes go
nowhere: a path that carries the request out and drops every reply reads the same as E2B's firewall. E2B says no
packets reach the destination, and that this may change. The answered check catches any change that forwards traffic
both ways, since the first byte back refuses network none; it does not catch a one-way leak, and nothing run from
inside can. That is the rule for every provider, confirmed on 11-07, and why every
accept is recorded in words rather than dropped.

`dist/conformance/e2b-diagnose.js` (live switch
`AGENTRUN_COMPUTER_LIVE_E2B=1`) makes one sandbox exactly as create does for network none, with a 10-minute E2B
timeout, records the read-back and the provider's own check (`passed` with its `notes`, or its refusal), runs
`computerd probe --diagnose` in it (each check judged as `--connect` judges a target: any byte back is answered),
prints one JSON line, and kills the sandbox and reads it back gone, after an error or an abort too (SIGINT, SIGTERM,
or its own 8-minute bound). Exit 0 when a diagnosis came back and the sandbox reads gone, 1 otherwise, 2 with no live
switch or a refused setting.

### Extend and stream

`extend(ref, ttlMs)` sets E2B's timer to now + `ttlMs` (`Sandbox.setTimeout`, `index.mjs:5529-5541`), reads the end
back, then moves init's own deadline there with `deadline.extend`, and returns the deadline init took. It is never
earlier than the current end, and never past create's time plus the cap, the maximum init was given; a refusal moves
nothing. E2B's timer is asked for whole seconds, rounded down at the cap, so it never passes the cap by this machine's
clock; init's deadline is E2B's end up to the cap. When no whole number of seconds inside the cap reaches the deadline
held now (init's, or E2B's own end as `getInfo` reads it), extend is refused as `limit` and moves nothing, so E2B's
timer is never pulled under it. When init's move fails after E2B's, the error says E2B's timer moved
and init's did not: the programs end at the old deadline, earlier than asked, never later. A provider runs one extend
of a computer at a time, each reading the deadline the one before it left, so a slow, shorter extend never pulls E2B's
timer under a longer one's (two providers extending one computer at once are not ordered). E2B has no call that
changes metadata, so the deadline label stays as create wrote it, and `list()` and `attach()` report E2B's own end, up
to the cap, once it is more than 2 s past where create set it (its start plus the timeout create gave, by E2B's clock,
to the second E2B rounds to); extend never leaves E2B's end inside those 2 s, moving it at least 3 s past create's end,
so an extend however short reads back.

`stream()` exists only on a provider made with `publicStream` (`COMPUTER_E2B_PUBLIC_STREAM=1`): a private sandbox's
URL needs the `e2b-traffic-access-token` header, which a browser cannot send (E2B docs, network/restrict-public-access),
so a stream URL a person can open needs public traffic, and that opens every port, so such a provider's computers are
network `open` only, and `check()` refuses none in words. `stream()` starts x11vnc on the display, listening on
loopback only and IPv4 alone, with a fresh password from a file only the computer's user reads, and noVNC in front of it, both through
the daemon (the ports and paths are E2B Desktop's own: `@e2b/desktop@2.5.0` `dist/index.mjs:426-506`), and returns
`https://6080-<id>.<domain>/vnc.html?autoconnect=true&resize=scale&password=<password>`. The password is the URL's
only secret beyond the sandbox's id, a bearer token: it is never logged and never in an error (a unit test holds that).
VNC authentication reads 8 characters at most (it keys DES with them), so it is 8 random letters and digits. Each call
starts the stream anew, so an earlier URL stops working: it reads every page of the process table, kills the running
x11vnc and noVNC it finds, waits up to 10 s for each to end (a signal is only sent, and an old server holds its port
until it ends), then starts the new pair, and returns the URL only once both new servers still run and ports 5900 and
6080 both listen; a new server that ended first is an error with its last lines of stderr. `viewOnly` starts x11vnc
with `-viewonly`. E2B's own SDK
leaves x11vnc listening on every interface (`dist/index.mjs:502`); this provider does not.

### What the provider does

- `check(spec)` refuses in words, with no call: no template, a lifetime past the cap (the shared `checkLifetime`), a
  network that is neither none nor open, an allowlist, none with `publicStream`, a label in the provider's namespace,
  `cpus`, `memoryMb` or `pids` (a template's size is its own), `user`, `workdir` and any other field.
- `create` reads the sandbox back with `getInfo` and refuses any drift: the template (its id, or its alias when E2B
  reports one), every label, the network (above), `lifecycle.onTimeout` other than `kill`, `autoResume`, a state that
  is not `running`, and an end that is not E2B's start plus the timeout create gave. Then the daemon: hello (version,
  `linux`, `amd64`, kind and groups), `/proc/self/status` (uid and gid 1000, no groups, `NoNewPrivs` 1, every
  capability set zero), `/proc/self/cwd` (`/work`), `/proc/self/exe`; and for none, the probe. It waits until the label
  listing shows the new computer. A failure, mismatch or abort at any step kills the sandbox and waits for it to go;
  create never returns ok once its signal has aborted.
- `attach({ id })` or `attach({ labels })` reads the spec back from E2B and, for a running computer, the daemon, as at
  create; one that drifts is refused and left as it is. `image` is the template create was asked for, from its label,
  and `snapshot` the id E2B reports.
- `list(labels)` asks E2B for the labels with `agentrun.computer=1` (`Sandbox.list`, running and paused sandboxes,
  `index.d.mts:10289`), every page, and reads each one back with `getInfo` for its network; paused is `stopped`. One
  deadline, `listMs` (60 s) from the call, bounds every page and every read-back, each read's own request bound
  included; past it, `list()` is a timeout in words.
- `connect(ref)` refuses a paused computer without connecting, since E2B's connect resumes one; it gives E2B a timeout
  a little under what is left, and E2B moves a running sandbox's timer only to a longer one (`index.d.mts:10250`), so
  connecting never moves the end.
- `release(ref, "delete")` reads the sandbox back to check it is this provider's, then kills it (`index.mjs:5398-5410`;
  a sandbox E2B no longer has is done), both never signalled, so a release whose signal aborted first still kills;
  then it waits through `waitUntil` until `getInfo` answers not found (`index.mjs:5431`) and the label listing no
  longer shows it, twice running, with pauses doubling from `pollMs` to 5 s, within `goneMs` (120 s) and the caller's
  signal, which ends only this wait.
  `release(ref, "stop")` is refused in words.
- Every SDK call has its own bound and takes the caller's signal; the paginator takes it per page (`Sandbox.list`
  itself takes none, `index.d.mts:10280`).

### Conformance on E2B

```sh
AGENTRUN_COMPUTER_LIVE_E2B=1 COMPUTER_E2B_API_KEY=... npm run conformance -w @parcha/agentrun-computer -- --provider e2b
```

The conformance module, `dist/conformance/e2b.js`, checks `AGENTRUN_COMPUTER_LIVE_E2B=1` before it reads anything
else, then builds the provider through `fromEnv` with every computer capped at 30 minutes, Hobby's plan for conformance
(Hobby caps a sandbox at 1 h; a run that needs more moves to Pro). `conformanceImage()` is `COMPUTER_E2B_TEMPLATE`, else
`desktop` (`base` for kind linux), and `createDriftedProvider()` uploads a daemon built with Go as `<version>-drift`.
`test/e2b/conformance.e2b.test.mjs` runs the suite with `computerd-fixture` built for linux/amd64, and skips unless the
switch and `COMPUTER_E2B_API_KEY` are both set; `E2B_API_KEY` never counts.

`dist/conformance/e2b-sweep.js --before <file>` records every sandbox E2B lists with `agentrun.computer=1`; `--after
<file>` kills every one not in the file, reads each back until `getInfo` no longer finds it and the listing no longer
shows it, up to 60 s each, and prints `{"swept":n,"gone":m,"stillThere":[ids]}`. Exit 0 when every swept sandbox is
gone, 1 when one is still there, 2 on a usage error, an unreadable before file, no key, or a refused listing (nothing is
killed then). It reads `COMPUTER_E2B_API_KEY` and `COMPUTER_E2B_DOMAIN` as the provider does, and needs no live switch.

`fromEnv` reads `COMPUTER_E2B_API_KEY` (required), `COMPUTER_E2B_DOMAIN`, `COMPUTER_E2B_DAEMON`, `COMPUTER_E2B_KIND`,
`COMPUTER_E2B_MAX_LIFETIME_MS`, `COMPUTER_E2B_USER` and `COMPUTER_E2B_PUBLIC_STREAM`.

### What waits for a live run

One live E2B run has been made, the network diagnostic of 2026-11-07 (one sandbox, killed and read back gone); every
other fact above is read from the SDK, envd and the desktop template's source, and the unit tests run against a fake.
A live run must show:

- that `getInfo` reports `allowInternetAccess` or `denyOut`, and `network.allowPublicTraffic: false`, for a sandbox
  made with them: the provider refuses a computer whose read-back lacks them, so a missing field fails every create;
- that `getInfo` reports a template asked for by alias with that alias, or its id (the drift check skips an alias E2B
  does not report);
- that a sandbox with no internet access gets no answer from any probe target, IPv6 included (the one diagnostic read
  the IPv6 target refused and every IPv4 one accepted with 0 bytes), and what else `denyOut 0.0.0.0/0` lets through;
- that envd keeps init running once create disconnects, and how long `getInfo` takes to answer not found after a kill;
- that Xvfb starts as uid 1000 in the desktop template, and the screen and input cases pass against it;
- `endAt` against E2B's start plus the timeout, to the second, and how long the listing takes to show a new sandbox;
- with `publicStream`, that noVNC answers 200 at the URL.

### Sources

`e2b@2.63.0` (npm, `dist/index.mjs` and `dist/index.d.mts`), `@e2b/desktop@2.5.0` (npm, `dist/index.mjs`),
`e2b-dev/desktop@91f23aca` (`template/template.py`), `e2b-dev/infra@ff3922213`
(`packages/orchestrator/pkg/template/build/core/rootfs/files/envd.service.tpl`,
`packages/envd/internal/services/process/start.go`, `.../process/handler/handler.go:395-420`), and E2B's docs
(network/restrict-public-access and network/internet-access, read 2026-11-07). Each is cited where it is used above and in `src/e2b.ts`.

## Conformance

A provider for another vendor passes the same suite as Docker's, with one command. The suite is data: each case in
`src/conformance/cases/` names its level, its group (`health`, `exec`, `files`, `process`, `provider`, `drift`,
`mount`, `screen`, `input`, `touch`, `apps`, `lifetime`) and the capabilities it needs, and uses only `ComputerProvider`,
`ComputerClient` and the suite's assertion helpers, so the same cases run against a provider with daemon `none`.

```sh
npm run conformance -w @parcha/agentrun-computer -- --provider docker            # or modal, daytona: any registry id
npm run conformance -w @parcha/agentrun-computer -- --provider ./my-provider.js [--image debian:bookworm-slim] [--only exec,files] [--fixture <path>] [--json]
```

```text
computer conformance · docker · linux, daemon pid1 · computerd 0.1.0-beta.30 linux/amd64
core health    hello ping unknown-method kind-consistent    ✓ 4
core exec      argv streams exit-code cwd env timeout abort ✓ 11
               truncation setsid-escapee unprivileged user
...
full lifetime  extend                                       - 1
  - lifetime.extend: the provider has no extend()
optional screen screenshot-size                              - 1
  - screen.screenshot-size: the provider does not declare screen
...
core PASS 54/54 · 9 optional cases skipped, not declared · full 10/14 · mount:archil screen stream input.pointer input.keys input.touch apps.install apps apps.ui_tree extend not declared
```

An id is resolved through the provider registry, and only there; the usage lists every id it holds. A module path is
resolved from the directory npm was run in. It exits 0 when Core passes, 1 when it fails, 2 on a
usage error, and 3 on a partial run; `--json` prints the report object (`{ provider, providerVersion, kind,
daemonMode, image, daemon: { version, os, arch }, only?, coreNotRun?, results: [{ id, level, group, status, reason?,
undeclared? }], core, undeclared, cleanup, notes?, computerNotes? }`). A failure is listed under its line with what the
case found. `computerNotes` (`[{ computer, note }]`, absent when empty) holds every note a `create` returned beside its
ref, such as a probe target that accepted and sent nothing back, naming the computer, in the order they came; the text
report prints each as `note <computer>: <words>` above the verdict, so a run that passes Core never hides one. Notes an
`attach` returns are not carried: cases call `attach` on the provider directly, so the runner never sees them.

`--only` that leaves any Core case out is a partial run: `core` is `"partial"` when every case that ran passed (a
skipped Core case is not a pass) and nothing was left behind, else `"fail"`; `coreNotRun` names the Core cases that did
not run, the text report lists them on a `core not run` line, and the verdict reads `core PARTIAL 11/11 · 52 Core cases
not run` (on Docker, `--only health,provider`), never PASS. A partial run exits 3, so a script that checks for 0 never takes a subset for a Core pass. An
`--only` that names every Core case is a whole run, and can pass.

What a module given by path implements: either a provider file's `fromEnv()` (see
[Adding a computer](#adding-a-computer)), run with no drifted provider, or a conformance module's:

- `export function createProvider()` returning a `ComputerProvider` (sync or async): `id`, `version`,
  `capabilities()`, `check`, `create`, `attach`, `list`, `network`, `connect` and `release`, as in `src/provider.ts`.
  `connect` hands out a connection whose daemon answers the methods in `src/protocol.ts`.
- `export function createDriftedProvider()`, for the drift case: the same provider with a daemon that reports a version
  other than `version`. A computer of that daemon must never be handed out: `create` refuses it (and deletes it), or
  `connect` refuses it. Without this export the case is skipped, so Core does not pass.
- `export function mountFor(kind)`, for the mount cases: a fresh run folder for a mount kind the provider declares
  (`RunFolder`: `{ mount, read(path), write(path, data), close() }`), with its outside, where no computer runs: the
  folder on the host for a bind, the disk's file API for Archil. `undefined` for a kind it cannot make. The runner
  closes each folder when its case ends. `--provider docker` gives a bind of a new folder under the temp directory,
  owned by the provider's user. Without this export the mount cases skip in words.

Core and Full follow the Kubernetes agent-sandbox conformance levels (KEP-539.2):

- **Core** is what every computer of its kind does; for a linux computer: hello and ping, `exec.run` as a user other than root with no capability in
  any set and `no_new_privs` (`CapEff`, `CapPrm`, `CapInh`, `CapBnd` and `CapAmb` all zero and `NoNewPrivs` 1 in
  `/proc/self/status`, a field not reported failing; the run's spec asks for no user), a HOME that user owns and writes while `/` refuses it, the
  `files.*` and `tar.*` methods, the `process.*` methods, a computer with network `none` (`network:none`: a provider
  that cannot make one fails Core, and the suite never asks for a wider network instead), `check`, `create`, `attach`
  (with the spec it reads back: the network and image create asked for, and a non-root `user` as `uid:gid`), `list`,
  `network` read-back and `release`, `release(ref, "stop")` as declared (a provider whose `capabilities().release` holds
  `"stop"` lists the computer stopped until it is deleted, or, when it also declares `stopDeletes`, leaves it neither
  listed nor attachable; one that does not refuses stop as `unsupported`, in words, and the computer stays listed and
  running), a change to a network the provider does not declare refused with the
  network unchanged (Core asks for no network the provider could give), a computer that does not run past its deadline
  (after a sweep, for a janitor provider), and the drift checks. Core passes when every Core case passes and the run leaves no computer
  behind.
- **Core by kind.** `coreGroups(kind, daemon)` is what a computer of its kind must declare (the table in
  [The protocol extension](#the-protocol-extension-kind-daemon-modes-screen-input-apps-lifetime)): exec, files,
  processes and network `none` wherever computerd runs, screen and keyboard and pointer on a desktop, screen and touch
  on a phone. `health.kind-consistent` checks the kind, os and daemon pair, that hello's kind and groups are the
  provider's, and that kind's Core groups are declared; `provider.check-refuses` also asks `check` for
  `maxLifetimeMs + 1`. Where the kind makes them Core: `screen.screenshot-size` (every pixel of the PNG decodes, its
  IHDR size is `width` x `height`, `scale` is above 0, a region shot decodes and has the region's size, and on a
  desktop the fixture's four colors are where it paints them; the suite reads 8-bit, non-interlaced PNGs of at most
  16384 pixels a side and 2^25 pixels, and inflates no more than their IHDR gives), `input.click-lands` (a single and a double click show in the fixture's log at their
  point, with their count), `input.type-text` (`Hello, agentrun! 123` arrives exactly),
  `input.key-table-refuses-unknown` (a batch whose second action names `Hyper_Q` gives `done` 0, `failed.index` 1,
  kind `invalid`, and runs nothing), `input.actions-stops-at-first-failure` (move, left button down, move off the screen,
  click: `done` 2, the press released where it was, no click, and a later click lands, so nothing was left held), `touch.tap` and `touch.swipe` (the
  fixture app logs the tap at its point, and the swipe's start and end), `apps.install-launch` (installed, listed, in
  front when launched and not when terminated) and `apps.ui-tree-shape` (every node typed as the protocol says, inside
  the screenshot, with the fixture's button found by its id and text).
- **Full** is each optional capability a provider declares: network `open` (`network:open`), a network allowlist
  (`network:allow`), each with a change of a computer's network to it and back to `none`, refused or applied
  truthfully, on a computer of the case's own (`provider.network-switch`, `provider.network-switch-allow`), the janitor for a provider whose lifetime is `"janitor"` and that stops computers and keeps them
  (`lifetime:janitor`, `release:stop`, and no `stopDeletes`), a takeover by label (`provider.release-older`, which
  needs nothing declared: computers of one run at epochs 1, 2 and 3 and one of another run at epoch 1 carry and read
  back `agentrun.run` and `agentrun.epoch`; `releaseOlder` at epoch 3 deletes 1 and 2 and keeps 3 and the other run's,
  by id and by label; at epoch 2 after it, it is refused as fenced and deletes nothing), and a spec that
  asks for root (`user:root`, from `capabilities().user` holding `"root"`) or another uid (`user:uid`), still with no
  capability in any set and `no_new_privs`, read as in Core; and from the extension `touch.pinch` (two fingers logged
  moving apart), `lifetime.extend` (`extend`: made with 45 s and extended to 120 s, at 60 s it answers ping with a
  process started earlier still running and `list()` shows the new deadline; three extends are refused with the
  deadline unchanged: to an earlier deadline, to maxLifetimeMs + 1, and, 60 s after create, to maxLifetimeMs less 30 s,
  within the cap on its own but past create + maxLifetimeMs; a cap under 3 min skips it) and `screen.stream`
  (`stream`: an https URL that answers 200; only its origin is ever reported).
- **The mount group is Full**, optional for every kind until the cutover decides. "Mounts the run's folder",
  `mount.run-folder-bind` and `mount.run-folder-archil` (`mount:bind`, `mount:archil`, from `capabilities().mount`):
  on a computer of its own made with the run folder `mountFor(kind)` gives, `check` takes the spec, `attach` and `list`
  read the mount back as asked (`readBackOf`), a file written outside is read at `/workspace` with `files.read`, one
  `files.write` makes there is read outside, and `cat <file>` run through `exec.run` with `cwd: "/workspace"` prints
  it. For Archil, no read-back holds the token. `mount.undeclared-kind`: each kind the provider does not declare is
  refused by `check` with `field: "mount"` in words, and by `create` with `check`'s words, before any vendor call, with
  the token in no refusal; a provider that declares every kind skips it.

A case needs groups (declared by both `capabilities().groups` and hello), networks, the janitor, a user, a mount kind, or an optional
provider method (`extend`, `stream`, declared by being there). When a Core case needs what its kind requires and the
provider or the computer lacks it, the case fails in words: `a desktop computer with daemon pid1 must declare screen:
the provider does not declare screen`. Any other need that is not declared skips the case with the reason, never
fails it, and names it in `undeclared`; a Core case skipped so is not Core for this kind of computer: the report lists
it under `optional`, never under `core`, it is out of Core's count, and the verdict says how many (`9 optional cases
skipped, not declared`). Any other skip of a Core case (no fixture given, no way to observe a touch)
is not a pass, so Core does not pass.

The cases that check what input did read a fixture's own log, with no model. `--fixture <path>` (`fixture` from code)
names it: `computerd-fixture` for a desktop, a test-only static binary the case writes with `files.write` and starts
with `process.start` (`--log <path>`), a 200x200 override-redirect window at (0, 0) in four colors (red, green, blue,
yellow, clockwise from top left) that grabs focus; or the fixture APK for an Android phone (`ai.agentrun.fixture`,
installed with `apps.install` and launched, logging to its files directory, with a button
`ai.agentrun.fixture:id/button` that reads `agentrun fixture`). Each event is one JSON line (`ready`, `down`/`up` with
button and point, `wheel`, `key`, `text`, `touch` with finger and phase); `src/conformance/fixture.ts` is the
contract. A case that needs it and was given none skips, so Core cannot pass on a desktop or phone without it. The
fixture is stopped when its case ends, once launched, even when it never logged ready. A phone that declares neither files nor `apps.ui_tree` skips the touch cases:
`no way to observe the effect: declare files or apps.ui_tree`.

The suite makes every computer with the label `agentrun.conformance=<run id>`, image `--image`, a 30-minute lifetime
and network `none` (`open` for a phone that declares no `none`, since its kind does not require it). It deletes each computer a case made when the case ends, and the shared one at the end; for a
provider with lifetime `"janitor"` it then sweeps that label, and it lists the label to show nothing is left. A case
that runs past 3 minutes fails and its computers are deleted. Every provider call is bounded: a create or connect for
the shared computer that does not answer within 3 minutes fails the cases that need it, a release, sweep or list
that does not answer within a minute is named in `cleanup.errors`, and a computer or connection that arrives after
its case ended is deleted or closed as it arrives and named in `cleanup.late`; the run waits, bounded, for every
create a case started, a refused one included, so a late computer is deleted before the report returns. A call still
pending when that bound (a minute) runs out is named in `cleanup.errors`, since what it makes may be left, and Core
fails, as it does for a computer left behind. A case calls
`t.create(extra)` for a computer it needs, or `t.attempt(spec, by?)` for create's result as it is (a refusal it
expects, or the drifted provider's computer). With `--provider docker` and no
`COMPUTER_DOCKER_DAEMON`, a `docker version` that does not answer within 30 s is killed and the run fails, naming the call. The CLI exits once the report
is out. Cases do not assume root: the suite assumes only that the
computer's `HOME`, which the provider sets, is a directory its user can write, and works under
`$HOME/agentrun-conformance-<run id>`.

From code: `runConformance(provider, { image, only?, signal?, drifted?, mountFor?, caseTimeoutMs?, cleanupTimeoutMs?,
fixture?, fetch? })` returns the report, and `formatReport(report)` the text above.

## Adding a computer

A new computer is one provider file and one registry line. The conformance CLI (and serve, once wired) resolves
providers through the registry, `src/providers.ts`, and nothing else, so neither needs an edit:

```ts
export const providers = {
	docker: () => import("./docker.js"),
	modal: () => import("./modal.js"),
	daytona: () => import("./daytona.js"),
	e2b: () => import("./e2b.js"),
	fly: () => import("./fly.js"), // a new computer's line
} satisfies Record<string, () => Promise<ProviderModule>>;
```

Each import is lazy: loading the registry loads no provider and no vendor SDK. `providerFromEnv(id, env?)` builds a
provider by id and refuses an id it does not hold, naming the ones it does. The provider file, `src/<vendor>.ts`,
exports what a `ProviderModule` is:

- the provider class, which implements `ComputerProvider` and reports the registry id as its `id`;
- `ENV`, every variable it reads by role, each named `COMPUTER_<ID>_*`: never a vendor's bare variable such as
  `DAYTONA_API_KEY`, which on a shared host may hold another account's key, not even as a fallback;
- `fromEnv(env = process.env, options?)`, the provider built from those variables alone, the key read only then, and
  refused in words when one is missing or wrong;
- optionally `conformance`, `() => import("./conformance/<vendor>.js")`: a module that bounds a conformance run's
  computers and makes the drifted provider (`createProvider()`, `createDriftedProvider()`, `conformanceImage()`,
  `conformanceNotes`), building them through `fromEnv`. Without it the CLI runs `fromEnv`'s provider, and the drift
  case skips, so Core does not pass.

Docker reads `COMPUTER_DOCKER_DAEMON` (default this package's daemon for Docker's architecture, from `docker version`)
and `COMPUTER_DOCKER_USER`; Modal, Daytona and E2B read the names in their sections. `test/providers.test.mjs` holds every
provider file to its registry line and its line to this shape, and checks that the CLI's usage names every id. Run the
suite on the new computer, by path before its line exists and by id after:

```sh
npm run conformance -w @parcha/agentrun-computer -- --provider ./packages/computer/dist/fly.js
npm run conformance -w @parcha/agentrun-computer -- --provider fly
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
AGENTRUN_COMPUTER_LIVE_DAYTONA=1 COMPUTER_DAYTONA_API_KEY=... [COMPUTER_DAYTONA_SNAPSHOT=<snapshot>] npm run test:daytona -w @parcha/agentrun-computer
AGENTRUN_COMPUTER_LIVE_MODAL=1 npm run test:modal -w @parcha/agentrun-computer   # also needs COMPUTER_MODAL_TOKEN_ID/SECRET, a key the lead OKed
AGENTRUN_COMPUTER_LIVE_E2B=1 npm run test:e2b -w @parcha/agentrun-computer       # also needs COMPUTER_E2B_API_KEY, a key the lead OKed, and the e2b package
```

Where Xvfb is on PATH, the Go tests also run the X client, and screen and input against the fixture, on a real X
server; elsewhere those tests skip in words and the fake X server's tests still run.

The live tests run the conformance suite on Docker, one test per case, on a plain computer and on a desktop built from
`test/fixtures/desktop/Dockerfile` with `computerd-fixture` built from `daemon/cmd/fixture`, and the CLI against
`alpine:3.20`; the rest of
them check what only Docker shows (the user, sizes, tmpfs mounts and hardening flags in `docker inspect`, the daemon
mount, the socket directory, hello's arch against Docker's, `/work` as the user's home, the daemon's exit 0 on `docker
stop` and at its deadline, attach by a container's name). They need Docker, `debian:bookworm-slim`
and `alpine:3.20` pulled, both builds, and Go on PATH (the drift case builds a daemon of another version). They use
the daemon for Docker's own architecture, and remove every container they make by its exact name, pass or fail. One of
them, `test/docker/modal-commands.docker.test.mjs`, runs the Modal provider's entrypoint and upload exactly as sent, in
a Debian and an Alpine root container with no network, and checks that init comes up as uid 1000 with no capabilities
and `no_new_privs`, and answers hello over `computerd stdio`. Those root containers keep Docker's default
capabilities, or every one (`--cap-add ALL`), with no `--cap-drop`, as Modal runs them: with `--user 0:0` and
`--user 1000:1000`, `exec.run` reads every thread of init and its own status with all five sets zero and
`NoNewPrivs` 1, and a root container without CAP_SETPCAP has init refuse to start, in words.
`test/docker/e2b-commands.docker.test.mjs` runs the E2B provider's install, init and bridge as sent, in a root
container of the desktop fixture's image, starts Xvfb through the daemon on the display init was given and waits for
hello to declare the screen, and checks that `deadline.extend` moves up to `--max-deadline` and no further. The
programs the daemon starts get no `DISPLAY` of init's (it passes on only PATH, HOME, USER and LOGNAME): a caller that
starts a GUI program gives it `DISPLAY` in the request's `env`, on E2B as on Docker.

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
