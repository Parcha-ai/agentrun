# The provider contract

A provider is one vendor's adapter: it makes, finds and ends that vendor's computers, and opens the connection their
methods go over. It never runs a computer's commands itself; the computer's daemon does. With daemon `none` (a phone, a
browser), the provider answers the methods in its own process instead.

The contract is the TypeScript interface `ComputerProvider` in `packages/computer/src/provider.ts`. This page says what
each member promises. The types are the authority for names and shapes.

## Every call answers a result

Every call answers `{ ok: true, value }` or `{ ok: false, error: { code, message, vendor? } }`. An expected failure,
such as a refusal, a computer that is gone or a vendor that said no, is a result, never a throw.
- `message` is words a person can act on. It never holds a key, a token, a secret, or a URL that is a bearer.
- `code` is what a caller acts on: `gone`, `refused`, `timeout`, `aborted`, `not_found`, `invalid`, `unsupported`,
  `denied`, `limit`, `exists`, `not_dir`, `is_dir`, and from `testConnection`, `unauthorized` (the vendor refused the
  key) and `unreachable` (the vendor was not reached).
- `vendor` is the code for a failure the vendor answered with (its API, its CLI, its device). The error's `vendor` field
  then names which vendor: its descriptor's id (`daytona`, `phone-harness`, ...). One code serves every vendor, so a new
  vendor never edits the error type. An error passed up in new words keeps its code, and with code `vendor`, its vendor.
  (This replaces the per-vendor codes `docker`, `daytona`, `modal`, `e2b`, `orgo` and `phone`; it lands with the
  descriptor, below.)

## Members

| Member | Promise |
| --- | --- |
| `id`, `version` | The provider's id (its registry name) and its own version. A computer whose daemon reports another version is never handed out. |
| `capabilities()` | What its computers are and can do, before any is made (below). |
| `check(spec)` | Every way a spec is beyond what it declares, in words, field by field, with no vendor call. `create` refuses the same. |
| `create(spec)` | Makes one computer for `spec`, with a deadline, and answers its ref. The lifetime is required: a computer with no deadline is refused. |
| `attach(ref)` | Finds one computer this provider made, by id or by labels, with its spec read back from the vendor. None or several is an error in words. |
| `list(labels)` | Every computer this provider made that carries all of these labels: the janitor's view. |
| `network(ref, policy?)` | Reads the network back; with a policy, sets it, or refuses in words. Never wider than asked. |
| `connect(ref)` | A connection to the computer, after `hello`. It refuses a `hello` whose protocol, version, kind or groups differ from what it declared. |
| `release(ref, how)` | `delete`, or `stop` where declared; an undeclared `stop` is refused in words, with the computer left as it was. Idempotent: a computer already gone is ok. |
| `extend?` | Moves the deadline later, never earlier, and never past the provider's cap counted from create. |
| `stream?` | A URL that shows the screen live, the vendor's own. |
| `watch?` | The computer's live view: frames, and input on what it answers. A computer with a screen gives it. |
| `sweepLeftovers?` | Removes what its computers left outside themselves, by labels. |
| `testConnection?` | One account-level read with the provider's keys that never creates a computer, so it never spends. |

A computer's spec (`ComputerSpec`):
- `image`;
- `lifetimeMs`, required;
- `network`: `none`, `open` or an allowlist;
- `cpus`, `memoryMb`, `pids`, `labels`, `workdir`;
- `user`: a uid, or `uid:gid`; unset is a non-root default, and root only when asked;
- `mount`: the run's folder, mounted at `/workspace`, of a kind the provider declares;
- `owner` (**draft**): `{ agent }`, the agent a computer that keeps its state belongs to, so a later run of that agent
  finds it again and no other agent does.

## capabilities()

`ComputerCapabilities` declares, before any computer is made:

| Field | What it declares |
| --- | --- |
| `kind`, `os`, `daemon` | What the computers are, and who answers their methods (see [`kinds.md`](kinds.md)). |
| `groups` | What each computer offers; each computer's `hello` repeats it. |
| `lifetime` | Who ends a computer at its deadline: the vendor, or our janitor by label. |
| `maxLifetimeMs` | The longest lifetime it gives: the vendor's hard cap. |
| `network` | The networks it takes: `none`, `open`, `allow`. With `allow`, `allow` says what a list may hold. `networkReadBack` says whether the vendor reads the policy back from outside. |
| `isolation` | `container`, `gvisor`, `microvm`, `vm` or `machine`. |
| `release` | `delete`, and `stop` where a stopped computer is kept; `stopDeletes` where a stop ends in deletion. |
| `user` | What `spec.user` may ask for beyond the non-root default: `root`, another `uid`. |
| `mount` | The kinds of folder a computer can mount at `/workspace`. |
| `vendorAgentPorts` | The ports the vendor's own agent listens on inside the computer. A `child` daemon must declare them. |
| `persistence` (**draft**) | `{ keepsState, resume }`: whether a computer keeps its disk and state past a run, and whether a kept computer can be resumed by a later run. Absent means neither: each computer lives for one run. |

