# The AgentRun computer protocol

Draft. Protocol version **0.2**, the wire as `packages/computer` speaks it today.

A computer is anything an agent can run commands on or look at: a container, a microVM, a VM, a desktop, a phone, a
browser. The protocol lets any vendor's computers, and a machine of your own, be given to an agent the same way. It has
two layers:

- **The computer's methods.** JSON-RPC 2.0, one JSON object per line. `exec.run`, `files.*`, `process.*`, `screen.*`,
  `input.actions`, `apps.*`, `ui.observe`, `ui.act` and a few more answer for the computer. Inside most computers a small daemon, `computerd`,
  answers them over its stdin and stdout. A phone or a browser has no daemon: its provider answers the same methods
  itself.
- **The provider.** One per vendor. It makes, finds and ends computers, reads their network back, and opens the
  connection the methods go over. It declares what its computers can do before any is made, and each computer's `hello`
  says the same.

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

The two generated files come from `packages/computer/src/protocol.ts` by `node scripts/generate-computer-spec.mjs`. A
test runs it with `--check`, so the published wire cannot drift from the code. Where a document and a generated file
disagree, the generated file is right, and the document is a bug.

## Versioning

`hello` carries `protocol`, the version of this protocol, apart from the daemon's own `version`.

The rule is exact match. A provider hands out a computer only when its `hello` names the provider's protocol version
and the provider's own daemon version, character for character: a 0.3 daemon is refused by a 0.2 provider, a 0.1
daemon too, and so is a `hello` that names no protocol. There is no additive step a caller may skip over.

Why: AgentRun ships the daemon with the provider. `@parcha/agentrun-computer` carries `computerd` for each
architecture in its own package, stamped with the package's version, and the provider puts that binary in every
computer it makes. A daemon of any other version is one the provider did not put there, so the rule never refuses a
computer the provider made right, and it never has to guess which methods an older or newer daemon has.

An attached driver, an app a person installs on their own device, is the one exception: the provider cannot replace
it, so only the protocol version must match, and any build of that version is accepted ([`attach.md`](attach.md#versions)).

Each protocol version's notes say what changed in it.

**0.2** adds the `ui` group (`ui.observe`, `ui.act`), `hello.screen` and `hello.features`, the error kind `stale`,
`apps.launch`'s `url` and `background`, and the limits the new methods need. Its one break: the `apps.ui_tree` group and
method are gone, replaced by `ui`.

## Proving it: conformance

`packages/computer` ships the conformance suite: one command runs every case against a provider, a vendor's included,
and reports Core and Full per kind (see [`kinds.md`](kinds.md#levels-core-and-full)).

```sh
npm run conformance -w @parcha/agentrun-computer -- --provider ./my-provider.js --kind sandbox
```

The suite holds the wire to what this spec says. Among its contract cases:
- **`health.declared`:** a provider's descriptor, its `capabilities()` and each computer's `hello` agree, and `hello`
  carries this protocol version.
- **`health.no-key-in-errors`:** a provider built with planted keys answers every refusal path with none of them in its
  words.
- **`screen.watch`:** a computer with a screen gives its live view.

## Status

- The wire, the stdio binding, kinds, groups and levels are what the providers in `packages/computer` run today: Docker,
  Modal, Daytona and E2B sandboxes, Orgo and E2B desktops, an Android phone, and Browserbase and Kernel browsers.
- The descriptor and the single `vendor` error code (in [`provider.md`](provider.md#the-descriptor)) are written from
  their types, which land with the provider contract's next change. Until then a provider declares itself by its
  module's `CAPABILITIES` and the kind registry's entry.
- Persistence (`capabilities().persistence`, `spec.owner`) and the zero-dependency protocol package are named and
  marked **draft**: their shapes may change before they land.
- The `ui` group runs on the Android phone over adb (through `UiEngine`) and on the fake ui driver. Computerd on macOS
  and phoned on Android, its native drivers, are being built against it.
- The attach binding ([`attach.md`](attach.md)), where a driver dials the server so a machine needs no inbound port, is
  **draft**: the provider's side is written and tested, and serve's routes are not built yet.
