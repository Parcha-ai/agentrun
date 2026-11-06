# The packages

AgentRun is built from packages that also work on their own. The [README](../README.md) covers running the platform; this page covers using the pieces.

### Use one piece

Each package works on its own. [Pi](https://pi.dev) is an open-source coding agent; pi-durable is
Pi's runtime that commits each turn and tool call to storage; chord is the plugin and service runtime pi-durable is built
on; [Archil](https://archil.com) is a network disk you mount on any Linux host.

| Package | What it does | What it needs | First command with no key | Status |
| --- | --- | --- | --- | --- |
| [`@parcha/agentrun-dsl`](../packages/dsl/README.md) | Define, validate, inspect and run workflows | Node 22.19+ | `npx @parcha/agentrun-dsl@latest demo` | published (`@latest`) |
| [`@parcha/agentrun-jev`](../packages/jev/README.md) | Jev typed decisions as a workflow's `runJudge` | the DSL; a TypeSafe key or an OpenRouter key for live calls | its README's [offline test](../packages/jev/README.md#offline-tests) | published (`@latest`) |
| [`@parcha/agentrun-pi`](../packages/pi/README.md) | The `/agentrun` Pi extension and a Pi-backed node runner | Pi 1.0.4 to below 1.4 (CI tests 1.0.4, 1.1.0, 1.2.0 and 1.3.0); a model for live runs; pi-durable for its `./durable` entry | `/agentrun demo` in Pi (scripted, no model calls) | published (`@latest`) |
| [`@parcha/pi-durable-disk`](../packages/pi-durable-disk/README.md) | Run a pi-durable agent on a network disk: one owner per run, a fence, a supervisor | pi-durable and chord; an Archil account, a disk and an API key | none yet | published (`@latest`) |
| [`@parcha/pi-browser`](../packages/pi-browser/README.md) | Your agent gets its own browser, and you can take over and hand it back. Pages it reads are filed as evidence, and failures have typed codes | Pi; a provider (a local Chrome needs no key; Browserbase and Kernel need their keys); pi-durable and chord for its `./durable` entry | its README's [no-key command](../packages/pi-browser/README.md#try-it-without-a-key-or-a-chrome) | published (`@latest`) |
| [`@parcha/pi-vision`](../packages/pi-vision/README.md) | Lets a pi agent read documents, images, scans and video within the model's limits, and keeps a priced record of every look | nothing for a document's text; Photon or sharp for images; a pi-durable host (pi-durable, chord and pi-ai); a model that looks, for questions about a file | [`examples/vision-agent`](../examples/vision-agent/README.md) (one agent that answers questions about files: `npm run demo:vision -- examples/document-check` runs on fakes, no key; it needs ffmpeg and poppler), then its README's [first read](../packages/pi-vision/README.md#a-first-read-with-no-key) | published (`@latest`) |
| [`@parcha/pi-transport`](../packages/pi-transport/README.md) | A pi agent's tools on the machine each step needs: this machine, Docker, or a Daytona or Modal sandbox, behind one `Box` interface; Jev places each step | pi-durable and chord; Docker for the Docker provider; a Daytona key or a Modal client for those; a TypeSafe key, or an OpenRouter key, for Jev's placement | the "A box" example in its README (a local box, no key; a second one needs Docker) | published (`@latest`) |
| [`@parcha/pi-git-remote`](../packages/pi-git-remote/README.md) | A git repository a host keeps for its agent: commits through git's plumbing, no hook or filter of either repository runs, no push is forced | git 2.40+; pi's coding agent only for its `./coding-agent` extension | its README's [quickstart](../packages/pi-git-remote/README.md#quickstart-no-key-no-network) | published (`@latest`) |
| [`@parcha/pi-agent-learn`](../packages/pi-agent-learn/README.md) | An agent that learns in its own git repository: a `learn` tool, notes curated into commits, saved workflows promoted on receipts | pi-durable and chord; git 2.40+; a judge (Jev or a general model) for curation | its README's [quickstart](../packages/pi-agent-learn/README.md#quickstart-no-key-no-network) | published (`@latest`) |
| [`@parcha/agentrun-learn`](../packages/learn/README.md) | Self-learning on any harness, as files: the layout of an agent's own learning repository, the memo and note formats, and a checker for a run's branch | the DSL; git | `agentrun-learn check --base main` on a run's branch | held, not published |
| [`@parcha/agentrun-decisions`](../packages/decisions/README.md) | Fast decision models besides Jev for a workflow's decision nodes: Parallel Decisions, with probabilities and web citations, behind the DSL's provider seam | the DSL; a Parallel key | `runJudge: judgeFromProvider(parallelProvider())` | published from the next release (`@latest`) |
| [`@parcha/pi-durable-agent`](../packages/pi-durable-agent/README.md) | An agent home for pi agents: its definition, skills, saved sign-ins and runs in one directory that also moves as one file, a pack. An agent's sign-ins are saved in its home, so its next run starts signed in | pi-durable and chord; nothing else for its quickstart (a browser provider such as pi-browser makes the sign-ins) | its README's [quickstart](../packages/pi-durable-agent/README.md#quickstart-no-key-no-network) | published (`@latest`) |
| [`@parcha/agentrun-harness`](../packages/harness/README.md) | A reference harness: the host we use to run AgentRun demos and tests, meant to be read and forked | pi-durable, chord, pi-ai, pi-codemode and typebox; pi-transport only for a demo with boxes | its README's [first demo](../packages/harness/README.md#run-a-demo-from-an-install-with-no-key) | held, not published |

A held package is built, tested and verified with the others, and its manifest says `"private": true`; it installs from
a packed tarball, not from npm.

### Use all of it

One program puts the packages together and runs a job end to end on pi-durable: a durable run, the recovery driver, the
node runner, the browser and vision. It uses a scripted model and a fake browser, needs no key, and prints the record
and the receipts it cites.

```sh
npm ci --ignore-scripts
npm run build
npm run demo:reference
```

[`examples/reference/`](../examples/reference/) has the job; the host is the package [`@parcha/agentrun-harness`](../packages/harness/README.md). [What a host supplies](reference-host.md)
lists the seven functions the packages ask a host for, the install order and why, and what the example does not do yet.
