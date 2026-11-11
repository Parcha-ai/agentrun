# The AgentRun computer protocol

Draft. Protocol version **0.1**, the wire as `packages/computer` speaks it today.

A computer is anything an agent can run commands on or look at: a container, a microVM, a VM, a desktop, a phone, a
browser. The protocol lets any vendor's computers, and a machine of your own, be given to an agent the same way. It has
two layers:

- **The computer's methods.** JSON-RPC 2.0, one JSON object per line. `exec.run`, `files.*`, `process.*`, `screen.*`,
  `input.actions`, `apps.*` and a few more answer for the computer. Inside most computers a small daemon, `computerd`,
  answers them over its stdin and stdout. A phone or a browser has no daemon: its provider answers the same methods
  itself.
- **The provider.** One per vendor. It makes, finds and ends computers, reads their network back, and opens the
  connection the methods go over. It declares what its computers can do before any is made, and each computer's `hello`
  says the same.

## Files

| File | What it holds |
| --- | --- |
| [`wire.md`](wire.md) | The methods, `hello` and the protocol version, errors, cancellation, and the limits. |
| [`stdio.md`](stdio.md) | The stdio binding: how the methods travel to and from `computerd`. |
| [`kinds.md`](kinds.md) | Kinds, operating systems and daemon modes; groups; the Core and Full levels. |
| [`provider.md`](provider.md) | The provider contract: what a vendor implements, and the descriptor it declares itself by. |
| [`schema/methods.schema.json`](schema/methods.schema.json) | Each method's params and result, as JSON Schema. Generated. |
| [`protocol.json`](protocol.json) | The protocol version, the limits, the JSON-RPC codes, the groups and the key table. Generated. |

The two generated files come from `packages/computer/src/protocol.ts` by `node scripts/generate-computer-spec.mjs`. A
test runs it with `--check`, so the published wire cannot drift from the code. Where a document and a generated file
disagree, the generated file is right, and the document is a bug.

## Versioning

`hello` carries `protocol`, the version of this protocol, apart from the daemon's own `version`.

- A **minor** step adds: a method, an optional field, a group, an error kind a caller may not have seen. A caller that
  speaks 0.1 keeps working against 0.2: it never calls what it does not know, and it ignores result fields it does not
  know.
- A **major** step changes or removes.
- A provider refuses a computer whose `hello` names another protocol version than its own, as it refuses a daemon of
  another version.

Until 1.0, a minor step may still change something a draft got wrong. Each such change is named in the step's notes.

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
- An outbound binding, where `computerd` dials the server so a machine needs no inbound port, is planned and is not
  part of 0.1.
