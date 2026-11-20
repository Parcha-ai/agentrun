// A template eval case's previous runs (template-eval.ts `previous:`): its fixture, checked when the case is read, and its
// results seeded in the eval's own server's store as completed runs of the run's agent, each a firing of the package's
// schedule trigger, before that trigger fires the case's run. So the run is handed what previousResultOf hands a
// scheduled run (trigger-targets.ts) from the server's own reads: the last result's result.output whole up to
// PREVIOUS_RESULT_MAX_BYTES, else the fields its run's output schema names in x-carried, trimmed to fit, else nothing,
// said so. Each result is written as the store writes an ended run it did not run (Store.importRun, its transcript as
// import.ts transcriptOf lays one out): its answer the output as one fenced json block, on the agent's current revision,
// or on a revision of its own whose output schema is the result's `output_schema` (the trim reads the producing run's
// schema), the agent's current one left as it was. What the run was handed is read back from its input (handedPrevious),
// for its graders and its report.
import { carriedProblem, lastJsonBlock, schemaCheck } from "./answer-json.js";
import { transcriptOf } from "./import.js";
import type { Session } from "./import-sources.js";
import { launchBody } from "./run-launch.js";
import { uuidv7 } from "./runs-over-store.js";
import type { Store } from "./store/index.js";
import { PREVIOUS_HEADS } from "./trigger-targets.js";
import { isObject, type Json } from "./validate.js";

/** One earlier completed run of the trigger: its result.output, and the output schema it was checked against when that
 *  is not the package's (`outputSchema`, the fixture's output_schema). */
export type PreviousResult = { output: Json; outputSchema?: Json };
/** A previous case's fixture: the trigger's earlier completed results, oldest first (the last is the one its next run is
 *  handed), and the package's schedule trigger that starts the run (filled in by the caller when the fixture names none). */
export type PreviousFixture = { description?: string; results: PreviousResult[]; trigger: string };

const FIXTURE_FIELDS = ["description", "results", "trigger"];
const RESULT_FIELDS = ["output", "output_schema"];

/** `value` read as a previous fixture, each problem through `bad` in words naming `at`; undefined when one does not read.
 *  Each output is checked against its own output_schema, else `packageSchema` (the package's output schema), as the
 *  server checks a run's answer: a result whose run would have no result.output is refused here, before any run. */
export function previousFixtureOf(value: unknown, at: string, packageSchema: unknown, bad: (message: string) => void): (Omit<PreviousFixture, "trigger"> & { trigger?: string }) | undefined {
  if (!isObject(value)) return bad(`${at}: a previous fixture is {description?, results: [{output, output_schema?}, ...], trigger?}`), undefined;
  let ok = true;
  const no = (message: string) => ((ok = false), bad(`${at}: ${message}`));
  for (const key of Object.keys(value).filter((key) => !FIXTURE_FIELDS.includes(key))) no(`no field ${key}: its fields are ${FIXTURE_FIELDS.join(", ")}`);
  if (value.description !== undefined && typeof value.description !== "string") no("description is text");
  if (value.trigger !== undefined && (typeof value.trigger !== "string" || !value.trigger)) no("trigger is the name of the package's schedule trigger that starts the run");
  const results: PreviousResult[] = [];
  if (!Array.isArray(value.results) || !value.results.length) no("results is the trigger's earlier completed runs, oldest first, at least one: each {output, output_schema?}");
  else {
    for (const [i, result] of value.results.entries()) {
      const where = `results[${i}]`;
      if (!isObject(result)) {
        no(`${where} is {output, output_schema?}`);
        continue;
      }
      for (const key of Object.keys(result).filter((key) => !RESULT_FIELDS.includes(key))) no(`${where} has no field ${key}: its fields are ${RESULT_FIELDS.join(", ")}`);
      if (!isObject(result.output)) no(`${where}.output is the run's result.output, a JSON object`);
      const own = result.output_schema;
      if (own !== undefined) {
        const compiled = schemaCheck(own);
        if ("why" in compiled) {
          no(`${where}.output_schema ${compiled.why}`);
          continue;
        }
        const carried = carriedProblem(own as Json);
        if (carried) {
          no(`${where}.output_schema's x-carried ${carried}`);
          continue;
        }
      }
      const schema = own ?? packageSchema;
      if (schema === undefined) {
        no(`${where} has no output schema it was checked against: give it output_schema, or the package an output (a run's result.output is its answer as an output schema checks it)`);
        continue;
      }
      const compiled = schemaCheck(schema);
      if (!isObject(result.output) || "why" in compiled) continue;
      const problems = compiled.check(result.output);
      if (problems.length) no(`${where}.output does not meet ${own === undefined ? "the package's output schema" : "its output_schema"}: ${problems.slice(0, 3).join("; ")}`);
      else results.push({ output: result.output, ...(own !== undefined ? { outputSchema: own as Json } : {}) });
    }
  }
  if (!ok) return undefined;
  return { ...(typeof value.description === "string" ? { description: value.description } : {}), results, ...(typeof value.trigger === "string" ? { trigger: value.trigger } : {}) };
}

