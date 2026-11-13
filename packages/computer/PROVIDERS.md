# Writing a computer provider

A provider makes, finds and ends computers on one vendor. The daemon inside each computer (computerd) does the work;
the provider gets it there, proves it is the one asked for, and carries its wire. This file starts with how to
contribute one, then has two halves: what a provider declares and how it is judged (the protocol half), and what a
vendor writes to run its machines on the shared adapter (the MachineHost half).

## How to contribute a provider

One pull request, with no generator script. For a vendor whose machines run Linux and can start a process as root:

1. Copy E2B, the simplest vendor on the adapter (one key, one SDK): `src/e2b.ts` (its `MachineHost` and provider), `src/descriptors/e2b.ts` (its
   descriptor) and `src/conformance/e2b.ts` (its conformance module), renamed for your vendor. Add your descriptor to
   `DESCRIPTORS` in `src/descriptors/index.ts`: that line puts it in the registry.
2. Write the eight members in [What the vendor writes](#what-the-vendor-writes), and only the optional hooks your vendor
   needs. Unit-test what needs no vendor, as `test/e2b-provider.test.mjs` does.
3. Name your settings `COMPUTER_<VENDOR>_*` in the conformance module's `ENV`, the key as `COMPUTER_<VENDOR>_API_KEY`,
   behind the live switch `AGENTRUN_COMPUTER_LIVE_<VENDOR>=1`.
4. Build, then run the suite with your own key between two sweeps, from the repository root:

   ```sh
   npm ci --ignore-scripts && npm run build
   npm run build:daemon -w @parcha/agentrun-computer   # needs Go on PATH
   export AGENTRUN_COMPUTER_LIVE_<VENDOR>=1 COMPUTER_<VENDOR>_API_KEY=<your key>
   node packages/computer/dist/conformance/sweep.js --provider <vendor> --before /tmp/<vendor>-before.json
   npm run conformance -w @parcha/agentrun-computer -- --provider <vendor>
   node packages/computer/dist/conformance/sweep.js --provider <vendor> --after /tmp/<vendor>-before.json
   ```

   A desktop also needs the fixture the input cases read, built for the vendor's machines (`GOARCH=amd64` or `arm64`);
   without it those cases skip and Core fails. Build it, then add `--fixture /tmp/computerd-fixture` to the run:

   ```sh
   (cd packages/computer/daemon && CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -o /tmp/computerd-fixture ./cmd/fixture)
   ```

   `--kind sandbox` (or `desktop`) runs one kind's cases and ends on its verdict. `-- --help` lists every flag.
5. Paste the report and the sweep's last line into the pull request and fill in its checklist. The run passes when it
   ends `core PASS` and exits 0, and the sweep prints `"stillThere":[]`.

## The protocol half

The contract is `ComputerProvider` (`src/provider.ts`). [spec/computer/provider.md](../../spec/computer/provider.md)
says what each member promises; this is the short version. A vendor on the MachineHost adapter gets all of it from
`hostedProvider` and writes none of it by hand.

### What a provider declares

- A descriptor (`src/descriptors/<id>.ts`, built with `defineProvider`): its id, label, the keys Settings takes, whether
  it is metered, its mount kinds, one entry per configuration (a machine kind and its groups) and its default image.
  See [The descriptor](../../spec/computer/provider.md#the-descriptor).
- `capabilities()`: what its computers are, before any is made: kind, os, daemon (`pid1`, `child` or `none`), groups,
  who ends a computer at its deadline, the lifetime cap, networks, isolation, release (`delete`, `stop`), users, mounts
  and the vendor agent's ports. See [capabilities()](../../spec/computer/provider.md#capabilities). On the MachineHost
  adapter these come from `facts`.
- The rest of the surface: `id`, `version`, `check(spec)`, `create(spec, { requestId })` (once per request id, see
  [Idempotent create](../../spec/computer/provider.md#idempotent-create)), `attach`, `list`, `network`, `connect` and
  `release`; optionally `extend`, `stream`, `watch`, `sweepLeftovers` and `testConnection`. See
  [Members](../../spec/computer/provider.md#members).

The case `health.declared` holds `capabilities()` to the descriptor, and each computer's `hello` to `capabilities()`.

### Refusals

Every call answers `{ ok: true, value }` or `{ ok: false, error: { code, message, vendor? } }`, never a throw. The
message is words a person can act on, and never holds a key, a token or a bearer URL: `health.no-key-in-errors` checks
it with planted keys. The codes are a closed set (`ComputerErrorCode`, `src/result.ts`); a provider never adds one. See
[Every call answers a result](../../spec/computer/provider.md#every-call-answers-a-result).

| Code | When |
| --- | --- |
| `invalid` | The request is malformed whatever the provider: its shape, a value out of range, an unknown field. |
| `unsupported` | The provider has no such call or feature: `release(stop)` where stop is not declared. |
| `refused` | The call exists, but not for this value or state: a network, kind, image or GPU it does not declare, a network change after create. |
| `exists` | The request id was used before, and its computer differs from the spec or has ended. |
| `gone` | The computer, or the run's hold on it, has ended. |
| `not_found` | No such thing: a computer `attach` names, a file, a process. |
| `timeout`, `aborted` | The call ran past its bound; the caller cancelled it. |
| `denied`, `limit` | Not allowed; over a bound (a size, a rate, an extend past the cap). |
| `not_dir`, `is_dir`, `stale` | A file call's path is the wrong kind; a `ui` ref or point no longer holds. |
| `unauthorized`, `unreachable` | From `testConnection` alone: the vendor refused the key; the vendor was not reached. |
| `vendor` | The vendor failed (its API, CLI or device); the error's `vendor` names the descriptor's id. |

### How the conformance report judges a provider

`npm run conformance` makes real computers, runs each case, deletes what it made, and prints one line per level and
group, then the verdict. The package README's [Conformance](README.md#conformance) section has a sample report and the
JSON shape (`--json`).

- **Core and Full.** A Core case is what every computer of its kind must do: on a Linux computer with a daemon, exec,
  files, processes and network `none` (and the vendor agent's ports for a `child` daemon); a desktop adds screen,
  pointer and keys. A Full case tests an optional capability and runs only where the provider declares it.
- **pass, fail, skip.** Each case ends in one of the three, and a skip always says why, under its line. A Core case
  skipped because it needs something optional the provider does not declare, or because it is written for another
  OS, is listed as `optional` and does not count against Core. Any other skip of a Core case (no fixture given) fails
  Core.
- **Nothing left over.** At the end the runner lists the run's label: `cleanup.left` and `cleanup.errors` must be
  empty. On the MachineHost adapter it also runs [the live sweep](#the-live-sweep) over the run's label, and
  `cleanup.sweep.stillThere` must be empty. A leftover prints as `cleanup ✗ left <ids>` and fails Core.
- **The verdict.** The last line reads `core PASS n/m · ... · full p/q`. Core is `pass` when every Core case passed
  and nothing was left over, `partial` when `--only` left Core cases out (never a pass), and `fail` otherwise. Full
  results are reported and do not change it. The exit code is 0 for pass, 1 for fail, 2 for a usage error and 3 for
  partial. With `--kind`, the run ends on `kind <kind> PASS` or `kind <kind> FAIL: <reasons>` and exits 0 or 1 on that
  alone.

## The MachineHost half

A vendor whose machines run Linux and can start a process as root writes a `MachineHost` (`src/host.ts`), and
`hostedProvider(host, options)` (`src/hosted/provider.ts`) makes it a whole `ComputerProvider`. The doc comments in
`src/host.ts` are the contract; this section is their summary. E2B is the first vendor on it (`src/e2b.ts`), and
Agent37 the second (`src/agent37.ts`: REST over fetch, every command over SSH, no file API).

### What the vendor writes

Eight members, each a call about the vendor's own machines:

| Member | What it does |
| --- | --- |
| `id` | The descriptor's id: the vendor named by every error of code `vendor`. |
| `facts` | Static: `daemon` (`child` or `pid1`), `isolation`, `lifetime` (`vendor` timer or `janitor`), `maxLifetimeMs`, `arch`, `vendorAgentPorts`, `networkReadBack`, `network`, `mounts`, `release`; optional `gpu`, `user`, `specFields`, `labelRules`, `runtime`. `capabilities()` is built from these and the adapter's options alone. |
| `create(req, ctx)` | Makes one machine from a `MachineRequest` (its name, image, labels, lifetime, network, and on a pid1 host its command) and answers once the vendor has its id. No wait for running or listed: the adapter waits. |
| `get(id, ctx)` | One `Machine` as the vendor reads it now (labels, state, network, resolved image, the timer's end, the vendor's own drift in words), or `undefined` once the vendor no longer has it. |
| `list(labels, ctx)` | Every machine carrying all of these labels, every page, each as `get` reads it, within `ctx.timeoutMs`. |
| `delete(id, ctx)` | Deletes; not found is ok; answers once the vendor took it. |
| `exec(id, argv, { stdin }, ctx)` | Starts argv as root (or a user with passwordless sudo), outside the computer's tools, with no command timeout; a `MachineProcess` (stdout, stderr, write, end, wait, kill). |
| `errorCode(error)` | The code of an error the vendor's client threw: one of `ComputerErrorCode`, `vendor` for anything else. |

`upload` is optional: a vendor with no file API leaves it out, and the adapter streams the daemon through `exec`'s
stdin. Six optional hooks exist, each for one vendor's need: `prepare` (settings once a machine runs), `stop` (with
`release: ["stop"]`), `setTimer` (a vendor timer that extend moves), `setLabels` (a janitor deadline that extend
moves), `check` (the vendor's own spec rules, such as an image name) and `testConnection` (where a list would make
something).

A method answers a `Result`; one that throws is read through `errorCode`. The adapter bounds every call by
`ctx.timeoutMs` and the caller's `ctx.signal`, and never cancels a create: one that answers after the caller gave up is
deleted as it lands, and one whose answer never comes is found by its name and deleted.

### What the adapter does for every vendor

- `check(spec)`: the shared rules (lifetime and cap, network none only, the provider's own label namespace, sizes and
  users not in `specFields`, GPUs, the Archil mount and its tool user), then the host's `check`. A host whose
  `specFields` holds `user` makes each computer's daemon run as the uid (or uid:gid) its spec names, never root unless
  `facts.user` holds `root`; `attach` reads that user back from inside. A host with `facts.runtime` has the probe's
  kernel held to it at create (gVisor or not).
- `create(spec, { requestId })`: the name is `computer-` and the first 12 hex digits of the request id's sha256. It
  lists by that name first: a machine still starting is waited for (within `createMs`) and returned once up; one up is
  returned when its labels and daemon read back as `attach` reads them (a daemon not yet as declared, such as a
  desktop whose display is still starting, is waited for within `createMs`), else refused as `exists`; one stopped,
  ended or past its deadline is refused as `exists`. A second create of a request still in flight on the same
  instance shares the first's answer only when it asks the same (labels, user, and every other field the host is
  given); otherwise it is refused as `exists`. A request this instance gave up on or deleted is refused as `exists`
  from memory (the last 4096) while the vendor no longer lists it; past that, the caller's request id is what keeps a
  request from running twice, so a caller never reuses one. Two provider instances can both find no machine and both make
  one, so after the vendor answers, and again once the machine is listed, the name's listing is read: where more than
  one machine holds the name, the oldest (`Machine.createdAt`, or the lowest id where any has none) is kept, every
  other is deleted and read back gone, and both creates answer the one kept. Then: the machine made, read while it
  starts, the vendor's read-back held to the request (labels, network, state, a timer that reads moved, the host's
  drift), the daemon uploaded and installed with its sha256 read back, an Archil folder mounted (through
  `archilEgress` when given), init started from
  its home with the display (detached on a child host; on a pid1 host, the entrypoint, which starts the daemon only
  once the marker install writes beside it holds this create's nonce, never one the image had there), the bridge opened, the display
  started on a desktop, the daemon's credentials, network and binary read back, the network-none probe run, and the
  listing waited for (two consecutive polls that show it, `listedStableMs` apart). A failure or an abort at any step
  after the machine exists deletes it and waits until the vendor reads it gone.
- `connect`, `attach` (the host's drift held as at create, the size read back reported), `list`, `network` (fixed at
  create: any change is refused), `extend` (where `setTimer` or `setLabels` lets the deadline follow), `release`
  (delete, then wait until `get` reads it gone and the name's listing no longer shows it, twice running; a stop or a
  delete of a running Archil computer lets go of its folder first), `watch` and `testConnection`.
- Refusals use `ComputerErrorCode` alone: `invalid` for a malformed request, `unsupported` for a call or feature the
  provider does not have, `refused` for a value or state it does not serve, `exists` for a request already made;
  `vendor` carries the vendor's own words.

### Testing a host

The adapter's lifecycle is tested once, against its one fake host (`test/fake-host.mjs`,
`test/hosted-provider.test.mjs`). A vendor's host is not tested against a fake of the vendor: its unit tests cover
only what needs no vendor (its capabilities, its check, how the key and the endpoint reach the SDK, the environment its
conformance module reads). Its proof is the live conformance kit, run before and after a change from a frozen folder.

### The live sweep

```sh
node packages/computer/dist/conformance/sweep.js --provider <id> --before <file>
node packages/computer/dist/conformance/sweep.js --provider <id> --after <file>
```

`--before` records every machine listed with `agentrun.computer=1`. `--after` deletes each new one that carries a
conformance run's label (`agentrun.conformance`), reads each back gone, leaves alone a new one without it (another user
of the account) and every one recorded before, and prints `{"swept":n,"gone":m,"stillThere":[ids],"leftAlone":k}`.
Exit 0 when every swept machine is gone, 1 when one is still there, 2 on a usage error. It reaches the vendor through
the conformance module's `createHost({ env })`, which reads the same settings as the run and needs no live switch. A
module whose account holds more than one place to list (an app and a server) also exports `sweepScope({ env })`:
`--before` records it, and `--after` refuses a file of another place, or one that names none, before it lists. A
conformance run of a hosted provider runs the same sweep over its own label at its end: the report's `cleanup.sweep`,
whose `stillThere` must be empty for Core to pass.

### A new vendor

1. `src/<vendor>.ts`: the SDK slice it calls, a class implementing `MachineHost`, and a provider class (or
   `create(options)`) that builds `hostedProvider(host, { label, ...options })`.
2. `src/descriptors/<vendor>.ts`: the descriptor, its `load()` importing that file, listed in `DESCRIPTORS`
   (`src/descriptors/index.ts`).
3. `src/conformance/<vendor>.ts`: the live switch, `settingsFromEnv` with its `COMPUTER_<VENDOR>_*` names,
   `createProvider`, `createDriftedProvider`, `createHost`, `conformanceImage` and `conformanceNotes`.
