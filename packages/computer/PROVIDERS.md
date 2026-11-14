# Contributing a computer provider

AgentRun is an open-source platform for running AI agents. It gives each agent a computer, a sandbox or a desktop, on
a vendor's machines. This page shows how to add your machines in one pull request.

## How to contribute a provider

### What your API needs

AgentRun needs two things from your API:

- **A streaming, two-way exec.** You start a process in a machine, write to its stdin and read its stdout and stderr
  while it runs, byte for byte, with no timeout. AgentRun talks to its daemon over one such process for the machine's
  whole life.
- **A list by label.** You can list your machines by a label, tag or metadata pair that AgentRun sets at create.

If your API only runs a command and gives back its output when it ends (a one-shot REST exec), or can't list machines
by label, this adapter can't use it today. Talk to us first by [opening an issue](https://github.com/Parcha-ai/agentrun/issues)
that says what your API offers.

### Step one: run the exec pre-check

Before you write anything else, write your host's constructor and its `exec` (see [the twelve members](#the-twelve-members)
below). Then write a `createHost({ env })` in your conformance module that builds the host from your key, and point to
that module from your provider file with `conformance`, as `e2b.ts` does. E2B's `createHost` in
`src/conformance/e2b.ts` is three lines. Make a machine by hand in your console, then run, from the repository root:

```sh
npm ci --ignore-scripts && npm run build
export COMPUTER_<VENDOR>_API_KEY=<your key>
npm run conformance -w @parcha/agentrun-computer -- --provider ./packages/computer/dist/<vendor>.js --exec-stream --machine <machine id>
```

It calls `exec` and nothing else. It sends all 256 byte values each way and 8 MiB of random bytes, reads output while
the process still runs, checks stderr comes back apart from stdout, checks the exit code and `kill`, and runs a silent
process for 75 seconds to check nothing cuts it off. Each failure says what your exec did wrong, such as "byte 0x80 came
back on stdout as ef bf bd: your exec decodes UTF-8". `--quick` shortens the 75 seconds to 5. When it prints `exec
PASS`, write the rest.

### What you write

You write one small TypeScript object, a `MachineHost`. It creates, reads, lists and deletes your machines, and runs a
command in one. AgentRun does the rest. It installs its daemon (computerd) in each machine. This package ships that
daemon, so it always matches the provider's protocol and version exactly. AgentRun also enforces deadlines, makes create
safe to retry, sweeps up leftovers and checks from inside that the agent's programs have no network. This works
for any vendor whose machines run Linux and can start a process as root.

You add four things under `packages/computer/src/`, each copied from E2B's:

- `<vendor>.ts`, your host and the provider class that wraps it. Start from [`e2b.ts`](src/e2b.ts).
- `descriptors/<vendor>.ts`, your descriptor: id, label, key and the kinds of computer you offer.
- `conformance/<vendor>.ts`, which reads your key and builds your provider for the test suite.
- One line in `descriptors/index.ts` that adds your descriptor to `DESCRIPTORS`.

### The twelve members

A host has twelve members: `descriptor`, `facts`, `create`, `get`, `list`, `delete` and `exec`, then the optional
`upload`, `errorCode`, `stop`, `extend` and `check`. Every snippet below is cut from E2B's host in `src/e2b.ts`, and
`// …` marks a cut. A call answers a `Result`, either `ok(value)` or a failure with a code. If a call throws, AgentRun
reads the error through `errorCode`. Each call gets `ctx` with a `timeoutMs` and sometimes a `signal`. Pass both to
your client where you can.

**`descriptor`** is your descriptor (below). Errors with code `vendor` name its id, refusals name its label, and the
provider's network and mounts are the ones it declares.

```ts
class E2BHost implements MachineHost {
	readonly descriptor = E2B;
```

**`facts`** says what your machines are. It never changes, and AgentRun builds the provider's capabilities from it.
`daemon: "child"` means your own agent runs first and starts processes; with `"pid1"`, the machine's main process is
the command AgentRun passes to create. `lifetime: "vendor"` means your timer ends a machine at its deadline; with
`"janitor"`, AgentRun ends it by label. `vendorAgentPorts` are the ports your agent listens on inside the machine.
`HostFacts` in [`src/host.ts`](src/host.ts) lists the optional fields, such as `gpu`, `user` and `specFields`.