/** A result seeded: its run's id, and its output as written. */
export type Seeded = { runId: string; output: Json };

/** How far apart the seeded results ended, the last that far before the case's run. */
const SEEDED_APART_MS = 24 * 60 * 60_000;

/** `fixture`'s results seeded in `store` as completed runs of `agentId`, oldest first, each a firing of `triggerId` that
 *  started it, ended a day apart before `before` (the clock the case's run fires on): each run's input is `content` (the
 *  trigger's), its answer its output as one fenced json block. A result with its own output schema is a run of a revision
 *  of its own, the agent's current body with that schema, made and then left behind, so the agent's current revision is
 *  the one the case's run starts on. */
export async function seedPrevious(store: Store, fixture: PreviousFixture, { agentId, triggerId, content, before }: { agentId: string; triggerId: string; content: string; before: number }): Promise<Seeded[]> {
  const current = (await store.agents.get(agentId))?.currentRevision;
  const revision = current ? await store.agents.revision(current) : undefined;
  if (!current || !revision) throw new Error(`the agent ${agentId} has no current revision to seed its previous runs on`);
  const seeded: Seeded[] = [];
  for (const [i, result] of fixture.results.entries()) {
    const endedAt = before - (fixture.results.length - i) * SEEDED_APART_MS;
    const startedAt = endedAt - 60_000;
    let revisionId = current;
    if (result.outputSchema !== undefined) {
      revisionId = uuidv7();
      await store.agents.addRevision({
        id: revisionId, agentId, kind: revision.kind, body: { ...(revision.body as Json), outputSchema: result.outputSchema },
        ...(revision.skills !== null ? { skills: revision.skills } : {}), ...(revision.mcpPin !== null ? { mcpPin: revision.mcpPin } : {}), ...(revision.monidPin !== null ? { monidPin: revision.monidPin } : {}),
        note: "A template eval's previous run, on its own output schema.", ifCurrent: current,
      });
      await store.agents.setCurrent(agentId, current);
    }
    // Run ids sort by their start: each seeded one is older than the next, and than the case's run.
    const runId = uuidv7(startedAt);
    const key = `template-eval-previous-${i + 1}`;
    const answer = `\`\`\`json\n${JSON.stringify(result.output, null, 2)}\n\`\`\``;
    const session = { turns: [{ role: "user", text: content, at: startedAt }, { role: "assistant", text: answer, calls: [], at: endedAt }] } as unknown as Session;
    await store.importRun({
      id: runId, agentId, revisionId, importedFrom: { source: "pi", session: key + "-" + runId },
      launch: { body: launchBody({ input: { content }, title: `Previous run ${i + 1} of the case`, place: { mode: "runner" }, trigger: { id: triggerId, firing_key: key } }) },
      state: "ended", costUsd: 0, startedAt, endedAt, transcript: transcriptOf(session, (value) => value).batches,
    });
    // The firing that started it, as the trigger's history keeps one: recorded settled (no engine drives it), then started
    // with its run, which moves the trigger's last run to it.
    await store.triggers.record(triggerId, [{ key, by: "schedule", nominalAt: Math.floor(startedAt / 1000) * 1000, status: "skipped" }]);
    await store.triggers.settle(triggerId, key, { status: "started", runId }, { reset: true });
    seeded.push({ runId, output: result.output });
  }
  return seeded;
}

/** What a previous case's run was handed after its trigger's message: `whole`, the last result's output as it is;
 *  `carried`, its carried `fields` alone, `dropped` the entries each carried array gave up from its front, by field, 0
 *  for one that gave up none (a carried field that is not an array in both is not in it); `too_large`, nothing, said so; `none`, nothing at all. `text` is the words as handed, `run_id` the
 *  seeded run they name. */
