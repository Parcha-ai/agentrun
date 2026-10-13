# @parcha/pi-transport

**Experimental.** The API changes without notice between releases.

Run a [pi-durable](https://github.com/earendil-works/pi) session's tools in another machine, or move the session
there. This release holds the first two layers: the `Box` interface with two providers and a conformance suite, and
`boxEnv`, which runs a session's tools in a box.

## A box

A `Box` is one running machine: a directory on this machine, a container, a sandbox, a VM. A `BoxProvider` creates
boxes, finds them again by id and lists them by label.

```ts
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { finish } from "@parcha/pi-transport";
import { dockerBoxes } from "@parcha/pi-transport/box/docker";

const provider = dockerBoxes();
const created = await provider.create({ maxLifetimeMs: 10 * 60_000 }, BACKGROUND_CONTEXT);
if (!created.ok) throw created.error;
const box = created.value;

const started = await box.exec(["uname", "-a"], undefined, BACKGROUND_CONTEXT);
if (started.ok) console.log(await finish(started.value));
await box.destroy(BACKGROUND_CONTEXT);
```

Expected failures are returned as `Result` values with a `BoxError` and a code. Every box has a maximum lifetime
that its provider enforces with no call from the host, so a host that dies does not leave boxes behind. A program in
a box never receives the host process's environment. A provider refuses a spec field it cannot honour instead of
ignoring it.

| Provider | Import | Isolation |
| --- | --- | --- |
| This machine | `@parcha/pi-transport/box/local` | none: for development and tests |
| Docker | `@parcha/pi-transport/box/docker` | a container per box |

`localBoxes` gives a program a fixed `PATH` (`/usr/local/bin:/usr/bin:/bin`, or the `path` option), a private `HOME`
and `TMPDIR`, and the spec's `env`. A detached watchdog ends a box when its lifetime has passed. On Linux, `destroy`
and the watchdog end every program of the box, also one that went to the background or left its process group. Where
`/proc` is missing they end only the programs the calling process started, and the watchdog removes the directory only.
It refuses `image`, `snapshot`, `cpus`, `memoryMb`, `gpu`, `region` and any `isolation` but `none`.

`dockerBoxes` runs `sleep` for the lifetime in place of the image's own entrypoint, so Docker ends the box. It refuses
`snapshot`, `region` and any `isolation` but `container`. Docker cannot choose a GPU model: any `gpu` gives the
container every GPU of the host.

## Hands: tools run in a box

`boxEnv(box)` is pi's `ExecutionEnv` over a box. Hand it to a pi-durable Harness and the session's `read`, `write`,
`edit` and `bash` tools run in the box, while the session, its store and its model calls stay with the host.

```ts
import { boxEnv } from "@parcha/pi-transport/hands";

const env = boxEnv(box);
const written = await env.writeFile("notes/a.txt", "hello", BACKGROUND_CONTEXT);
const ran = await env.exec("wc -c notes/a.txt", { timeout: 10 }, BACKGROUND_CONTEXT);
```

- Every file operation and every command is one `Box.exec` of a fixed script. Paths are arguments, never part of the
  script.
- Every file operation has a deadline, and so has the start of a command. A box that ended or stopped answering is
  a tool error on that call and on every later one, with the reason in the message. A command runs as long as its
  caller's timeout allows; with none it has no deadline, as in pi's local environment, unless `maxExecMs` sets one.
- A command runs as a process group of its own. A timeout or an abort kills the whole group with a second exec, also
  on a box whose provider cannot stop a program it started.
- The variables a caller asks for, `PATH` included, reach the command alone. The environment's own scripts keep the
  box's search path, so a `PATH` with no shell in it still runs a program named by its path.
- Results match pi's `NodeExecutionEnv` on the same files: the same values and the same error codes. Messages differ.
  The suite checks this with pi's own environment conformance cases and with random operation sequences run against
  both.
- The environment's id is `pi-transport:<provider>:<box id>`. `~` is the box's home directory.

What a box must have: a POSIX `sh`, and the GNU versions of `dd`, `find`, `mv`, `mktemp`, `realpath`, `sleep` and
`truncate` with `setsid` (coreutils, findutils and util-linux, as in Debian and Ubuntu images). An image built on
BusyBox does not have them. A string command runs in `bash` when the box has it, else in `sh`. The environment keeps its
commands' process groups in `.pi-transport` under the box's temporary directory (`TMPDIR`, else `/tmp`).

Where it differs from `NodeExecutionEnv`, on purpose:

- A command that is stopped is asked to end first and killed a second later. Node kills at once.
- With `inheritEnv: false` a command still has a default `PATH`.
- A rename across file systems succeeds, because `mv` copies.
- `listDir` returns a name that is not UTF-8 with the replacement character. Node fails the whole listing.
- A watcher polls, so its `mode` is `polling`.
- `openBinaryReader` and `openTextLineReader` read the file whole when they open it, in one round trip to the box, and
  serve every later read from that copy on the host. A file above `maxReaderBytes` (64 MiB by default) is refused with
  `not_supported` before a byte of it leaves the box; a command (`head`, `tail`, `sed`) reads such a file in parts.
  Node reads the ranges it is asked for. `readTextLines` with `maxLines` brings only those lines out of the box.

Not covered by hands: MCP servers, code mode and model calls stay with the Harness.

## Ownership: one writer per session

`@parcha/pi-transport/home` holds the lease that says which home may write a session. It is a numbered epoch, not a
timer: the epoch changes only when a host takes, so a slow home is never taken over because a clock ran out.

```ts
import { dirStore, leaseIn } from "@parcha/pi-transport/home";

const lease = leaseIn(dirStore("/shared/leases"));
const taken = await lease.take("session-1", { environment: "gpu", provider: "modal", box: "sb-1", host: "h1" }, 0, undefined, BACKGROUND_CONTEXT);
```

- `take(session, holder, expected, details, context)` succeeds only when the session's epoch is `expected` (0 for a
  session nobody took); the new epoch is `expected + 1`. Anything else, including another host that took first, is
  `lost`. `details.move` makes a retried take of the same move return the record it made instead of losing to itself;
  `details.seal` records the sealed store. `current(session)` reads the newest record.