`maxLifetimeMs` in `facts` is the longest any of your plans keeps a machine. For E2B that's Pro's 24 hours
(`PRO_MAX_MS`). Your provider's `maxLifetimeMs` option is the cap a user gets, and it may only lower the fact. Default
it to the plan most people are on, which is also the plan you test on. For E2B that's Hobby's 1 hour (`HOBBY_MAX_MS`).
A user on a bigger plan raises the option, up to the fact.

```ts
	readonly facts: HostFacts = {
		daemon: "child",
		isolation: "microvm",
		lifetime: "vendor",
		maxLifetimeMs: PRO_MAX_MS,
		arch: "amd64",
		vendorAgentPorts: [ENVD_PORT],
		networkReadBack: true,
		release: ["delete"],
	};
```

**`create(req, ctx)`** makes one machine and answers as soon as you have its id. Don't wait for it to boot, because
AgentRun polls `get`. Store `req.labels` on the machine, since `list` finds machines by them. `req.network` is always
`"none"`, except for a computer with an Archil storage mount. There AgentRun asks `"open"` so its root can reach
Archil, and the agent's programs still have no network.

```ts
	async create(req: MachineRequest, ctx: HostCall): Promise<Result<{ id: string }>> {
		const timeoutMs = Math.ceil((req.lifetimeMs ?? 0) / 1000) * 1000;
		const options: E2BCreateOptions = {
			...this.#api(ctx.timeoutMs),
			timeoutMs,
			metadata: { ...req.labels, [TIMEOUT_LABEL]: String(timeoutMs) },
			allowInternetAccess: req.network === "open",
			// …
		};
		const sandbox = await this.#Sandbox.create(req.image, options);
		// …
		return ok({ id: sandbox.sandboxId });
	}
```

**`get(id, ctx)`** reads one machine as your API sees it now. It returns a `Machine` with its labels, its `state`
(`starting`, `running`, `stopping`, `stopped`, `going` or `failed`), and the network and image you read back. A machine
that no longer exists is `undefined`, or an error that maps to `not_found`; neither is a failure.

```ts
	async get(id: string, ctx: HostCall): Promise<Result<Machine | undefined>> {
		return ok(machineOf(await this.#Sandbox.getInfo(id, this.#api(ctx.timeoutMs, ctx.signal))));
	}
```

**`list(labels, ctx)`** returns the machines your listing shows for these labels, every page, within `ctx.timeoutMs`,
each as the listing reads it. Leave out what the listing doesn't carry, such as the network: AgentRun calls `get` where
it needs it. You may return machines that don't carry every label (your API filters by some, or none): AgentRun keeps
the ones that do.

```ts
	async list(labels: Record<string, string>, ctx: HostCall): Promise<Result<Machine[]>> {
		// …
		const paginator = this.#Sandbox.list({ ...this.#connection, requestTimeoutMs: this.#requestMs, query: { metadata: labels }, limit: PAGE });
		// … every page into found
		return ok([...found.values()].map(listedOf));
	}
```

**`delete(id, ctx)`** deletes a machine and answers once your API accepts the delete. A machine that is already gone is
fine. AgentRun then waits until `get` and `list` stop showing it.

```ts
	async delete(id: string, ctx: HostCall): Promise<Result<void>> {
		// …
		await this.#Sandbox.kill(id, this.#api(ctx.timeoutMs));
		return ok(undefined);
	}
```