export type HandedPrevious = { kind: "whole" | "carried" | "too_large" | "none"; text: string; run_id?: string; fields?: string[]; dropped?: Record<string, number> };
export const HANDED_KINDS = ["whole", "carried", "too_large", "none"] as const;

/** What the run whose input content is `content` was handed, against the results `seeded` for it: the text from the
 *  first of the handover's heads (PREVIOUS_HEADS) after the run's own line (the schedule's "(Started by ...)", the last
 *  line of the trigger's message: its words can't be the package's text). For carried fields, how many entries each
 *  carried array lost from its front is the seeded output's length less the handed one's. */
export function handedPrevious(content: string, seeded: readonly Seeded[]): HandedPrevious {
  const line = content.lastIndexOf("\n\n(Started by ");
  const after = line < 0 ? -1 : content.indexOf("\n", line + 2);
  const rest = after < 0 ? "" : content.slice(after);
  const kind = (Object.keys(PREVIOUS_HEADS) as (keyof typeof PREVIOUS_HEADS)[]).find((one) => rest.startsWith(PREVIOUS_HEADS[one]));
  if (!kind) return { kind: "none", text: "" };
  const from = [...seeded].reverse().find((one) => rest.includes(`(${one.runId}`));
  const handed: HandedPrevious = { kind, text: rest, ...(from ? { run_id: from.runId } : {}) };
  if (kind !== "carried") return handed;
  let picked: unknown;
  try {
    picked = JSON.parse(lastJsonBlock(rest) ?? "null");
  } catch {
    return handed;
  }
  if (!isObject(picked)) return handed;
  const output = (from?.output ?? {}) as Json;
  const dropped = Object.fromEntries(Object.entries(picked).flatMap(([field, value]) => {
    const was = output[field];
    return Array.isArray(was) && Array.isArray(value) ? [[field, Math.max(0, was.length - value.length)]] : [];
  }));
  return { ...handed, fields: Object.keys(picked), dropped };
}

/** A `handed` grader's verdict: the run was handed its previous result as `expect` says (and, for carried fields, each
 *  array in `dropped` gave up exactly that many first entries, 0 for none). A field the grader counts that is no carried
 *  array the run was handed (a misspelled name, a scalar) fails it by name: never read as 0 dropped. */
export function handedVerdict(handed: HandedPrevious | undefined, expect: HandedPrevious["kind"], dropped?: Readonly<Record<string, number>>): { pass: boolean; reason: string } {
  if (!handed) return { pass: false, reason: "the run has no previous result seeded to read" };
  const said = handedWords(handed);
  if (handed.kind !== expect) return { pass: false, reason: `${said}; the grader expects ${KIND_WORDS[expect]}` };
  const lists = Object.keys(handed.dropped ?? {});
  const unknown = Object.keys(dropped ?? {}).filter((field) => !lists.includes(field));
  if (unknown.length) return { pass: false, reason: `${said}; the grader counts ${unknown.join(", ")}, which ${unknown.length === 1 ? "is" : "are"} no carried array it was handed (${lists.length ? lists.join(", ") : "none"})` };
  const wrong = Object.entries(dropped ?? {}).filter(([field, n]) => handed.dropped![field] !== n);
  if (wrong.length) return { pass: false, reason: `${said}; the grader expects ${wrong.map(([field, n]) => `${field}: the first ${n} dropped`).join(", ")}` };
  return { pass: true, reason: said };
}

const KIND_WORDS: Record<HandedPrevious["kind"], string> = {
  whole: "its trigger's last result whole",
  carried: "its trigger's last result as its carried fields",
  too_large: "nothing of its trigger's last result, too large to hand",
  none: "no previous result",
};

/** What a run was handed, in words. */
function handedWords(handed: HandedPrevious): string {
  if (handed.kind !== "carried") return `the run was handed ${KIND_WORDS[handed.kind]}`;
  const dropped = Object.entries(handed.dropped ?? {}).filter(([, n]) => n > 0);
  return `the run was handed ${KIND_WORDS.carried} (${(handed.fields ?? []).join(", ")})${dropped.length ? `, ${dropped.map(([field, n]) => `${field}: the first ${n} ${n === 1 ? "entry" : "entries"} dropped`).join("; ")}` : ", nothing dropped"}`;
}
