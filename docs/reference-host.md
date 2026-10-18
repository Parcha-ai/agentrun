# What a host supplies

[`@parcha/agentrun-harness`](../packages/harness/README.md), with its example job in `examples/reference/`, is one program that puts the open packages together: a
durable pi run, the recovery driver, the workflow node runner, the browser and vision. It runs one job end to end with
a scripted model and no key. This page says what each package asks of the host that runs it, so you can replace the
scripted parts with your own.

```sh
npm ci --ignore-scripts && npm run build && npm run demo:reference
```

## The seven host functions

The example declares them as one value, `Host` (`packages/harness/src/host.ts`). Each member feeds an option that an open
package already has; none is new. The last column is what `localHost()` passes so the job needs no key.

| # | Host function | Who asks for it | The type that already exists | The example passes |
| --- | --- | --- | --- | --- |
| 1 | **Models** | pi-durable's `models`; the node runner's agent (`NodeHost.agent`); vision's `eyes` or `eyesModel` | pi-ai `Models`; pi-durable `ModelRef` | pi-ai's faux provider, answering from the job's script |
| 2 | **Tools** | the workflow's `call` (`runEffect`); the agent's extensions and tools; the browser's `provider` and `driver` | the DSL's `runEffect`; pi `Extension`; pi-browser `BrowserProvider` and `DriverFactory` | a `search` tool in the process, no extra extensions, the browser's `FakeBackend` from `@parcha/pi-browser/testing` |
| 3 | **Evidence** | the browser and vision: both file receipts through one `evidence` option | `EvidenceRecord` (`@parcha/pi-browser`) and `LookRecord` (`@parcha/pi-vision`); `file(label, record)` returns the path the model cites | one JSON file per record under `<run>/evidence/<label>/`, named by its hash |
| 4 | **Decisions** | the workflow's `judge`, `pick`, `sift`, `route`, `ask` and `verify` (`runJudge`) | the DSL's `runJudge` | a scripted judge. `runJudge` may be left out only when the workflow has no `judge`, `pick`, `sift`, `route`, `ask` or `verify` step; with one of them and no `runJudge`, the run throws |
| 5 | **Status** | the browser's `onSession`; vision's `onLook` and `onMiss`; the workflow's `onEvent` | each package's own row type. A throw in a status function never fails the call that reported | one JSON line per row in `<run>/events.jsonl` |
| 6 | **Delivery** | the workflow's output | the DSL's run result | `<run>/out/record.json` |
| 7 | **Credentials** | the browser's `redact` (strings scrubbed from its output) and its provider (a closure that holds the key); vision's `env`, the whole environment of a program it starts; Jev's key | closures, and `ChildEnv` from `@parcha/pi-vision/node`. No package stores a secret in a document | none. A program vision starts sees only `PATH` |

Two things the packages ask for are not on that list, and the example folds them into where the run lives:

- **The run's place**: its id, store, work directory and evidence directory. `@parcha/pi-durable-disk` already has the
  shape, `AppContext { ref, root, work, store }`, and the browser's `workspace` and vision's `deriveDir` are paths under it.
- **Labels**: the browser's `BrowserConfig.label`, vision's `scope().label` and a workflow node's `label` all name the
  work one conversation does, and each names an evidence directory. One function gives all three.

## Install order

A host installs every extension in the registry before the Harness opens, because tasks a crashed process left need
them when the run resumes. A conversation selects the installed extensions in install order, a later extension's tool
replaces an earlier tool of the same name, and `wrapTool` decorates whichever tool won. The example installs, in this order:

1. File and shell tools: the disk package's `ArchilCodingTools`, confined to the run's `work/` directory. The tools
   other extensions wrap must exist first.
2. The host's own extensions (`tools.extensions`). A host tool that replaces `read` has to win before vision wraps it.
3. Vision. Its `read` wrap decorates whichever `read` won, and its guard fits the images of every tool's result,
   the browser's screenshots included.
4. The browser, then web tools.
5. The workflow node runner's extension, which carries `submit`. It is selected by a node's own conversation only.

Then, in this order: open the run (a claim on a plain directory, and the Harness); reconcile the browser's sessions
(the browser asks for this "after install and before resume"; on a disk run pi resumes inside the open, so a workflow
task it resumes waits until the reconcile has run); start the workflow's task, which opens the recovery driver on
the run's own documents, or reach the task the open resumed, and wait for its outcome; deliver the record; release
the browser sessions each node opened and wait for the release tasks; close the browser (`browser.close()`, which is
not the driver's close); release the run.

Install order matters only for tools of the same name and for wraps. Vision's guard sees a browser screenshot's image
whichever of the two is installed first.

## What a kill does

Measured by killing the reference job at many points and resuming it in a new process on the same directory:

- A call that completed is answered from the run's journal and is never sent again.
- A model request that was in flight is asked again by the next process: once in each process, as often as kills
  cut it.
- A tool call cut between its dispatch and the moment the host kept its answer cannot be settled. The resumed run
  refuses it with `FROZEN_EFFECT_UNKNOWN` rather than send it twice. Once the host has kept the answer (the example's
  tool door keeps it under the call's identity), the next process settles the call from it and goes on.

## What the example does not do yet

- Model tiers: one lead model.
- A cost fold: it prints pi's usage as it is.
- A tool gateway with grants: extensions pass straight through.
- Workspace custody beyond the disk package's confined tools.
- An agent loop outside a workflow: every model step here is a workflow node on the open node runner.
- A real browser by default. The fake backend opens the first search result and returns `run`'s code unrun. `--chrome`
  drives a local Chrome instead.

## Versions

Aim for one copy of pi-durable and one of chord: types do not cross copies, and behavior may not either. Each package
declares its own peer range for them, and an install of several packages can end up with more than one copy. Check what
your install landed on with `npm ls @earendil-works/pi-durable @earendil-works/chord`. The example's install has one
copy of each, so no value crosses copies and the example needs no cast between them.

## Swap a scripted part for a real one

Build `localHost()`'s value and replace one member:

- Models: a pi-ai `Models` with a real provider, and its model as `models.lead`.
- Judge: `createJevRunner()` from `@parcha/agentrun-jev` as `decisions.runJudge`. It needs `TYPESAFE_API_KEY`.
- Browser: `provider: () => browserbaseProvider()` (`provider` is a function that returns the provider) and
  `driver: stagehandDriver()` as `tools.browser`, with your prices.
- Tools: your own pi extensions in `tools.extensions`, and your tool server behind `tools.runEffect`.

The [integration guide](host-integration.md) covers the workflow interpreter's own adapters (`runEffect`, `runNode`,
`runJudge`, recovery and decision receipts) in more depth.
