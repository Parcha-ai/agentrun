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
that its provider enforces, so a host that dies does not leave boxes behind. A program in a box never receives the
host process's environment.

| Provider | Import | Isolation |
| --- | --- | --- |
| This machine | `@parcha/pi-transport/box/local` | none: for development and tests |
| Docker | `@parcha/pi-transport/box/docker` | a container per box |

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
- Every call to the box has a deadline. A box that ended or stopped answering is a tool error on that call and on
  every later one, with the reason in the message. It is never a hang.
- A command runs as a process group of its own. A timeout or an abort kills the whole group with a second exec, also
  on a box whose provider cannot stop a program it started.
- Results match pi's `NodeExecutionEnv` on the same files: the same values and the same error codes. Messages differ.
  The suite checks this with pi's own environment conformance cases and with random operation sequences run against
  both.
- The environment's id is `pi-transport:<provider>:<box id>`. `~` is the box's home directory.

What a box must have: a POSIX `sh`, and the GNU versions of `find`, `mv`, `mktemp`, `realpath`, `sleep` and `truncate`
with `setsid` (coreutils, findutils and util-linux, as in Debian and Ubuntu images). An image built on BusyBox does
not have them. A string command runs in `bash` when the box has it, else in `sh`.

Where it differs from `NodeExecutionEnv`, on purpose:

- A command with no timeout of its own gets `maxExecMs`, 30 minutes by default. Node sets no deadline.
- A command that is stopped is asked to end first and killed a second later. Node kills at once.
- With `inheritEnv: false` a command still has a default `PATH`.
- A rename across file systems succeeds, because `mv` copies.
- `listDir` returns a name that is not UTF-8 with the replacement character. Node fails the whole listing.
- A watcher polls, so its `mode` is `polling`.

Not covered by hands: MCP servers, code mode and model calls stay with the Harness.

## Writing a provider

Fill `BoxProvider` and `Box`, then run the conformance suite against real boxes:

```ts
import { describe, expect, it } from "vitest";
import { registerBoxConformance } from "@parcha/pi-transport/testing";

registerBoxConformance({ describe, expect, it }, "my boxes", (use) => use(myBoxes()));
```

A box whose `exec` carries input and streams output can take `uploadByExec` and `downloadByExec` as its file calls.