Fields marked **draft** are named but not yet in the types; their shapes may change before they land.

## The descriptor

A provider declares itself once, in a **descriptor** (`ProviderDescriptor`, `packages/computer/src/descriptor.ts`), so
that the server, Settings and the conformance suite all read the same declaration. Every field is data except
`load()`: reading a descriptor loads no provider module and no vendor SDK.

| Field | What it declares |
| --- | --- |
| `id` | Its id in the provider registry and in Settings: lowercase letters, digits and hyphens. Errors with code `vendor` name it. |
| `label` | Its name in words, as Settings shows it. |
| `keys` | The keys Settings takes for it: each a `name` (what Settings stores and shows, such as `DAYTONA_API_KEY`; never a value), the `create()` `option` it fills, and whether it is `required`. `[]` for none. |
| `settings?` | Values that are not keys but fill a `create()` option (Modal's app): `name`, `option`, and a `default` used when the server names none. |
| `metered` | The vendor bills by time. Prices are the vendor's page, not ours. |
| `mounts` | The mount kinds its computers take (`bind`, `archil`), as its providers' `capabilities().mount` declare; `[]` for none. |
| `capabilities` | One entry per configuration it offers: a machine kind and its groups, as each built provider's `capabilities()` declares. At least one. |
| `defaultImage?` | The image a computer of each setting kind starts from when its setting names none. A kind with no entry has no default, and the caller refuses the setting in words. |
| `prepareImage?` | Its providers have `prepareImage()`: the image is built or pulled before the first create. |
| `local?` | Its computers run on this machine's container engine, so the server passes it its local host options. |
| `ledger?` | `{ option }`: `create()` takes a ledger the server keeps for it in that option (the phone harness's sessions). |
| `load()` | Imports the provider module on demand: its `create()` and its conformance module. |

A descriptor module (`packages/computer/src/descriptors/<id>.ts`) builds it with `defineProvider`, which checks it and
throws in words naming each problem: the id's shape, unique non-empty key and setting names and options, a `required`
on each key, a known mount kind, one configuration at least. `descriptorProblems(value)` gives the same checks as a list,
for a descriptor loaded from elsewhere. `DESCRIPTORS` (`descriptors/index.ts`) lists the built-in ones in the order
Settings shows them. The kind registry's `PROVIDERS` and the provider registry are derived from them; nothing else
repeats what a descriptor says.

The provider module takes its `MOUNT` and `CAPABILITIES` from its descriptor and exports `create(options)`, where
`options` holds each key and setting by its `option` name.

The conformance case `health.declared` holds `capabilities()` to the declaration, and `hello` to `capabilities()`.

**Status.** The descriptor lands with the provider contract's next change (branch `computer/cp1-descriptor`). Until it
merges, `PROVIDERS` in `packages/computer/src/kinds.ts` is kept by hand and each module exports its own `CAPABILITIES`
and `MOUNT`; the suite reads `PROVIDERS` either way. After that, the contract types move to a zero-dependency package,
`@parcha/agentrun-computer-protocol` (**draft**), and this spec is generated from there.

## A new vendor

1. A descriptor (`defineProvider`, above) and a provider module: a class implementing `ComputerProvider`, with
   `create(options)`. `create` takes its keys as options and reads no environment. A vendor's own failure is
   `vendorFail(<id>, message)`, or `failFor(<id>)` for every failure the module returns.
2. The daemon in, by its mode: an image with `computerd init` as its entrypoint (`pid1`), `computerd` uploaded and
   started at boot (`child`), or no daemon, with the provider answering the methods itself (`none`).
3. Optionally a conformance module that reads the run's settings from `COMPUTER_<ID>_*` names (`ENV` lists them) and
   builds the provider, its drifted twin (a daemon of another version) and the run's image.
4. Run the suite by path, then by id once it is in the registry:

   ```sh
   npm run conformance -w @parcha/agentrun-computer -- --provider ./dist/my-vendor.js --kind sandbox
   ```

   For the no-key case, the suite builds the provider again from its conformance module with a planted value in each
   `ENV` name that holds a key, token or secret. It then asks every refusal path, about the case's own computer so each
   reaches the vendor, and none of the planted value may come back. A release refused for its key must leave that
   computer where it was.
