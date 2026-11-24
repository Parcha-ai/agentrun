# The AgentRun computer protocol

Protocol version **0.2**. This page is for an engineer at a sandbox, VM or desktop company who has never seen AgentRun.
It says what the protocol is, why it's built the way it is, which providers run it today, and where we'd like your
feedback.

## What it is

[AgentRun](../../README.md) runs AI agents, and an agent often needs a computer: a sandbox to run code in, a desktop to
click through, a phone or a browser. The computer protocol puts every one of those behind one wire. Inside the machine
runs a small daemon, `computerd`. It answers JSON-RPC methods (`exec.run`, `files.*`, `process.*`, `screen.*`,
`input.actions`, `apps.*`, `ui.*`) over its stdin and stdout. Outside the machine, each vendor has a small
`MachineHost`: eleven members that create, read, list and delete the vendor's machines, and start one process in a
machine. AgentRun does the rest through that one process. It installs the daemon, talks to it over that process's
stdin and stdout, enforces deadlines, makes create safe to retry, and sweeps up leftovers. A phone or a browser has no
daemon, so its provider answers the same methods itself.

```
 agent ──► AgentRun ──► provider (MachineHost: create, get, list, delete, exec, …) ──► your API
                │                                                                 │
                └──────── JSON-RPC over one exec's stdin/stdout ──────► computerd (inside the machine)
```

## Why it's built this way

Each choice below cost us something, and we say what.

- **A daemon inside the machine, not each vendor's API.** Files, processes, the screen and input work the same on
  every vendor because one program implements them. A vendor writes the machine's lifecycle and one exec, nothing
  else. *What it costs:* each create uploads the daemon binary and checks its sha256, and the vendor must start a process as
  root in a Linux machine.
- **The daemon's version matches exactly.** AgentRun ships `computerd` inside its own npm package and puts that
  binary in every machine it makes. A computer whose `hello` names another protocol or daemon version is never handed
  out, so nothing ever has to guess which methods a daemon has. *What it costs:* no mixed versions during a rollout.
  The one exception is a driver a person installs on their own device (a Mac, a phone), where only the protocol must
  match ([`attach.md`](attach.md)).
- **Exec keeps text intact, two-way and live.** The whole protocol rides one exec stream for the computer's whole life:
  UTF-8 text both ways, stdin open, output as it's written, and no timeout on a silent process. A text-only exec in
  split calls fits through `framedExec`. *What it costs:* a vendor whose exec runs a command and returns its output at
  the end (a one-shot REST exec) can't plug in today.
  There's a pre-check for this ([`provider.md`](provider.md#a-hosted-vendors-exec)).
- **Isolation is read from inside, never taken on trust.** The agent's programs run as a non-root user, in a network
  namespace of their own. On hosted vendors today that namespace has loopback alone. After every create, `computerd`
  probes from inside that nothing answers. The vendor's own agent ports and its session sockets are declared, and the
  agent's programs can't reach them. *What it costs:* agent programs on hosted vendors get no network yet. An
  allowlist runs only where we enforce it ourselves: Docker, through our egress proxy, and Local Chrome.
- **The listing finds; `get` answers.** Vendor list endpoints lag: we've seen a killed sandbox still listed, and an
  extended machine listed with its old end. So AgentRun takes only ids from `list` and reads each machine with
  `get`, and a delete is done when `get` answers "none" twice running. *What it costs:* more API calls.
- **Create is idempotent by name.** A machine is named `computer-` plus 12 hex digits of the request id's hash, so a
  retried create finds the machine it already made. Of two that raced, the oldest is kept.
- **Errors are a closed set of codes,** with the vendor's own words carried through and never a key in a message.
  A conformance case plants keys to check.

## Providers today

| Provider | Kinds | Isolation | Agent network | Run folder mount | GPU | Keeps state |
|---|---|---|---|---|---|---|
| Docker (local) | sandbox, Linux desktop | container | none, open, allowlist | bind | – | – |
| E2B | sandbox, Linux desktop | microVM | none | Archil, synced | – | – |
| Modal | sandbox | VM (gVisor with a GPU) | none | Archil, synced (synced alone with a GPU) | T4 to B300, up to 8 | – |
| Daytona | sandbox | container, or VM | none | synced | H100 ×1 | – |
| Agent37 | sandbox, Linux desktop | gVisor or VM | none | Archil, synced | – | – |
| Orgo | Linux desktop | VM | none | – | – | yes, resumes |
| Phone harness | Android phone | VM | open | – | – | – |
| Browserbase, Kernel | browser (CDP, live view) | the vendor's | open | – | – | – |
| Local Chrome | browser (CDP) | the host | open, allowlist | – | – | – |
| boxd | sandbox, Linux desktop | microVM | none | synced | – | – |

A synced folder is a plain `/workspace` the runner fills before the agent's tools run and reads back after each call
that may change it, over the computer's own file and exec calls: no FUSE, so a GPU host takes one too.

Every row is declared in `packages/computer/src/descriptors/`, and the conformance suite holds each provider to
its declaration. A Mac or an Android phone of your own can also attach with its own driver
([`attach.md`](attach.md), draft).

