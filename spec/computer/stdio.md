# The stdio binding

How the methods of [`wire.md`](wire.md) travel to and from `computerd`, the daemon inside a computer. A provider with
daemon `none` (a phone, a browser) answers the same methods in its own process and needs no binding.

## Framing

- One JSON object per line, UTF-8, ended by `\n` (a `\r\n` is read as one too).
- A line holds at most `maxLineBytes` bytes without its newline ([`protocol.json`](protocol.json)). A request over it
  gets an error reply of kind `limit` with the request's `id` when it can be read from the line's start, and the
  connection goes on at the next line. A reply that would be over it is replaced by an error of kind `limit`.
- Both sides write whole lines. Replies may come in any order.
- A line that is not JSON gets an error reply with a null `id`, code `-32700`, kind `invalid`.

## The daemon and its socket

`computerd` runs in two roles:

- **`computerd init`** is the computer's long-lived daemon. It listens on a unix socket, `/run/agentrun/computerd.sock`
  by default, mode 0600, so only the daemon's user can connect. Every connection is served by the same daemon, with one
  process table: a process started on one connection can be read, waited for or signalled from another, and outlives
  the connection that started it.
- **`computerd stdio`** is the bridge a provider runs through the vendor's exec. It connects to init's socket (waiting
  up to 3 s for a computer that has just started) and copies bytes both ways, from its stdin to the socket and from the
  socket to its stdout, until either side ends. It never serves on its own: with no daemon to reach, it says so on
  stderr and exits 1.

So a provider's connection is: the vendor's exec (or terminal, or `docker exec`) runs `computerd stdio` in the
computer, and the provider writes requests to its stdin and reads replies from its stdout.

## How the daemon gets in: the daemon modes

| Mode | Who runs `computerd init` | When init exits |
| --- | --- | --- |
| `pid1` | The computer runs it as its main process (an image's entrypoint). | The computer ends. |
| `child` | The vendor's own agent is the main process; the provider uploads `computerd` and starts init at boot. | The computer goes on; the provider no longer hands it out. |
| `none` | No daemon runs. The provider answers the methods itself (over adb, the vendor's API, CDP). | (no init) |

A provider declares its mode in `capabilities().daemon` (see [`kinds.md`](kinds.md)).

## What init promises the programs it runs

These hold in every mode where init runs, and the conformance suite checks them from inside:

- Every program runs as a user other than root by default, with no capability in any set, and `no_new_privs` set. Init
  drops these itself before it listens, and refuses to start in words when it cannot prove them dropped: a computer
  fails closed.
- With a network of `none`, nothing answers a program, read from inside.
- A program never outlives its run. `exec.run` puts each program under a guard of its own, which ends the program's
  whole process tree when the program ends, times out or is cancelled. A program started by `process.start` lives until
  it ends, it is signalled, or the computer shuts down.
- On shutdown (a signal, or the computer's deadline), init stops taking new programs, sends every program SIGTERM, then
  SIGKILL 5 s later, and exits.
- In `child` mode, where the vendor's own agent runs beside the programs, init moves itself into a network namespace of
  its own, so no program reaches that agent's ports on any address.

## A provider's side of the binding

- Open a connection, call `hello`, and refuse the computer if its `protocol`, `version`, `kind` or `groups` differ from
  what the provider declared. A computer of another version is never handed out.
- Keep each connection's requests and replies matched by `id`. Cancel with `$/cancelRequest`.
- Close the bridge's stdin to end the connection. Requests still running on it are cancelled; processes started on it
  are not.
