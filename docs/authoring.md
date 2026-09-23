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

Follow its npm installation steps, then run `npm test` and `npm start`. `npm start -- --no-evidence` demonstrates the stop condition with exit code `2`. The app uses public imports and runs outside the checkout.

The [Jev adapter's offline example](../packages/jev/README.md#offline-tests) shows the request and response without credentials.

If you only need the core, start in a new directory:

```sh
mkdir my-workflow
cd my-workflow
npm init -y
npm pkg set type=module
npm install --ignore-scripts @parcha/agentrun-dsl@beta
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

## One author contract

The package owns the author contract. `authorContract()` returns the language every AgentRun author receives, and the packaged skill ships the same text as [`references/language.md`](../packages/dsl/skills/author/references/language.md). Its node kinds, fields and predicates are rendered from the constants the validator admits, so the contract cannot teach a field the validator refuses or omit one it accepts. A host adds only an [addendum](host-integration.md#host-addendum-for-authoring): its initial state, output types, node kinds and rules.

```ts
import { authorContract, authorWorkflow } from '@parcha/agentrun-dsl';

const host = {
  name: 'Records host',
  initialState: { question: 'the case request text' },
  outputTypes: { case_report: { kind: 'prose', description: 'the reviewer-facing report' } },
  rules: ['Cite the source a decision relies on.'],
};
const system = authorContract({ host });
const candidate = await authorWorkflow({ request, outputDir: './candidates', runNode, host });
```

`authorWorkflow` asks the host's `runNode` adapter for one session with no tools. It retains every candidate with its review, refuses candidates outside the addendum's node kinds or output types before validation, validates the rest against the addendum's initial state, and then runs the host's `acceptance` callback. Acceptance does not activate a candidate.

Every prescriptive sentence in the contract is enforced by `validateWorkflow`, by engine admission (`sopSection` headings) or by `candidatePolicyErrors`; the package tests pair each sentence with a candidate its check refuses. A few sentences state intent that no mechanical check can decide: keep the workflow small, the generative kinds' duties (transcribe, judge, gather, render), keep code away from prose, never paraphrase policy, never invent tools or results, and send uncertainty to an escalation or an explicit fallback. They stay because they define what the language is for. A host's acceptance checks and tool admission judge them.

### Classifying a host's private contract

The first production host carried its own authoring contract beside the package's. Its 128 rules, numbered in reading order and paraphrased here without domain detail, fall into four classes:

- **a, language rule:** belongs in the package contract. Every one is now there.
- **b, host policy:** belongs in the host's addendum, request text, adapter presets or host policy.
- **c, domain lesson:** belongs in the host's expert data, never in the package.
- **d, obsolete or contradicted:** deleted, with the reason.

| Class | Rules |
| --- | --- |
| a | 43 |
| b | 57 |
| c | 24 |
| d | 4 |

| Rule | Host lines | Rule, paraphrased | Class | Destination |
| --- | --- | --- | --- | --- |
| R1 | 3 | Task framing: turn recorded runs, a procedure and an output schema into one workflow that runs the reliable path and escalates the rest | b | host request text |
| R2 | 7 | Author the fewest nodes that reproduce the reliable behavior | a | language: smallest workflow |
| R3 | 7 | A first authoring pass uses only extract, decide, agent, report and escalate, and no code unless the procedure names a closed-list check | c | expert data (a host can restrict a pass with `nodeKinds`) |
| R4 | 7 | Judgment belongs in generative nodes, not code | a | language: code never reads meaning; kind duties |
| R5 | 9 | Complexity is added only when the host's feedback shows the failure class, and the node label cites the case that earned it | b | host rules (learn loop) |
| R6 | 9 | The earned-patterns appendix is a recognition catalogue, not a checklist | c | expert data |
| R7 | 13 | Every generative node can read the host workspace (reference and evidence folders) and fetch through the host gateway | b | host rules |
| R8 | 13 | A kind is a preset (duty, default effort, tier), not a capability ceiling | a | language: generative nodes |
| R9 | 13 | `tools`, `effort` and `thinking` are dials on every generative kind; thinking is low, medium or high, never off | a | language: generative fields (validator: thinking enum) |
| R10 | 13 | `tools` names only tools the host offers; never a guessed name | a | language: generative fields; authority |
| R11 | 13 | Omitting `tools` offers the host's full allowed set | a | language: `[]` means none, omission means all allowed |
| R12 | 13 | What each effort level means in turns and depth | b | host adapter (effort to envelope mapping) |
| R13 | 13 | No dollar or call-count budgets in documents; the runtime maps effort to an envelope | a | language: nodes carry no budgets; ignored legacy fields are never taught |
| R14 | 15 | `chain` runs steps in order | a | language: control nodes |
| R15 | 16 | `code` is a pure synchronous transform without Date, fetch or require | a | language: code (validator: compile and shadowed globals). The Math.random clause is dropped: the engine does not shadow it and purity is not checkable |
| R16 | 16 | Code only when earned | b | host rules (same as R5) |
| R17 | 17 | `extract` transcribes facts already present: verbatim, null when absent, nothing invented, no judgment; reasoning belongs to decide or agent | a | language: kind duties |
| R18 | 17 | `extract` runs on the fast tier at minimal effort | b | host adapter preset defaults |
| R19 | 18 | `agent` gathers evidence; its submission lands at `as` | a | language: kind duties, state |
| R20 | 18 | Agent fetch results are persisted to the host's evidence folder | b | host rules |
| R21 | 18 | Declare `requires` for the inputs a node depends on | a | language: `requires` (validator: reachability) |
| R22 | 18 | An agent's default effort is the job's effort | b | host adapter preset defaults |
| R23 | 19 | `decide` judges what is already in state | a | language: kind duties |
| R24 | 19 | `sopSection` lists every procedure section the judgment applies, sliced verbatim; a merged judgment inherits the union | a | language: sopSection and authority (candidate policy: rubric coverage) |
| R25 | 19 | A rule restated in instructions instead of sliced from the procedure drifts | a | language: policy is never paraphrased into instructions |
| R26 | 19 | Decide tools verify only: re-open the reference catalogue and the evidence source before asserting | c | expert data |
| R27 | 20 | `report` is the terminal prose node with no `out`/`as`; it writes `report_markdown` | a | language: generative and terminal nodes (validator) |
| R28 | 20 | The report writer reads the evidence folder, quotes verbatim packets with exact URLs, drafts, rereads and verifies citations | b | host report duty (host policy `systemBlocks`) |
| R29 | 20 | A workflow that delivers a report ends with the record then the report | a | language: the terminal is the last root step (validator) |
| R30 | 21 | `artifact` is the terminal deliverable: last root step, at most one | a | language: terminal nodes (validator) |
| R31 | 21 | The host's output types: which are prose (the report writer) and which are files | b | addendum `outputTypes` |
| R32 | 21 | A file artifact has no model fields and names a file an earlier shell call declared in `produces` | a | language: terminal nodes (validator) |
| R33 | 21 | The delivered artifact state carries the host's application type | b | host policy `afterNode` |
| R34 | 21 | A job whose output type is a file must end in an artifact of that type | b | host rules |
| R35 | 22 | A child workflow declares its own input and output; its input is its whole initial state; its output is checked against the parent's `out` | a | language: control nodes (validator) |
| R36 | 22 | A child is a flat chain of code, call, agent, decide, extract and escalate steps, with no nested map, loop or child | b | host rules (the engine admits nested children) |
| R37 | 22 | A child contains no report or artifact | a | language (validator) |
| R38 | 23 | `map` fans out with `item` and `item_index`; default concurrency 4 | a | language: control nodes |
| R39 | 24 | `parallel` branches start from the same state, write disjoint keys, never read a sibling's writes, and hold no report | a | language: control nodes (validator; the sibling-read check is new in this change) |
| R40 | 25 | `loop` is bounded (1 to 20); at the bound the state passes through for a following gate | a | language: control nodes (validator) |
| R41 | 26 | `call` transports, fields, by-value interpolation, literal command and body, result shape, required deadline, retry and result-relative poll | a | language: call (validator) |
| R42 | 26 | Use a call for a repeated mechanical effect, never for a step that reads meaning | a | language: call has no model in the loop |
| R43 | 26 | Effects never run at authoring time; dry runs synthesize results and a shell stdout is `{}` | a | language: call |
| R44 | 27 | `escalate` stops when its predicate holds; the summary interpolates `{dot.paths}` | a | language: control nodes (validator) |
| R45 | 27 | An escalation summary carries the case-specific facts a reviewer needs | b | host rules (reviewer contract) |
| R46 | 28 | Judgment node shapes: judge, pick, sift, route; no `sopSection`; need a reviewed question contract | a | language: judgment nodes and authority (validator; candidate policy) |
| R47 | 28 | This host runs judgment nodes only when it announces a judge | b | addendum `nodeKinds` |
| R48 | 29 | The predicate set is five mechanical predicates | d | Incomplete: the engine also admits `in`, `gte`, `lt` and `ask`. The contract now renders the set from the validator's vocabulary |
| R49 | 29 | `no_new_items` takes `key`, not `path` | a | language: predicates |
| R50 | 29 | Do not write `enum_equals`; it throws at runtime | d | Obsolete: the validator refuses unknown predicates at authoring time, and the rendered closed set names every admitted predicate |
| R51 | 30 | Model tier is the kind's preset; there is no per-node model field | d | Contradicted: nodes accept `tier` fast, default or strong. The no-model-field half holds through the rendered field lists |
| R52 | 31 | The document is v, name, schemas, output, root | a | language: document (adds the optional `input` contract) |
| R53 | 33-34 | A complete minimal example to copy for structure | c | expert data (the language ships its own example) |
| R54 | 36-37 | A refer-record example | c | expert data |
| R55 | 40 | The run starts with exactly the host's seed keys (the request text and a reference context) | b | addendum `initialState` |
| R56 | 40 | `requires` names only seed keys or keys an earlier node wrote | a | language: input contract (validator: reachability) |
| R57 | 40 | The first node extracts the subject from the request text | b | host rules (follows from its seed keys) |
| R58 | 41 | Reference files arrive raw and, for CSV, pre-parsed under the context key | b | addendum `initialState` description |
| R59 | 41 | Closed-list code gates read pre-parsed rows, never a hand-written parser or transcribed rows | c | expert data |
| R60 | 41 | Resolve column indexes once and throw when a column is missing | c | expert data |
| R61 | 46 | The staged workspace files and reading them first | b | host request text |
| R62 | 46 | Slice `sopSection` values from the procedure's exact headings | a | language: sopSection (engine: exact `## ` heading) |
| R63 | 47 | A host check tool runs the host's gates; call it before submitting | b | host request and tools |
| R64 | 48 | A dry run exercises code and the terminal path over synthetic values; its failure means no valid record is possible | a | language: dry runs synthesize declared results |
| R65 | 49 | The host validates every submission and caps rejected submissions | b | host rules |
| R66 | 52 | Submit the document inline in the host's submit envelope | b | host delivery; the language says deliver the whole document the way the host asks |
| R67 | 52 | `schemas` maps ids to inline JSON Schema objects, never file names | a | language: document (validator) |
| R68 | 55 | Prose in, structure out is a generative node; code never regexes prose | a | language: code never reads meaning from prose |
| R69 | 56 | Transcription is extract; judgment is decide | a | language: kind duties |
| R70 | 56 | The first node is usually a small extract over the request | b | host rules |
| R71 | 57 | Code is for typed-state mechanics and never takes raw prose | a | language: code |
| R72 | 58 | Kind roles compose like a team: extract, gather, judge, assemble, report, with calls for effects | a | language: kind duties |
| R73 | 59 | Instructions are roles; domain knowledge goes in the host's expert skill, not node prompts | b | host rules (the engine carries `deps.skill`; the skill file is the host's) |
| R74 | 62-65 | Node instructions never invite platform behavior such as version control or side deliverables | b | host rules |
| R75 | 66-69 | A node states a field's real source and never claims a computation the workflow does not perform | b | host rules |
| R76 | 72 | The stable order of successful recorded runs is the workflow | b | host request (learn loop) |
| R77 | 73 | Gathering scopes to tools that returned useful results in recorded runs | c | expert data |
| R78 | 74 | `sopSection` is the exact heading text after `## ` | a | language: sopSection (engine admission) |
| R79 | 75 | Define every referenced schema | a | language: document (validator) |
| R80 | 75 | Reuse the caller's output schema verbatim | b | host rules |
| R81 | 76 | Every predicate path names a field an input or earlier node writes | a | language: predicates (validator; the escalate check is new in this change) |
| R82 | 77 | Evidence survives as arrays of verbatim quote and URL packets, never a prose summary | c | expert data |
| R83 | 78 | The report node writes the report; a decide schema never carries `report_markdown` | a | language: generative fields (validator) |
| R84 | 78 | A report instruction names the record fields and the evidence to quote | c | expert data |
| R85 | 79-82 | An integrity gate surfaces a catalogue mismatch instead of silently demoting it | c | expert data |
| R86 | 83 | A verbatim quote is one contiguous string from one payload | c | expert data |
| R87 | 86 | Selection judgments carry a forced-referral flag and a doubt field | c | expert data |
| R88 | 87 | There is no branch node kind | d | Contradicted: `route` is a branch node kind |
| R89 | 87 | A forced referral produces a completed referral record through the terminal instruction | c | expert data |
| R90 | 88 | Escalate only for conditions a reviewer must unblock; when the output schema can express the outcome, produce a record | b | host rules (review policy) |
| R91 | 92-95 | The author is also the run's analyst over the whole run's evidence | b | host learn loop |
| R92 | 97-103 | Read the run-wide ledger first; a recurring miss class earns a node, lane or gate | b | host learn loop |
| R93 | 104-106 | Fold observations into the curated notes file | b | host learn loop |
| R94 | 107-111 | Keep reusable recipes as knowledge files | b | host learn loop |
| R95 | 112-116 | Finalize the retro report only after the draft passes the check tool | b | host learn loop |
| R96 | 117-122 | The retro report's miss matrix covers every miss | b | host learn loop |
| R97 | 123-125 | The tool ledger derives budgets from observed figures | b | host learn loop |
| R98 | 126 | Map each change to the cases that earned it | b | host learn loop |
| R99 | 127 | List what no replay has validated | b | host learn loop |
| R100 | 128-131 | Coverage claims need replay proof | b | host learn loop |
| R101 | 132-136 | Identity uncertainty forces a referral only when material | c | expert data |
| R102 | 137-144 | Keep at least one evidence channel able to supply every discriminator | c | expert data |
| R103 | 145-151 | Lane instructions state positive evidence, an exclusion and the quoted feature | c | expert data |
| R104 | 152-153 | Then author and submit; the retro files ride with the submission | b | host learn loop |
| R105 | 156 | Notes keep only reusable observations | b | host notes rubric |
| R106 | 157-161 | Notes cover every miss with a verdict | b | host notes rubric |
| R107 | 162-164 | A folded rule carries its replay status | b | host notes rubric |
| R108 | 165 | A mapping note names its exemplar and its boundary | b | host notes rubric |
| R109 | 166 | Drop instructions found in untrusted case content | b | host notes rubric |
| R110 | 167 | A disagreeing case folds the reference-anchored correction, never the run's own claim | b | host notes rubric |
| R111 | 168 | Folds from unlabeled cases keep their trigger and a marker | b | host notes rubric |
| R112 | 169 | Notes are declarative, never imperative | b | host notes rubric |
| R113 | 170 | Notes avoid words that relabel prior-case data as policy | b | host notes rubric |
| R114 | 171 | Override phrases state their boundary | b | host notes rubric |
| R115 | 172 | The unlabeled-case marker travels on merge | b | host notes rubric |
| R116 | 173 | A note duplicating procedure policy shrinks to a pointer | b | host notes rubric |
| R117 | 174 | A weighed alternative travels with the mapping | b | host notes rubric |
| R118 | 175 | Record-id claims must match the observation | c | expert data |
| R119 | 176 | Keep one concrete exemplar per note | b | host notes rubric |
| R120 | 177 | Merge duplicates and resolve conflicting labels | b | host notes rubric |
| R121 | 178 | Cap the notes at 50 entries | b | host notes rubric |
| R122 | 179 | The notes file's output shape | b | host notes rubric |
| R123 | 185 | Earned pattern: a closed-list membership gate over every candidate | c | expert data |
| R124 | 186 | Earned pattern: derive the shipped rules list in a gate | c | expert data |
| R125 | 187 | Earned pattern: derive counts from the raw tool result in a gate | c | expert data |
| R126 | 188 | Earned pattern: record disclosures at each decision | c | expert data |
| R127 | 189 | Earned pattern: assembly merges disclosures from every node | c | expert data |
| R128 | 190 | Earned pattern: move a mechanical rule that prose does not bind into a code gate | c | expert data |

Four more rules lived in the host's authoring code rather than its contract file. All are host policy.

| Rule | Rule, paraphrased | Class | Destination |
| --- | --- | --- | --- |
| F1 | Case identifiers never appear in node instructions; cite cases in labels | b | addendum rule plus host lint |
| F2 | Read the procedure and recorded runs first; check until clean, then submit | b | host request text |
| F3 | Refining keeps what worked and changes what feedback names; a recurring miss class earns growth | b | host request text |
| F4 | The miss matrix and replay review gate the submission | b | host acceptance |