## Open questions: we'd love your feedback

1. **Snapshots and resume.** Orgo keeps a desktop's disk and resumes it, and every other provider deletes the machine
   at the end of a run. Our shape is `persistence: { keepsState, resume }`. Is that enough to describe your snapshots,
   your pause and resume, and a fork?
2. **GPUs and FUSE.** We mount the agent's run folder with a FUSE client (Archil). Modal's GPU runtime (gVisor) isn't
   proven with it, and Daytona's GPU hosts have no `/dev/fuse`, so those take the synced folder, which copies what
   changed after each call. Should a GPU machine expose FUSE, or is a synced folder the way storage should reach it?
3. **Egress policy.** Agent programs on hosted vendors get no network today, because we can't verify an allowlist from
   outside. How would you want an allowlist expressed, so you can enforce it and we can check it from inside?
4. **Desktop streaming.** We stream a desktop's screen through `computerd` (`screen.watch`: frames, then input). Some
   vendors have their own live stream. Which should be the default, and what latency and frame rate do you see on
   yours?
5. **What a vendor should expose.** We need two things: a streaming, two-way exec, and a list by label. We'd also like
   a get by name, a deadline you enforce, and a way to register a public OCI image as a template. What's missing, and
   what's hard for you?
6. **One image for every vendor.** We publish one public image (`ghcr.io/parcha-ai/agentrun-box`) and register it per
   account: an E2B public template, Modal from the registry, an Agent37 template from an `image_ref`. Does your API
   take a public OCI image directly?

Tell us in [an issue](https://github.com/Parcha-ai/agentrun/issues).

## Read next

- [`PROVIDERS.md`](../../packages/computer/PROVIDERS.md): add your machines in one pull request, starting with a
  30-minute path.
- [`provider.md`](provider.md): the provider contract and the descriptor.
- [`wire.md`](wire.md): the methods, `hello`, errors and limits. [`stdio.md`](stdio.md) is how they travel to
  `computerd`. [`kinds.md`](kinds.md) covers kinds, groups and the Core and Full levels.
- The conformance kit: `npm run conformance -w @parcha/agentrun-computer -- --provider <id | ./module.js>`, in
  [`packages/computer`](../../packages/computer/README.md#conformance).

## Files

| File | What it holds |
| --- | --- |
| [`wire.md`](wire.md) | The methods, `hello` and the protocol version, errors, cancellation, the limits, and the `ui` group's rules. |
| [`stdio.md`](stdio.md) | The stdio binding: how the methods travel to and from `computerd`. |
| [`attach.md`](attach.md) | The attach binding: a driver dials the server over a WebSocket, with a token it got by pairing. Draft. |
| [`kinds.md`](kinds.md) | Kinds, operating systems and daemon modes; groups; the Core and Full levels. |
| [`provider.md`](provider.md) | The provider contract: what a vendor implements, and the descriptor it declares itself by. |
| [`schema/methods.schema.json`](schema/methods.schema.json) | Each method's params and result, as JSON Schema. Generated. |
| [`protocol.json`](protocol.json) | The protocol version, the limits, the JSON-RPC codes, the groups and the key table. Generated. |

`node scripts/generate-computer-spec.mjs` generates both from `packages/computer/src/protocol.ts`. A test runs it with
`--check`, so the published wire can't drift from the code. Where a document and a generated file disagree, the
generated file is right, and the document is the bug.

## Versioning

`hello` carries `protocol`, this protocol's version, apart from the daemon's own `version`. A protocol version is
`<major>.<minor>`. Two sides work together when the majors match, whatever the minors: a minor step only adds (a method,
an optional field, a group), and `hello`'s groups and features say what each side has. Another major, a version of
another shape, or none is refused. The daemon's own version is exact: a provider hands out a computer only when its
`hello` names the provider's daemon version, character for character. AgentRun puts the daemon in every computer, so a
daemon of any other version is one it didn't put there. An attached driver is the one exception: its own version may be
any ([`attach.md`](attach.md#versions)).

**0.2** adds the `ui` group (`ui.observe`, `ui.act`), `hello.screen` and `hello.features`, the error kind `stale`,
`apps.launch`'s `url` and `background`, and the limits the new methods need. Its one break: the `apps.ui_tree` group and
method are gone, replaced by `ui`.

## Conformance

`packages/computer` ships the conformance suite. One command runs every case against a provider, a vendor's own
included, and reports Core and Full per kind ([`kinds.md`](kinds.md#levels-core-and-full)). Among its contract cases:

- **`health.declared`:** a provider's descriptor, its `capabilities()` and each computer's `hello` agree, and `hello`
  carries a protocol version of this one's major ([Versioning](#versioning)).
- **`health.no-key-in-errors`:** a provider built with planted keys answers every refusal path with none of them in its
  words.
- **`screen.watch`:** a computer with a screen gives its live view.

## Status

- The wire, the stdio binding, kinds, groups, levels, the descriptor and persistence are what the providers above run
  today.
- The `ui` group runs on Android, through phoned and over adb, and in `computerd` for macOS.
- The attach binding ([`attach.md`](attach.md)) is a **draft**.