**`exec(id, argv, { stdin }, ctx)`** starts `argv` in the machine as root, or as a user with passwordless sudo, and
answers once the process has started. It returns a `MachineProcess` with the output streams, `write` and `end` for
stdin, `wait` for the exit code, and `kill`. AgentRun installs and starts its daemon this way, then talks to the daemon
over one process's stdin and stdout for the machine's whole life. So bytes go both ways while the process runs. Every
byte comes back exactly as written, with no text decoding and no terminal. Nothing times the process out. stdout and
stderr stay apart, and `kill` ends the process itself. [The spec](../../spec/computer/provider.md#a-hosted-vendors-exec)
says each rule, and the exec pre-check tests them.

E2B's SDK hands `commands.run` output over as text, decoded as UTF-8, which breaks any byte that isn't UTF-8. So E2B's
`exec` reads envd's process stream itself and passes on the bytes each event carries:

```ts
	async exec(id: string, argv: readonly string[], { stdin }: { stdin: boolean }, ctx: HostCall): Promise<Result<MachineProcess>> {
		const sandbox = await this.#sandbox(id, ctx);
		// …
		const events = sandbox.commands.rpc.start(
			{ process: { cmd: "/bin/bash", args: ["-l", "-c", shellLine(argv)], envs: {} }, stdin },
			{ headers: { Authorization: ROOT, [KEEPALIVE_HEADER]: KEEPALIVE_S }, signal: stream.signal, timeoutMs: 0 },
		)[Symbol.asyncIterator]();
		// … the start event gives the pid; then each data event's bytes go to out or err as they come
		return ok({
			stdout: out,
			stderr: err,
			write: (bytes) => sandbox.commands.sendStdin(pid, bytes, { requestTimeoutMs }),
			end: () => sandbox.commands.closeStdin(pid, { requestTimeoutMs }),
			wait: () => exited,
			// … and kill
		});
	}
```

**`errorCode(error)`** is optional. It maps an error your client threw to one of AgentRun's [codes](#refusals), and
anything you don't map is `"vendor"`. AgentRun reads an `AbortError` as `aborted` and a `TimeoutError` as `timeout`
itself, so map the rest. Map your vendor's not-found exception to `not_found`: AgentRun reads that from `get` as a
machine that is gone and from `delete` as done, so those two need no catch of their own. E2B's `errorCode` returns
`codeOf(error)`:

```ts
function codeOf(error: unknown): ComputerErrorCode {
	const name = (error as { name?: unknown } | null)?.name;
	if (name === "SandboxNotFoundError" || name === "NotFoundError" || name === "FileNotFoundError") return "not_found";
	// …
	return "vendor";
}
```

**Optional hooks.** `upload(id, path, bytes, ctx)` puts a file in the machine. E2B has one because it has a file API;
without it, AgentRun streams its daemon through `exec`'s stdin. Three more hooks each cover one vendor need. `stop`
goes with `release: ["stop"]`; it only asks, and AgentRun waits until the machine reads stopped. `extend` moves a
machine's end when an agent extends its deadline: your timer with `lifetime: "vendor"`, AgentRun's deadline label with
`"janitor"`. AgentRun reads the end back through `get`. `check` adds your own rules for a spec, such as image names; the
spec it gets is an object whose fields aren't checked yet. Leave out what you don't need. Settings' test of your keys is
one `list` by AgentRun's label, so a `list` must never create anything.

### Wire it up

Your provider class hands the host to `HostedProvider`, which turns it into a whole `ComputerProvider`, the interface
the rest of AgentRun calls.

```ts
export class E2BProvider extends HostedProvider {
	constructor(options: E2BProviderOptions) {
		// … check the options
		super(new E2BHost(Sandbox, connectionOptions({ apiKey, domain }), requestMs), { ...rest, kind, maxLifetimeMs });
	}
}
```

The same file exports `create(options)` and `conformance`, as `e2b.ts` does. Load your SDK
lazily through a constant like `E2B_PACKAGE` and pin it exactly as a root devDependency. `test/vendor-sdks.test.mjs`
finds that constant in your file and checks the pin.

The descriptor is data. AgentRun's Settings page shows it, and the registry loads your file through `load`.

```ts
export const E2B = defineProvider({
	id: "e2b",
	label: "E2B",
	keys: [{ name: "E2B_API_KEY", option: "apiKey", required: true }],
	metered: true,
	mounts: ["archil"],
	network: ["none"],
	capabilities: [SANDBOX, LINUX_DESKTOP],
	defaultImage: { sandbox: E2B_BASE_TEMPLATE, desktop: E2B_DESKTOP_TEMPLATE },
	load: () => import("../e2b.js"),
});
```

The tests that cover every provider read the descriptors, so your descriptor is the only list you add to.

Settings stores your key under the name your descriptor gives it, `<VENDOR>_API_KEY`. The conformance module reads it
as `COMPUTER_<VENDOR>_API_KEY` instead, so a test run never picks up a key your shell already holds for something else.
It reads your other settings as `COMPUTER_<VENDOR>_*` too, and creates nothing unless `AGENTRUN_COMPUTER_LIVE_<VENDOR>=1`.
Rename E2B's and keep its exports: `createProvider`, `createDriftedProvider` (its daemon reports another version, and
the suite checks AgentRun refuses it), `createHost` for the exec pre-check and the sweep, `conformanceImage` and
`conformanceNotes`.

