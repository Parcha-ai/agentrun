# Build a workflow you can inspect and test

AgentRun composes code, tools, Jev system one decisions, and agents. A workflow defines their order and data contracts. The host supplies the implementations, permissions, and resources.

Use TypeScript to author with inferred boundary types, or write the JSON document directly. Both run through the same interpreter.

TypeScript consumers require TypeScript 5.4 or newer.

## Run a complete example

From the source checkout, with Node 22.19 or newer:

```sh
npm ci --ignore-scripts
npm run build
npm run demo
npm run test:typed-example
```

Should our small team move its documentation from a wiki into the code repository? A planning step splits it into questions about reviews, editing, and search. Each question runs the same research component. A final agent assembles the findings.

```text
Plan the research
       ↓
Research each question in parallel
  Search → Jev screens evidence → Write a finding
                ↓ no selected evidence
             Escalate
       ↓
Write the report
```

The demo runs the real interpreter with fictional passages and scripted adapters. It makes no network or model calls and does not measure research quality. The workflow is in [typed-research.ts](../examples/typed-research.ts); scripted responses live separately in [typed-research-fixtures.ts](../examples/typed-research-fixtures.ts).

Run `npm run demo -- --no-evidence` to make every source fail the evidence check. The same workflow stops before writing findings or a report, with exit code `2`.

For a first edit, change `keep: { path: 'answersQuestion', gte: 0.8 }` to `gte: 0.99` in `typed-research.ts`, then rerun `npm run demo`. The scripted evidence probability is `0.95`, so it now stops. No rebuild is needed for this TypeScript example. Restore `0.8` before running the unchanged acceptance tests. This changes a real execution rule; changing a prompt alone will not change the scripted model responses.

The [configured research walkthrough](live-research.md) wires the same workflow to Jev and your saved Pi default, and includes independently labeled evidence cases.

## Use in your own app

Copy the [standalone TypeScript app](../examples/starter/README.md) to build your own workflow. It includes a package file, compiler configuration, offline Jev client, and four tests. It keeps a documentation policy and its emergency exception while dropping a promotional claim. No agent is needed.

Follow its tarball installation steps, then run `npm test` and `npm start`. `npm start -- --no-evidence` demonstrates the stop condition with exit code `2`. The app uses public imports and runs outside the checkout. Keep the tarballs for reinstalls until packages are published; their paths are recorded in the app's lockfile.

