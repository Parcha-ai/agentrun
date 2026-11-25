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
  `denied`, `limit`, `exists`, `not_dir`, `is_dir`, `stale`, and from `testConnection`, `unauthorized` (the vendor
  refused the key) and `unreachable` (the vendor was not reached). The set is closed (`ComputerErrorCode`): a provider
  never adds one, and `vendor` (below) is the only kind open to a vendor's own failures.
- Three are easy to mix up, and each means one thing:
  - `invalid`: the request is malformed whatever the provider: its shape, a value out of range, an unknown field.
  - `unsupported`: the provider or driver has no such call or feature at all: `release(stop)` where stop is not
    declared, `ui.nav` on a desktop.
  - `refused`: the call exists, and this value or state is not one it serves: a network, kind, image or GPU it does
    not declare, or a network change after create on a remote computer.
- `vendor` is the code for a failure the vendor answered with (its API, its CLI, its device). The error's `vendor` field
  then names which vendor: its descriptor's id (`daytona`, `phone-harness`, ...). One code serves every vendor, so a new
  vendor never edits the error type. An error passed up in new words keeps its code, and with code `vendor`, its vendor.

## Members

| Member | Promise |
| --- | --- |
| `id`, `version` | The provider's id (its registry name) and its own version. A computer whose daemon reports another version is never handed out. |
| `capabilities()` | What its computers are and can do, before any is made (below). |
| `check(spec)` | Every way a spec is beyond what it declares, in words, field by field, with no vendor call. `create` refuses the same. |
| `create(spec, { requestId })` | Makes one computer for `spec`, with a deadline, and answers its ref. A run's computer needs a lifetime: one with no deadline is refused. Once per request id ([below](#idempotent-create)). |
| `attach(ref)` | Finds one computer this provider made, by id or by labels, with its spec read back from it. None or several is an error in words. |
| `list(labels)` | Every computer this provider made that carries all of these labels: the janitor's view. |
| `network(ref, policy?)` | Reads the network back; with a policy, sets it, or refuses in words. Never wider than asked. A remote computer's network is fixed at create: a change is refused `refused`, and asking for the network it has answers ok. |
| `connect(ref)` | A connection to the computer, after `hello`. It refuses a `hello` whose protocol, version, kind or groups differ from what it declared. |
| `release(ref, how)` | `delete`, `stop` where declared, or `detach` (an agent's computer, kept with its state) where `persistence` is declared. An undeclared `stop` or `detach` is refused in words, with the computer left as it was. Idempotent: a computer already gone is ok. A deleted computer stays gone: no later call, a read included, brings it back. |
| `extend?` | Moves the deadline later, never earlier, and never past the provider's cap counted from create. |
| `stream?` | A URL that shows the screen live, the vendor's own. A vendor with none leaves it out: `watch` is the live view. |
| `watch?` | The computer's live view: frames, and input on what it answers. A computer with a screen gives it. |
| `sweepLeftovers?` | Removes what its computers left outside themselves, by labels. |
| `testConnection?` | One account-level read with the provider's keys that never creates a computer, so it never spends. |
| `prepareImage?` | The image its computers start from, made ready before the first create; a second call makes nothing ([below](#prepareimage)). |

A computer's spec (`ComputerSpec`):
- `image`;
- `lifetimeMs`, required for a run's computer; an agent's computer (`owner`) has none;
- `network`: `none`, `open` or an allowlist;
- `cpus`, `memoryMb`, `pids`, `labels`, `workdir`;
- `user`: a uid, or `uid:gid`; unset is a non-root default, and root only when asked;
- `mount`: the run's folder at `/workspace`, of a kind the provider declares: `{ kind: "bind", path }`,
  `{ kind: "archil", disk, region, folder, token }` or `{ kind: "sync" }`;
- `gpu`, `browser`: GPUs and browser features, of what the provider declares;
- `owner`: `{ agent, server?, idleTtlMs? }`, the agent a computer that keeps its state belongs to, so a later run of
  that agent finds it again and no other agent does.

## Idempotent create

`create`'s context carries a required `requestId` (`CreateContext`). It names the request, not the computer, so a
retry of one request (a timeout, a crash between the vendor's answer and ours) makes no second computer. There is no
fallback that makes one up: serve passes the run's claim (`<run>#<epoch>`), and conformance one per create.

- The computer's vendor-side name is `computer-<the first 12 hex of sha256(requestId)>` (`computerNameFor`), with no
  extra label, so a provider finds the request's computer by listing that name.
- The same id while that computer is still starting is the same create: it waits as a fresh create does, within the
  same bounds, and answers it once it is up; one that reaches its deadline first is refused `exists`.
- The same id while it is up answers it once it is the computer the spec asks for, as far as the vendor reads it back
  (Docker: every field its drift check reads, the network and the mount among them; a phone: its labels and image); one
  that differs is refused `exists`. A retry never gets a wider network, another folder or another user than it asked.
  A size (`cpus`, `memoryMb`) is compared only where the vendor reads one back; on a vendor that reads none back
  (Modal), a retry asking another size after a restart answers the request's computer as it was made.
  The GPUs are compared likewise: the hosted adapter records them at create in the label `agentrun.computer.gpu`
  (`<type>:<count>`), on every vendor, so a retry asking a GPU finds a computer made without one, or the other way
  round, refused `exists`.
- The same id after it stopped, ended or passed its deadline is refused `exists`, in words: "computer-… was made for
  this request and has ended: create with a new request id". Never a second computer under the same name.
- A second create of a request still in flight in the same provider waits for the first and answers what it does; one
  asking another spec (any field but `lifetimeMs`, which each create counts from its own start) is refused `exists`.
  The provider remembers the requests whose computers it ended, so the same id is refused even once the vendor forgets
  the computer; past the process, what the vendor (or the provider's ledger) still shows is what holds.

Every provider that makes computers keeps it through one mechanism, `CreateRequests` (`src/create-requests.ts`): the id checked, the name,
the creates in flight and the requests ended. What the vendor holds under the name is the provider's to read: the
hosted adapter lists the name and reads each machine it finds by `get`, Docker's `docker run --name` finds the name
taken and reads that container, and the phone harness reads its ledger by name and sends a key derived from the id as
the `Idempotency-Key`.

`provider.create-retried` creates twice with one id and expects one computer; `provider.create-after-release` releases
it and expects the same id refused `exists`. Both are Full.

## capabilities()

`ComputerCapabilities` declares, before any computer is made:

| Field | What it declares |
| --- | --- |
| `kind`, `os`, `daemon` | What the computers are, and who answers their methods (see [`kinds.md`](kinds.md)). |
| `groups` | What each computer offers; each computer's `hello` repeats it. |
| `lifetime` | Who ends a computer at its deadline: the vendor, or our janitor by label. |
| `maxLifetimeMs` | The longest lifetime it gives: the vendor's hard cap, measured where the vendor documents none, or the janitor's where the vendor never ends a computer. |
| `network` | The networks it takes: `none`, `open`, `allow`. With `allow`, `allow` says what a list may hold. `networkReadBack` says whether the vendor reads the policy back from outside. |
| `isolation` | `container`, `gvisor`, `microvm`, `vm`, `machine` or `host` (processes of the provider's own machine, such as the local browser's). |
| `release` | `delete`, and `stop` where a stopped computer is kept; `stopDeletes` where a stop ends in deletion. |
| `user` | What `spec.user` may ask for beyond the non-root default: `root`, another `uid`. |
| `mount` | The kinds of folder a computer can have at `/workspace`: `bind`, `archil`, and `sync` wherever the configuration has `files` and `exec` (the [synced folder](#the-synced-folder)). |
| `vendorAgentPorts` | The TCP ports the vendor's own agent listens on inside the computer. A `child` daemon must declare them: `[]` where none listens on TCP (the agent is on a unix socket or a virtio device, or not in the computer). |
| `gpu`, `browser` | The GPUs `spec.gpu` may ask for; a browser's features beyond the protocol. |
| `persistence` | `{ keepsState, resume }`: whether a computer keeps its disk and state past a run, and whether a kept computer comes back running or boots again from its disk. Absent means neither: each computer lives for one run. A provider on the shared machine-host adapter never declares it today: delete is its only release. |

On the shared machine-host adapter, a host fixes two vendor timers (`packages/computer/src/host.ts`). A janitor's host
whose vendor has a delete or stop timer of its own sets it to `MachineRequest.backstopAt`, five minutes past the most
the deadline may reach (create + `maxLifetimeMs`), so a computer still ends when the server is gone. A host switches off
every vendor timer that ends a quiet machine; where it can't be switched off, the vendor doesn't fit yet. A host's
`get` answers `undefined` for a machine the vendor no longer has, and for a record the vendor keeps of one that is
deleted and won't come back, which its `list` leaves out; `gone` is a machine still being destroyed, and release waits
on it after the delete.

## The descriptor

A provider declares itself once, in a **descriptor** (`ProviderDescriptor`, `packages/computer/src/descriptor.ts`), so
that the server, Settings and the conformance suite all read the same declaration. Every field is data except
`load()`: reading a descriptor loads no provider module and no vendor SDK.

| Field | What it declares |
| --- | --- |
| `id` | Its id in the provider registry and in Settings: lowercase letters, digits and hyphens. Errors with code `vendor` name it. |
| `label` | Its name in words, as Settings shows it. |
| `keys` | The keys Settings takes for it: each a `name` (what Settings stores and shows, such as `DAYTONA_API_KEY`; never a value), the `create()` `option` it fills, and whether it is `required`. `[]` for none. |
| `settings?` | Values that are not keys but fill a `create()` option (Modal's app): `name`, `option`, and a `default` used when the server names none. Settings has no field for one, so a value with no default that works for everyone (a server URL, a team, project or workspace id) is a key with `required: true`, secret or not. |
| `metered` | The vendor bills by time. Prices are the vendor's page, not ours. |
| `mounts` | The mount kinds its computers take beside the synced folder (`bind`, `archil`); `[]` for none. `sync` is never listed: it is derived, for each configuration with `files` and `exec` on a provider that lists no `bind` and has no `unmounted.sync`, and `capabilities().mount` and `mountsOf` declare it. |
| `unmounted?` | Why its computers take none of some mount kinds, each in one sentence, keyed by kind; never one `mounts` declares. `check()` refuses a mount of that kind in these words, code `refused` (Daytona's `archil`: Archil's client hangs on its hosted cloud; Orgo's `sync`). |
| `mountsWith?` | Mount kinds its computers take only where the operator sets one of its keys, keyed by kind, each the name of an optional key; each kind is in `unmounted` too. A provider made with that key declares the kind in `capabilities().mount`; one made without it refuses it in the `unmounted` words. `mountsOf(descriptor, set)` gives the mounts for the keys set, which a server reads without loading the provider (Daytona's `archil`, with `DAYTONA_ARCHIL_EGRESS`: a self-hosted target's Archil egress relay). |
| `capabilities` | One entry per configuration it offers: a machine kind and its groups, as each built provider's `capabilities()` declares. At least one. |
| `unserved?` | Setting kinds its capabilities don't serve though a caller would ask for one, keyed by kind, each with why in words; never `none`. A server refuses a setting of that kind on it in these words, in place of the generic ones (serve's entry for a paired computer: each kind its driver's hello serves not, with why). |
| `defaultImage?` | The image a computer of each setting kind starts from when its setting names none. A kind with no entry has no default, and the caller refuses the setting in words. |
| `prepareImage?` | Its providers have `prepareImage()`, which makes the image ready before the first create ([below](#prepareimage)). |
| `imageEnv?` | The server's environment variable that, when set, names the image every computer of the provider starts from in place of `defaultImage` (Daytona's `AGENTRUN_DAYTONA_SNAPSHOT`). The provider's `check()` still judges it. |
| `local?` | Its computers run on this machine's container engine, so the server passes it its local host options. |
| `ledger?` | `{ option }`: `create()` takes a ledger the server keeps for it in that option (the phone harness's sessions). |
| `profiles?` | `{ settleMs }`, a browser's only: its providers keep profiles (`profiles` on the built provider, a server's saved sign-ins), and `settleMs` is how long after a session that saved to one ends the vendor may still be writing it back (Browserbase 10 s, Kernel 0). The built provider's `capabilities().browser.profiles` is the same, and a server holds a saved sign-in's next save back for it without loading the provider. |
| `load()` | Imports the provider module on demand: its `create()` and its conformance module. |

A descriptor module (`packages/computer/src/descriptors/<id>.ts`) builds it with `defineProvider`, which checks it and
throws in words naming each problem: the id's shape, unique non-empty key and setting names and options, a `required`
on each key, a known mount kind, one configuration at least. `descriptorProblems(value)` gives the same checks as a list,
for a descriptor loaded from elsewhere. `DESCRIPTORS` (`descriptors/index.ts`) lists the built-in ones in the order
Settings shows them. The kind registry's `PROVIDERS` and the provider registry are derived from them; nothing else
repeats what a descriptor says.

The provider module exports `create(options)`, where `options` holds each key and setting by its `option` name. Its
mounts and capabilities are its descriptor's, read from the descriptor and exported nowhere else.

The conformance case `health.declared` holds `capabilities()` to the declaration, and `hello` to `capabilities()`.

**Status.** Next, the contract types move to a zero-dependency package, `@parcha/agentrun-computer-protocol`
(**draft**), and this spec is generated from there.

## The synced folder

A `{ kind: "sync" }` mount is a plain `/workspace`, owned by the computer's user with mode 0700, with nothing mounted
there. A child-daemon host's install makes it as root before init starts. On a machine that dials, the box image's
`agentrun-dial` makes it. The computer takes no disk, region or token. The runner holds the run's folder, puts it in
before the agent's tools run, and reads what changed back after each call that may change it. Every byte goes through
the computer's own `files` and `exec` calls, so no FUSE is needed and a GPU host takes one too.

- The read-back is `{ kind: "sync", epoch }`, from the computer's `agentrun.epoch` label. The label
  `agentrun.mount = {"kind":"sync"}` (`SYNC_LABELS`) lets a kept computer be reattached as one. `list` reports the
  label's record. `attach` and `create` read `/workspace` from inside (`readMount`): if something is mounted there,
  it isn't a directory, or its owner isn't `/work`'s, the create fails in words and the machine is deleted.
- `FolderSync` (`packages/computer/src/sync-folder.ts`) takes the delta against a `SyncSink` (put, mkdir, remove,
  meta). It reads one paged `files.list` of the folder and compares it with the last listing's manifest. A new tree
  comes in one `tar.pull`. A changed file of up to 512 KiB comes through `files.read`, and a larger one through
  `tar.pull`; 8 pulls and 8 puts run at once. Deletes run only when every put landed, deepest first. While a directory the computer's user can't read hides
  what the sink holds under it, a sync writes nothing and fails in words. A path whose old entry the sink did not
  remove gets nothing new until a later sync removes it. Modes and links
  come from the listing alone, never as bytes; a link is kept by its target as written, never followed. A path that is
  no plain relative path (absolute, a `.` or `..` segment, a backslash, a NUL) fails the sync in words.
- A file whose mtime is within 1 s of the newest in its listing is read again at the first sync 1 s later (git's
  racy rule). Bytes that equal the ones last put are not put again. A write that leaves both the size and the mtime as
  they were is not seen.
- Over `SYNC_MAX_ENTRIES` (20,000) entries or `SYNC_MAX_BYTES` (2 GiB), a sync fails with code `limit`. The entry cap
  is checked as each page arrives, so no listing past it is held. The byte cap holds for what a sync reads too: each
  body takes its size (a tar entry's at its header) before it is held, so a file grown since the listing fails the
  sync with `limit` and is never read whole.

## prepareImage

A provider whose computers start from an image it makes declares `prepareImage: true`, and its provider class has
`prepareImage(ctx)`. A server calls it before its first create and puts what it answers in `spec.image`. The image is
the box image: `packages/computer/box/install.sh` holds every step of its build, as POSIX shell run as root on the
Dockerfile's base, with `agentrun-archil` beside it, and the box Dockerfile only runs it.

- A vendor that builds images from a running machine (a snapshot, a blueprint, a template): `prepareImage` boots the
  vendor's base, runs `install.sh` there as root, then snapshots or registers the result.
- A vendor that takes an image from its own registry (Vercel Sandbox, from Vercel Container Registry): push the box
  image there, built from `box/Dockerfile` as it is, under the tag `agentrun-box:<hash>`.
- A vendor that builds from a Dockerfile on its side (Hyperbrowser's remote builder): send `box/Dockerfile` with the
  rest of the recipe (`RECIPE` in `box/recipe.mjs`: `install.sh` and `agentrun-archil`) as the build's context, and
  name the result `agentrun-box-<hash>`, a name and not an OCI tag.
- A vendor that needs its own base image (Blaxel, Baseten, Fly Sprites) doesn't fit these paths yet.
- It is idempotent by name. The name or tag carries the box recipe's hash (`boxRecipeHash()`, which covers
  `install.sh`), so a second call finds the image by it and answers it, with no build and no `onWait`. Where the vendor
  has no get by name, `prepareImage` lists its images and takes the one of that name, in any state. A name the vendor
  refuses as taken, or one it is still making (VCR's `Preparing`, a build under way), is another build of it: wait for
  that one, bounded by `ctx.signal`. One whose build failed is a failure in the vendor's words, never built over.
- It calls `ctx.onWait("build" | "pull", tag)` once, and only when it really builds or pulls.
- It answers the image a create then names: ok with it, or an error in the vendor's words.

The in-tree ones are the references: Agent37 registers a template from the published image (`agentrun-box-<hash>`),
E2B answers a public template, Modal answers a public registry tag, and Docker builds from a recipe locally. The
provider's `prepareImage()` is the declaration; the descriptor's `prepareImage: true` says the same to a server that
reads descriptors without loading the provider. The Core case `provider.prepare-image` checks the two agree, then
calls `prepareImage` twice in one run: both answer the same image, and the second is told no `onWait`. A provider with
no `prepareImage` passes it, observed.

## A hosted vendor's exec

A vendor on the shared machine-host adapter writes a `MachineHost` (`packages/computer/src/host.ts`), and its `exec` is
the whole protocol: the adapter installs and starts `computerd` through it, then runs `computerd stdio` through it and
talks to the daemon over that one process's stdin and stdout for the computer's whole life ([`stdio.md`](stdio.md)).
`exec(id, argv, ctx)` answers a `MachineProcess` once the process has started, or throws. Its stdin is always open: the
adapter calls `end()` at once for a command it gives no input, such as the daemon's install. The process is:

- **Two-way and live.** Each `write()` reaches the process's stdin as it is written, and stdout and stderr bytes come
  back as the process writes them, while it runs. Not request and response, and never held until the process exits.
- **Text intact.** UTF-8 text both ways: every code point, lines of any length, `\r` and `\r\n` kept, no newline
  translation, no terminal, nothing added or dropped, and a character split across two pieces of output comes back
  whole. Each `write()` is whole characters. Bytes that aren't UTF-8 need not pass: the adapter's own traffic is text
  (the bridge's JSON lines, and the daemon's upload as base64 through `base64 -d`). An exec that carries bytes carries
  this.
- **Without a timeout.** The process runs until it exits or `kill()` ends it. The vendor's command timeout, and any idle
  timeout on the stream, are off.
- **Apart and accountable.** stdout and stderr stay separate, `wait()` answers the process's own exit code, and
  `end()` gives stdin end of file where the vendor has one, and otherwise does nothing: nothing the adapter runs waits
  for end of file (the upload reads its length, a root command's input is one line, the
  bridge ends by `kill()`).
  `kill()` ends the process in the machine, not only the streams: a wrapper that records its pid for a second exec to
  kill is enough.

The exec pre-check checks each of these with `exec` alone, on a machine made by hand, before anything else of the host
is written:

```sh
npm run conformance -w @parcha/agentrun-computer -- --provider <id | ./module.js> --exec-stream --machine <id>
```

It builds the host with the module's `createHost(options)`, which it calls with `{}`, so `env` defaults to `process.env`
(E2B's `createHost({ env = process.env } = {})`). It sends text of every class of code point, with `\r`, `\r\n` and a
1 MiB line, each way, and 8 MiB of random UTF-8 (compared by sha256), checks output and stdin while the process runs,
stderr apart, `sh -c 'exit 7'`, a killed `sleep`, and a silent process of 75 s (`--quick`: 5 s). No check ends stdin.
Each failure says what the exec did wrong, such as "U+000A (at byte 12) came back on stdout as 0d 0a 0b 0c: your exec turns
\n into \r\n, as a terminal does". It exits 0 when every check passes and 1 when one fails.

The vendor's exec may be any transport that keeps these rules: its own stream, SSH, its SDK, a relay in the image over
any two-way stream, or split calls (one starts a process, one streams its events, one per write), which
`framedExec` (`packages/computer/src/hosted/framed-exec.ts`) turns into a `MachineProcess`; `ndjson` and `sse`
(`hosted/rest.ts`) read events that come as NDJSON or as server-sent events. A request and response exec, which
answers a command's output when it ends, can't carry the bridge.

On a vendor whose root can make a network namespace, or one inside a user namespace, the three networks are the
adapter's: init's fence holds `none`, and init's egress proxy holds `open` and a list
(`packages/computer/src/hosted/network.ts`). A vendor policy is optional hardening, never wider than these, and a host
may ignore `egress: false` where it has none. The probe from inside is what counts. Where root can make neither, init
refuses to start, so the adapter doesn't fit.

### A vendor with no exec: machines that dial

A host whose facts say `connect: "dial"` has no `exec` and no `upload`: descriptor, facts, `create`, `get`, `list`
and `delete`, with `errorCode`, `extend` and `check` optional. The constructor refuses one with `exec` or `upload`,
in words.
`HostedProvider` takes `dial: { url, tokens, hub }`: the server's public address (`AGENTRUN_PUBLIC_URL`), its
`MachineTokens` and its `AttachHub`. Then:

- `create` refuses `refused`, before the vendor is called, each in its own words: with no `dial` (the process has
  no attach hub), when the url is missing or not `https` (`http` only on `127.0.0.1`), and for an Archil mount. A
  host that doesn't dial ignores `dial`, so a server may pass it to every hosted provider. It mints the machine's token, expiring at `backstopAt`, and calls the
  host's `create` with `boot.env` ([`attach.md`](attach.md#hosted-machines-that-dial) names them: five, and `DISPLAY`
  for a desktop) and `egress`
  true, since the machine's root reaches the server (its tools' network is init's); the host puts the env in the
  machine's env and runs nothing. Creates of one request take turns on one server, so two machines of a request never
  dial at once. Then it waits up to `createMs` for the machine's socket in the hub; one that
  never dials is deleted, its token revoked, and create fails `timeout`, naming the address. One whose dial the server
  refused in words (`MachineTokens.refused`: a relay to a runner in a process of its own it could not make) is deleted
  as that read answers, and create fails `refused` in those words. The read is bounded by `requestMs`, the time left
  and the caller's signal, and holds no look in the hub back: a token store that stalls costs no machine that dials
  meanwhile, and the hub is read once more before a timeout.
- Nothing is installed, uploaded or started through the host: the machine's `agentrun-dial` does it. The drift check
  holds by the daemon's SHA-256, which the machine checks before it runs it. A desktop's X server starts over the
  machine's socket, through `process.start`, and its window manager as on a host with exec: by computerd, asked by
  init's `--window-manager` where the host's facts say `windowManager`.
- `connect` goes over the machine's socket, by the attach binding's rules, with a fresh `hello` (a desktop's display
  answers after it dialed): a drop fails `gone`. A desktop whose `hello` says `linux` (its display is down) fails
  `connect` and `watch` as drift, as on a host with exec. `release` with
  `delete` revokes the token and closes the socket before the vendor's delete.
- The Core case `provider.dial-token` checks the token: a `hello` of another kind, os or arch is closed `4400` (a
  desktop's token takes `linux`, its hello before its display answers), and
  after delete or past `backstopAt` it is refused. A run of a dial host passes `ConformanceOptions.dial`, the server's
  side for the case (through the CLI, its conformance module's `dialKit()`); a host with exec passes the case, observed.

## A new vendor

1. A descriptor (`defineProvider`, above) and a provider module: a class implementing `ComputerProvider`, with
   `create(options)`. `create` takes its keys as options and reads no environment. A vendor's own failure is
   `vendorFail(<id>, message)`, or `failFor(<id>)` for every failure the module returns. A vendor of Linux machines
   writes a `MachineHost` instead and hands it to `HostedProvider` ([PROVIDERS.md](../../packages/computer/PROVIDERS.md)).
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
