# Examples

Each example shows one property you get from running pi-durable agents on this package. The ones marked "CI: yes" run on
a directory of this machine with pi-ai's faux model: no disk, no key, no network. A test runs each of them on every
change, and each one ends with a single `ok: ...` line naming what it showed.

| Example | What it shows | Needs | Since | CI |
|---|---|---|---|---|
| [01-durable-chat](01-durable-chat/) | A chat survives its host being powered off: another host revokes the dead claim and goes on from the last committed message, nothing answered twice | Linux, the archil client, an Archil disk and API key | checkout | no |
| [01-durable-chat/on-a-directory.mjs](01-durable-chat/on-a-directory.mjs) | The no-key quickstart: the same chat on a directory of this machine, killed after its third answer and finished by a second process | Linux, Node 22.19 or later | 0.1.0-beta.13 | yes |
| [02-paid-effect](02-paid-effect/) | A paid charge cut mid-flight by a lost host is never sent twice: the new host records it `interrupted` and tells the model | Linux, the archil client, an Archil disk and API key | checkout | no |
| [no-double-charge](no-double-charge/) | A paid call cut by `kill -9` is never sent twice: the next process gets it back `interrupted`, and the payment server has one charge per invoice | Linux, Node 22.19 or later | 0.1.0-beta.13 | yes |
| [audit-across-crashes](audit-across-crashes/) | A run killed twice mid-call is accounted for from its store alone: a recorder in `beforeResume` snapshots every task, document and entry at each incarnation's head, and the account names the cut calls and who settled them | Linux, Node 22.19 or later | 0.1.0-beta.13 | yes |
| [kill-9](kill-9/) | A coding agent survives `kill -9` in the middle of a long bash command: its files are intact, the cut command comes back `interrupted` and is never run again, its file tools stay in `work/`, and it finishes | Linux, Node 22.19 or later | 0.1.0-beta.13 | yes |
| [planned-move](planned-move/) | A run moves from this machine to a Daytona sandbox at a step boundary by hand-over: released and sealed, opened at the next generation, the agent told, nothing revoked or interrupted | Linux host with the archil client and systemd, an Archil disk and API key, a Daytona key (Tier 3 or 4) | 0.1.0-beta.14 | no |
| [fork-into-many](fork-into-many/) | One run taken to a checkpoint and sealed is forked three ways: each fork is a run of its own, continues from the checkpoint with its own instruction, and the source stays byte for byte | Linux, Node 22.19 or later | 0.1.0-beta.14 | yes |
| [serve-and-park](serve-and-park/) | An idle agent holds no process: a run that only waits on a long retry parks (the wake in `run.json`, the claim released, exit 0), a restart at `wakeAt` finishes it, and a repeated `requestId` is answered, not run again | Linux, Node 22.19 or later | 0.1.0-beta.14 | yes |
| [docker-quickstart.sh](docker-quickstart.sh) | Example 02 with every instance in a container, on macOS or Linux, with nothing installed but Docker and Node | Docker, an Archil disk and API key | checkout | no |
| [verify-production-path.sh](verify-production-path.sh) | The README's production host setup, checked on a disposable root machine | a disposable Linux machine with root, Archil | checkout | no |

## Run one

An example built to the conventions below (each one marked "CI: yes" except the quickstart file) runs from a checkout,
after the root `npm ci --ignore-scripts && npm run build`:

```sh
cd packages/pi-durable-disk
node examples/<name>/main.ts
```

The quickstart is `node examples/01-durable-chat/on-a-directory.mjs`. Examples 01 and 02 on a disk, and the two scripts,
run as their own READMEs and headers say.