Unit-test what needs no network, as `test/e2b-provider.test.mjs` does: your capabilities, your `check`, how the key and
endpoint reach your SDK, and the settings your conformance module reads. A small fake of the SDK calls you make, which
records what it's given, is fine for that. You don't need a fake that behaves like your vendor. AgentRun tests its own
lifecycle against one fake host, and your live run is the proof.

### Prove it

Without Go, `build:daemon` takes AgentRun's daemon from the same version on npm, as long as your checkout's daemon
source is that version's. If you or your branch changed the daemon, you need Go to build it. The drift case always needs Go on your PATH, because it compiles a second copy of the daemon that reports another
version. Build, then run the suite with your own key between two sweeps, from the repository root:

```sh
npm ci --ignore-scripts && npm run build
npm run build:daemon -w @parcha/agentrun-computer
export AGENTRUN_COMPUTER_LIVE_<VENDOR>=1 COMPUTER_<VENDOR>_API_KEY=<your key>
node packages/computer/dist/conformance/sweep.js --provider <vendor> --before /tmp/<vendor>-before.json
npm run conformance -w @parcha/agentrun-computer -- --provider <vendor>
node packages/computer/dist/conformance/sweep.js --provider <vendor> --after /tmp/<vendor>-before.json
```

The first sweep records what your account already holds. The second deletes anything the run left behind and prints
what is still there. `--kind sandbox` or `--kind desktop` runs one kind's cases, and `-- --help` lists every flag.

A desktop also needs the fixture its input cases check against, built for your machines' arch (`GOARCH=amd64` or
`arm64`). Without it those cases skip and the run fails. Build it, then add `--fixture /tmp/computerd-fixture`:

```sh
(cd packages/computer/daemon && CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -o /tmp/computerd-fixture ./cmd/fixture)
```

### What passing looks like

A real Daytona run, trimmed. It had 68 passes, 0 failures and 45 skips, and left nothing behind.

```text
computer conformance · daytona · linux, daemon child · computerd 0.1.0-beta.36 linux/amd64
core health    hello ping unknown-method kind-consistent    ✓ 7
               kind-served declared no-key-in-errors
core exec      argv streams exit-code cwd env timeout abort ✓ 11
               truncation setsid-escapee unprivileged user
core files     home write-read stat list mkdir move remove  ✓ 18
               …
core process   outlives-connection read-by-offset stdin     ✓ 14
               …
core provider  check-refuses create-release attach list     ✓ 9
               stop owner detach network-change deadline
core drift     hello-matches arch network version           ✓ 4
core isolation vendor-agent                                 ✓ 1
full provider  create-retried create-after-release          ✓ 3 - 6
               …
  - provider.network-open: the provider does not declare network:open
  …
optional screen    screenshot-size watch                        - 2
  - screen.screenshot-size: the provider does not declare screen
  …
daemon computer-… (shared): computerd 0.1.0-beta.36 linux/amd64 · fence netns
core PASS 64/64 · 13 optional cases skipped, not declared · full 4/36 · user:root user:uid persistence … not declared
```

The second sweep:

```text
{"swept":0,"gone":0,"stillThere":[],"leftAlone":0}
```

`✓` counts passes, `✗` failures and `-` skips, and every skip says why. The 45 skips aren't failures. They're cases for
groups Daytona doesn't declare, such as screen and mounts. That's 13 Core cases only a desktop needs, listed as
optional, and 32 Full cases for capabilities it doesn't offer. Only Core decides whether a run passes. Core is the set of
cases every computer of your kind must pass. The run passes when the last line reads `core PASS` and the command exits
0. `"stillThere":[]` means the run left nothing on your account.

### Send it

Open a pull request with the report and the sweep's last line pasted in, and fill in the four-line provider checklist
in the pull request template.

## Reference

### What a provider declares

