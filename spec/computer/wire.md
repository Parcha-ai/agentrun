# The wire

The methods a computer answers, as [JSON-RPC 2.0](https://www.jsonrpc.org/specification). Each method's params and
result are in [`schema/methods.schema.json`](schema/methods.schema.json); the numbers below are in
[`protocol.json`](protocol.json). Both are generated from the code, and they are the authority where this page is
shorter.

## Methods

A computer answers the methods of the groups it declares (see [`kinds.md`](kinds.md#groups)), and `hello` and `ping`
always.

| Group | Methods |
| --- | --- |
| (always) | `hello`, `ping` |
| `exec` | `exec.run`: one program, from argv (never a shell string), to its end, with its output |
| `files` | `files.read`, `files.write`, `files.stat`, `files.list`, `files.mkdir`, `files.move`, `files.remove`; `tar.pull.begin`, `tar.pull.read`, `tar.pull.end`, `tar.push.begin`, `tar.push.write`, `tar.push.end` |
| `processes` | `process.start`, `process.read`, `process.write`, `process.signal`, `process.resize`, `process.list`, `process.wait`: programs that outlive the call |
| `screen` | `screen.shot`, `screen.read`, `screen.watch` |
| `input.pointer`, `input.keys`, `input.touch` | `input.actions`: a batch of pointer, key and touch actions, each allowed by its group |
| `apps` | `apps.list`, `apps.launch`, `apps.terminate` |
| `apps.install` | `apps.install` |
| `apps.ui_tree` | `apps.ui_tree` |
| (a computer whose daemon keeps its deadline) | `deadline.extend` |
| (a computer with a synced disk mounted) | `mount.sync` |

A method a computer does not have is an error of kind `unsupported`, in words; the connection goes on.

## hello

`hello` is the first call on a connection. Its result says what the computer is:

```json
{"protocol":"0.1","version":"0.1.0-beta.31","os":"linux","kind":"linux","arch":"arm64","groups":["exec","files","processes"]}
```

- `protocol`: the version of this protocol the computer speaks. A caller refuses a computer that speaks another.
- `version`: the daemon's own version, or with daemon `none` the provider's. A provider refuses a daemon of a version
  other than its own (a drifted daemon is never handed out).
- `os`, `kind`, `arch`: what the computer is (see [`kinds.md`](kinds.md)). `arch` is Go's name: `amd64`, `arm64`.
- `groups`: what it offers. It must be what the provider declared for it (`capabilities().groups`). `cdp`, `stream` and
  `downloads` are the provider's and never appear in a daemon's `hello`.
- `display`: a desktop's X display, such as `":99"`; absent elsewhere.

## Requests, replies and order

- Requests run at once. Replies may come in any order: a caller matches each by its `id`.
- A caller sends only the params the schema gives: each method's params object is closed
  (`additionalProperties: false`), a map such as `exec.run`'s `env` holds strings only, and a number is a whole number
  (`integer`) except a scroll's `dx` and `dy` in pixels and a pinch's `scale`.
- `computerd` refuses anything else: an unknown field, or a value of the wrong type, is an error of kind `invalid`. A
  provider that answers the methods in its own process (daemon `none`: a phone, a browser) may ignore an unknown field
  instead, so a caller never relies on that refusal.
- `hello` and `ping` are the exceptions, in the schema and in `computerd`: they take any params and read none. A client
  learns what a computer speaks from `hello`, so a newer client's `hello` is never refused for a field this computer
  doesn't know.
- Bytes travel as base64: `exec.run`'s `stdout` and `stderr`, a file's data, a screen's image.
- Large reads come in chunks of at most `maxChunkBytes`. `files.read` reads a file by offset and length. `screen.shot`
  and `screen.watch` carry an image's first chunk and an `id`, and `screen.read` reads the rest by that id and offset.
  `tar.pull.*` and `tar.push.*` stream an archive by begin, read or write, and end.

## Cancellation

A caller cancels a request with the notification `$/cancelRequest` and params `{"id": <the request's id>}`.

- The request ends with an error of kind `aborted` (JSON-RPC code `-32800`).
- An `exec.run` that is cancelled, or that times out, has its whole process tree ended: a group SIGTERM, then SIGKILL
  2 s later. A timeout is a result with `timedOut: true`, not an error.
- When the input ends, every request still running on that connection is cancelled. A process started by
  `process.start` is not: it outlives the connection.

## Errors

An error reply is JSON-RPC's, with the protocol's kind in `data`:

```json
{"jsonrpc":"2.0","id":7,"error":{"code":-32000,"message":"no such file: /workspace/notes.txt","data":{"kind":"not_found"}}}
```

- `message` is words a person can act on. It never holds a key, a token or a secret.
- `data.kind` is one of `not_found`, `invalid`, `timeout`, `aborted`, `denied`, `limit`, `unsupported`, `exists`,
  `not_dir`, `is_dir` (`errorKinds` in [`protocol.json`](protocol.json)). A caller acts on the kind, never on the
  message.
- `code` follows from the kind:

  | Kind | Code |
  | --- | --- |
  | `invalid` | `-32602` (invalid params) |
  | `aborted` | `-32800` (request cancelled) |
  | `unsupported` for a method the computer does not have | `-32601` (method not found) |
  | a line that is not JSON | `-32700` (parse error), kind `invalid` |
  | a request line over the line limit | `-32600` (invalid request), kind `limit` |
  | every other kind | `-32000` (server error) |

## Limits

Each is in [`protocol.json`](protocol.json)'s `limits`:

| Limit | What it bounds |
| --- | --- |
| `maxLineBytes` | One line, a request or a reply, without its newline. A request over it gets an error reply and the connection goes on; a reply over it is replaced by an error of kind `limit`. |
| `maxOutputBytes` | Each of `exec.run`'s `stdout` and `stderr`. The rest is read and dropped, and `truncated` is true. |
| `maxChunkBytes` | One `files.read` or `tar.pull.read` (more is refused as `limit`), and one chunk of a screen image. In base64 it fits a line. |
| `maxListDepth`, `maxListEntries` | `files.list`'s depth and its entries. |
| `processRingBytes`, `processLogBytes`, `maxProcesses`, `processRetainedBytes` | What a computer keeps of its processes: the last bytes of each stream, read by offset; the first bytes in a log file; how many processes, running or ended; and the output of all of them together, past which the rings of processes that ended first are let go. |
| `maxReadWaitMs` | The longest a `process.read` waits for output. |
| `maxActions`, `maxBatchWaitMs`, `maxKeyRepeat` | One `input.actions` batch: its actions, the durations they add up to, and a key's repeat. |
| `maxUiNodes` | The nodes `apps.ui_tree` returns. |

An `input.actions` batch is checked whole before any action runs: an action of a group the computer does not declare,
or a key not in the key table (`keys` in [`protocol.json`](protocol.json), or one printable character), refuses the
batch with nothing run. A batch that fails partway answers how many actions ran.
