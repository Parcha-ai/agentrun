# Contributing a computer provider

AgentRun is an open-source platform for running AI agents. It gives each agent a computer, a sandbox or a desktop, on
a vendor's machines. This page shows how to add your machines in one pull request.

How 25 sandbox vendors fit this contract today, and what each provider would take: [the provider scorecard](SCORECARD.md).

## The first 30 minutes

Conformance comes first: each step ends on a command that tells you whether it's done. Run them from the repository root.

1. Check that your API has the [two things AgentRun needs](#what-your-api-needs), and find its
   [exec shape](#exec-shapes-that-work).
2. Write your host's constructor, `exec` and `createHost`, then run the [exec pre-check](#step-one-run-the-exec-pre-check)
   on one machine until it prints `exec PASS`. Make that machine the way your vendor makes them: by hand in its console;
   through the relay you ship, once it is deployed to your own account; or, on a cloud, in the cluster, group or project
   you made first. `--machine` takes whatever your `exec` takes, the id `create` answers and `get` reads (a name is fine):
   `npm run conformance -w @parcha/agentrun-computer -- --provider ./packages/computer/dist/<vendor>.js --exec-stream --machine <machine id>`
3. Copy `e2b.ts` into [the four files](#what-you-write) and fill in [the eleven members](#the-eleven-members).
4. Run the [whole suite between two sweeps](#prove-it) until its last line reads `core PASS`:
   `npm run conformance -w @parcha/agentrun-computer -- --provider <vendor>`
5. [Open the pull request](#send-it) with the report and the sweep's last line.

To see a pass before you write anything, point the pre-check at a stub. It takes seconds and needs no key. Make a module
that exports `createHost = async () => fakeExecHost()`, from `packages/computer/test/fake-exec-host.mjs` (its `exec`
runs local processes), and pass its path to `--provider`, with `--machine local --quick`.

## How to contribute a provider

### What your API needs

AgentRun needs two things from your API:

- **A streaming, two-way exec.** You start a process in a machine as root, write to its stdin and read its stdout and
  stderr while it runs. AgentRun talks to its daemon over one such process for the machine's whole life.
- **A list by label.** You can list your machines by a label, tag or metadata pair that AgentRun sets at create.
  A vendor whose API keeps no labels does not fit yet: a provider needs a place for them, kept by the vendor or by us.

### Exec shapes that work

Whatever carries it, your `exec` keeps five rules, and the [exec pre-check](#step-one-run-the-exec-pre-check) judges
it by them alone:

- **Text intact both ways, live.** UTF-8 text in and out while the process runs: every code point, lines of any
  length, `\r` and `\r\n` as they were, and no terminal (a tty turns `\n` into `\r\n`). Decode output as one stream,
  so a character split across two pieces comes back whole. Bytes that aren't UTF-8 needn't pass: AgentRun sends its
  daemon as base64 text.
- **stdin needn't end.** Where your API has no end of file, `end()` may do nothing: nothing AgentRun runs waits for
  one (the default upload reads a length, a root command's input is one line, the bridge ends by `kill`), and the
  pre-check never ends stdin.
- **`kill()` ends the process in the machine**, not only your streams: the pre-check reads its pid back gone. Where
  your API has no kill, start the process under `PID_WRAPPER` and kill it over a second exec with `pidKill`, both in
  [`src/hosted/scripts.ts`](src/hosted/scripts.ts): the wrapper puts the process's pid first on stderr, and the kill
  ends it and every process under it.
- **stderr apart**, and `wait()` answers the process's own exit code.
- **No timeout.** No command timeout and no idle timeout on the stream: the bridge sits silent for minutes.

| Your API gives | Your `exec` | In the tree |
| --- | --- | --- |
| A native two-way process stream | reads the stream's bytes itself | E2B, [`src/e2b.ts`](src/e2b.ts) |
| Split calls: one starts a process, one streams its output as text, one call per stdin write; maybe no end of stdin or kill | the three calls, handed to `framedExec`, which queues the writes, decodes the output and kills by pid ([below](#a-text-exec-in-split-calls)) | Daytona, [`src/daytona.ts`](src/daytona.ts): a session command, its log WebSocket, and its input call, which takes whole lines; the tests' REST-shaped vendor, [`test/fake-text-host.mjs`](test/fake-text-host.mjs) |
| The same, with the output as server-sent events (`text/event-stream`) | the same calls, with `sse` reading the events ([below](#output-as-server-sent-events)) | none yet; Hyperbrowser's shape, the same fake |
| SSH to an sshd in the machine | opens one SSH channel per process, as the user and with the auth your vendor gives | Agent37, [`src/hosted/ssh-exec.ts`](src/hosted/ssh-exec.ts): root with a private key, over a WebSocket tunnel to the instance's sshd, and the shared pid wrapper for `kill`. Morph, [`src/morph.ts`](src/morph.ts): the same SshExec over plain TCP to the vendor's gateway, as the instance id with the instance's own key, read over REST; never an account key in the username, since an unpinned gateway would read it |
| An exec only inside its SDK | calls the SDK, loaded lazily and pinned exactly ([Wire it up](#wire-it-up)) | Modal's `sandbox.exec(argv, { mode: "binary" })`, [`src/modal.ts`](src/modal.ts). Modal has no kill for an exec, so its `kill` kills by the pid the shared wrapper reports |
| Any binary two-way stream into the machine (a WebSocket, an open port) | runs a relay of yours in the image that starts the process and carries its three streams and its kill | none yet |
| No exec, only screen and input calls | none: this isn't a `MachineHost`. Write a `ComputerProvider` with daemon `none` that answers the methods itself | Orgo's Windows and macOS desktops, [`src/orgo-desktop.ts`](src/orgo-desktop.ts); the phone harness, [`src/phone-harness.ts`](src/phone-harness.ts) |

One shape can't carry the daemon today. A request and response exec (one call runs a command and answers its output
when it ends) can't hold a process open: it needs a relay over another stream. The pre-check judges a relay as it
judges any exec. If none of these fits, [open an issue](https://github.com/Parcha-ai/agentrun/issues) that says what
your API offers.

#### A text exec in split calls

`framedExec` from `src/hosted/framed-exec.ts` takes your vendor's calls about one process and answers the
`MachineProcess` that `exec` returns. Each `write` gets whole characters and starts once the one before it answered;
a write that fails fails every one after it. Output is read no faster than AgentRun reads it. An `events` that
throws ends the output and fails `wait()` with its error. Without `kill`, the
process starts under a `sh` that writes its pid and start time to stderr first, and `kill()` kills that pid and
every process under it, only while it has that start time, so a reused pid is never hit. Without `end`, `end()` does nothing, so a command that reads to end
of file never ends; AgentRun runs none. `rest`'s `stream` reads a response's body as it comes, with the call's
timeout on its headers alone, and `ndjson` reads that body a line at a time. For an API whose output events are
`{"stream":"stdout","text":"…"}` lines, then `{"exit":0}`:

```ts
const api = rest({ base, headers: () => ({ Authorization: `Bearer ${key}` }), vendor: "acme", timeoutMs: 30_000 });
const exec = (id: string, argv: readonly string[], ctx: HostCall) =>
	framedExec<string>(
		{
			start: async (argv, ctx) => (orThrow(await api.json("POST", api.url(`/machines/${id}/processes`), { json: { argv }, timeoutMs: ctx.timeoutMs })) as { id: string }).id,
			events: async function* (pid) {
				yield* ndjson(orThrow(await api.stream("GET", api.url(`/processes/${pid}/events`))).body) as AsyncIterable<FramedEvent>;
			},
			write: async (pid, text) => void orThrow(await api.call("POST", api.url(`/processes/${pid}/stdin`), { json: { text } })),
		},
		argv,
		ctx,
	);
```

An event may carry `base64` in place of `text` for output that isn't text. The tests run this host against a
loopback vendor ([`test/fake-text-host.mjs`](test/fake-text-host.mjs)) through the pre-check and the shared adapter's
create.

#### Output as server-sent events

`sse` from `src/hosted/rest.ts` reads a `text/event-stream` body as the HTML standard says: comments (a keep-alive)
are skipped, `data:` lines are joined, and each event carries the last `id:` and `retry:` the stream set, which a host
that resumes a dropped stream asks from. Hyperbrowser's process API is this shape: `POST /sandbox/processes` answers
the process's stream, `event: started` with its id, then `event: output` with `data: {"stream":"stdout","encoding":
"base64","data":"…"}`, where `stream` may also be `system` (the runtime's own lines, not the process's), then
`event: done` with `data: {"exit_code":0}`. Its stdin and kill calls take that id. `start` reads the stream as far as
the id and hands the rest to `events`:

```ts
const quote = (word: string) => `'${word.replaceAll("'", "'\\''")}'`;
const stdin = (id: string, json: object) => api.call("POST", api.url(`/sandbox/processes/${id}/stdin`), { json });
const exec = (argv: readonly string[], ctx: HostCall) =>
	framedExec<{ id: string; stream: AsyncGenerator<SseEvent> }>(
		{
			async start(argv, ctx) {
				const command = `exec ${argv.map(quote).join(" ")}`; // exec: the vendor's kill reaches argv, not a sh
				const stream = sse(orThrow(await api.stream("POST", api.url("/sandbox/processes"), { json: { command }, timeoutMs: ctx.timeoutMs })).body);
				const first = await stream.next();
				if (first.done || first.value.event !== "started") throw new Error("the process's stream ended before it started");
				return { id: (JSON.parse(first.value.data) as { id: string }).id, stream };
			},
			async *events({ stream }) {
				for await (const { event, data } of stream) {
					const value = JSON.parse(data);
					if (event === "done") yield { exit: value.exit_code };
					else if (event === "output" && value.stream !== "system") yield { stream: value.stream, base64: value.data };
				}
			},
			write: async ({ id }, text) => void orThrow(await stdin(id, { data: Buffer.from(text).toString("base64"), encoding: "base64" })),
			end: async ({ id }) => void orThrow(await stdin(id, { eof: true })),
			kill: async ({ id }) => void orThrow(await api.call("DELETE", api.url(`/sandbox/processes/${id}`))),
		},
		argv,
		ctx,
	);
```

The tests run the same host against a Hyperbrowser-shaped loopback vendor, the same fake, through the pre-check.

### Step one: run the exec pre-check

Before you write anything else, write your host's constructor and its `exec` (see [the eleven members](#the-eleven-members)
below). Then write a `createHost({ env = process.env } = {})` in your conformance module that builds the host from
your key (the pre-check calls it with `{}`, the sweep with `{ env }`), and point to that module from your provider file
with `conformance`, as `e2b.ts` does. E2B's `createHost` in `src/conformance/e2b.ts` is three lines. Make one machine
(in your console, through your relay, or in your cloud project), then run, from the repository root:

```sh
npm ci --ignore-scripts && npm run build
export COMPUTER_<VENDOR>_API_KEY=<your key>
npm run conformance -w @parcha/agentrun-computer -- --provider ./packages/computer/dist/<vendor>.js --exec-stream --machine <machine id>
```

It calls `exec` and nothing else, and checks the five rules: text of every kind of code point with `\r`, `\r\n` and a
1 MiB line each way, 8 MiB of random UTF-8 by sha256, stdin and output while the process runs, stderr, the exit code,
`kill`, and a silent process of 75 seconds (`--quick`: 5). It also writes 4 MiB to `cat` while its stdout is left
unread for 10 seconds, then reads it: a write may wait for the reader, but it must go on once stdout is read, and every
byte must come back in order. Each failure says what your exec did wrong, such as "U+000A (at byte 12) came back on
stdout as 0d 0a 0b 0c: your exec turns \n into \r\n, as a terminal does". When it prints `exec PASS`, write the rest.
Every command it starts stays under 32 KiB of argv (the 1 MiB line is made in the machine), so a vendor that caps a
command's arguments at 64 KiB, as Modal does, runs it.

After the checks it prints what the machine offers, each fact with what it means for your host: whether root can make
a network namespace (`unshare -n`, else `unshare -Urn`, the gVisor fence), whether root can open `/dev/fuse` (an Archil
mount), `uname -m` for `facts.arch`, the kernel, and the TCP listeners for `facts.vendorAgentPorts`. The facts pass or
fail nothing.

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

A worked example from outside the core team: [`boxd.ts`](src/boxd.ts), a janitor-lifetime host over a vendor SDK, with
its descriptor, conformance module and fake-SDK tests (`test/boxd-provider.test.mjs`).

### The eleven members

A host has eleven members: `descriptor`, `facts`, `create`, `get`, `list`, `delete` and `exec`, then the optional
`upload`, `errorCode`, `extend` and `check`. Every snippet below is cut from E2B's host in `src/e2b.ts`, and `// …`
marks a cut. A member answers its value, or throws. AgentRun reads a thrown error's code: a `HostError(code, message)`
(from `src/host.ts`) carries its own, and any other error goes through `errorCode`, then defaults to `"vendor"`. Each
call gets `ctx` with a `timeoutMs` and sometimes a `signal`. Pass both to your client where you can. A vendor with no
two-way exec leaves out `exec` and `upload`, and its machines dial in instead ([Machines that dial in](#machines-that-dial-in)).

**`descriptor`** is your descriptor (below). Errors with code `vendor` name its id, refusals name its label, and the
provider's network, mounts, and each kind's groups and GPUs are the ones it declares.

```ts
class E2BHost implements MachineHost {
	readonly descriptor = E2B;
```

**`facts`** says what your machines are. It never changes, and AgentRun builds the provider's capabilities from it.
`daemon: "child"` means your vendor starts AgentRun's processes through its exec, and AgentRun starts its daemon that
way at boot; with `"pid1"`, the machine's main process is the command AgentRun passes to create. `lifetime: "vendor"`
means your timer ends a machine at its deadline; with `"janitor"`, AgentRun ends it by label. `vendorAgentPorts` are
the TCP ports your vendor's agent listens on inside the machine. `[]` is right when none listens on TCP (it is reached
over a unix socket or a virtio device, or nothing of the vendor runs in the machine): the Core case
`isolation.vendor-agent` still runs, and checks that the computer's programs reach only their own loopback and no unix
socket but the computer's own. The pre-check prints the listeners.
If your image leaves system paths that root runs or reads with permissions wider than root's, list them in `rootOnly`:
create makes them root's alone (root the owner, no write by group or other users) before anything else, and the Core case `isolation.root-runs` checks
that the computer's user can write nothing root runs. `HostFacts` in [`src/host.ts`](src/host.ts) lists the optional fields, such as `user` and `labels`.

`maxLifetimeMs` in `facts` is the longest any of your plans keeps a machine. For E2B that's Pro's 24 hours
(`PRO_MAX_MS`). Your provider's `maxLifetimeMs` option is the cap a user gets, and it may only lower the fact. Default
it to the plan most people are on, which is also the plan you test on. For E2B that's Hobby's 1 hour (`HOBBY_MAX_MS`).
A user on a bigger plan raises the option, up to the fact. If your vendor documents no cap, measure it (keep a machine
until the vendor ends it) and write down where the number came from; don't guess one. If your vendor never ends a
machine, the cap is the janitor's, as Agent37's 24 hours (`DAY_MS`, `src/agent37.ts`).

Switch off every vendor timer that ends a quiet machine (an idle stop or sleep): a computer sits quiet for minutes, and
the vendor would end it under the agent. Agent37's `create` sends `auto_sleep: false`, and Daytona's idle stop is off
unless a user sets `autoStopMinutes` (`src/daytona.ts`). Where the idle timer can't be switched off, your vendor
doesn't fit yet. With `"janitor"`, where your vendor has a timer that deletes or stops, set it to `req.backstopAt`, so a machine still ends if
AgentRun's server is gone.

```ts
	readonly facts: HostFacts = {
		daemon: "child",
		isolation: "microvm",
		lifetime: "vendor",
		maxLifetimeMs: PRO_MAX_MS,
		arch: "amd64",
		vendorAgentPorts: [ENVD_PORT],
		// …
	};
```

**`create(req, ctx)`** makes one machine and answers as soon as you have its id. Don't wait for it to boot, because
AgentRun polls `get`. The exception is a vendor that applies a machine's settings only once it is ready, as boxd does
its egress allowlist (`["none"]`, network none) and its idle hibernation timer: there `create` may wait until the
machine is ready, within `ctx.timeoutMs`, set them, and answer then. Store `req.labels` on the machine, since `list`
finds machines by them. Where your API keeps fewer or shorter labels than AgentRun writes, declare
`labels: { count, bytes }` in `facts`, and where its values are short, `labels: { packed: { valueBytes } }`. Where your API takes `req.name` and refuses a name it already holds (a 409), throw
`HostError("exists", …)`: AgentRun lists that name and adopts the machine, as a retry of the request does. `req.egress` is `false` for a computer whose network is `none`, except with an Archil storage
mount. There AgentRun asks `true` so its root can reach Archil, and the agent's programs still have no network. It is
`true` under `open` or a list: the egress proxy init starts goes out through the machine's network, and the agent's
programs reach it alone. `req.cpus` and `req.memoryMb` come whenever the spec gives them: a
vendor whose size is its image's refuses them in its own `check`.

```ts
	async create(req: MachineRequest, ctx: HostCall): Promise<{ id: string }> {
		const timeoutMs = Math.ceil(req.lifetimeMs / 1000) * 1000;
		const options: SandboxOpts = {
			...this.#api(ctx.timeoutMs),
			timeoutMs,
			metadata: { ...req.labels, [TIMEOUT_LABEL]: String(timeoutMs) },
			allowInternetAccess: req.egress,
			// …
		};
		const sandbox = await this.#Sandbox.create(req.image, options);
		// …
		return { id: sandbox.sandboxId };
	}
```

**`get(id, ctx)`** reads one machine as your API sees it now, as a `Machine`:
`{ id, labels, state, name?, image?, endsAt?, createdAt?, why? }`.

- `state` is `starting`, `running`, `stopped` (there but not running, such as paused) or `gone` (being deleted,
  ended, or failed).
- `endsAt` is when your timer ends it, with `lifetime: "vendor"`.
- `createdAt` is when your API made it. Of two racing creates' machines, AgentRun keeps the oldest.
- `why` is your API's words for a machine that failed to start, which is `gone`.

A machine that no longer exists is `undefined`, or an error that maps to `not_found`; neither is a failure. So is your
vendor's record of a machine that is deleted and won't come back (Hyperbrowser's `closed`, Blaxel's `TERMINATED`): `get`
answers `undefined` for it and `list` leaves it out. `gone` is a machine still being destroyed, and it holds the wait
after a delete, so a record read `gone` makes every delete wait out its bound. Don't read
back what create sent: AgentRun checks the machine from inside. `get` never wakes a machine: a read that resumes a
paused or ended one undoes a deadline or a delete. If your vendor's reads wake machines, read through one that
doesn't, or make machines in the vendor's mode that doesn't keep them. A deleted machine stays gone after any call: the
Core case `provider.create-release` checks that after the delete, a connect, an `attach` by id and `list` all find nothing.

Some vendors have states beyond these four:

| Your vendor says | `state` |
| --- | --- |
| recovering, restoring, temporarily unavailable | `starting` |
| needs a person's decision before it goes on | `stopped`: create gives up on it, and the janitor still ends it |
| ended by the platform (an eviction, a cap) | `gone`, with the platform's words in `why`; one it stopped and still keeps (a disk, a bill) is `stopped`, so the janitor still finds and deletes it |
| deleted, kept as a record | `undefined` |
| only a running flag | `running` when it is set. `create` waits until it is, within `ctx.timeoutMs`; after that, unset is `stopped` |

```ts
	async get(id: string, ctx: HostCall): Promise<Machine | undefined> {
		return machineOf(await this.#Sandbox.getInfo(id, this.#api(ctx.timeoutMs, ctx.signal)));
	}
```

**`list(labels, ctx)`** returns the machines your listing shows for these labels, every page, within `ctx.timeoutMs`,
in the same shape as `get`. The listing finds; `get` answers: AgentRun takes only the ids from your listing and reads
each one by `get` for its state, labels and end, and drops one `get` reads as not found. So your listing may be stale,
as E2B's is (it can still show a deleted machine, or an end from before a timer moved). You may return machines that
don't carry every label (your API filters by some, or none): AgentRun keeps the ones whose `get` does. Your listing
may also trail a create: create waits up to `timeouts.listedMs` (15 s) for it to show the new machine, then reads the
machine by `get`, and keeps one that reads running with its labels (with a note), as Daytona's eventually consistent
listing needs. Any other answer fails create `timeout`.

```ts
	async list(labels: Record<string, string>, ctx: HostCall): Promise<Machine[]> {
		// …
		const paginator = this.#Sandbox.list({ ...this.#connection, requestTimeoutMs: this.#requestMs, query: { metadata: labels }, limit: PAGE });
		// … every page into found
		return [...found.values()].map(machineOf);
	}
```

**`delete(id, ctx)`** deletes a machine and answers once your API accepts the delete. A machine that is already gone is
fine. AgentRun then waits until `get` answers `undefined` (or `not_found`), twice running: a machine `get` still reads
`gone`, one your API is still deleting, holds the wait. Delete is the only release: AgentRun never stops a
machine and keeps it. So a host never declares `persistence` today, even where your vendor can stop and resume:
`src/hosted/provider.ts` refuses `release` `stop` and `detach` in words.

```ts
	async delete(id: string, ctx: HostCall): Promise<void> {
		// …
		await this.#Sandbox.kill(id, this.#api(ctx.timeoutMs));
	}
```

**`exec(id, argv, ctx)`** starts `argv` in the machine as root, or as a user with passwordless sudo, and answers once
the process has started. It returns a `MachineProcess` with the output streams, `write` and `end` for stdin, `wait`
for the exit code, and `kill`. stdin is always open: AgentRun calls `end` itself, at once for a command it gives no
input. AgentRun installs and starts its daemon this way, then talks to the daemon over one process's stdin and stdout
for the machine's whole life, so it keeps the [five rules](#exec-shapes-that-work).

E2B's SDK runs `commands.run` in a login shell (`/bin/bash -l -c`), where root's profile, which the image may change,
runs first and sets `PATH`. So E2B's `exec` makes the same envd call itself, without the login shell: `/bin/sh` by its
path, the argv as its own words, `PATH` the system's directories alone:

```ts
	async exec(id: string, argv: readonly string[], ctx: HostCall): Promise<MachineProcess> {
		const sandbox = await this.#sandbox(id, ctx);
		// … ProcessRpc types the slice of envd's stream it reads: the SDK keeps rpc protected
		const events = (sandbox.commands as unknown as { rpc: ProcessRpc }).rpc.start(
			{ process: { cmd: ROOT_SHELL, args: [...ROOT_SHELL_ARGS, ...argv], envs: { PATH: ROOT_PATH } }, stdin: true },
			{ headers: { Authorization: ROOT, [KEEPALIVE_HEADER]: KEEPALIVE_S }, signal: stream.signal, timeoutMs: 0 },
		)[Symbol.asyncIterator]();
		// … the start event gives the pid; then each data event's bytes go to out or err as they come
		return {
			stdout: out,
			stderr: err,
			write: (bytes) => sandbox.commands.sendStdin(pid, bytes, { requestTimeoutMs }),
			end: () => sandbox.commands.closeStdin(pid, { requestTimeoutMs }),
			wait: () => exited,
			// … and kill
		};
	}
```

**`errorCode(error)`** is optional. It maps an error your client threw to one of AgentRun's [codes](#refusals).
AgentRun reads a `HostError`'s own code, an `AbortError` as `aborted` and a `TimeoutError` as `timeout` itself, and
anything you don't map is `"vendor"`. Map your vendor's not-found exception to `not_found`: AgentRun reads that from
`get` as a machine that is gone and from `delete` as done, so those two need no catch of their own. E2B's `errorCode`
returns `codeOf(error)`:

```ts
function codeOf(error: unknown): ComputerErrorCode {
	const name = (error as { name?: unknown } | null)?.name;
	if (name === "SandboxNotFoundError" || name === "NotFoundError" || name === "FileNotFoundError") return "not_found";
	// …
	return "vendor";
}
```

**Optional hooks.** `upload(id, path, bytes, ctx)` puts a file in the machine. E2B has one because it has a file API;
without it, AgentRun streams its daemon through `exec`'s stdin as base64 text, so the image needs `head` and
`base64` (coreutils and busybox both have them). `download(id, path, ctx)` hands back a file's bytes, read as root;
give it when your exec's output is slow (Daytona's is a log read at about 0.3 MB/s). A `files.read` past one chunk then
takes its first chunk from the daemon and the rest from a copy AgentRun makes as the daemon's user (`setpriv`,
util-linux) and downloads, so the read shows nothing that user can't read. `extend(id, endsAt, ctx)` moves a machine's end when
an agent extends its deadline: your timer with `lifetime: "vendor"`, AgentRun's deadline label with `"janitor"`. Never
move it past its `agentrun.computer.max-deadline` label, which AgentRun writes only on a host with `extend`. When no end your API takes lands there, throw
`HostError("limit", <why>)` and move nothing. AgentRun reads the end back through `get`, from the deadline label: if
your API keeps no label change, `get` reads your moved timer as that label. Without `extend`, a computer can't be
extended: leave it out when what it moves (your timer, or with `"janitor"` your labels) is fixed at create.
`check(spec)` adds your own rules for a spec, such as image names; the spec it gets is an object whose fields aren't
checked yet. Leave out what you don't need. Settings' test of your keys is one `list` by AgentRun's label, so a
`list` must never create anything.

### Machines that dial in

A vendor with no two-way exec, whose create boots an image with env, can still host computers: each machine dials the
server, and AgentRun talks to its daemon over that socket ([`attach.md`](../../spec/computer/attach.md#hosted-machines-that-dial)).
Declare `connect: "dial"` in `facts`, and write `descriptor`, `facts`, `create`, `get`, `list` and `delete`, with
`errorCode`, `extend` and `check` if you need them. Leave out `exec` and `upload`. The image is the box image, which
runs `agentrun-dial` when `AGENTRUN_ATTACH_URL` is set. Your `create` puts `req.boot.env` in the machine's env and runs nothing else. This
sketch's `api` stands for your client; the tested host is `test/fake-dial-host.mjs`:

```ts
readonly facts: HostFacts = {
	connect: "dial", daemon: "child", lifetime: "janitor", isolation: "microvm",
	maxLifetimeMs: 24 * 3_600_000, arch: "amd64", vendorAgentPorts: [],
};
async create(req: MachineRequest, ctx: HostCall) {
	const machine = await this.#api.createMachine({ image: req.image, env: req.boot?.env, metadata: req.labels }, ctx);
	return { id: machine.id };
}
// Where the provider is built: the server's public address, its machine tokens and its AttachHub.
new HostedProvider(host, { daemonPath, dial: { url: process.env.AGENTRUN_PUBLIC_URL, tokens, hub } });
```

- **Your server needs a public https address** (`AGENTRUN_PUBLIC_URL`) that the vendor's machines reach. A laptop with
  a tunnel (cloudflared, tailscale funnel) works. Run one server process: a machine's socket lands on the process it
  dialed. Without the address, or from a process with no attach hub, create is refused in words before your API is
  called. The daemon your machines fetch is `hostedDaemonPath(arch)`, the file whose SHA-256 they check.
- **Machines that reach listed addresses alone** dial through a relay the operator runs on that list: give it as
  `attachEgress` (`<IPv4 relay>:<port>`; Daytona's key `DAYTONA_ATTACH_EGRESS`). Create adds `AGENTRUN_ATTACH_EGRESS`
  to the boot env, and the daemon fetch and the attach socket open TCP to the relay and speak TLS and HTTP to the public
  host through it, unchanged.
- **The token sits in the machine's env**, scoped to that machine (its kind, os and arch) until delete or its
  `backstopAt`, whichever comes first. A machine that never dials within `createMs` is deleted.
- **No Archil mount.** A spec with one is refused in words (`mountsOf` drops it on dial).
- **A desktop over dial** works as on exec: create adds `DISPLAY` (`:0`) to the boot env, `agentrun-dial` gives it
  to init, and once the machine dials, its X server starts through computerd's `process.start` over that socket, as
  the tool user. Where the host's facts say `windowManager`, computerd starts xfwm4 itself (init `--window-manager`;
  see `daemon/internal/windowmanager`); hello's `windowManager` says how it went, and create waits on it. A machine
  minted a desktop may say `linux` (same os and arch) until its display answers; a `connect` while it says `linux`
  fails as drift, as on exec. Every dial provider takes one, from the box image, whose
  `desktop` step (`box/install.sh`) installs Xvfb, xfwm4, xfce4-terminal, mousepad, firefox-esr and thunar. A desktop gets the
  sandbox's size, 2 CPUs and 4 GiB by default, which holds Xvfb at 1280x800, xfwm4 and a browser:
  - **E2B**: its default on either connect, from the box template (the template's own size).
  - **Fly Machines**: `kind: "desktop"`; 2 shared CPUs and 4 GiB (`guest`), up to 8 shared CPUs and 2 GiB a CPU
    (fly-go's `MachineGuest`, as `src/fly.ts` holds it).
  - **Cloudflare**: `kind: "desktop"`; the relay's image is `FROM` the box image (`relays/cloudflare/Dockerfile`), and
    2 CPUs and 4 GiB pick standard-3, 2 vCPUs, 8 GiB and 16 GB of disk; an image may be as large as the instance's
    disk ([containers/platform-details/limits](https://developers.cloudflare.com/containers/platform-details/limits/)).
    The box image is about 400 MB compressed (amd64); its size unpacked is **unverified**, but well under standard-1's
    8 GB.
  - **Modal**: `kind: "desktop"` on `connect: "dial"` alone; 2 CPUs and 4 GiB on Modal's VM runtime, with no GPU (a GPU
    sandbox runs on gVisor). On `connect: "exec"` the constructor refuses a desktop in words; the descriptor's desktop
    configuration selects dial itself.
  - **Daytona**: `kind: "desktop"` on `connect: "dial"` alone, from the operator's snapshot of box/Dockerfile
    (`AGENTRUN_DAYTONA_SNAPSHOT`) at its 2 CPUs and 4 GiB, with no GPU. Its container sandboxes run under Sysbox on a
    kernel (Ubuntu 6.8) with `kernel.apparmor_restrict_unprivileged_userns=1`: root makes every namespace, but the tool
    user (uid 2510) can't write a user namespace's `uid_map` and can't make a network namespace (measured 11-19), so
    the window manager the client used to start under `unshare --user --net` failed there
    (`unshare: write failed /proc/self/uid_map: Operation not permitted`). computerd starts it now, as root makes its
    network namespace. On `connect: "exec"` the constructor refuses a desktop in kindRefusal's words, because a
    desktop's sandbox boots from the snapshot and dials, and none has run through the toolbox's session commands. The
    descriptor's desktop configuration selects dial itself. A self-hosted target whose runners let sandboxes reach
    listed addresses alone needs `DAYTONA_ATTACH_EGRESS`, the operator's relay on that list (above).

  Xvfb and the window manager over the dial were verified live (dial desktop runs 11-18/19: E2B, Fly, Cloudflare,
  Modal), with the client starting the manager. computerd's own start of it ran live on Daytona over dial (11-20):
  Core passed, the five desktop cases passed, every hello's `windowManager` said `running`, and a frame showed Mousepad
  framed by xfwm4. The other hosts have not yet run computerd's start live.
- **Prove it** as below. Your conformance module also exports `dialKit()`, the server your machines dial, for the
  Core case `provider.dial-token` (`test/fixtures/dial-provider.mjs` is one).
- **No REST call that starts a machine?** Ship a relay the operator deploys once, as Cloudflare's
  (`src/cloudflare.ts`; deploy and remove it as `relays/cloudflare/README.md` says).

A provider that can do both takes one option, `connect: "exec" | "dial"`, read once in its constructor, which picks
its host's facts: on `dial` the host declares `connect: "dial"` and has no `exec` or `upload`, and create boots the
machine with `req.boot.env`. Its descriptor declares the option as a setting with no default (`e2bConnect`,
`modalConnect`, `daytonaConnect`), so exec holds unless the server's settings say dial. E2B, Modal and Daytona do this.
Modal's create gives the sandbox `agentrun-dial` as its command and the env as `env`. The other two start
`agentrun-dial` themselves, once. A template's start command runs once at the template's build and never sees a
create's env, so E2B's create starts it through envd, with the env as that one process's
([README](README.md#e2b-on-dial)). Daytona's create starts it in a toolbox session once the sandbox reads `started`,
the URL on its line ([README](README.md#daytona-on-dial)). A host that starts it can give `dialLog(id)`, and a machine
that never dials then fails with its last lines first. One that can also read its exit gives `dialExit(id)`: an
`agentrun-dial` that exited fails create at once, and one that runs and keeps writing is waited for past `createMs`,
up to twice it. With `redial(id)` too, an exit of 3 (its fetch failed) or 5 (its init never listened, and was ended)
starts it once more in the same machine. Their conformance
modules' `dialKit()` refuse, since a machine dials the server that minted its token: the Core run happens inside the
public server's process.

#### Worked example: Fly Machines

[`src/fly.ts`](src/fly.ts) is a dial host on the [Machines API](https://fly.io/docs/machines/api/machines-resource/).
`create` posts the box image as `config.image`, `req.boot.env` as `config.env` and the labels as `config.metadata`, with
`auto_destroy: true` and restart policy `"no"`: once init's deadline ends the daemon, the machine stops and Fly destroys
it. `list` filters by `metadata.<key>=<value>`, `delete` passes `force=true`, and `extend` writes the deadline label
alone, for the janitor. Each Fly fact has its doc link in the file, and the ones the docs leave open say **unverified**.

The machines live in one Fly app of yours, the `FLY_APP` setting (`COMPUTER_FLY_APP` for Core). Fly app names are
global across all of Fly, not per org, so give it a name with your org in it, `agentrun-computers-<org slug>`:
`POST /v1/apps {"app_name": "agentrun-computers-<org slug>", "org_slug": "<org slug>"}`, or
`fly apps create agentrun-computers-<org slug> --org <org slug>`. A bare `agentrun-computers` is likely held already.
For an app that exists in an org your token can't see, Fly answers `403 unauthorized`, not `404`. Our own runs use
`agentrun-computers-parcha`.

Core for any dial provider runs inside the server its machines dial: `packages/serve/scripts/dial-conformance.mjs`,
in the server's image at `/opt/agentrun/packages/serve/scripts/`. It runs serve's attach routes on `$PORT`, runs Core
with `--long`, prints the report between `DIAL-CONFORMANCE-REPORT-BEGIN` and `-END`, then idles until it is stopped.
Before the report, a desktop's run prints the last whole-screen shot its cases read, as base64 lines between
`DIAL-CONFORMANCE-FRAME-BEGIN <sha256> <bytes>` and `DIAL-CONFORMANCE-FRAME-END`. The report's `daemons` carry each
hello's `windowManager`, so a live run shows that computerd started the manager
(`--exit` exits 0 on a pass, else 1):

```sh
COMPUTER_FLY_API_TOKEN=… COMPUTER_FLY_APP=agentrun-computers-<org slug> AGENTRUN_PUBLIC_URL=https://… PORT=8080 \
  node packages/serve/scripts/dial-conformance.mjs --provider fly
```

`COMPUTER_FLY_KIND=desktop` runs the desktop suite (unset, linux); Cloudflare, Modal and Daytona's modules read `COMPUTER_CLOUDFLARE_KIND`, `COMPUTER_MODAL_KIND` and `COMPUTER_DAYTONA_KIND` the same way.

### Wire it up

Your provider class hands the host to `HostedProvider`, which turns it into a whole `ComputerProvider`, the interface
the rest of AgentRun calls.

```ts
export class E2BProvider extends HostedProvider {
	constructor(options: E2BProviderOptions) {
		// … check the options
		super(new E2BHost(Sandbox, connectionOptions({ apiKey, domain }), timeoutsOf(rest.timeouts).requestMs), { ...rest, kind, maxLifetimeMs });
	}
}
```

The same file exports `create(options)` and `conformance`, as `e2b.ts` does. Load your SDK
lazily with `vendorSdk(label, "<package>")` (`src/vendor-sdk.ts`), never an `import()` of your own, and pin it exactly in
this package's `optionalDependencies`: a plain `npm install` then brings it, and without it `create` says
`E2B needs the e2b package: npm install e2b@2.63.0`. `test/vendor-sdks.test.mjs` finds the call in your file and checks
the pin against the lockfile.

The descriptor is data. AgentRun's Settings page shows it, and the registry loads your file through `load`.

```ts
export const E2B = defineProvider({
	id: "e2b",
	label: "E2B",
	keys: [{ name: "E2B_API_KEY", option: "apiKey", required: true }],
	metered: true,
	mounts: ["archil"],
	network: ["none", "open", "allow"],
	capabilities: [SANDBOX, LINUX_DESKTOP],
	prepareImage: true,
	load: () => import("../e2b.js"),
});
```

A descriptor declares only the network forms its computer enforces; a form it doesn't declare is refused at save, never
widened. On a vendor whose root can make a network namespace (or one inside a user namespace, as on Modal's gVisor),
AgentRun enforces all three itself: init's fence holds `none`, and init's egress proxy holds `open` and a list
(`src/hosted/network.ts`). So declare all three, even if your vendor has no network control. A vendor policy (deny-all
for `egress: false`, as Agent37's `create` sends) is optional hardening and never wider than ours; a host may ignore
`egress: false` where it has none, since the fence holds without it. The probe from inside is what counts. If root can
make no network namespace, init can't fence and refuses to start, so the shared adapter doesn't fit: declare nothing
your machines can't hold.

**Your image.** A vendor whose stock image will do names it in `defaultImage` by setting kind. A computer that mounts
an Archil disk or shows a desktop needs the box image (`box/`), so E2B's descriptor names no `defaultImage`: it says
`prepareImage: true`, and the provider class has `prepareImage(ctx)`. A server calls it before its first create and puts
its answer in `spec.image` ([the contract](../../spec/computer/provider.md#prepareimage)). The in-tree ones are the
references: E2B answers a public template (`boxE2bTemplate()`) and Modal a public registry tag (`boxImageRef()`), both
with no call; Agent37 registers the published image as a template (`agentrun-box-<hash>`); Docker builds locally.

If your vendor builds images in your account (a snapshot, a blueprint, a template), build the box image there.
`box/install.sh` is every step of its build, as POSIX shell. Boot your vendor's base (`python:3.12-slim`, the box
Dockerfile's `FROM`), put `install.sh` and `agentrun-archil` in one folder, run `install.sh` as root, and snapshot the
machine under a name that carries the recipe's hash. The provider in `test/conformance-image.test.mjs` runs this on the
fake host, with an in-memory vendor:

```ts
async prepareImage(ctx: CallContext & { onWait?: (making: "build" | "pull", tag: string) => void } = {}): Promise<Result<string>> {
	const name = `agentrun-box-${boxRecipeHash()}`; // install.sh is in the hash: a changed build is a new name
	const vendor = (this.host as VendorHost).client;
	try {
		if (await vendor.findSnapshot(name, ctx)) return ok(name); // a second call ends here: no build, no onWait
		ctx.onWait?.("build", name);
		const machine = await vendor.boot("python:3.12-slim", ctx);
		try {
			for (const file of ["install.sh", "agentrun-archil"]) {
				await vendor.upload(machine, `/tmp/agentrun-box/${file}`, await readFile(new URL(`../box/${file}`, import.meta.url)), ctx);
			}
			await vendor.run(machine, ["sh", "-c", "sh /tmp/agentrun-box/install.sh && rm -rf /tmp/agentrun-box"], ctx); // as root
			await vendor.snapshot(machine, name, ctx).catch(async (error) => {
				// refused because another server's build of the same recipe made it first: that image is this one
				if (!(await vendor.findSnapshot(name, ctx))) throw error;
			});
		} finally {
			// its own deadline, not the caller's signal: a cancelled build still deletes its machine
			await vendor.delete(machine, { signal: AbortSignal.timeout(60_000) });
		}
		return ok(name);
	} catch (error) {
		return fail(codeOfError(this.host, error), `building the box image ${name}: ${error instanceof Error ? error.message : String(error)}`);
	}
}
```

Call `onWait` only when you build or pull. `findSnapshot` here answers true for a snapshot that is ready; if your
vendor lists one while it is still being made, wait for it, bounded by `ctx.signal`, before you answer it. `install.sh`
ends the same when run twice on one machine, so a retried build is safe. A first build takes minutes, once per account and recipe. The method is the declaration; the
descriptor's flag says the same to Settings, which reads descriptors without loading a provider, and the Core case
`provider.prepare-image` fails a provider where the two disagree, and calls `prepareImage` twice: it fails a second
call that builds, pulls or answers another image.

Two more shapes take `box/Dockerfile` as it is, with no other base, layer or entrypoint:

- **Your vendor takes an image from its own registry** (Vercel Sandbox, from Vercel Container Registry): build the box
  image and push it there under the tag `agentrun-box:<hash>` (`vercel vcr build docker . agentrun-box:<hash> --push`,
  run in `box/`).
- **Your vendor builds from a Dockerfile on its side** (Hyperbrowser, `hx vm image build --remote`, which uploads the
  build context): send `box/Dockerfile` with the rest of `RECIPE` (`install.sh` and `agentrun-archil`) as the context,
  and name the result `agentrun-box-<hash>`. A Hyperbrowser team image is a name, not an OCI tag.

Either way, find the image by that tag or name before you build, so a second call is no build. The provider in
`test/conformance-image.test.mjs` runs this on the fake host, with an in-memory builder that finds images only by
listing them, as Hyperbrowser does:

```ts
async prepareImage(ctx: CallContext & { onWait?: (making: "build" | "pull", tag: string) => void } = {}): Promise<Result<string>> {
	const name = `agentrun-box-${boxRecipeHash()}`; // Vercel: the tag agentrun-box:<hash> in your project's VCR
	const vendor = (this.host as VendorHost).client;
	try {
		const image = (await vendor.listImages(ctx)).find((one) => one.name === name); // no get by name: list
		if (image?.status === "failed") throw new Error(`its last build failed (${image.error}): delete ${name} in the account, then call again`);
		if (image === undefined) {
			ctx.onWait?.("build", name); // only here: a second call finds the image and is told nothing
			const box = (file: string) => readFile(new URL(`../box/${file}`, import.meta.url));
			const context = { Dockerfile: await box("Dockerfile"), "install.sh": await box("install.sh"), "agentrun-archil": await box("agentrun-archil") };
			await vendor.build(name, context, ctx).catch(async (error) => {
				// refused because another server's build took the name since the list: wait on that one
				if (!(await vendor.listImages(ctx)).some((one) => one.name === name)) throw error;
			});
		}
		return ok(await vendor.ready(name, ctx)); // ready now, or once a build (this one, or another server's) is
	} catch (error) {
		return fail(codeOfError(this.host, error), `building the box image ${name}: ${error instanceof Error ? error.message : String(error)}`);
	}
}
```

An image of that name the vendor is still making (VCR's `Preparing`, a Hyperbrowser build under way) is another
server's build of it: `ready` waits for it, bounded by `ctx.signal`, and nothing builds again. One that failed (VCR's
`Error`) is a failure, in the vendor's words and with the next step; building over it would hide why.

What the two vendors say, read 11-16:
- Vercel ([concepts/images](https://vercel.com/docs/sandbox/concepts/images)): VCR serves an image to Sandbox only once
  it has an optimized `linux/amd64` build, and reads `Ready` (`Preparing` until then; a create before it answers
  `image_not_ready`). Sandbox never runs an image's `ENTRYPOINT` or `CMD`, which suits the box: the adapter starts what
  a computer runs through exec.
- Hyperbrowser ([sandboxes/custom-images](https://hyperbrowser.ai/docs/sandboxes/custom-images)): `--remote` uploads
  the build context and runs its Dockerfile in a remote builder; images are amd64. There is no get by name, only the
  list (`hx vm image list`), and a build is followed by its build id (`hx vm image status <build-id>`, `wait`).

A vendor that needs its own base image (Blaxel, Baseten, Fly Sprites) doesn't fit this path yet.

The tests that cover every provider read the descriptors, so your descriptor is the only list you add to.

A credential of several parts is several `keys`. A value that isn't secret but has a default that works for everyone
(an app name) is a `setting`: the server passes its `default`, and Settings has no field for it. A value with no such
default (a server URL, a team, project or workspace id) is a key with `required: true`, so Settings asks for it and
names it while it's missing, as it names a missing secret. Modal's descriptor (`src/descriptors/modal.ts`) is the
worked example:

```ts
	keys: [
		{ name: "MODAL_TOKEN_ID", option: "tokenId", required: true },
		{ name: "MODAL_TOKEN_SECRET", option: "tokenSecret", required: true },
	],
	settings: [{ name: "modalApp", option: "app", default: "agentrun" }],
```

A vendor whose machines live in a project the user makes first takes the project's id as one more key:

```ts
	keys: [
		{ name: "<VENDOR>_API_KEY", option: "apiKey", required: true },
		{ name: "<VENDOR>_PROJECT_ID", option: "projectId", required: true },
	],
```

Settings stores each key under its `name` and passes it to your `create(options)` as its `option`, and each setting's
`default` likewise. The conformance module reads the same values from `COMPUTER_<VENDOR>_*` names instead (Modal's
`MODAL_ENV`: `COMPUTER_MODAL_TOKEN_ID`, `COMPUTER_MODAL_TOKEN_SECRET`, `COMPUTER_MODAL_APP`), so a test run never picks
up a key your shell already holds for something else, and it creates nothing unless `AGENTRUN_COMPUTER_LIVE_<VENDOR>=1`.
Settings makes nothing on your vendor: a cluster, a resource group or a project the machines live in is the user's to
make first. Take its id as a required key, and when your vendor says it doesn't exist, say in your error what to make.
Rename E2B's and keep its exports: `createProvider`, `createDriftedProvider` (its daemon reports another version, and
the suite checks AgentRun refuses it), `createHost` for the exec pre-check and the sweep, `conformanceImage` and
`conformanceNotes`.

Unit-test what needs no network, as `test/e2b-provider.test.mjs` does: your capabilities, your `check`, how the key and
endpoint reach your SDK, and the settings your conformance module reads. A small fake of the SDK calls you make, which
records what it's given, is fine for that. You don't need a fake that behaves like your vendor. AgentRun tests its own
lifecycle against one fake host, and your live run is the proof.

### Prove it

Without Go, `build:daemon` takes AgentRun's daemon from the same version on npm, as long as your checkout's daemon
source is that version's. If you or your branch changed the daemon, you need Go to build it. The drift case always
needs Go on your PATH, because it compiles a second copy of the daemon that reports another version. Build, then run
the suite with your own key between two sweeps, from the repository root:

```sh
npm ci --ignore-scripts && npm run build
npm run build:daemon -w @parcha/agentrun-computer
export AGENTRUN_COMPUTER_LIVE_<VENDOR>=1 COMPUTER_<VENDOR>_API_KEY=<your key>
before="$(mktemp -d)/before.json"
node packages/computer/dist/conformance/sweep.js --provider <vendor> --before "$before"
npm run conformance -w @parcha/agentrun-computer -- --provider <vendor> --run "$(node -p 'require(process.argv[1]).run' "$before")"
node packages/computer/dist/conformance/sweep.js --provider <vendor> --after "$before"
```

The first sweep records what your account already holds and mints the run's id, which `--run` gives the run. The second
deletes anything that run left behind and prints what is still there. Each run takes a before file of its own, in a
fresh `mktemp -d` folder: `--before` refuses a file that is already there. `--kind sandbox` or `--kind desktop` runs one kind's cases, and `-- --help` lists every flag.
Add `--long` to the run you send: it runs the long cases, which wait minutes on your vendor's timers. `lifetime.idle`
leaves a computer quiet for 6 minutes and must find it still running, its daemon answering.

The report's last lines say the most computers the run had alive at once. If your plan keeps fewer (a free tier's few
machines), add `--concurrency <n>`: a create waits for a computer to go, and the run's own computer is deleted while a
case that doesn't use it needs room. A case that needs more at once than `n` fails in words. Put the number your run
printed in your pull request. If your API limits requests an hour, your provider passes `HostedProvider` a larger
`timeouts.pollMs` (default 1 s): create's wait for the listing to show a new machine starts at 150 ms between
listings and backs off to it.

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
refuses it in those words. A kind they take only where the operator sets one of your keys goes in `mountsWith` as well,
by that key's name (an optional key): a provider made with that key declares the kind, one made without it refuses it in
the `unmounted` words, and `mountsOf(descriptor, set)` gives the mounts for the keys set, which a server reads without
loading your module. On a `MachineHost`, give the host that descriptor (`{ ...DESCRIPTOR, ...mountsOf(DESCRIPTOR, set) }`),
so `capabilities()` and `check()` read it. Daytona declares `unmounted: { archil: "Archil mounts don't work on
Daytona's hosted cloud, ..." }` and `mountsWith: { archil: "DAYTONA_ARCHIL_EGRESS" }`: a self-hosted Daytona target
whose sandboxes reach Archil through an Archil egress relay takes the mount.

A provider whose computers run computerd with files and exec takes the synced folder (`sync`) with no work of yours:
the computer holds a plain /workspace, and the server pushes the run's folder in at the claim and syncs each change
back before the call that made it answers. In Mode 2 a server gives a run the Archil mount where the provider takes
one and its image is there, and the synced folder elsewhere (hosted Daytona, a GPU with no FUSE, a paired Linux box of
a person's own, whose `/workspace` its owner makes once: [attach.md, A Linux box](../../spec/computer/attach.md#a-linux-box)). Your create makes
/workspace empty and owned by the computer's user, and `attach` and `list` read the mount back as `{ kind: "sync",
epoch }`; the `mount.sync-*` cases check the push, the sync before each answer, a delete and the entry cap.

If your machines can't run Linux as root, the adapter doesn't fit, and you'd implement `ComputerProvider`
(`src/provider.ts`) directly, as [the last exec shape](#exec-shapes-that-work) does: the whole lifecycle, claims and
all, becomes yours to write. Talk to us first, in [an issue](https://github.com/Parcha-ai/agentrun/issues).

### Refusals

Every `ComputerProvider` call answers `{ ok: true, value }` or `{ ok: false, error: { code, message, vendor? } }` and
never throws. Your host throws instead, and AgentRun turns what it throws into one of these. The message is words a
person can act on. It never holds a key, a token or a bearer URL, and `health.no-key-in-errors` plants keys to check.
The codes are a closed set (`ComputerErrorCode` in `src/result.ts`). A provider never adds one.

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

- **`check(spec)`** applies the shared rules (lifetime and its cap, the network forms you declare, the label namespace and your
  `labels` bound, sizes, users, GPUs, the Archil mount), then your `check`.
- **`create(spec, { requestId })`** names the machine `computer-` plus the first 12 hex digits of the request id's
  sha256, so a retried create finds the machine it already made. It deletes a machine whose create landed after the
  caller gave up. When two creates race, it keeps the oldest machine and deletes the rest. A GPU computer's GPUs go in
  the label `agentrun.computer.gpu` (`<type>:<count>`), which a retry and `attach` read back. Then it waits for the
  machine to run, checks the labels `get` reads back, closes the session buses in `/tmp` (`/tmp/dbus-*`) to the
  computer's user on a `child` host, uploads the daemon and checks its sha256, starts it, and probes from inside that
  nothing answers directly and the kernel is the runtime you declare. Under `open` or a list, init starts the egress
  proxy before it leaves the machine's network, and the probe also checks that init's relay answers and that the
  proxy serves the spec's form. If any step fails after the machine exists, it
  deletes the machine and waits until `get` answers none, twice running.
- **The rest** covers `attach`, `list`, `connect`, `network` (fixed at create), `extend` (where your host has
  `extend`), `release` (delete, then the same wait; a stop is refused: a computer here is deleted, never stopped and
  kept), `watch` and `testConnection`.
  Every refusal uses the codes above, and `vendor` carries your API's own words.
- **A proxy for your vendor calls.** Behind a corporate proxy or a gateway that holds one allowlist, set the standard
  `HTTPS_PROXY` (or `HTTP_PROXY`) and `NO_PROXY` where the server and the runner start. `agentrun-serve` installs them
  once for the process (Node's `http.setGlobalProxyFromEnv`), which covers `fetch`, Node's global `WebSocket` and
  `https.request`; gRPC (Modal's and boxd's SDKs) gets the same values as its own `grpc_proxy` and `no_grpc_proxy`; E2B's
  SDK, whose fetch is its own undici Agent, is handed the proxy as its `proxy` option, one for all its hosts, so only an
  entry covering the whole domain (`.e2b.app`) sends E2B direct; Morph's SSH gateway goes through
  the proxy's CONNECT tunnel (the proxy must allow CONNECT to port 22). Loopback and the server's own public address
  always go direct. Archil's SDK builds its own undici Agent with no proxy option, so the Archil mount can't use one.
  Unset, nothing changes. A provider of yours that calls out with `fetch` or the global `WebSocket` needs nothing more;
  one whose client brings its own HTTP stack or a raw socket takes the same proxy through `src/env-proxy.ts`, which
  reads no environment: it follows the proxy the process installed into Node (`--use-env-proxy`, `NODE_USE_ENV_PROXY`
  or `http.setGlobalProxyFromEnv`), so a process that installed none has E2B and Morph go direct, as its `fetch` does.

### The live sweep

`--before <file>` records every machine listed with `agentrun.computer=1`, and mints a run id that it records in the file
and prints (`{"recorded":n,"file":...,"run":"<id>"}`). It makes the file, and refuses, with exit 2 and nothing listed,
a file that is already there: two runs given one path would otherwise leave the first run's `--after` reading the second
run's id. Give each run its own, from `mktemp -d`. The conformance CLI's `--run <id>` gives a run that id, and every
computer it makes carries it as `agentrun.conformance`. `--after <file>` deletes each new machine whose
`agentrun.conformance` is the file's run, and reads it back gone. It leaves alone everything recorded before and any
other new machine: one of someone else on the account, or of another conformance run going on beside yours. A before
file that names no run is refused before anything is listed. Two conformance processes may share one `--run`, such as
a sandbox run and a desktop run under one before file: each also labels its computers with an id of its own,
`agentrun.conformance.runner`, names its create requests by it, so neither finds the other's computers, and its own
end-of-run sweep goes by that label, so the first to end never deletes the other's live computers. `--after` goes by the run's id alone and takes what either left. It prints
`{"swept":n,"gone":m,"stillThere":[ids],"leftAlone":k}` and exits 0 when every swept machine is gone, 1 when one is
still there, and 2 on a usage error. It reaches your API through the conformance module's `createHost({ env })`, which
reads the same settings as the run and needs no live switch. If one account holds more than one place to list, such as
an app and a server, the module also exports `sweepScope({ env })`, and `--after` refuses a file recorded for another
place.