Node 22.19 or later runs the TypeScript directly. Linux only, for now: a run on a local directory holds its root through
`/proc/self/fd` (see [A run on a local directory](../README.md#a-run-on-a-local-directory)).

## Run one from an install

The examples on `main` are written against `main`, and what npm has is the last published beta (`npm view
@parcha/pi-durable-disk dist-tags`). The **Since** column is the first published version that has what the example imports:
older than that, it stops at its first import. To run one from an install, in an empty directory on Linux with Node 22.19 or
later:

```sh
npm init -y && npm pkg set type=module
npm install @parcha/pi-durable-disk@beta @earendil-works/pi-durable@~1.2.0 @earendil-works/pi-ai@~1.2.0 @earendil-works/chord@~1.2.0
mkdir audit-across-crashes && cd audit-across-crashes
# copy the example's files in (main.ts and any helper beside it, not its README or its test), from a checkout or from GitHub
node main.ts
```

The pi packages are pinned to 1.2: pi 1.3.0 pins its own packages to exact versions, and this release's ranges stop below 1.3 until the next one.

`npm pkg set type=module` is what lets Node read the example's `import` lines without reparsing every file and printing a
warning on each start. Run it from the directory that holds `node_modules`, or from one inside it. An example whose Since is
`checkout` imports files outside its own directory and runs only from a checkout of the repository.
The `ExperimentalWarning` about SQLite on stderr is Node's own and harmless.

The Since cells are checked, not just written: the `stranger` CI job (`scripts/stranger.mjs pi-durable-disk`, spec
`scripts/stranger/pi-durable-disk.json`) installs each keyless example's Since from npm the way the section above says, runs it
and expects its `ok:` line. An example whose Since is above the registry's `beta` tag is skipped, with the reason printed;
`node scripts/stranger.mjs pi-durable-disk --examples` runs just this check.

## Writing an example

Examples 01 and 02 predate these conventions and run on an Archil disk. A new example follows them, and
`test/examples/conventions.test.ts` checks the parts code can check.

1. **One directory, one property.** `examples/<name>/` holds `README.md` and `main.ts`, and helpers beside them if it needs
   any. The name is descriptive, lowercase, with dashes and no number prefix (`kill-9`, `no-double-charge`). The property
   is something a user cares about, stated in one sentence.
2. **Self-contained.** The example imports only `@parcha/pi-durable-disk` (and its subpaths), its peers
   (`@earendil-works/pi-durable`, `@earendil-works/pi-ai`, `@earendil-works/chord`), `node:` builtins, and files in its own
   directory. Nothing from `../`, `src/`, `test/` or `lib/`. A reader can copy the directory into a project that installed
   the package. A fake third party (a payment API, a slow service) lives in the example's directory.
3. **TypeScript that Node runs.** `node examples/<name>/main.ts` runs it with no flags and no `tsx`. So only erasable
   syntax (no `enum`, `namespace` or constructor parameter properties), `import type` for types, and `.ts` on relative
   imports. `npm run typecheck` checks examples against the package's source, so an API change that breaks an example
   fails the build.
4. **No key, no network.** The run is `localRun` on a fresh directory `<name>-run` under the current directory: remove it
   first, and print its path. The model is pi-ai's faux provider, scripted so the run is the same every time. A real model
   is an optional flag (`--model <provider>/<modelId>`, its key from the provider's usual environment variable), never
   needed by the test, and only where the property does not depend on what the model chooses. Two things keep a scripted
   run the same on every pi version the peers accept (1.0.4 to 1.2): the faux script reads the last message that is not
   the system's (pi 1.0.4 puts its system message after the user's), and a tool gives the model its text with
   `api.output(text)` and returns no `content` (`api` is the `ToolExecutionApi`, `execute`'s second argument; pi 1.2 drops
   a returned `content`), and reads a result's text as `output ?? content`.
5. **Its own supervisor.** An example that kills and restarts the run spawns its own instances (`main.ts instance`), reads
   their output a line at a time (`readline`), and waits for `close`, not `exit`, before it reads what they wrote. It
   ends every process it started, on success and on failure.
6. **One verdict line.** Progress lines go to stdout as the run goes. On success the last line is
   `ok: <a fixed sentence naming the property>` and the exit code is 0; anything variable (a path, a count) comes after the
   fixed sentence. On failure it writes `not ok: <what was wrong>` to stderr and exits 1.
7. **A README a stranger can follow.** What it shows (the property, one paragraph), how to run it with the output to
   expect, how it works (short, pointing at the lines of `main.ts` that matter), and what it does not show: a run on a
   local directory has no fence and guards one machine only, and the example says so where it matters.
8. **A test that runs it.** `test/examples/<name>.test.ts` calls `runExample("<name>")` from
   `test/examples/_run-example.ts`, which runs `node main.ts` from a scratch directory, gives the process group a timeout and
   reaps it, then `assertExampleOk(run, /^ok: <the sentence>/m)`: exit 0 on its own, before the timeout (an example that
   exits while a process it started still holds its output is a failure), and the `ok:` line. It needs no key and no
   network, and runs in the package's `npm test`.
9. **Listed and logged.** The example's pull request adds its row to the table above (`[<name>](<name>/)`, what it shows,
   what it needs, the first published version that has what it imports, CI) and a changelog fragment,
   `changes/pi-durable-disk-example-<name>.md` with `kind: docs`. Its README says that version too, in its "Run it" section:
   an example for an API that is on `main` and not yet published says "or later" and names the next beta.