- `leaseIn(store)` works over any `ConditionalStore`: `get`, and `put` with `{ absent: true }` or `{ version }`, which
  must lose with `conflict` when the key is not as the caller saw it. An object store's conditional write, a database
  row or a key with a compare-and-set fits.
- `dirStore(directory)` is that store in a directory, for one machine or a directory several hosts share. A key is a
  directory of numbered files; a write is made whole in a temp file, synced, and linked to the next number with
  `link(2)`, so two writers race for one name and exactly one wins, and a name never holds half a value. The file
  system must support hard links. Old versions are kept. A writer that dies between the temp file and the link leaves
  a `.tmp-` file that nothing reads.
- `registerStoreConformance` (`./testing`) runs the cases every `ConditionalStore` must pass: absent and versioned
  writes, 50 takers of one version with one winner in each of 20 epochs, no read of half a value while takers write,
  every byte value, any text as a key, and, when the store gives a writer that dies, a kill between writing and
  making the value current.

## Writing a provider

Fill `BoxProvider` and `Box`, then run the conformance suite against real boxes:

```ts
import { describe, expect, it } from "vitest";
import { registerBoxConformance } from "@parcha/pi-transport/testing";

registerBoxConformance({ describe, expect, it }, "my boxes", (use) => use(myBoxes()), {
	// One box is left alone for its lifetime. `ended` must ask the vendor's own API, never the provider under test.
	lifetime: { maxLifetimeMs: 60_000, graceMs: 120_000, ended: (box) => myVendorSaysGone(box.id) },
});
```

A box whose `exec` carries input and streams output can take `uploadByExec` and `downloadByExec` as its file calls.
