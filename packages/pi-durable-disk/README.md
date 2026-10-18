# @parcha/pi-durable-disk

A durable pi host on a network disk. It runs [pi-durable](https://www.npmjs.com/package/@earendil-works/pi-durable) agents with each
run's state on a disk that outlives the machine. Each run is one directory on the disk that holds pi's SQLite store and the
agent's workspace. One process at a time holds that directory (a second claim is refused), every commit is on the disk before
anything is shown, a host that is lost or hung is fenced by revoking its claim, and a stateless supervisor restarts the run on
another host, where pi-durable resumes from the last commit and never repeats a tool call whose intent it had already committed.

**The disk.** The package needs two things from the disk: an exclusive claim on a run's directory, so that a second mount is
refused, and a fence, so that revoking the claim makes the old holder's writes fail. [Archil](https://archil.com) gives both, which
makes it the supported disk and the only one in this release. A disk without both cannot carry the package's guarantees. This
release names no other backend and promises none.

pi-durable assumes two things it does not provide: exactly one live process per store, and a store that outlives the
machine. A Cloudflare Durable Object gives it both. This package gives it both on an Archil disk you mount on any Linux host.

## Choose your path

| You have | Start with | What you see |
|---|---|---|
| Linux and Node 22.19 or later, nothing else | [Quickstart on one machine](#quickstart-on-one-machine-no-disk-no-key) | A durable chat on a directory of this machine, killed with `SIGKILL` and finished by a second process. One machine and no fence: the directory is the claim |
| Linux and Node 22.19 or later, and an app module | `pi-durable-disk run --dir PATH --app MODULE` ([The CLI](#the-cli)) | Your app, or example 01's (`examples/01-durable-chat/app.ts`), as an instance on a directory of this machine: `kill -9` it and run the same command again, and it resumes. One machine and no fence |
| macOS and Node 22.19 or later, for development | The same [quickstart](#quickstart-on-one-machine-no-disk-no-key) and `run --dir` | The same runs, development grade: commands keep your rights, and the file tools' confinement holds against the agent's paths but not a command racing it ([On macOS](#on-macos)). Use Linux or Docker when the agent is not trusted |
| Docker (macOS or Linux) and an Archil account | [Quickstart with Docker](#quickstart-with-docker) | A host killed in the middle of a paid charge, and the run resumed on another, every instance in a container |
| A Linux host with FUSE and an Archil account | [Quickstart on a Linux host](#quickstart-on-a-linux-host-kill-a-host-watch-the-run-resume-on-another), then [Setting up a host for production](#setting-up-a-host-for-production) | The production shape: systemd units, the supervisor, and a lost host's run back in about a second |
| An app or a host of your own | [The app](#the-app) and [Library](#library) | `openDurableRun`, `localRun`, the supervisor and host drivers, `serve`, parking and `fork` from your code |

[examples/](examples/README.md) lists the examples, one property each, with what each needs: several run with no disk
and no key.

## How it maps to a Durable Object

| Durable Object | This package | Supplied by |
|---|---|---|
| One live instance per id | One exclusive mount of `runs/<id>/`; a second mount is refused | the Archil server |
| A stale instance is fenced | The supervisor revokes the claim; the old holder's next fsync fails with EIO, its SQLite commit fails, pi poisons the session, the instance kills its commands and exits 75 | Archil, pi and this package |
| Knowing an instance is gone | A lease (a heartbeat in `run.json`), Archil's orphan flag for a dead client, and the host driver's own status | this package |
| Storage bound to the instance | pi's `SqliteStorage` at `runs/<id>/store/run.sqlite`, on the claimed mount, at `synchronous = FULL` | pi |
| A write is durable before the response leaves | `commit()` resolves after an Archil fsync, pi publishes only after the commit, and an effect starts only after its intent is committed | pi and Archil |
| The input gate | pi's single commit line | pi |
| Eviction and resume | Any host that claims the directory reopens the store and `resume()`s | pi and this package |
| Alarms | On the same host, the host's process supervisor restarts the instance; across hosts, `supervise`. pi's own retry and poll waits stay in process | this package |
| A container to exec in | Tools run as child processes of the instance, against the run's `work/` directory on the same mount | the host |
| Hibernate and wake on request | The instance parks (releases the claim) while everything waits, and `requestRun` starts it again on a request: `serve`, parking, below | this package |

## Requirements

- Either Docker, on any operating system: each instance then runs in a container of this package's image
  (`docker/Dockerfile`, see [Quickstart with Docker](#quickstart-with-docker)), and nothing else below applies to the
  machine; or the following on a Linux host.
- Linux with systemd and FUSE (`/dev/fuse`, `libfuse2`, which the archil package depends on, and `fusermount` from `fuse3`,
  which cleans a dead mount), `setpriv` (util-linux) and `sudo`, near the disk's region: a commit is one round trip to the
  region (3 to 6 ms p50 from a VM next to it, measured).
- Node 22.19 or later, to run the package and its unit tests.
- The [`archil` client](https://docs.archil.com/mounting/linux) 0.8.40 or later (0.8.42 tested):
  `curl -s https://archil.com/install | sh`.
- Root for the mounts: every `archil` verb needs it on client 0.8.42. The package reaches root only through
  `sudo -n` of `bin/archil-scoped` (below), so the instance and the agent's tools run unprivileged.
- `/proc` that shows the instance root's processes: acquire's stale-daemon cleanup needs `/proc` visibility of root
  processes, so mount `/proc` without `hidepid`, or run the instance where it can see them. Otherwise an archil daemon
  left on a run's mountpoint fails every acquire there with `MOUNT_FAILED` (exit 1) until something else ends it.
- An Archil account, a disk, and an API key for the supervisor, all from the Archil console. Create the disk in the region
  nearest the host (any size; its id looks like `dsk-0123456789abcdef` and its region like `aws-us-east-1`). Hosts and
  instances never hold the API key.
- `@earendil-works/pi-durable` and `@earendil-works/chord`, `>=1.0.4 <1.4.0`, as peer dependencies. The package is developed against 1.1.0, and CI runs its whole suite on 1.0.4 too, the lowest version the range accepts, and on 1.2 and 1.3.

Not covered yet: a Kubernetes host driver (the `HostDriver` interface is below) and running the loop across machines
where FUSE is unavailable. Without Archil, a run can live on a plain directory of one machine
([A run on a local directory](#a-run-on-a-local-directory)).


## Install

```sh
npm install @parcha/pi-durable-disk@beta @earendil-works/pi-durable@~1.2.0 @earendil-works/pi-ai@~1.2.0 @earendil-works/chord@~1.2.0
```

The pi packages are pinned to 1.2: pi 1.3.0 pins its own packages to exact versions, and this release's ranges stop below 1.3 until the next one.

From a checkout (this package is `packages/pi-durable-disk` of the repository; the root build compiles `dist/`):

```sh
git clone https://github.com/Parcha-ai/agentrun.git && cd agentrun && npm ci --ignore-scripts && npm run build
cd packages/pi-durable-disk
```

## Quickstart on one machine: no disk, no key

The fastest look, on Linux with Node 22.19 or later (or on macOS, [for development](#on-macos)): a durable chat on a
directory of this machine, with [`localRun`](#a-run-on-a-local-directory) instead of a disk and pi-ai's faux model
instead of a key. One process answers the first messages and is killed (`SIGKILL`) after its third answer; a second
opens the same run and answers the rest, and the transcript, read back from the store, has every message answered once.
The directory is the claim, so this guards one machine only; the quickstarts below put the run on a disk that outlives
the machine.

In an empty directory, install the package and its peers, save this as `chat.mjs`
(it is [examples/01-durable-chat/on-a-directory.mjs](examples/01-durable-chat/on-a-directory.mjs)):

```sh
npm install @parcha/pi-durable-disk@beta @earendil-works/pi-durable@~1.2.0 @earendil-works/pi-ai@~1.2.0 @earendil-works/chord@~1.2.0
```

```js
// A durable chat on a directory of this machine: no disk, no key (pi-ai's faux model answers). One process answers the
// first messages and is killed (SIGKILL) after its third answer; a second opens the same run and answers the rest, and
// the transcript, read back from the store, has every message answered once. One machine: the directory is the claim.
import { spawn } from "node:child_process";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { createRegistry } from "@earendil-works/pi-durable";
import { localRun, openDurableRun } from "@parcha/pi-durable-disk";

const MESSAGES = ["Where does your transcript live?", "What happens if this process is killed now?", "Who answers after that?", "What was my first question?", "Are you the same process?", "Say goodbye."];
const root = join(process.cwd(), "chat-run");
const text = (message) => (typeof message.content === "string" ? message.content : message.content.map((part) => part.text ?? "").join(""));

if (process.argv[2] === "instance") {
  let generation = 0;
  const faux = fauxProvider();
  faux.setResponses(Array.from({ length: 100 }, () => (context) => {
    const asked = context.messages.filter((message) => message.role === "user");
    return fauxAssistantMessage(`Answer ${asked.length}, by generation ${generation}: "${text(asked.at(-1))}"`);
  }));
  const models = createModels();
  models.setProvider(faux.provider);
  const run = await openDurableRun({ disk: "local", region: "local", id: "chat" }, { ...localRun(root), harness: { models, registry: createRegistry() } });
  generation = run.generation;
  const model = faux.getModel();
  const chat = await run.harness.root(ctx, { agent: { model: { provider: model.provider, modelId: model.id } } });
  const answers = async () => (await chat.entries({}, 100, undefined, ctx)).items.reverse().filter((entry) => entry.kind === "pi.assistant");
  const before = (await answers()).length;
  console.log(`generation ${generation} opened the run in ${root} (${before} answered before)`);
  for (const [i, content] of MESSAGES.entries()) {
    // The request id makes a message a no-op once it was admitted: a new generation walks the list from the top.
    await (await chat.submit({ type: "input", content, requestId: `message-${i + 1}` }, ctx)).wait(ctx);
    if (i >= before) console.log(`generation ${generation} answered message ${i + 1}`);
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  for (const answer of await answers()) console.log(`  ${text(answer.model[0])}`);
  await run.setStatus("done");
  await run.release();
  process.exit(0);
}

// The supervisor: an instance, killed after its third answer, then another on the same directory (a fresh one each time).
// It reads whole lines, and waits for `close` (the process gone and all its output read), not `exit`.
rmSync(root, { recursive: true, force: true });
const start = () => spawn(process.execPath, [fileURLToPath(import.meta.url), "instance"], { stdio: ["ignore", "pipe", "inherit"] });
const eachLine = (child, onLine) =>
  createInterface({ input: child.stdout }).on("line", (line) => {
    console.log(line);
    onLine(line);
  });
const first = start();
eachLine(first, (line) => {
  if (/answered message 3\b/.test(line)) first.kill("SIGKILL");
});
await new Promise((resolve) => first.on("close", resolve));
console.log("the first process was killed (SIGKILL); a second opens the same run");
const output = [];
const second = start();
eachLine(second, (line) => output.push(line));
const code = await new Promise((resolve) => second.on("close", resolve));
const answered = output.flatMap((line) => {
  const match = /^ {2}Answer (\d+), by generation (\d+)/.exec(line);
  return match ? [{ n: Number(match[1]), generation: Number(match[2]) }] : [];
});
const once = MESSAGES.every((_, i) => answered.filter((a) => a.n === i + 1).length === 1) && answered.length === MESSAGES.length;
const generations = [...new Set(answered.map((a) => a.generation))].sort();
if (code !== 0 || !once || generations.length < 2) {
  console.error(`not ok: exit ${code}, answers ${JSON.stringify(answered)}`);
  process.exit(1);
}
console.log(`ok: ${MESSAGES.length} messages answered once each, by generations ${generations.join(" and ")}, from the store in ${root}`);
```

Then run it (about five seconds; it writes the run under `./chat-run/`):

```sh
node chat.mjs
```

It ends with:

```
  Answer 1, by generation 1: "Where does your transcript live?"
  ...
  Answer 6, by generation 2: "Say goodbye."
ok: 6 messages answered once each, by generations 1 and 2, from the store in <this directory>/chat-run
```

## Quickstart with Docker

You need Docker (Docker Desktop, OrbStack or Colima on macOS, Docker Engine on Linux), Node 22.19 or later, and an Archil
account (the free plan is enough): from the Archil console, a disk for scratch runs and an API key. This machine needs no
root, no FUSE and no archil client: each instance of a run is a container of this package's image, and that container is
the instance's machine.

```sh
git clone https://github.com/Parcha-ai/agentrun.git && cd agentrun
export ARCHIL_API_KEY=...            # Archil console, API keys; only the supervisor on this machine reads it
export ARCHIL_DISK=dsk-...           # the disk's id
export ARCHIL_REGION=aws-us-east-1   # the disk's region
packages/pi-durable-disk/examples/docker-quickstart.sh
```

The script prints each command before it runs it:
1. it checks Node, Docker and the three variables, and says whether the Docker daemon applies AppArmor;
2. it installs the workspace (`npm ci`), builds this package, and builds the image from `docker/Dockerfile`: Node 24, the
   archil client checked by sha256, FUSE and this package;
3. it runs example 02 with `--host docker`. An agent charges six invoices through a fake paid API, and host A's container
   is killed (`docker kill`) while the third charge is in flight. Host B's container takes over and finishes;
4. it cleans up: the run's containers, its directory on the disk, its token users, and the tarball it packed.

It ends with a table of what the paid API received against what the run recorded: each charge was received once, and the
charge that was in flight is recorded `interrupted` and was not sent again. A first run takes about two minutes, most of it
building the image (826 MB, 250 MB of it the archil client; `docker image rm pi-durable-disk:local` removes it). Later
runs take about 15 seconds. Measured on Linux (Docker Engine 29 on Ubuntu 24.04); the macOS case (Docker Desktop,
OrbStack, Colima, and the arm64 image on Apple silicon) is unverified until the script has been run on a Mac. Then try
`packages/pi-durable-disk/examples/docker-quickstart.sh freeze`: host A's container is frozen (`docker pause`), and once
the lease expires host B's supervisor stops it and takes over. From `packages/pi-durable-disk`, `node
examples/01-durable-chat/demo.ts --host docker` runs a chat that continues on the other host.

To run your own app the same way:

```sh
npx pi-durable-disk supervise --host docker --image pi-durable-disk:local \
  --disk "$ARCHIL_DISK" --region "$ARCHIL_REGION" --id my-run --create --app ./my-app.ts --every 30s
```

Your app's directory (or `--app-root DIR`) is mounted read-only into each container. Its imports of
`@parcha/pi-durable-disk`, `@earendil-works/pi-durable`, `chord` and `pi-ai` resolve to the image's copies, and a
`node_modules` in that directory is hidden. If your app needs other packages, build an image `FROM` this one that
installs them under `/opt/pda`.

## Quickstart on a Linux host: kill a host, watch the run resume on another

This runs example 02, from `packages/pi-durable-disk` of a checkout, on one machine that plays two hosts: "host A" and "host B" are two mount roots, each
with its own FUSE client, which to Archil are two machines. It needs the requirements above, a user with passwordless `sudo`,
a scratch disk and an API key. It uses pi-ai's faux model, so it needs no model key.

```sh
# 1. The archil wrapper, root-owned (root executes it), and one mount root per host. Once per machine.
sudo install -D -o root -g root -m 0755 bin/archil-scoped /usr/local/lib/pi-durable-disk/archil-scoped
for root in /mnt/archil-a /mnt/archil-b; do sudo mkdir -p $root/runs && sudo chown "$USER" $root/runs; done

# 2. Your disk and API key. The key stays in the supervisor's environment; no instance ever sees it.
export ARCHIL_API_KEY=...        # from the Archil console
export ARCHIL_DISK=dsk-...       # the disk id or name
export ARCHIL_REGION=aws-us-east-1

# 3. Run it: an agent charges six invoices, host A is killed while the third charge is in flight, host B takes over.
node examples/02-paid-effect/demo.ts kill
```

It takes about 15 seconds and ends with a table of what the fake paid API received against what the run recorded. The
cut charge is reported `interrupted` and was received once. (Node prints "ExperimentalWarning: SQLite is an experimental
feature": pi's store uses `node:sqlite`. It is harmless.) Next: `node examples/02-paid-effect/demo.ts freeze` (the host's
mount hangs instead of dying) and `node examples/01-durable-chat/demo.ts` (a chat that continues on the other host).
Each example's README lists the exact commands the demo runs, so you can run them by hand.

## The app

An instance is `pi-durable-disk run --app <module> ...`: `openDurableRun` with the app's options. The module is an ES
module whose default export is a function of where the run lives and returns pi's Harness options without `env` (the run
builds `env` on its claim: the workspace is `<root>/work`), plus an optional `beforeResume` and an optional `onOpen`.

The factory runs once the claim is held: the run's directory is mounted, its owner lock taken, `store/`, `work/` and
`tmp/` made, and the commands a killed incarnation left running ended (`openDurableRun`'s `afterClaim`). This
incarnation's `run.json` comes after it. So `where.root` is the live directory whenever app code runs, and a factory may
write under it (a recorder's spool, a `signals/` directory). Before, the factory ran before the mount, and its writes
landed in the bare mountpoint and were lost. The Harness opens after the factory, with what it returns. Claim options, if
one ever needs them, are static (CLI flags or the environment) and never returned by the factory, since the claim is
taken before the factory runs. A module that does not load, or a factory that throws, fails the open with `APP_FAILED`
(exit 1), and the claim is let go. Such a start publishes nothing: a new run still has no `run.json`, and a resumed run
keeps its previous one. A supervisor therefore counts it a failed start and backs off (`ensureRunning`), never starting
it again on every tick.

```ts
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { createRegistry } from "@earendil-works/pi-durable";
import { ArchilCodingTools } from "@parcha/pi-durable-disk";
import type { AppContext, AppOptions } from "@parcha/pi-durable-disk";

export default async function app(where: AppContext): Promise<AppOptions> {
  // where = { ref: { disk, region, id }, root, work, store }: the claim is held, so root is the live run directory.
  const models = createModels();
  models.setProvider(openaiProvider());       // reads OPENAI_API_KEY from the instance's environment
  const registry = createRegistry();          // every extension the run's tasks need
  registry.install(ArchilCodingTools);        // pi's read, write, edit and bash, with `read` declared replay-safe
  return {
    models,
    registry,
    async beforeResume({ harness, context, generation, previous }) {
      // Awaited once per incarnation, after the Harness is open and before it resumes: no resumed task takes a step
      // until this settles, and what it admits commits before their steps do. Reconcile here what a resumed tool depends on.
      // previous is run.json as the run was left (null when there was none): `sleeping` with its wakeAt after a park,
      // `paused` with its detail after a planned stop or a fork, `running` with the dead holder and no new seal after a crash.
    },
    async onOpen(run) {
      // Called once per incarnation, after the run is open and resumed. run.generation is 1 on a first start and
      // higher on every resume. run.harness is pi-durable's Harness.
      const agent = { model: { provider: "openai", modelId: "gpt-6-sol" } };
      const root = await run.harness.root(ctx, { agent });
      await root.submit({ type: "input", content: "Summarize work/notes.md", requestId: "job-1" }, ctx); // a retry is a no-op
    },
  };
}
```

`openDurableRun` installs the registry before `Harness.open`, because a recovered task resumes only when an extension
of its name is installed. A tool that only reads can be marked `replay: "safe"` (`markReadOnlySafe`): after a crash it is
rerun. Any other tool is an effect: its intent is committed before it starts, and after a crash the model is told the call
was `interrupted`, never run again. `run.setStatus("done" | "failed" | "paused" | "sleeping", detail)` records the run's
status in `run.json`; `done` and `failed` run the durability barrier first. `run.release()` closes the Harness, kills the
run's commands, runs the barrier, seals `run.json` with the store's last sequence, and unmounts. A module that is missing
or throws, or an `onOpen` that rejects, is `AppError` (exit 1, which the unit retries; a module that fails lets the claim
go first). A `beforeResume` that rejects
fails the open (its step is `before-resume`) and releases the claim. Besides the Harness, the hook gets `storage`, the
store the Harness was opened over as four reads (`scanConversations`, `scanTasks`, `scanDocuments`, `document`) with no
way to a write, and `head`, the store's last committed sequence: a recorder snapshots every document at `head` there.
Until the hook commits, the current state is the state at `head`, which is how a document that keeps no history reads.

## The CLI

`pi-durable-disk` is on the PATH after an npm install (`node dist/cli.js` in a checkout).

| Command | What it does |
|---|---|
| `run --dir PATH --app MODULE [--id ID]` | The instance on a local directory (`localRun`): no disk, no mount token, no key. The same app contract and exit codes as on a disk (76 when another process holds the run, or when a process its last incarnation left will not die; 75 when fenced), and the same run flags but the Archil ones (`--disk`, `--region`, `--mount-root`, `--archil`, `--token-stdin` are refused beside it, exit 2). `--id` defaults to the directory's name |
| `run --disk D --region R --id ID --app MODULE` | The instance a host driver starts: claim the run, open it, resume it. `--token-stdin` reads the mount token from stdin. Lease flags: `--heartbeat-ms`, `--lease-expiry-ms`, `--lease-margin-ms`. `--on-sigterm resume` (default) or `pause`. `--serve PORT`, `--park-threshold`, `--park-idle`, `--drain-timeout` (below). `--run-as USER` runs the agent's commands as USER when the instance runs as root (in a container) |
| `supervise --disk D --region R (--id ID ... \| --all) [--every 30s] --app MODULE` | One decision per run, once or in a loop: nothing to do, start, or revoke and start; `--app` is the module each started instance runs. `--create` makes the run directory. `--check` proves this host's fence first. `--sweep-tokens` removes expired token users. `--host docker --image IMAGE` starts each instance in a container (`--app-root`, `--fleet`, `--name-prefix`, `--run-as`, `--docker-arg`, `--apparmor`). Prints one JSON line per decision |
| `status --dir PATH` | `run.json` read from the directory, and whether its holder is still the process that claimed it: `running` (this boot, its pid alive with the start ticks `run --dir` recorded), `stopped`, `gone` (another boot), or `unknown` when this machine's boot or processes cannot be read |
| `status --disk D --region R --id ID` | `run.json` over the S3 API, the run's delegations and the holder's state |
| `release --id ID` | Unmount the run's mount on this host (a dead mount is cleaned) |
| `fork --id A --new-id B` | Copy a released, sealed run into a new run (see Serve, parking and fork) |

The supervisor passes the app on (`--app MODULE`, made absolute), other flags for the instance as `--run-arg=--heartbeat-ms=2000`,
and the instance's environment as `--env KEY=VALUE`. The API key is read from the environment variable named by
`--api-key-env` (default `ARCHIL_API_KEY`) by the supervisor commands only; `run` never needs it.

An instance's exit code tells the host's process supervisor what to do:

| Exit | Meaning | Restarted? |
|---|---|---|
| 0 | Drained on SIGTERM: sealed `sleeping` (due now, the default) or `paused`, unmounted | by the supervisor at its next tick, if sleeping |
| 1 | The app module failed to load or `onOpen` rejected, or a mount or CLI call failed | yes, within systemd's start limit |
| 2 | Usage error | no |
| 65 | Data error: the store is behind its seal (an acknowledged commit is missing), or `run.json` is unreadable. `run.json` says `failed` | never |
| 70 | The store's head cannot be read (pi's schema moved). `run.json` says `failed` | never |
| 75 | Fenced: the claim was revoked, its mount failed or left the mount table (`CLAIM_UNMOUNTED`), or the lease lapsed; or an incarnation given no mount token found no live mount to reuse (`CLAIM_GONE_NO_TOKEN`: a restart whose mount went with the failed incarnation) | never in place; the supervisor decides |
| 76 | Held: another client holds the claim (a delegation, live or orphaned; the supervisor revokes orphans), or another process on this host holds the run's owner lock | never in place |

## Host drivers and the supervisor

`ensureRunning(ref, host, { control })` is the whole supervisor: a function you call (from a timer, before you talk to a
run, or as `supervise --every 30s`). It holds no state, and it must run in a different process from any instance, because a
process with files on a hung mount cannot even fork. For one run it reads `run.json` over the S3 API and the delegations
over the control API:

| `run.json` and the delegation | Decision |
|---|---|
| `done` or `failed` | nothing (a failed run is never restarted) |
| `paused`, or `sleeping` with `wakeAt` later | nothing, unless the caller passes `demand` |
| no delegation on `runs/<id>` | start an instance (nothing while a start is in its grace) |
| every delegation orphaned (the holder's client is gone, seen in 0.2 s) | revoke, start (nothing while a start is in its grace) |
| a delegation still checking out | nothing: a mount is in progress |
| held, heartbeat within 90 s | healthy |
| held, heartbeat older than 90 s | nothing while a start is in its grace; then stop the holder if the driver can reach it, revoke, start |

Every start first writes a mark, `runs/<id>/start.json`: the generation the new instance will write into `run.json`, and
when. Until `run.json` reaches that generation or the start grace passes (`--start-grace`, `startGraceMs`; default the
lease expiry, 0 turns it off), a tick neither revokes nor starts. An instance takes about a second from its start to its
first `run.json` write (node boot, mount, open), more on a busy host, and a tick inside that window would otherwise see an
expired lease and fence the instance it just started. The mark is in the run's directory, so supervisors in other
processes see it too. A start that writes nothing within the grace has failed: the next tick revokes and starts again.

A run whose starts keep failing (each instance ends before its first `run.json` write: 76 when another client holds the
run, 1 on `MOUNT_FAILED`) backs off: the next start records the failure in its mark (`failures`, `lastExit`) and gets
the grace doubled per consecutive failure, up to `--start-backoff-max` (`startBackoffMaxMs`, default 10 min). With the
default 90 s grace that is starts at 0, 1.5, 4.5, 10.5 and 20.5 minutes, then one every 10 minutes, where a short tick
would start one per tick. `lastExit` is what the supervisor saw of the failed start (`no-delegation`, `held`,
`orphaned`); the instance's own exit code is in its host's log. `supervise` prints one `start-backoff` line per step.
The first `run.json` write at a start's generation resets the count.

Revoking a holder that is alive is safe: its next fsync fails and it exits 75, and nothing it writes after the revoke
reaches the new owner. No wait follows a revoke, because the fence is the server's, not a clock. Two supervisors racing
on one run are safe: the mount admits one claimant and the other instance exits 76.

A host driver is three calls, plus an optional fourth, and nothing else in the package knows which compute runs an instance:

```ts
export interface HostDriver {
  // The handle is JSON; the instance writes it into run.json. `attempt` (the generation the instance will open) lets a
  // driver key a start, so a retry of the same attempt finds the instance it already started. `env` is what this start
  // adds to the instance's environment, over the driver's own `env`; PATH and PDA_HOLDER are the driver's (refused).
  start(ref: RunRef, mountToken: string, attempt?: { attempt: number; env?: Record<string, string> }): Promise<HostHandle>;
  status(handle: HostHandle): Promise<"running" | "stopped" | "failed" | "gone" | "unknown">;
  stop(handle: HostHandle): Promise<void>;
  // Optional: take the instance away as a crash would. No drain, no release, nothing cleaned.
  kill?(handle: HostHandle): Promise<void>;
  readonly kills?: "process" | "box";
}
```

`kill` leaves the run's claim the way a crash leaves it, and the supervisor's next pass decides what follows. `kills` says
what a kill takes. `localHost` kills `process`: `systemctl kill --signal=SIGKILL --kill-whom=all` on the unit, or SIGKILL
to the child's process group. Its machine stays, and with `restart` on, systemd starts the unit again. `dockerHost` kills
`box` (`docker kill`; the container stays exited until the next start removes it), and so does `daytonaHost` (the
sandbox's delete). A handle from another fleet or boot is a no-op, and a kill that fails while the instance still runs
throws `KILL_FAILED`.

`localHost()` runs instances on this machine as systemd transient units with `KillMode=control-group`, so stopping or
restarting the unit kills every command the instance started, pi's detached ones included. The unit restarts on failure,
except after exit 65, 70, 75 or 76. `localHost({ mode: "child" })` runs a detached child process instead, for development,
without that guarantee.

`daytonaHost({ client, snapshot, ... })` runs each instance in a Daytona sandbox of its own (library only: `supervise`
starts local units, so pass the driver to `ensureRunning`). Its `box(handle)` is that sandbox's receipt: its size
(vCPUs, memory, disk), when it was made and when the driver deleted it, and its list price per second at
`DAYTONA_LIST_PRICES`. Those are Daytona's published rates, with the page and the date they were read
(https://www.daytona.io/pricing, 2026-10-16): $0.0504 per vCPU-hour, $0.0162 per GiB-hour of memory and $0.000108 per
GiB-hour of disk past the first 5 GiB, billed per second. The page's "first 5 free" footnote is applied to disk only (its
placement is ambiguous). A box of unknown size gets no price, and neither does a box with a GPU: the page prices GPUs per
model, which the driver doesn't map (`daytonaUsdPerSecond`). The box comes from a snapshot that holds Node, the archil client
(`libfuse2`), this package, the run user and the sudoers drop-in, or from a default image that the caller's `prepare` installs
them into. A container sandbox has no systemd (PID 1 is the Daytona daemon), so an in-box launcher keeps the instance
alive in place and never restarts it after exit 0, 65, 70, 75 or 76. Every incarnation of an attempt gets the attempt's
token on stdin. A restart whose mount is still live reuses it, and one whose mount went with the failed incarnation mounts
again: after a takeover, that mount is `HeldError` (76, terminal). The token stays in the launcher's memory for the attempt. The mount token is uploaded to a root-only file and
handed to the instance on stdin, never put in the sandbox's environment, which Daytona stores and returns on every read.
Status comes from the sandbox state plus the launcher's own word, and `stop` drains the instance, then deletes the box. The
archil client needs the sandbox's egress to Archil's mount servers (Daytona's Tier 3 or 4, full egress; a domain allowlist
cannot mount). Where the kernel refuses every unmount (a Sysbox box), the claim's release checks the delegation in, moves the
mount aside (`archil-scoped retire`) and kills its daemon. Before the move, the client must list no Active delegation
under the mount. Its own bookkeeping under `.archil/` doesn't count: the client makes `.archil/client-<n>` and its
`unlinked` whenever a file under the mount is deleted, and no checkin clears them once the mount is read-only. Measured live on Daytona's hosted `us` region, about 6 ms from
`aws-us-east-1`: a box takes about 15 s to start an instance, an exclusive mount 142 ms and a commit 8.55 ms p50; a
power-off, a freeze of the instance and its FUSE daemon, and a network partition were each taken over on another box (the
power-off through the orphaned delegation, the freeze and the partition through the lease, the partitioned box stopped by
the driver), and the thawed instance exited 75. A driver for another compute (a Kubernetes pod, another sandbox product) is the same three calls.

`dockerHost({ image })` (`supervise --host docker --image IMAGE`) runs each instance in a container of its own; one
container is one incarnation.
- **Start.** `docker create` named `pda-<run>-<disk key>-g<attempt>` (the disk key is 8 hex digits of the disk and region,
  so equal run ids on two disks never share a container) and labeled `pda.fleet`, `pda.run`, `pda.disk` and `pda.region`.
  A retry of the same attempt adopts a running container that carries all four labels (the supervisor then removes the
  token it minted for that start) and replaces a dead one; a container by that name with other labels is refused.
  Flags: `--device /dev/fuse --cap-add SYS_ADMIN` for the mount, `--security-opt no-new-privileges`, `--restart no` (the
  supervisor decides every start; `dockerArgs` with another policy are refused), and `--security-opt apparmor=unconfined` only where the Docker daemon applies
  AppArmor (`docker info` lists it; Docker Engine on Ubuntu and Debian), because Docker's default profile denies mount(2).
  The supervisor prints that decision and its reason once. Docker Desktop and OrbStack apply no AppArmor and get no option.
- **The mount token** is copied into the created container as a root-only file, which the entrypoint removes before the
  instance starts. It never appears in `docker inspect`, an argument or an environment variable; the API key stays with the
  supervisor.
- **Inside the container** the instance runs as root, so the archil verbs need no sudo, and the agent's commands run as the
  image's user `pda` (uid 1500, `run --run-as`) under no_new_privs, with every capability set empty. `work/` and the files
  pi's write and edit tools create there belong to `pda`; the run's store, `run.json` and the archil daemon (which holds the
  token) stay root's, and Archil enforces their modes.
- **Status** comes from `docker inspect`: exit 0 is stopped, any other exit (75 and 76 included) failed, and a paused
  container is running, so the lease decides. **Stop** is `docker stop` (the instance drains), then `docker rm`.
- **Parking and the drain** are the local driver's: the instance gets `--park-threshold` (60 s, `parkThresholdMs`; null
  or 0 off) and a `--drain-timeout` of the stop timeout less a close reserve. A parked instance exits 0 and its container
  stays exited until the supervisor starts the next one at the wake.
- **A dead container takes its mount with it**: the mount lives in the container's mount namespace, nothing is left on the
  host, and the next supervisor tick revokes the orphaned claim and starts a new container.

Measured with Docker Engine 29 on Ubuntu 24.04, about 3 ms from `aws-us-east-1`: a killed container is replaced in about
1 s and the run resumes about 2 s after the kill; a frozen one is replaced 7 to 8 s after the freeze with a 6 s test
lease, and when thawed it exits 75 within 0.5 s. A SQLite FULL commit from a container has the same p50 as from the host
(about 6 ms); a pi commit, through that store, about 11 ms.

Mount tokens are reusable with a 24 h TTL (`--token-ttl`), one token user per start attempt, named
`pda-<run id>-g<attempt>-<time>` so a user can be traced to its run. They are not single-use: the archil client
re-authenticates 5 minutes after the mount and every 5 minutes after, and the control plane rejects a spent single-use
token for good, after which every write on the mount fails. An instance whose token expires is fenced at its next refresh
(exit 75) and the supervisor restarts the run with a fresh token. Each supervise pass removes the token users of the runs it
supervises that no live mount needs: the run holds no delegation, its `run.json` says released, and the user is older than
`--token-grace` (15 minutes). Removing a token user under a live mount kills that mount's claim, so a running run keeps its
users. `supervise --sweep-tokens` also removes the expired users of any run, and with no `--id` cleans every released run under
the token prefix.

### Serve, parking and fork

`pi-durable-disk run --serve PORT` (0: any free port; `--serve-host`, default 127.0.0.1; any other address needs
`--serve-token-file`, see Security, and a wildcard such as 0.0.0.0 also needs `--serve-url`, the address clients reach) puts
a small HTTP front on the open run, so a client talks to the run, not to a host:

| Request | What it does |
|---|---|
| `POST /submit {requestId, content, conversationId?, whenBusy?, wait?}` | pi's `submit`. pi deduplicates `requestId` per conversation in the run's store, so a retry that reaches the next incarnation, even on another host, gets the same submission, and with `wait: true` its answer. The same `requestId` on another conversation is a new submission there |
| `POST /abort {submissionId? \| conversationId?}` | pi's abort |
| `GET /events` | pi's agent events as server-sent events |
| `GET /status` | the run's status |

The instance writes its address into `run.json` (`holder.serve`) and answers 503 (`OPENING`, `PARKING`, `RELEASED`) while it
opens, parks or is gone. The app module may add `root` (the options for pi's `root()`, which the serve root conversation
gets) and `wake`. `requestRun(ref, { method, path, body }, { host, ensure, token? })` is the client, the equivalent of a
Durable Object stub's `fetch`: it reads `run.json` over S3 and sends to the running holder while its lease is fresh (a
request whose holder's lease lapses meanwhile is dropped: a frozen instance accepts connections and never answers).
Otherwise it calls `ensureRunning` with demand, waits for the instance it started, or for the one the supervisor reports
`starting`, to write its generation, and retries until `timeoutMs`.

**Parking.** With `--park-threshold` (the local and docker drivers pass 60 s; `supervise --park-threshold 0` turns it off) the instance
classifies pi's tasks after every commit. When everything that could run only sleeps in a retry or a deferred-poll wait longer
than the threshold, it writes `run.json` `sleeping` with `wakeAt` (the deadline), releases the claim and exits 0, and the
supervisor starts it at `wakeAt`. With `--serve`, a run with no live work also parks after `--park-idle` (default: the
threshold) with `wakeAt` null, so only a request wakes it. Open requests and event streams keep the instance up; a blocked task
(one no definition can run) does not. An app's `wake` hook replaces how the wake is recorded: a refusal keeps the instance up
through the wait (pi's own timer ends it), while a failed `run.json` write is a fence (exit 75, resumed after the lease). On
SIGTERM the instance stops taking submissions and drains for up to `--drain-timeout` (the local driver: its stop timeout minus
the smaller of 5 s and half of it), then writes its wake (now, the wait's deadline, or null when idle) and releases. Work cut
at the deadline resumes on the next open: safe tools rerun, unsafe ones report the interruption. The parking follows the
lifecycle of Rivet's pi-durable host (rivet-dev/agents, Apache-2.0); no code was copied.

**Fork.** `pi-durable-disk fork --id A --new-id B` (or `fork(ref, newId, { control, mountRoot })` on the supervisor side)
copies a released, sealed run (paused, sleeping, done or failed, with no delegation) under two short exclusive mounts of its
own into a new run that starts `paused` at generation 0 with the source's `sealedSeq`. Its first open is generation 1, and a
lossy copy is refused (`STORE_BEHIND_SEAL`). The source is only read (store, `run.json` and workspace stay byte-identical;
only the claim probe `.claim` is rewritten by the mount); `run.json`, `owner.lock`, the supervisor's start mark
`start.json` and `tmp/` are not copied. A fork owns the new run's directory only while it holds that directory's mount: one
that fails after that empties the directory through its own mount and removes it, and one that lost the directory to another
fork or start leaves it alone.

On a local directory, `forkLocal(from, [{ id, root }, ...])` makes the same copy without a disk: one new run directory per
entry, from a directory of a run released and sealed (`SOURCE_NOT_RELEASED` for anything else, `TARGET_EXISTS` for a target
that is there). The source is only read; every copy is made beside its target under a temporary name and none is published until all are complete, so a failed
batch leaves no half copy. A target inside the source (also through a symlink) is `INVALID_ARGUMENT`. A local directory has no mount to take it exclusively, so nothing stops a process that opens the source while it
is being copied: fork a run after it is released, and open the forks with `localRun` like any run.

### Setting up a host for production

The Quickstart runs the supervisor as your own user. On a production host the instance and the agent's tools run as an
unprivileged user and only the archil client runs as root:

1. **A dedicated run user** (here `pda`) that owns `<mountRoot>/runs` (default `/mnt/archil/runs`), so mountpoints are
   created and removed without root. The run user must be able to execute `node` and read the package and the app module:
   a Node under your home directory (nvm) is usually not readable by another user, so install Node system-wide.
2. **The archil wrapper, root-owned**, because root executes it. It starts `archil mount` in its own systemd scope, outside
   the instance's unit, so a restart in place finds its mount and claim still held, and it takes the mount token as one
   line on stdin:
   `sudo install -D -o root -g root -m 0755 bin/archil-scoped /usr/local/lib/pi-durable-disk/archil-scoped`
   (from an npm install the file is `node_modules/@parcha/pi-durable-disk/bin/archil-scoped`, and `ARCHIL_SCOPED`, exported by
   the package, is its path). Point the driver at it: `localHost({ archil: "/usr/local/lib/pi-durable-disk/archil-scoped",
   user: "pda" })`, or `supervise --archil /usr/local/lib/pi-durable-disk/archil-scoped --user pda`.
3. **A sudoers drop-in for exactly that wrapper and `fusermount -u`.** It keeps no environment: the token travels on the
   wrapper's stdin, and sudo logs every variable it preserves. Install it as `/etc/sudoers.d/pi-durable-disk`, mode 0440,
   after `visudo -cf` accepts it:

   ```
   pda ALL=(root) NOPASSWD: /usr/local/lib/pi-durable-disk/archil-scoped, /usr/bin/fusermount -u /mnt/archil/runs/*
   ```

4. **The supervisor runs as root** (it creates units, stops them, and writes each start's token under
   `/run/pi-durable-disk`, root-only), with `--user pda`, so instances never run as root; `localHost` refuses to start
   them as root without a named user. Give it the API key from a root-only environment file that its own systemd unit
   loads (`EnvironmentFile=`), never through `sudo`: sudo logs the command line and the variables it preserves.
5. **Check the host once.** `pi-durable-disk supervise --check --disk D --region R` proves the fence on this host (a
   second exclusive mount is refused, a revoked mount's fsync fails) and warns if the wrapper is not root-owned.

`examples/verify-production-path.sh` performs and checks steps 1 to 4 on a disposable root machine (`setup`, `run`,
`teardown`, or `all`; `plan` prints every step without running it): it creates the run user, the wrapper, the drop-in and
the key file, runs example 02 with the supervisor as root and `--user`, and checks that the instances never run as root,
that the run user can sudo the wrapper and nothing else, that `no_new_privs` takes even that away from a command, that no
mount token reaches the journal, and that nothing is left behind. It needs systemd; do not run it on a shared machine.

## The failure table

| Failure | What happens | Effects |
|---|---|---|
| The instance crashes or is OOM-killed, host alive | The unit restarts it in place on the same claim; the unit's cgroup kills the previous incarnation's commands; reopen, `resume()` | running tasks go back to pending; effects in flight are `interrupted`, never rerun; at most one cut model request is sent again |
| The host is lost (power-off, VM loss, pre-emption) | The client's sockets close and Archil flags the delegation orphaned in 0.2 s; the supervisor revokes (tens of ms) and starts an instance elsewhere | every acknowledged commit is there; unflushed workspace writes are lost; no effect whose intent was committed runs again |
| A Docker host is lost before its instance reaches running (the container killed or removed, or its daemon gone, between the start and the instance's first `run.json` write) | If the driver's start is still running, it fails typed (`START_FAILED`) and tries to remove the container it made (a removal that fails, as it does while the daemon is gone, is not retried); the supervisor's tick fails `HOST_START_FAILED`, counts no failed start, and the next tick starts again. If the start had returned, the supervisor's start mark (`runs/<id>/start.json`) keeps the run `starting` until the start grace passes (default the lease expiry, 90 s, doubled per consecutive failed start up to 10 min), so nothing is revoked or started twice; then it starts again, revoking first if the container had mounted (its FUSE daemon died with it, so its delegation is orphaned), and that start tries to remove the run's earlier dead containers. Removal is attempted, never guaranteed: once the daemon is back, look for leftovers with `docker ps -a --filter label=pda.run=<id>` | nothing is lost: an instance writes `run.json` at its generation before it opens the store, so it had committed nothing. The run has no instance for up to the grace; the time from the loss to the next instance's first commit is not measured on Docker |
| A Daytona host is lost before its instance reaches running (the box errors, is deleted or never starts while the driver starts it, or is lost after the launcher returned and before the instance's first `run.json` write) | While the driver starts it, a box that goes to an error state or away, does not start within the start timeout, or refuses an upload gets a delete request (attempted: a failed delete is not retried) and the start fails typed (`START_FAILED`); the supervisor counts no failed start and starts again on the next tick. Lost after the start returned: as on Docker, `starting` until the grace passes, then revoke if its client had mounted, and start a new box. A box deletes itself once stopped and Daytona destroys it at its TTL (default 25 h), so a box whose delete failed leaks nothing past that | as on Docker: nothing committed, no instance for up to the grace; not measured on Daytona |
| The host hangs or is partitioned (a zombie) | It is not orphaned, so the lease expires at 90 s; the supervisor stops the host if its driver can, revokes, and starts elsewhere | the zombie's next commit fails (`SQLITE_IOERR_FSYNC`) and it exits 75; a call it already has in flight may complete, but it cannot start a new one, because a new call needs an intent commit |
| A zombie that never commits again | Its lease watchdog (a worker thread, so a main thread stuck in a FUSE request does not matter) kills its commands at 75 s without touching the mount | an in-flight command runs at most until the self-fence |
| The mount is taken away under a live instance (an operator's `umount -l`, a cleanup's `fusermount -u`) | The instance writes `run.json` and creates its directories through the directory it opened at acquire, and checks before each write that the run's path is still that mount; at the next heartbeat the path names the local directory under the mountpoint, so it exits 75 (`CLAIM_UNMOUNTED`) | nothing of its own is written to the local disk; as host lost |
| A run's mountpoint holds entries and nothing is mounted on it (files written by path after a mount vanished) | acquire moves the directory aside whole to `<mountRoot>/.stray/<run>-<tag>` (root-owned, 0700), puts an empty one in its place, logs one JSON line on stderr with the entry count (never a name or a byte of the files), and mounts; `MOUNTPOINT_NOT_EMPTY` when it cannot | nothing in the moved directory is read or brought into the run |
| The mountpoint holds entries written since the starting incarnation began, before its claim mounted (an app's factory writing under `ctx.root`, which the CLI runs before the mount) | acquire refuses the start: `MOUNTPOINT_WRITTEN`, exit 65 (terminal, since a restart would write them again), naming the first few as `<mp>/...` in at most 240 characters; nothing moves aside and nothing mounts | the writes stay where the app left them, never silently lost; write in `onOpen`. The two rules side by side: this incarnation's own fresh writes are named (they are what the app must fix); an earlier incarnation's leftovers are counted, never named (they may be another incarnation's files) |
| The mountpoint holds more entries than the stray check looks at (100,000), or one this process cannot read | acquire refuses the start: `MOUNTPOINT_UNCHECKED`, exit 65, naming none of the entries; nothing moves aside and nothing mounts. A directory keeps its time when a file in it is rewritten in place, so only a check that looked at every entry can rule out this incarnation's own writes | someone looks at the directory and moves it aside by hand |
| A stale archil daemon on the mountpoint with no mount (a client that failed at a token refresh drops its mount and keeps its process and control socket) | acquire kills it (`archil-scoped stale`) before mounting; archil's refusal ("an older Archil process is still running", "Failed to bind control socket") is `MOUNT_FAILED` (exit 1), not 76 | none |
| The FUSE daemon dies, the loop lives | I/O returns `ENOTCONN`, the claim is fenced, the instance exits 75 and the unit does not restart; the supervisor finds the claim orphaned, revokes it and starts an instance | as host lost |
| Archil is unavailable or its write buffer is full | The commit fails, pi poisons the session, the instance exits 75; the supervisor retries | nothing is published past the last durable commit |
| The mount token expires mid-run | I/O fails at the next 5 minute refresh and the instance exits 75; the supervisor restarts it with a fresh token | nothing started past the last commit |
| A second instance on the same host | The owner lock (an exclusive SQLite lock on `owner.lock`) is refused, exit 76 | none |
| Two supervisors race | The mount admits one claimant; the other instance exits 76 | none |
| The control API lists the run's holder without a path (it resolves paths best-effort) | The supervisor maps pathless delegations' inodes to run directories with one `Disk.exec` per pass (`find -inum`) and counts one on the run's directory as the run's: a live one keeps the run healthy, an orphaned one is revoked and the run restarted. Where `exec` is unavailable or fails, the pass is `CONTROL_API_FAILED` and starts nothing (the supervisor never forces); a dead holder then stays until Archil lists its path again or an operator revokes it by client and inode | no second instance; nothing started over a holder it cannot see |
| A client dies holding its own private directories (`.archil/client-<clientId>` and its `unlinked/`, which the control API lists with no path and on no run directory) | They block no run. Every revoke that fences or deletes a run (`revoke`, `takeOver`, the supervisor's takeover, `deleteRunTree`) also revokes, from the same listing, the private-directory delegations of the clients it revokes on the run, confirmed by one `Disk.exec` (`stat`), unless the client holds anything else; best effort, so one left stays for an operator to revoke by client and inode | none: they hold no run directory |
| The store is behind its `run.json` seal | `STORE_BEHIND_SEAL`: `run.json` is marked failed and the instance exits 65; the supervisor does not restart it | none started |
| SIGTERM (a deploy) | The instance stops taking submissions and drains for up to `--drain-timeout`, writes `sleeping` with its wake (now; the deadline when everything only waits; null when idle and woken by requests), then closes, kills its commands, barriers, seals and unmounts, exit 0; the supervisor starts it again at the wake | work cut at the drain's deadline resumes on the next open: safe tools rerun, unsafe ones report the interruption |
| Everything the run does is a retry or poll wait longer than the park threshold | The instance writes `sleeping` with `wakeAt` (the deadline), releases and exits 0; the supervisor starts it at `wakeAt` and pi's timer sleeps whatever is left; a `run.json` write that fails is a fence (exit 75) and the lease path resumes the run | nothing is lost: the wait is a checkpoint in the store |

**On a local directory** (`localRun`) nothing is mounted or delegated and no supervisor watches the run, so the rows above
about revocation, takeover and the lease's replacement do not apply. These do:

| Failure | What happens | Effects |
|---|---|---|
| The instance crashes or is SIGKILLed | Its owner lock goes with the process. The next open of the directory (by the app, or whatever restarts it) takes the run, ends the commands the killed incarnation left running (its `commands` step, before any code of the new incarnation runs), and `resume()`s from the last commit | running tasks go back to pending; effects in flight are `interrupted`, never rerun; no command of the killed incarnation still runs once the run resumes. pi makes each command the leader of its own process group, so the SIGKILL does not reach them and a local run has no unit cgroup: the instance records each command's group under `commands/` (by pid, start ticks and boot) and the next open kills what still matches. A command started within about 0.1 s before the kill can be missed |
| A process the killed incarnation's commands started does not die at the next open (an uninterruptible wait, or one the run's user may not signal) | The open is refused: `HeldError` `COMMANDS_ALIVE`, exit 76, with the message below; the records stay | none: the run does not resume beside it. End those processes and open the run again |
| Power loss or an OS crash | The store's commits are durable (SQLite at `synchronous = FULL`); `work/` is the operating system's to flush, since the claim's barrier syncs nothing | the store resumes from its last commit; files the agent wrote in `work/` can be older than what the store recorded |
| A second process opens the run on this machine | The owner lock is refused (`HeldError`, exit 76) | none |
| A process on another machine reaches the directory (a network share) | Nothing stops it: a local directory has no fence | unsupported, since two writers can corrupt the store. A directory another machine can reach needs a disk with a claim and a fence |

The refusal names each process, as the open writes it (here one, in a run at `<root>`):

```
1 process(es) a killed incarnation's commands started are still alive after SIGKILL: pid 4242 (tar -xf /mnt/slow/archive.tar). The run does not resume beside them. End them (kill -9 4242, as their owner, or wait for them) and open the run again; they stay recorded in <root>/commands until then.
```

What a revoke cannot do: no fence reaches a third party. A paid API that already has a request has it. The package
guarantees that this runtime does not start an effect twice; an effect your model decides to retry is a new call, so give a
paid API an idempotency key from your own business key.

Measured on a VM about 3 ms from `aws-us-east-1`, archil 0.8.42: acquire 222 ms p50, release 139 ms, takeover by revoke
252 ms, commit 3.75 to 5.63 ms p50, a killed host's run back to its first commit in 1 to 1.5 s, a hung host replaced in 6
to 6.3 s with a 6 s test lease (90 to 120 s with the defaults). A start that never reaches running costs its start grace: live on Archil with a 6 s grace and a 3 s tick,
starts that all failed were retried six times in five minutes, each grace doubled (`test/live/supervise-slow.live.test.ts`),
and a takeover whose start was slowed 5 s before its first `run.json` write started once and was never revoked, 5 of 5
(`test/live/supervise.live.test.ts`). On Docker and Daytona hosts, a start lost before its instance runs is not measured.

## Security

- **The mount token goes on the wrapper's stdin.** It is never in argv or in an environment that `sudo` sees. Some setup
  guides pass the mount token with `sudo --preserve-env=ARCHIL_MOUNT_TOKEN archil mount ...`; sudo logs every variable it
  preserves to the journal and `auth.log`, so that form leaves the token readable to anyone who can read those logs. The wrapper reads
  one line on stdin and sets `ARCHIL_MOUNT_TOKEN` only for the exec of `archil`. The sudoers drop-in must never use
  `env_keep` for it. The local driver hands the token to the instance on stdin from a root-only file that is emptied once
  the unit has started; the instance reads it and closes stdin, so no process of the run's user can reopen it.
- **Tokens cover the whole disk.** A leaked one could mount or force-take any run on that disk until it expires, so the
  supervisor mints one per start attempt, removes it after the instance releases, and sweeps expired ones. The tenant
  boundary is the disk (Archil's own advice): give each tenant its own disk.
- **The API key stays with the supervisor.** Hosts and instances never hold it, and the local driver never copies its own
  environment into a unit.
- **No privilege for the agent.** The instance, pi's tools and the agent's commands run as an unprivileged user. Every
  command starts under `setpriv --no-new-privs` (on Linux; macOS has no equivalent, see [On macOS](#on-macos)), so a
  command cannot use the run user's sudo rule (sudo refuses: "The no new privileges flag is set"). An app that turns
  this off (`archilEnv(claim, { noNewPrivs: false })`) or runs commands another way must confine them itself. Commands
  run next to the FUSE client on the host that holds the claim: if the agent is not trusted with the host, sandbox its
  commands (for example with bubblewrap) and keep the FUSE client outside the sandbox.
- **The file tools stay inside `work/`.** pi's `read`, `write` and `edit` run in the loop's process, not in a command
  sandbox, so every file operation of the environment resolves its path to the file the kernel would reach (`..`,
  absolute paths, symlinks, dangling links, a missing tail) and refuses it unless it lies in `work/` (reads may also use
  `tmp/`, where the bash tool tells the model its long output went, and `readRoots` the app names; writes may also go
  inside a directory the environment's `createTempDir` returned, for the tool it was handed to). An agent cannot `write
  ../store/run.sqlite`, `../run.json` or `../owner.lock`: the call fails with a `PathOutsideWorkError` the model sees as
  a failed tool result. A path is opened one component at a time from a held handle of `work/`, without following links,
  so a link a command swaps in after the check is refused too (on Linux; on macOS the walk is by path, see [On
  macOS](#on-macos)). This covers the file tools only; a command still runs as the run user and can reach anything that
  user can, which is what an app's own command sandbox is for. `archilEnv(claim, { confineFiles: false })` turns it off
  where `/proc/self/fd` is unavailable.
- **`--serve` authenticates only with a bearer token.** On 127.0.0.1 (the default) the token is optional. A non-loopback
  `--serve-host` requires `--serve-token-file`, a file of mode 0600 holding the token (never argv or the environment); every
  request must send `authorization: Bearer <token>`, and it is compared in constant time. The file is readable by the run
  user, so by the agent's own commands: it guards the network, not the agent. Put TLS in front of anything that leaves the
  machine.
- **In a container** (`dockerHost`) the instance runs as root and holds `CAP_SYS_ADMIN` (with AppArmor unconfined where the
  daemon applies AppArmor), which `archil mount` needs. The agent's commands do not: they run as uid 1500 with every
  capability set empty, the bounding set included, and no_new_privs, so `mount`, `unshare` and `nsenter` fail from a
  command. With `fs.protected_hardlinks` on (the live suite checks it), a command cannot hard-link the store or `run.json`
  into `work/` either. Anything passed with `--env` is visible to `docker inspect` on the machine and to the agent's
  commands, so never pass a secret there that the agent must not read.
- **A revocation is the most dangerous operation.** It happens only for an orphaned client, a dead host or an expired
  lease, and every takeover writes the new `generation` and the previous holder into `run.json` and the supervisor's log.

## Layout on the disk

```
<disk>/runs/<id>/          the claimed subtree, mounted at <mountRoot>/runs/<id> on every host (default /mnt/archil)
  run.json                 status, generation, holder, heartbeat, seal
  owner.lock               the same-host owner lock
  store/run.sqlite         pi's store (exclusive profile: no -shm file)
  work/                    the workspace the tools write
  tmp/                     pi's temp files and long-output spills, so a path a result names still exists after a takeover
```

A run on a local directory (`localRun`) has the same layout, plus `commands/`: the process groups of the commands its
instance started, which the next open ends before it resumes (a local run has no unit cgroup to end them).

The mountpoint is the same absolute path on every host of a deployment, so paths inside the run are identical wherever
it resumes.

### Removing a run

A run is the subtree `runs/<id>/` of the disk. To remove one: let its instance release (or stop it), check that nothing
holds a delegation on it (`pi-durable-disk status` lists them; an orphaned one is revoked through the control API), delete
its objects, and remove its token users (`supervise --id ID --sweep-tokens --token-grace 0s` on a run that is done).

**Revoke before you delete.** Deleting the objects of a run through the S3 API while a delegation on the path is still
held, even an orphaned one left by a killed host, does not take effect: the same run id came back with its old store when a
supervisor next started it. `deleteRunTree(control, id)` does it in order: it revokes the run's delegations and its holders' private directories,
deletes, and requires the prefix to be empty. Doing it by hand, revoke first (`revoke(control, id)` takes the same set), delete,
then list the prefix and check it is empty.

## Library

`openDurableRun(ref, options)` is what `run` calls: mount, verify the claim, take the owner lock, make `store/`, `work/`
and `tmp/`, end a killed incarnation's commands, write `run.json`, open the store, check the seal, open and resume the
Harness, keep the lease. Its `afterClaim(claim)` is awaited once the claim is held and before `run.json`, with the
claim's `ref`, `root`, `work` and `store`. What it returns (`harness`, `beforeResume`, `seed`) goes into the open, so
`harness` may come from there instead of the options, and a factory can give a new run its seed (over the options'
`seed`); the seed runs right after `afterClaim` and before `run.json`, on a new run only. A rejection fails the open with `run.json` as the open found it and lets the
claim go. `acquire`, `ensureRunning`, `localHost`,
`archilEnv` and the typed errors (`FencedError`, `HeldError`, `StoreBehindSealError`) are exported for apps that compose
their own lifecycle, and so are serve (`serveRun`, `requestRun`), parking (`watchParking`, `drain`, `busyState`, and
`leaseParkTarget` for a Harness a host opened over `openRunLease`) and `fork`. `src/index.ts` lists every export; the
`.d.ts` files in `dist/` are the reference.

A supervisor of your own (a driver `supervise` does not start, such as `daytonaHost`) gets its `control` from
`archilControl({ apiKey, disk, region })`: the disk's S3 and control API, the same object `supervise` builds from its flags.

```ts
const control = await archilControl({ apiKey: process.env.ARCHIL_API_KEY!, disk: "dsk-...", region: "aws-us-east-1" });
await ensureRunning({ disk: "dsk-...", region: "aws-us-east-1", id: "job-1" }, daytonaHost({ client, snapshot }), { control });
```

A host that owns its own pi-durable Harness and store connections imports the narrow entry instead:
`@parcha/pi-durable-disk/lease` holds `openRunLease` (the claim, the owner lock, `run.json` with its heartbeat, the lease
self-fence, the seal and the release, without a store or a Harness), `storeHead`, the store's fence and pragma helpers
(`Fence`, `FencedDatabase`, `assertPragmas`, `PROFILE_PRAGMAS`, `openArchilStore`), parking (`leaseParkTarget`,
`watchParking`, `drain`, `busyState`), and the typed errors and exit codes. It leaves out the supervisor, the host drivers,
the CLI and the app contract, and the package declares `"sideEffects": false`, so a bundler keeps only what you use: a
bundle of the app with `await import("@parcha/pi-durable-disk/lease")` is about 63 KB minified against about 620 KB
for `await import("@parcha/pi-durable-disk")` (esbuild `--bundle --minify --platform=node --format=esm`, which inlines
pi-durable, chord and their dependencies).

`@parcha/pi-durable-disk/internals` holds the claim, status and Daytona plumbing this repository's examples and demos use:
`runPath`, `unmountClaim`, `createRunDir`, the mount-token and delegation helpers, `isLeaseFresh`, and the Daytona labels,
names and `sweepSandboxes`. It carries no compatibility promise: a name there can change or go in any release.

### Seeding a new run

`seed` (in `openDurableRun`'s options, and `openRunLease`'s) writes what a new run starts with before anything sees the
run: its store file, a SQLite database the Harness then opens (saved sign-in profiles, say), and files in its
workspace (`work/.agents/skills/`). `beforeResume` runs after the store is open, too late for that.

```ts
await openDurableRun(ref, {
  ...localRun("/var/runs/run-1"),           // or a disk's mountToken
  harness: { models, registry },
  async seed({ storePath, workDir }) {      // also root: the claim's root
    const db = new DatabaseSync(storePath);
    db.exec("CREATE TABLE IF NOT EXISTS x_agent_profiles (name TEXT PRIMARY KEY, profile BLOB)");
    db.close();                             // closed before it returns: the store opens it next
    await cp(skillsDir, join(workDir, ".agents/skills"), { recursive: true });
  },
});
```

- **When it runs.** Once, on the open that finds no `run.json`: inside the run's first claim, with the owner lock held,
  after `store/`, `work/` and `tmp/` exist, a killed incarnation's commands are ended and `afterClaim` has run, before
  `run.json` is written and before the store opens. Its step is `seed`. What it wrote is made durable (the claim's
  barrier) before `run.json` publishes the run.
- **From the app.** `afterClaim` may return `seed` (as `AfterClaim`), over the options' one, so a factory that runs on the
  claimed directory can give the run its starting state.
- **When it doesn't.** Never for a run that has `run.json`, whatever its generation, and never on a fork's first open
  (`fork` writes `run.json`).
- **When it fails.** A seed that throws fails the open with its own error. A process killed while it seeds leaves the run
  unpublished in the same way: no `run.json`, the claim let go. The next open seeds again, so a seed overwrites what an
  earlier attempt wrote.
- **How long it may take.** A new run has no `run.json` heartbeat while it seeds. A supervisor keeps a start in its grace
  (`--start-grace`, `startGraceMs`; default the lease expiry, 90 s) only while its start mark (`start.json`) is younger
  than the grace. So while the seed runs, the instance rewrites the mark's time every heartbeat, through its claim, when a
  supervisor's mark for generation 1 is there. It does so on a thread of its own, so a seed that holds its thread (a
  synchronous import through `DatabaseSync`) is covered too. A live seed of any length stays `starting`. A seeder that dies stops
  rewriting, the grace runs out as for any start, and the claim is revoked. If the claim is revoked while the seed still
  runs, its next write or its barrier is refused, the instance is fenced (exit 75) with nothing published, and the next
  start seeds again.
- **On a local directory** (`localRun`) it is the same. As with `work/`, the files it writes are the operating system's
  to flush; a SQLite database it commits with `synchronous = FULL` is durable when the commit returns.

### A run on a local directory

`localRun(root)` returns the `acquire` and `claimDir` that put a run on a plain directory of this machine, with no mount
and no mount token:

```ts
import { localRun, openDurableRun } from "@parcha/pi-durable-disk";

const run = await openDurableRun({ disk: "local", region: "local", id: "run-1" }, {
  ...localRun("/var/runs/run-1"),          // made when it is missing; work/ and store/ inside it
  harness: { models, registry },
});
```

The run's status is its `run.json`, and `readLocalRunStatus(root)` (the directory `localRun` takes) reads it, read-only and safe beside a live instance, the way `readRunStatus` reads a disk's: the
same `RunRecord` (`status`, `generation`, `wakeAt`, `holder`, `sealedSeq`, `detail`), `null` when the run has no `run.json`
yet, and `RunRecordError` (`RUN_JSON_INVALID`) when it is malformed.

```ts
const status = await readLocalRunStatus("/var/runs/run-1");   // { status: "sleeping", wakeAt: "...", ... } or null
```

It is for one machine (a laptop, a CI job, a test), and says so: the claim is the directory itself, so nothing but this
machine's owner lock keeps a second process off the run (a second open while one holds it is refused), and nothing at
all keeps out a process on another machine that can reach the directory. Its barrier refuses once the run is fenced,
like a mount's, but syncs nothing: the store's commits are made durable by SQLite, and the files the agent wrote in
`work/` are the operating system's to flush, so a power loss can lose what it had not written yet. `mountToken` is
required only with the default `acquire`; without either, the open is refused (`INVALID_ARGUMENT`) before anything mounts.

#### On macOS

A local run works on macOS for development, and is weaker there than on Linux in four ways. Use Linux, or the
[Docker quickstart](#quickstart-with-docker), when the agent is not trusted.

- **Commands keep your rights: `no_new_privs` has no macOS equivalent.** On Linux every command starts under
  `setpriv --no-new-privs`, so it cannot use `sudo` or gain privilege from a setuid program. macOS has no such flag and nothing
  that does its job (`sandbox-exec` is deprecated), so `noNewPrivs` defaults to false there and no `setpriv` runs. That
  leaves open: a command can use `sudo` wherever sudo asks it for no password (a `NOPASSWD` rule, for one), and setuid
  programs keep their privilege. `runAs` is not available either (it needs `setpriv`). As on Linux, a command runs as
  you and can reach anything you can.
- **The file tools' confinement is path-based.** On Linux it walks a path through `/proc/self/fd`, one held directory at
  a time, so no component can be swapped once it was checked; macOS has no `/proc/self/fd`. There it resolves the path
  (`realpath`) and refuses it unless it lies in `work/` or another root the file tools may use, as on Linux, opens each
  component by its full path with `O_NOFOLLOW`, then checks that the path still resolves to itself and names the
  directory it opened (same device and inode). It refuses `../store/run.sqlite`, absolute paths and links out of
  `work/`, a link already in place included. That leaves open: a command that swaps a directory above the target for a
  link between that check and the operation can win, and the file tool then acts where the link points.
- **The run's root is addressed by its path.** On Linux, `run.json` and the run's directories are written through the
  directory opened at acquire. On macOS each write is checked first against that directory, and a root renamed and
  replaced between the check and the write gets the write.
- **Commands are recorded from `ps`.** With no `/proc`, the instance reads one `ps` listing every 0.5 s while commands run,
  `ps -E` for a command's mark and `sysctl kern.bootsessionuuid` for the boot. A command started within about 0.5 s
  before a kill can be missed, and a process is told from a later one with the same pid by the second it started. The
  lease watchdog reads the same listing.

`fsync` on macOS does not flush the drive's cache, so the store also sets SQLite's `fullfsync` and
`checkpoint_fullfsync` there (SQLite then syncs with `F_FULLFSYNC`), and refuses to open unless they read back. CI runs
the no-key quickstart, the local run's tests (its command records, `run --dir` and `status --dir`, the lease watchdog,
the file tools' confinement) and the keyless examples on macOS.

### A short claim on any path, and a read of what it released

`withClaim` holds one path of a disk exclusively for a moment, outside any run: pi-durable-agent carries an agent's home
(`agent/agent.sqlite`) back at a run's end this way. `readReleased` reads a file such a claim released over the S3 API,
with no mount, so a reader never blocks a writer. Both are supervisor side: they take the `control` of
`archilControl({ apiKey, disk, region })`.

```ts
await withClaim({ control, disk: "dsk-...", region: "aws-us-east-1", path: "agent" }, async (held) => {
  const db = new DatabaseSync(join(held.root, "agent.sqlite"));
  db.exec("INSERT INTO runs (id) VALUES ('job-1'); PRAGMA wal_checkpoint(TRUNCATE)");
  db.close();
});
const store = await readReleased({ control, path: "agent" }, "agent.sqlite", { sqlite: true }); // null: none yet
```

A claim is one exclusive mount, about 0.4 to 1 s with its release, so it is for a run's end, never a turn.
- **Exclusive by the mount.** Archil refuses a second client's mount of the path, an ancestor or a descendant. The call
  mounts at a fresh `<mountRoot>/runs/<pid>-<uuid>` (default `/mnt/archil/.claims`; the shape `archil-scoped`'s cleanup
  takes on a host that cannot unmount) and never shares a mount. Archil mounts no path whose directory is missing, so it
  first makes the path's directories the disk lacks, over S3, as the calling process's own (0700; `owner` sets them). It writes
  `.claim` with its deadline (`holdMs`, default 60 s), runs `fn`, then barriers, unmounts and gives its mount token back,
  whether `fn` resolved or threw.
- **Lost holders are revoked first.** A holder whose client is gone (orphaned) is revoked before the mount, and so is a
  holder of exactly the path whose `.claim` names a deadline that has passed and stays the same for 3 s (a holder that
  just mounted rewrites it at once; a holder of a path above or below is never revoked by this path's `.claim`). A live holder within its deadline is waited for (`waitMs`, default 30 s), never
  revoked. A holder revoked while still alive fails its next fsync, so its commit rolls back and its own call is FENCED:
  the deadline never decides what is durable, the fence does.
- **What it refuses.** A path that is not relative and of safe segments, or that is under `runs/` (a run's own) or
  `.archil/`, is `ClaimError` `INVALID_ARGUMENT`, before any call. A live holder after `waitMs` is `HeldError`
  `CLAIM_HELD` (exit 76). The control API failing, or a delegation with no path it cannot attribute, is
  `CONTROL_API_FAILED`. A claim revoked from under `fn` is `FencedError` (exit 75), and `fn`'s writes are then not
  durable.
- **`CLAIM_HELD` is retryable.** The path is not released yet: retry within `waitMs`, and never fall back to an older
  release.

`readReleased` returns the bytes only when the read is of a released file. Nothing holds the path (or an ancestor or a
descendant) before or after the read, and the object is unchanged across it (its etag, else its size and time). For
SQLite (`sqlite: true`), its `-wal` must also be absent or empty, so its writer checkpointed with `TRUNCATE` and closed. A
held path is `CLAIM_HELD`, retryable as above, and a WAL with content is `NOT_RELEASED`. A file that changed during every
one of `attempts` reads (default 3) is `CLAIM_HELD`. Open the bytes as a local file, read-only (`?immutable=1`).

### Places: a run a supervisor can kill and bring back

A place is where one run lives and how its instance starts, is killed and comes back, for a supervisor that decides when
to kill (agentrun's reference demo). Each factory takes its options and returns `(ctx) => Place`; `ctx.paths` is the run's
id and directory as the supervisor computed them.

- `localPlace({ app, root? })` runs `pi-durable-disk run --dir <root> --id <id> --app <app>` as a child in its own
  process group, with `{ PATH, ...order.env }` and nothing else of the caller's environment. It needs no disk, no key and
  no token. A process kill is SIGKILL to the group, and the next runner resumes the run from the directory. A box kill
  also calls `ctx.destroyBoxes` (a deletion that failed is tried again by the next kill or recover). `release()` kills
  what still runs, then, under the run's owner lock, ends the commands the run recorded (pi starts each in a process
  group of its own, which the instance's kill does not reach). While another process holds the run, they are its own,
  and release leaves them. With `ctx.requestFile`, `signals(attempt)` yields the kill request the runner writes
  there when it parks at its planned crossing, and `requestFile` is that same file. `return()` ends a pending `next()`.
- `archilPlace({ disk, region, control, host })` runs the instance on the disk through a host driver set up with the app.
  - `token(attempt)` mints that attempt's mount token through `control`, and the runner handed that token mounts with it.
  - A start is `ensureRunning` with the token (`mountToken`) and the order's environment (`StartAttempt.env`).
  - A kill is the driver's `kill`, and `kills` is the driver's.
  - A recovery is the takeover: the killed holder's delegations are revoked whatever its lease says, and the next
    instance starts. It reports `revoked` and `ms`. A newer incarnation than the one the place killed (another
    supervisor's) gets the usual lease and start-grace checks instead, so a live one is `HELD`, not revoked.
  - `status()` reads `run.json` over S3 and lists the run's delegations, plus, when its host driver makes boxes
    (`daytonaHost`), a receipt for each box the place started, released ones included (`boxes`, `HostBox`). A receipt
    has the provider, the kind, `from` and `to` (null while it lives). It also has the published list price per second
    (`usdPerSecond`), the page that price was read from (`source`) and the ISO date it was read (`priced`). A box with
    no price has none of those three, never a price of 0. No field holds the provider's id of the box.
  - `recordHome` (when the control can list, as `archilControl`'s can): an attempt's runner records into
    `recordHome.dir(attempt)`, `<root>/record/<attempt>`, in the run's directory, so its delegation covers it and
    `deleteRunTree` removes it. `bringHome(into, { final })` reads that directory through the control (S3 list and get:
    nothing takes the run's claim) and brings the recording into the supervisor's `into`.
    - Blobs come first, each checked against the hash its name carries and written whole (a temporary file, fsync,
      rename). One that doesn't match is skipped; everything else still comes home, then the call throws
      `BLOB_MISMATCH`.
    - Then the new whole lines of each `.spool/*.jsonl` segment, with an offset per file name: what `into` already
      holds of it. So a second call, or a call from another process, brings nothing twice. A line waits while a blob it
      names isn't home yet. On `final` it comes home anyway, and the call throws `CARRY_FAILED` naming the blob.
    - Carriers that overlap on one `into` never append at once. The place runs one call at a time per destination, and
      each append happens under a lock file beside its spool file (`.<name>.lock`, naming its holder's pid), after the
      destination's size is read again, so only the lines past it are appended. A lock whose holder is gone is taken
      over; one held past 5 s is `CARRY_FAILED`. A second `into` gets every line: what the place fetched for one
      destination says nothing of another.
    - A list or get that fails is `CARRY_FAILED`.
    - The recording is on the disk, not in the box, so a final call after a box kill still brings home everything the
      box fsynced: this place never throws `BOX_GONE`.
    - With `ensure.create` (the run user's uid and gid), the place makes the EMPTY directories the runner writes into
      at each start: `signals/`, `record/<attempt>/.spool/` and `record/<attempt>/blobs/`. It makes them over the
      control, owned by the run user, mode 0755, in ensureRunning's window where no delegation holds the run. A
      directory a process made by path on an Archil mount was seen to refuse file creates afterwards (ENOENT), and one
      made over the control didn't. Every file in them stays the runner's. A refused put fails the start
      (`DIRS_REFUSED`, as the cause of `HOST_START_FAILED`), and without an owner nothing is made.
  - `requestFile(attempt)` is `<root>/signals/kill-<attempt>.json`, in the run's directory and outside `work/`, and
    `signals(attempt)` reads `runs/<id>/signals/kill-<attempt>.json` over S3 every 500 ms (`signalPollMs`). A runner on
    a box of its own can't reach the supervisor's files, so its request travels through the disk. The runner must write
    it durably for S3 to see it: a temporary file, fsync, rename, fsync of the directory. A missing object is a request
    not written yet; any other read failure is retried. Once reads have failed for `signalFailMs` (60 s) without a
    break, the iterator yields one `{ kind: "signals-failed", code, message }` and ends, so a parked runner never waits
    with no word of why. `code` is the failing read's own error code when it has one (`CONTROL_API_FAILED` for a read
    that timed out), else `SIGNALS_FAILED`. The iterator never rejects.
  - A request names `point` and `n`, and every other field it carries stays in the signal's `crossing`, except the
    per-attempt nonce the supervisor put in the order's env. That one is lifted to the signal's own `nonce` (when it is a
    string), where the supervisor reads it for its check, as from the local place. The place's token never goes into a
    request: on a disk it is the mount token, and the app never holds it.
  - `release()` stops every instance the place started and removes every token it minted. What it could not stop or
    remove, it reports (`RELEASE_FAILED`) and tries again on the next `release()`. The run's directory stays
    (`deleteRunTree`).

A runner's `exited` says how it ended. Locally that is the exit code or signal, and the outcome is the instance's
`{"outcome":{...}}` line on stdout. Without that line, or on a disk (a box's stdout is out of reach), the outcome is
`run.json`'s, with its generation, and `code`, `message`, `record` and `storeSha256` from the detail of the last status
the app set. Its `status` is the run's word, not the record's, so a supervisor needs no package vocabulary: `complete`
when the run is `done` and that detail carries a record, `failed` for anything else (done with no record, failed, or a
run its instance left `running`, `paused` or `sleeping`). So an app that runs on a box and wants its supervisor to have
its record puts the record there, in its final `setStatus("done", { record })`.

Either way the outcome may carry `models`, the role-to-model ids the run's live parts chose (`lead`, `eyes`, ...), on any
status, a failed run's too: from the outcome line's `models`, or from the final detail's (`setStatus("done", { record,
models })`). Both places keep it only when it is a plain object whose values are all strings; a missing or malformed one
is left out, never replaced by `{}`.

## Tests

```sh
npm test            # unit tests: no Archil, no network, no model
npm run typecheck
```

The package and its unit tests run on Node 22.19 or later.

The live suites (`npm run test:live:claim`, `:env`, `:run`, `:store`, `:supervise`) mount a real scratch disk, and
`npm run test:live:docker` runs the Docker driver's takeover test against this machine's Docker daemon. See
`test/live/README.md` for what they need and what they clean up.

## License

Apache-2.0, Parcha Labs, Inc. See `LICENSE` and `NOTICE`.