Every provider has a descriptor and answers `capabilities()` with its kind, OS, daemon, groups (exec, files, screen
and so on), lifetime, networks, isolation, release, users and mounts. On a `MachineHost` these come from `facts`, the descriptor
(networks and mounts) and the provider's options, so you write none of them by hand. The case `health.declared` checks `capabilities()` against the
descriptor, and each computer's `hello` against `capabilities()`. [spec/computer/provider.md](../../spec/computer/provider.md)
says what each member promises.

A mount kind your machines can't take goes in the descriptor's `unmounted`, with why in one sentence, and `check()`
refuses it in those words. Daytona declares no mount: `unmounted: { archil: "Archil mounts don't work on Daytona yet:
Archil's client hangs on its sandboxes" }`.

If your machines can't run Linux as root, the adapter doesn't fit, and you'd implement `ComputerProvider`
(`src/provider.ts`) directly. That's a big job, because the adapter's whole lifecycle, claims and all, becomes yours to
write.
Talk to us first, in [an issue](https://github.com/Parcha-ai/agentrun/issues).

### Refusals

Every call answers `{ ok: true, value }` or `{ ok: false, error: { code, message, vendor? } }` and never throws. The
message is words a person can act on. It never holds a key, a token or a bearer URL, and `health.no-key-in-errors`
plants keys to check. The codes are a closed set (`ComputerErrorCode` in `src/result.ts`). A provider never adds one.

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

### How the report judges a run

- **Core and Full.** A Core case is what every computer of its kind must do. On Linux with a daemon, that means exec,
  files, processes and network `none`, plus your agent's ports for a `child` daemon. A desktop adds screen, pointer and
  keys. A Full case tests an optional capability and runs only where you declare it.
- **Skips.** A Core case that needs something you don't declare, or another OS, is listed as `optional` and doesn't
  count. Any other Core skip, such as a desktop run with no fixture, fails Core.
- **Leftovers.** At the end the runner lists the run's label and sweeps it. `cleanup.left`, `cleanup.errors` and
  `cleanup.sweep.stillThere` must all be empty. A leftover prints `cleanup ✗ left <ids>` and fails Core.
- **The verdict.** Core is `pass` when every Core case passed and nothing was left, `partial` when `--only` left Core
  cases out, and `fail` otherwise. Full results never change it. The exit code is 0 for pass, 1 for fail, 2 for a usage
  error and 3 for partial. With `--kind`, the run ends on `kind <kind> PASS` or `kind <kind> FAIL: <reasons>` and exits
  0 or 1.

The package README's [Conformance](README.md#conformance) section has the JSON shape that `--json` prints.

### What AgentRun does for your host

- **`check(spec)`** applies the shared rules (lifetime and its cap, network none, the label namespace, sizes, users,
  GPUs, the Archil mount), then your `check`.
- **`create(spec, { requestId })`** names the machine `computer-` plus the first 12 hex digits of the request id's
  sha256, so a retried create finds the machine it already made. It deletes a machine whose create landed after the
  caller gave up. When two creates race, it keeps the oldest machine and deletes the rest. Then it waits for the machine
  to run, holds your read-back to the request, uploads the daemon and checks its sha256, starts it, and probes from
  inside that the network is none. If any step fails after the machine exists, it deletes the machine and waits until
  it reads gone.
- **The rest** covers `attach`, `list`, `connect`, `network` (fixed at create), `extend` (where your host has
  `extend`), `release` (delete, then wait until `get` and `list` read it gone; a stop waits until both read it
  stopped, or gone where a stop deletes it, and asks again while it reads running), `watch` and `testConnection`.
  Every refusal uses the codes above, and `vendor` carries your API's own words.

### The live sweep

`--before <file>` records every machine listed with `agentrun.computer=1`. `--after <file>` deletes each new machine
that carries a conformance run's label (`agentrun.conformance`) and reads it back gone. It leaves alone everything
recorded before, and any new machine without that label, which belongs to someone else on the account. It prints
`{"swept":n,"gone":m,"stillThere":[ids],"leftAlone":k}` and exits 0 when every swept machine is gone, 1 when one is
still there, and 2 on a usage error. It reaches your API through the conformance module's `createHost({ env })`, which
reads the same settings as the run and needs no live switch. If one account holds more than one place to list, such as
an app and a server, the module also exports `sweepScope({ env })`, and `--after` refuses a file recorded for another
place.