The [Jev adapter's offline example](../packages/jev/README.md#offline-tests) shows the request and response without credentials.

If you only need the core, install just its tarball. From the built AgentRun checkout:

```sh
agentrun_checkout="$PWD"
mkdir -p .release/npm
npm pack --workspace @parcha/agentrun-dsl --ignore-scripts --pack-destination .release/npm
mkdir ../my-workflow
cd ../my-workflow
npm init -y
npm pkg set type=module
npm install --ignore-scripts "$agentrun_checkout/.release/npm/parcha-agentrun-dsl-0.1.0-beta.1.tgz"
node --input-type=module -e 'import { runTriageDemo } from "@parcha/agentrun-dsl/demo"; console.log((await runTriageDemo("billing")).result.output)'
```

This prints `{ queue: 'billing', priority: 'normal' }` without a model or key. The core brings only TypeBox; Jev and Pi remain optional. For TypeScript with Zod, install `zod@4.6.5` and add `typescript@5.9.3` plus `@types/node@22` as development dependencies, with `"strict": true`, `"module": "NodeNext"`, and `"moduleResolution": "NodeNext"` in your compiler configuration.

## Define the contracts

`defineWorkflow` accepts raw JSON schemas or schemas implementing [Standard JSON Schema](https://standardschema.dev/json-schema). The source example uses Zod:

```ts
const Question = z.strictObject({ question: z.string().min(1) });
const Finding = z.strictObject({
  question: z.string(),
  answer: z.string(),
  sources: z.array(Source).min(1),
});
```

Name those schemas in `schemas`, select `input` and `output`, and supply `steps` or a single `root`. The result is an ordinary, deeply frozen Workflow v2 document. Schema-library objects and TypeScript type markers are absent from its JSON representation.

The builder uses these conveniences over the serialized document:

| Authoring field | Emitted document field |
| --- | --- |
| `input: 'Question'` | `input: { schemaId: 'Question' }` |
| `output: { schema: 'Report', path: 'report' }` | `output: { schemaId: 'Report', path: 'report' }` |
| `steps: [...]` | `root: { node: 'chain', steps: [...] }` |

Converted schemas retain their `$schema` dialect declaration. It is part of the document and its digest; conversion does not silently remove it.

The core has no Zod runtime dependency. Zod is a development dependency in this source workspace for the example and integration tests. In your own application, install the schema library you choose.

## Reuse the complete component

The research component has a private state and catalog. Its parent supplies only its declared input and receives its validated output:

```ts
{
  node: 'map', label: 'research', itemsPath: 'plan.questions',
  as: 'findings', maxConcurrency: 3, resultPath: 'finding',
  body: {
    node: 'workflow', label: 'research-question',
    workflow: researchQuestion,
    input: { question: '{item}' }, out: 'Finding', as: 'finding',
  },
}
```

Children can contain maps, loops, parallel branches, routes, and other children. Their schemas stay local; their whole definition is included in the parent's digest. Reports and artifact delivery remain parent-owned. Use an agent returning a structured finding inside a child; use a report or artifact at the root when the host needs a deliverable.

Jev's `sift` step asks whether each candidate passage provides evidence answering the subquestion. Its rubric explicitly retains contrary evidence and rejects topical mentions or promotional claims. The raw probabilities remain in the trace. The example threshold of 0.8 is illustrative and needs evaluation on your own evidence. This follows TypeSafe's [query and candidate comparison pattern](https://docs.typesafe.ai/cookbooks/rerank_typesafe).

A `code` step returns a state update: `s => ({ result: s.text.trim() })` writes the `result` key. It does not replace the whole state. Text such as `{question}` interpolates in designated fields such as `call.args`, node `state`, and `escalate.summary`. Model `instructions` remain literal; declare the input fields with `requires` and refer to them by name.

## Run with inferred output

```ts
import { runTypedWorkflow } from '@parcha/agentrun-dsl';
import { deepResearch } from './typed-research.js';

const result = await runTypedWorkflow(deepResearch, { question }, deps);
if (result.status === 'complete') {
  console.log(result.output.answer);
  console.log(result.output.findings);
}
```

With compiled NodeNext TypeScript, local imports use `.js` even when the source file is `.ts`.

`deps` supplies `runEffect` for `call` nodes, `runJudge` for Jev decisions such as `judge`, `pick` and `sift`, and `runNode` for model steps such as `agent`, `decide` and `report`. The example's fixture factory supplies all three offline. For real execution, supply your search tool and configured adapters; see the [Jev adapter](../packages/jev/README.md) and [Pi adapter](../packages/pi/README.md). The engine does not grant tool access or choose credentials.

Type inference covers the declared input/output boundaries. Intermediate state paths and node-to-schema references receive runtime validation, not full static dataflow inference. Raw JSON schemas infer `unknown`.

Only representable JSON contracts are supported. The Zod guard rejects refinements, transforms, coercion, defaults, and other unsupported parser behavior before conversion. Put those operations in an explicit code or tool step. Other Standard JSON Schema providers are responsible for faithful conversion. AgentRun does not run their parsers. Root input contracts must describe objects. A plain `z.object` allows extra keys in its input contract but forbids them in its output contract; use `z.strictObject` when sharing one schema between both boundaries.

`runTypedWorkflow` accepts the original definition returned by `defineWorkflow`. Copied or imported JSON runs through `runWorkflow`, whose output is `unknown`; define a new typed workflow to restore schema-bound inference.

## Inspect before executing

```sh
node examples/run-typed-research.ts --export research.json
node packages/dsl/dist/cli.js inspect research.json
node packages/dsl/dist/cli.js inspect research.json --json
```

Inspection reads the graph and reports nested steps, document addresses, adapters, tools, SOP references, and executable-code presence. It does not run authored code or perform semantic admission. JSON output includes the workflow digest so tooling can associate the inventory with the exact document. Addresses are JSON Pointers into that document; they can change when the graph is edited.

The `validate` and `dry-run` commands remain separate and require `--trusted`, because semantic validation can execute code probes. Neither command is a sandbox. The JavaScript `validateWorkflow` API can also execute code probes; it has no `--trusted` gate. Use `inspectWorkflow` to inspect untrusted definitions without executing them.

Synthetic boolean answers default to probability `0.5`, which decodes as `true`. Supply explicit fixtures to test both branches; synthetic answers do not evaluate your question.

Dry-run reports `skipped` when it cannot synthesize a schema, including string patterns and formats emitted by Zod. Check that field: `ok: true` with a skip does not mean the graph was exercised.

## Evaluate the component before the system

Run `researchQuestion` by itself to test its input/output contract. To isolate just the evidence decision, seed the state immediately before that step:

```ts
const result = await runWorkflowSlice(
  researchQuestion,
  { question: subquestion, search: { sources } },
  { from: 'screen-evidence' },
  { runJudge },
);
```

Search and agents do not run. Inspect `result.state.evidence.items` and the retained answers. Slices select root steps of the supplied component; they do not promise arbitrary nested-node addressing or final-workflow output validation.

The [example tests](../examples/typed-research.test.mjs) exercise the same decision alone, the complete component, the parallel system, malformed input, and missing evidence. They verify execution behavior using fixtures. For model evaluation, keep the cases and replace the scripted decision adapter with Jev, then score retained/excluded passages against independent labels.

## Use it with an existing host

The serializable document is the integration boundary. A host can adopt typed authoring while retaining its interpreter, policies, pin hashes, and durable stores. New standalone node support does not automatically add that capability to an older host.

See [host integration](host-integration.md) for the compatibility check and recovery requirements.
