# Use real decisions and agents

Continue from the [research demo](../README.md#research-demo). This is the same research workflow, with a runner that can switch from scripted responses to your configured models.

Should our team move its docs from a wiki into the code repository? Search reads a bundled fictional corpus about reviews, editing and search. Jev selects evidence for each subquestion; agent steps turn that evidence into findings and a report.

## Connect Jev first

Configure `TYPESAFE_API_KEY` through your usual secret configuration. Organizations using a gateway also set their approved `TYPESAFE_BASE_URL`, including any gateway path prefix; the SDK appends `/v1/systemone`. See [Jev configuration](../packages/jev/README.md#configuration).

```sh
npm run eval:research -- --live --out evidence-live.json
```

This tests the evidence selector without running search, planning or writing agents. It prints six PASS/FAIL results and saves the full JSON. Use a new output filename each time; existing reports are never overwritten.

| Evidence | Expected |
| --- | --- |
| A concrete observation answering the question | Keep |
| Evidence against the proposed benefit | Keep |
| An unrelated record | Exclude |
| Topic overlap without an answer | Exclude |
| An unsupported promotional claim | Exclude |
| Insufficient information | Exclude |

The evaluator uses the actual `screen-evidence` step, including its rubric and threshold. Expected labels are kept separately and never sent to Jev. The report retains the workflow digest, threshold, probabilities, expected selections and failures.

## Test your own evidence

Create a JSON array of cases from your own task. Each case has `id`, `question`, `text`, `keep` as a boolean, and `reason`. Choose the expected labels before running the evaluation, then pass the file with `--cases`:

```sh
npm run eval:research -- --live --cases my-cases.json --out evidence-live.json
```

Labels and reasons stay out of model inputs. The report hashes the normalized case data so results can be traced to the evaluated dataset. Custom datasets require `--live`; scripted answers cover only the original six cases.

Keep useful partial answers and contrary evidence. A passage need not settle the entire question. Selection establishes relevance, not sufficient support for a conclusion. Writers are instructed to preserve conditions and say what remains unknown; these instructions are not a verified claim-support gate. Write self-contained questions: "What review process applies to documentation in the code repository?" gives an independent step more context than "How would reviews change?" A host can also pass the parent question into each child as explicit context. Keep separate cases for checking changes; do not lower the cutoff just to pass a known failure.

## Add an agent for the report

If Pi is configured, the example uses its saved default. Otherwise, open `./node_modules/.bin/pi`, configure access using [Pi's setup instructions](https://pi.dev/docs/latest), and use `/model` to save your preferred available default. The example reads it without selecting a fallback or changing your settings.

```sh
npm run demo:research -- --live --out research-live.json
```

The planner proposes subquestions, the workflow researches them in parallel, and a final agent writes the report. A question the corpus cannot answer may cause escalation. Pi's agent steps receive the selected evidence; this example grants them no filesystem or shell tools.

## Use your existing agents

Pi is optional. Supply a trusted module that default-exports `{ runJudge, runNode }`:

```sh
npm run demo:research -- --live --config ./approved-adapters.mjs --out research-live.json
```

`runNode({ system, user, schema, signal })` calls your existing agent with the instructions, JSON input and output schema, then returns its parsed output object. `runJudge` implements the [decision adapter contract](../packages/jev/README.md); you can use `createJevRunner()` for it. Evaluation needs only `runJudge`.

Both adapters must honor `signal`. Importing the module executes its code. Hosts requiring broker routing should use their approved adapters without a direct-provider fallback. Tools, permissions and provider access stay with the [host](host-integration.md).

## Understand the result

These six fictional cases are a starting point, not a quality benchmark. Add independently labeled cases from your task before choosing a threshold. Citation checks verify that source IDs and text match the corpus; they do not establish that every generated claim is supported or evaluate the planner and writer. No live quality measurements are bundled.

For an offline baseline, omit `--live`. The output is labeled `scripted`: it tests execution and evaluation wiring, not model quality. Scripted responses do not adapt to prompt edits.

The npm commands print summaries. Run the underlying `.mjs` scripts directly for JSON; `--out` always saves full JSON with private file permissions. Reports appear only after a complete write. Raw SDK responses, provider errors and credentials are omitted; custom adapter logging remains the host's responsibility.

| Exit | Meaning |
| --- | --- |
| `0` | Report completed, or all evaluation cases passed |
| `2` | Escalation or evaluation mismatch |
| `1` | Configuration, execution or saving failed |
| `130` | Cancelled or deadline exceeded |

`configuration` points to missing access or saved-default setup; `ERR_MODULE_NOT_FOUND` points to a config path or dependency. Confirm the offline command works, then correct the prerequisite.

Ctrl-C and SIGTERM cancel the run. The default whole-command deadline is 600 seconds; use `--deadline 900` to change it (1 to 3600 seconds). The default Pi/Jev limits permit a 540-second execution path, leaving setup margin. Cancellation cannot undo an admitted provider call; custom adapters must cooperate.
