# @parcha/pi-transport

**Experimental.** The API changes without notice between releases.

Run a [pi-durable](https://github.com/earendil-works/pi) session's tools in another machine, or move the session
there. This release holds the first layers: the `Box` interface with two providers and a conformance suite, `boxEnv`,
which runs a session's tools in a box, and `transport()`, which sends each conversation's tools to the box its
config names.

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
| Daytona | `@parcha/pi-transport/box/daytona` | a container per box on the host kernel; a `linux-vm` snapshot is a VM |
| Modal | `@parcha/pi-transport/box/modal` | a gVisor sandbox, or a VM (`isolation: "vm"`) |

### Daytona

`daytonaBoxes({ apiKey, snapshot })` talks to the Daytona REST API with `fetch`; there is no SDK, and the key stays in
the host. Daytona sets a box's size with its snapshot, so a spec that names `cpus`, `memoryMb` or `gpu` is refused:
choose the size by naming a snapshot. A box that outlives `maxLifetimeMs` is ended by Daytona (`ttlMinutes`, measured
at about 65 to 70 s for a one-minute lifetime). Daytona's label index trails a create and answers each query shape on
its own schedule, so `list` always asks Daytona for the `pi-transport` label alone and filters the other labels itself,
and `create` returns only once that listing shows the box. A listing therefore pages through every box this package
made in the organization. The default workspace is `/tmp/workspace`. Programs run through the toolbox with their input
and output spooled in `/tmp/pi-transport`, polled about every 150 ms. A default sandbox is a container on the host
kernel (not gVisor); the `vm` class is mapped from a `linux-vm` snapshot but was not verified live in this run (a VM
snapshot could not be created in the test organization), so treat it as untested.

`localBoxes` gives a program a fixed `PATH` (`/usr/local/bin:/usr/bin:/bin`, or the `path` option), a private `HOME`
and `TMPDIR`, and the spec's `env`. A detached watchdog ends a box when its lifetime has passed. On Linux, `destroy`
and the watchdog end every program of the box, also one that went to the background or left its process group. Where
`/proc` is missing they end only the programs the calling process started, and the watchdog removes the directory only.
It refuses `image`, `snapshot`, `cpus`, `memoryMb`, `gpu`, `region` and any `isolation` but `none`.

`dockerBoxes` runs `sleep` for the lifetime in place of the image's own entrypoint, so Docker ends the box. It refuses
`snapshot`, `region` and any `isolation` but `container`. Docker cannot choose a GPU model: any `gpu` gives the
container every GPU of the host.

## Modal

`modalBoxes(sdk, { appName })` takes the host's own Modal client, so this package depends on no Modal SDK. The
client is typed structurally (`ModalSdk`); the `ModalClient` of the `modal` package, version 0.11.0, fits it.

```ts
import { ModalClient } from "modal";
import { modalBoxes } from "@parcha/pi-transport/box/modal";

const provider = modalBoxes(new ModalClient(), { appName: "my-boxes" });
await provider.create({ maxLifetimeMs: 10 * 60_000, isolation: "vm" }, BACKGROUND_CONTEXT);
```

- `isolation: "vm"` starts a VM with its own kernel. `"gvisor"` or no value starts Modal's default sandbox. Any other
  value is refused with `unsupported`.
- `gpu: "T4"` works on the default sandbox only; a GPU with `isolation: "vm"` is refused with `invalid`.
- `maxLifetimeMs` is Modal's own timeout, rounded up to whole seconds and capped at 24 hours. Modal ends the box when
  it passes, whatever happens to the host.
- The live suite spends money and runs only when asked. It needs `MODAL_TOKEN_ID` and `MODAL_TOKEN_SECRET` in the
  environment and the SDK, which is not installed with this package:
  `npm install --no-save modal@0.11.0`, then `npm run test:live:modal -w @parcha/pi-transport`. It names its Modal
  app and labels from `PI_TRANSPORT_LIVE_PREFIX` and `PI_TRANSPORT_LIVE_LABELS`, and `PI_TRANSPORT_LIVE_MODAL_KINDS`
  (`sandbox,vm,gpu`; default `sandbox,vm`) picks the kinds.

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
- Results match pi's `NodeExecutionEnv` on the same files: the same values and the same error codes. Messages differ.
  The suite checks this with pi's own environment conformance cases and with random operation sequences run against
  both.
- The environment's id is `pi-transport:<provider>:<box id>`. `~` is the box's home directory.

What a box must have: a POSIX `sh`, and the GNU versions of `find`, `mv`, `mktemp`, `realpath`, `sleep` and `truncate`
with `setsid` (coreutils, findutils and util-linux, as in Debian and Ubuntu images). An image built on BusyBox does
not have them. A string command runs in `bash` when the box has it, else in `sh`. The environment keeps its
commands' process groups in `.pi-transport` under the box's temporary directory (`TMPDIR`, else `/tmp`).

Where it differs from `NodeExecutionEnv`, on purpose:

- A command that is stopped is asked to end first and killed a second later. Node kills at once.
- With `inheritEnv: false` a command still has a default `PATH`.
- A rename across file systems succeeds, because `mv` copies.
- `listDir` returns a name that is not UTF-8 with the replacement character. Node fails the whole listing.
- A watcher polls, so its `mode` is `polling`.

Not covered by hands: MCP servers, code mode and model calls stay with the Harness.

### Where tools run is a line of config

`transport(config, host)` is a Harness's `env`. It reads the `transport` block of an agent's config and runs each
conversation's tools in the environment the block's `hands` names.

```ts
import { Harness } from "@earendil-works/pi-durable";
import { parseTransportConfig } from "@parcha/pi-transport";
import { dockerBoxes } from "@parcha/pi-transport/box/docker";
import { transport } from "@parcha/pi-transport/hands";

const config = parseTransportConfig({
	environments: { sandbox: { provider: "docker", maxLifetime: "6h" } },
	hands: "sandbox",
});
if (!config.ok) throw config.error;

// The transport is the Harness's `env`, so it is built first and reaches the Harness through this binding.
let harness: Harness;
const hands = transport(config.value, {
	providers: { docker: dockerBoxes() },
	commit: (change, context) => harness.commit(change, context),
});
harness = await Harness.open(storage, { models, registry, env: hands.env }, BACKGROUND_CONTEXT);
```

- **A box is created at the first file operation or command, not before.** pi asks for a conversation's environment
  at every prompt it prepares as well as at every tool call, so `env` returns a lazy environment. Until its box
  exists its `cwd` is `.` and its id ends in `:unopened`. A run that calls no tool creates no box.
- **A host that opens the session again finds its boxes.** A box's id is written to a session document
  (`transport.boxes`) before a tool runs in it, and the next `transport()` on the same store asks the provider for
  that box. Concurrent first uses share one creation.
- **One box for the session, or one for each conversation.** `scope: "session"` is the default; with
  `scope: "conversation"` every conversation gets its own.
- **Roles.** `hands: { default: "sandbox", build: "gpu" }` names a role. `hands.assign(conversation, "build", context)`
  points a conversation's tools at it, or at any declared environment, from its next tool call. The assignment is a
  conversation document (`transport.hands`). A fork starts without one, on the default.
- **A box that is gone is one failed tool call.** A box that cannot be created, or that ended behind the session's
  back, is that call's error result with the provider's code in the message. The next call asks for a box again.
- **Two ways to let boxes go.** `release()` forgets them and leaves them running, for a host that will open the
  session again; a box nobody comes back to ends at its lifetime. `destroy()` ends every box of the session,
  including those only the session's documents still name.
- **`undefined` means the host's own environment.** `env` returns `undefined` when the config names no `hands`, or
  names a `local` environment and the host passed no `local` provider. A host puts its own environment behind it:
  `(await hands.env(target, context)) ?? new NodeExecutionEnv({ cwd })`.

`transport()` throws a `TransportError` at start for a config it cannot serve: an environment whose provider the
host did not pass, `hands: "auto"`, and `expose`.

`expose` is not available yet: no secret is passed into a box. When it is, a secret will travel with each command
over the exec's input and be set in the box by the environment's launcher. It will never be in `BoxSpec.env`, which
a provider may store and return, and never in a command line.

`examples/01-hands.ts` runs one scripted session whose tools go where a config file says:

```sh
node --experimental-strip-types examples/01-hands.ts examples/hands.docker.json 'hostname; pwd'
```

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
