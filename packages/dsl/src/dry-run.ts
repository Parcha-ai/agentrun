import { Compile } from "typebox/compile";
import { runWorkflow, validateWorkflow, WorkflowInvalidError, WorkflowInputInvalidError, WorkflowOutputInvalidError, type Workflow, type WorkflowDeps } from "./workflow.js";
import { resolveSchemaForWorkflow } from "./schema-references.js";
import { synthesizeAnswers } from "./system-one.js";
import type { DecisionCapabilities, DecisionProvider } from "./decision-provider.js";

/** `ok` keeps its meaning: false only when a check failed. `status` says whether every check ran: `passed`, `not_run`
 *  (a check stood down; `skipped` says which and why, so this is not proof the graph was exercised) or `failed`. */
export type DryRunResult =
  | { ok: true; status: "passed" | "not_run"; skipped?: string[] }
  | { ok: false; status: "failed"; problems: string[]; stage?: string };

/** A provider for every id the workflow names, and a default: the dry run answers each decision itself, so a node's
 *  provider and timeoutMs hold it to no host's providers. */
function syntheticProviders(workflow: Workflow): NonNullable<WorkflowDeps["decisionProviders"]> {
  const ids = new Set(["dry-run"]);
  JSON.stringify(workflow, (key, value) => { if (key === "provider" && typeof value === "string") ids.add(value); return value; });
  const capabilities: DecisionCapabilities = { types: ["noul", "choice", "score", "box"], inputs: ["text", "json", "image", "pdf", "url"], evidence: "citations",
    probability: "none", grounding: false, replay: "deduped", maxQuestions: null, maxStateBytes: null };
  const provider = (id: string): DecisionProvider => ({ id, needs: [], capabilities, decide: async () => { throw new Error("A dry run answers its decisions itself."); } });
  return { providers: Object.fromEntries([...ids].map((id) => [id, provider(id)])), default: "dry-run" };
}

/** What one dry run may synthesize in all, across its input and every step's answer (DryRunOptions.budget), and what one
 *  synthesizeInstance call may when none is given: values (each array item, object, string, number...) and string
 *  characters. Synthesis counts each before it makes it and throws SynthesisTooLarge past either, so a schema that asks
 *  for a huge value (nested arrays of a large minItems, a long minLength) never allocates past the budget. */
export type SynthesisBudget = { values: number; chars: number };
/** The default: a million values and 16 million characters, far past what a real workflow's dry run builds (a few
 *  thousand values at most), and well within a host's memory (a few hundred MB at worst). */
export const SYNTHESIS_BUDGET: Readonly<SynthesisBudget> = { values: 1_000_000, chars: 16_000_000 };
/** The schema asked synthesis for more than its budget: the dry run ends not run, saying so. */
export class SynthesisTooLarge extends Error {
  override name = "SynthesisTooLarge";
}
type Spend = { values: number; chars: number; readonly limit: SynthesisBudget };
/** A budget's limits, each field the default unless given as a number (a field given as undefined keeps the default). */
const spendOf = (limit: Partial<SynthesisBudget> = {}): Spend => ({
  values: 0,
  chars: 0,
  limit: { values: typeof limit.values === "number" ? limit.values : SYNTHESIS_BUDGET.values, chars: typeof limit.chars === "number" ? limit.chars : SYNTHESIS_BUDGET.chars },
});
/** A literal's characters as the value it is (a const, an enum's first): its serialized size. */
const literalChars = (value: unknown): number => JSON.stringify(value)?.length ?? 0;
function charge(spend: Spend, values: number, chars: number): void {
  spend.values += values;
  spend.chars += chars;
  if (spend.values > spend.limit.values || spend.chars > spend.limit.chars) {
    throw new SynthesisTooLarge(`the schema is too large to synthesize: past ${spend.limit.values} values or ${spend.limit.chars} characters`);
  }
}

/** A value of `schema` (its `$ref`s read from `definitions`), synthesized within `budget` (SYNTHESIS_BUDGET when none):
 *  past it, SynthesisTooLarge. */
export function synthesizeInstance(schema: unknown, definitions: Record<string, unknown> = {}, depth = 0, budget: Partial<SynthesisBudget> = SYNTHESIS_BUDGET): unknown {
  return synthesize(schema, definitions, depth, spendOf(budget));
}

function synthesize(schema: unknown, definitions: Record<string, unknown>, depth: number, spend: Spend): unknown {
  // Every value it makes is counted before it is made, once (a $ref, an anyOf or a oneOf is the value it leads to, not one
  // of its own): past the budget it throws, having built no more than the budget.
  if (depth > 12 || !schema || typeof schema !== "object") return (charge(spend, 1, 0), null);
  const spec = schema as Record<string, any>;
  if (typeof spec.$ref === "string") {
    const match = /^#\/definitions\/(.+)$/.exec(spec.$ref);
    return match && definitions[match[1]] ? synthesize(definitions[match[1]], definitions, depth + 1, spend) : (charge(spend, 1, 0), null);
  }
  // A literal is charged its serialized size: one written long in the schema does not escape the character budget.
  if (spec.const !== undefined) return (charge(spend, 1, literalChars(spec.const)), spec.const);
  if (Array.isArray(spec.enum) && spec.enum.length) return (charge(spend, 1, literalChars(spec.enum[0])), spec.enum[0]);
  if (Array.isArray(spec.anyOf) && spec.anyOf.length) {
    const branch = spec.anyOf.find((candidate: any) => candidate?.type !== "null") ?? spec.anyOf[0];
    return synthesize(branch, definitions, depth + 1, spend);
  }
  if (Array.isArray(spec.oneOf) && spec.oneOf.length) return synthesize(spec.oneOf[0], definitions, depth + 1, spend);
  // The one value made below.
  charge(spend, 1, 0);
  const type = Array.isArray(spec.type) ? spec.type[0] : spec.type;
  if (type === "object" || (!type && spec.properties)) {
    const out: Record<string, unknown> = Object.create(null);
    for (const [key, property] of Object.entries((spec.properties as Record<string, unknown>) || {})) {
      // Its name is built into every value made under it, and serialized with it: charged before it is added.
      charge(spend, 0, key.length);
      out[key] = synthesize(property, definitions, depth + 1, spend);
    }
    return { ...out };
  }
  if (type === "array") {
    if (spec.maxItems === 0) return [];
    const min = Number.isInteger(spec.minItems) ? spec.minItems : 1;
    if (!spec.items) return [];
    // Each item is at least one value: a length past what the budget has left is refused before the array is made.
    const length = Math.max(1, min);
    if (length > spend.limit.values - spend.values) charge(spend, length, 0);
    return Array.from({ length }, () => synthesize(spec.items, definitions, depth + 1, spend));
  }
  if (type === "string") {
    if (spec.maxLength === 0) return "";
    const min = Number.isInteger(spec.minLength) ? spec.minLength : 1;
    charge(spend, 0, Math.max(1, min));
    return "x".repeat(Math.max(1, min));
  }
  if (type === "integer") {
    const lo = Math.max(
      Number.isFinite(spec.minimum) ? Math.ceil(spec.minimum) : -Infinity,
      Number.isFinite(spec.exclusiveMinimum) ? Math.floor(spec.exclusiveMinimum) + 1 : -Infinity,
    );
    const hi = Math.min(
      Number.isFinite(spec.maximum) ? Math.floor(spec.maximum) : Infinity,
      Number.isFinite(spec.exclusiveMaximum) ? Math.ceil(spec.exclusiveMaximum) - 1 : Infinity,
    );
    let value = Number.isFinite(lo) ? lo : 0;
    if (value > hi) value = hi;
    return value;
  }
  if (type === "number") {
    // A two-sided interval takes the MIDPOINT — stepping ±1 off one bound can cross the other
    // (an exclusive (5.2, 5.5) has no room for a unit step). One-sided bounds step off by 1.
    const lo = Math.max(
      Number.isFinite(spec.minimum) ? spec.minimum : -Infinity,
      Number.isFinite(spec.exclusiveMinimum) ? spec.exclusiveMinimum : -Infinity,
    );
    const hi = Math.min(
      Number.isFinite(spec.maximum) ? spec.maximum : Infinity,
      Number.isFinite(spec.exclusiveMaximum) ? spec.exclusiveMaximum : Infinity,
    );
    const loExclusive = Number.isFinite(spec.exclusiveMinimum) && spec.exclusiveMinimum === lo;
    const hiExclusive = Number.isFinite(spec.exclusiveMaximum) && spec.exclusiveMaximum === hi;
    if (Number.isFinite(lo) && Number.isFinite(hi)) {
      if (!loExclusive && !hiExclusive) return lo;
      // Halve first to avoid overflow at float-max scale. If rounding reaches
      // an endpoint, an inclusive upper endpoint is still a valid instance.
      const midpoint = lo / 2 + hi / 2;
      if (midpoint <= lo && loExclusive && !hiExclusive) return hi;
      if (midpoint >= hi && hiExclusive && !loExclusive) return lo;
      return midpoint;
    }
    if (Number.isFinite(lo)) return loExclusive ? lo + 1 : lo;
    if (Number.isFinite(hi)) return hiExclusive ? hi - 1 : hi;
    return 0;
  }
  if (type === "boolean") return false;
  if (type === "null") return null;
  // A schema synthesis cannot read: one character.
  charge(spend, 0, 1);
  return "x";
}

function unsupportedConstructs(schema: unknown, path: string, found: string[], depth = 0): string[] {
  if (depth > 12 || !schema || typeof schema !== "object") return found;
  const spec = schema as Record<string, any>;
  for (const keyword of ["pattern", "format", "not", "allOf", "if", "uniqueItems", "multipleOf", "propertyNames", "patternProperties"]) {
    if (spec[keyword] !== undefined) found.push(`${path}: ${keyword}`);
  }
  // An exclusive bound too large for ±1 to change its float representation cannot be stepped
  // off — the probe would sit ON the excluded bound and falsely reject. Generator limit: stand down.
  if (Number.isFinite(spec.exclusiveMinimum) && spec.exclusiveMinimum + 1 === spec.exclusiveMinimum) found.push(`${path}: exclusiveMinimum beyond float step`);
  if (Number.isFinite(spec.exclusiveMaximum) && spec.exclusiveMaximum - 1 === spec.exclusiveMaximum) found.push(`${path}: exclusiveMaximum beyond float step`);
  // Recurse ONLY into schema-bearing positions. `properties`/`definitions` are NAME-KEYED maps:
  // their keys are arbitrary field names, never keywords — a property literally named "pattern"
  // must not stand the gate down (that would silently disable it for the exact class it guards).
  for (const mapKey of ["properties", "definitions"]) {
    const map = spec[mapKey];
    if (map && typeof map === "object") {
      for (const [name, sub] of Object.entries(map)) unsupportedConstructs(sub, `${path}/${mapKey}/${name}`, found, depth + 1);
    }
  }
  for (const schemaKey of ["items", "additionalItems", "additionalProperties", "contains"]) {
    if (spec[schemaKey] && typeof spec[schemaKey] === "object") unsupportedConstructs(spec[schemaKey], `${path}/${schemaKey}`, found, depth + 1);
  }
  for (const listKey of ["anyOf", "oneOf", "allOf", "prefixItems"]) {
    if (Array.isArray(spec[listKey])) spec[listKey].forEach((sub: unknown, i: number) => unsupportedConstructs(sub, `${path}/${listKey}/${i}`, found, depth + 1));
  }
  return found;
}

export type DryRunOptions = {
  sop?: string;
  probeContext?: { references?: Record<string, string>; references_parsed?: Record<string, unknown> };
  input?: Record<string, unknown>;
  /** The host's executor for `code` nodes (WorkflowDeps.runCode). Present, the dry run validates
   *  with executeCode:false and hands every code node to it, so no code body runs in this process. */
  runCode?: WorkflowDeps["runCode"];
  /** Ends the dry run: it stops at its next step, as not run. */
  signal?: AbortSignal;
  /** The most synthetic steps (an agent's or a judge's answer, an effect, a code node the host runs) before the dry run
   *  stops, as not run: synthetic answers can keep a loop going to its bound, and a map over a long list. 10,000 by
   *  default. */
  maxSteps?: number;
  /** What the whole dry run may synthesize (SynthesisBudget): its input and every step's answer together. Past it the dry
   *  run stops, as not run ("the schema is too large to synthesize"). SYNTHESIS_BUDGET by default. */
  budget?: Partial<SynthesisBudget>;
  /** The longest the dry run may take by the clock (ms): past it, it stops at its next node or step, as not run. Read
   *  from the clock at each, never from a timer, so a dry run that never yields still stops. 60,000 by default. */
  deadlineMs?: number;
  /** The most node visits (a loop's body each iteration, a map's body for each item, any node run), whether or not they
   *  ask anything, before the dry run stops, as not run: a loop whose body asks nothing is no step, so maxSteps alone
   *  never ends it. Ten times maxSteps by default. */
  maxVisits?: number;
};


export async function dryRunWorkflow(workflow: Workflow, opts: DryRunOptions = {}): Promise<DryRunResult> {
  const valid = validateWorkflow(workflow, { ...(opts.input === undefined ? {} : { input: opts.input }), ...(opts.runCode ? { executeCode: false } : {}) });
  if (!valid.ok) return { ok: false, status: "failed", problems: [new WorkflowInvalidError(String(workflow?.name), valid.errors, valid.issues).message] };
  const skipped: string[] = [];
  const scanSchemas = (plan: Workflow): void => {
    for (const [id, schema] of Object.entries(plan.schemas || {})) unsupportedConstructs(schema, id, skipped);
    const visit = (node: Workflow["root"]): void => {
      if (node.node === "workflow") scanSchemas(node.workflow);
      if (node.node === "chain") node.steps.forEach(visit);
      if (node.node === "parallel") node.branches.forEach(visit);
      if (node.node === "map" || node.node === "loop") visit(node.body);
      if (node.node === "route") Object.values(node.branches).forEach(branch => visit(branch.body));
    };
    visit(plan.root);
  };
  scanSchemas(workflow);
  if (skipped.length) return { ok: true, status: "not_run", skipped };

  // One budget for everything this dry run synthesizes.
  const spend = spendOf(opts.budget);
  let input: Record<string, unknown> = opts.input ?? {};
  if (opts.input === undefined && workflow.input) {
    const schema = resolveSchemaForWorkflow(workflow, workflow.schemas[workflow.input.schemaId]);
    let generated: unknown;
    try {
      generated = synthesize(schema, (schema.definitions as Record<string, unknown> | undefined) ?? workflow.schemas, 0, spend);
    } catch (error) {
      if (error instanceof SynthesisTooLarge) return { ok: true, status: "not_run", skipped: [error.message] };
      throw error;
    }
    if (!generated || typeof generated !== "object" || Array.isArray(generated) || !Compile(schema as never).Check(generated)) {
      return { ok: true, status: "not_run", skipped: ["Could not synthesize a valid input object. Supply input explicitly to dryRunWorkflow or the dry-run CLI."] };
    }
    input = generated as Record<string, unknown>;
  }
  if (opts.probeContext && !Object.prototype.hasOwnProperty.call(input, "context")) {
    input = { ...input, context: {
      references: opts.probeContext.references ?? {},
      references_parsed: opts.probeContext.references_parsed ?? {},
    } };
  }
  let currentLabel = "";
  // Every synthetic step counts, and every 64th yields to the event loop, so the host can take a stop meanwhile.
  const maxSteps = opts.maxSteps ?? 10_000;
  let steps = 0;
  // Why the dry run stopped early, kept here: the interpreter may wrap what an adapter throws.
  let stopped: string | undefined;
  const stop = (reason: string) => { stopped ??= reason; throw new Error(stopped); };
  /** A step's synthetic answer within the run's budget: past it, the dry run stops (the interpreter may wrap the throw). */
  const synthesized = (make: () => unknown): unknown => {
    try {
      return make();
    } catch (error) {
      if (error instanceof SynthesisTooLarge) stop(error.message);
      throw error;
    }
  };
  const deadlineMs = opts.deadlineMs ?? 60_000;
  const deadline = Date.now() + deadlineMs;
  const maxVisits = opts.maxVisits ?? maxSteps * 10;
  let visits = 0;
  const pastDeadline = () => {
    if (Date.now() > deadline) stop(`The dry run stopped past its ${deadlineMs} ms deadline.`);
  };
  /** A node's visit (a loop's body each iteration, a map's body for each item), counted against maxVisits and the
   *  deadline, so a loop whose body asks nothing (no step) still ends. Synchronous: it reads the clock, never a timer, so
   *  a run that never yields still stops. */
  const visit = () => {
    if (opts.signal?.aborted) stop("The dry run was stopped before it finished.");
    visits += 1;
    if (visits > maxVisits) stop(`The dry run stopped after ${maxVisits} node visits: on synthetic values the workflow's loops or maps go on further, asking nothing. Supply input, or lower a loop's maxIters.`);
    pastDeadline();
  };
  const step = async () => {
    if (opts.signal?.aborted) stop("The dry run was stopped before it finished.");
    steps += 1;
    if (steps > maxSteps) stop(`The dry run stopped after ${maxSteps} synthetic steps: on synthetic values the workflow's loops or maps go on further. Supply input, or lower a loop's maxIters.`);
    pastDeadline();
    if (steps % 64 === 0) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      if (opts.signal?.aborted) stop("The dry run was stopped before it finished.");
    }
  };
  const runCode = opts.runCode;
  try {
    const result = await runWorkflow(workflow, input, {
      onVisit: () => visit(),
      sop: opts.sop,
      ...(runCode ? { runCode: async (...args: Parameters<typeof runCode>) => { await step(); return runCode(...args); } } : {}),
      onEvent: (event) => { if (typeof event.label === "string") currentLabel = event.label; },
      runNode: async ({ schema, review }) => {
        await step();
        const candidate = synthesized(() => synthesize(schema, (schema.definitions as Record<string, unknown> | undefined) ?? workflow.schemas, 0, spend));
        if (review) await review(candidate);
        return candidate;
      },
      // A node that requires evidence gets a placeholder, as a provider that gives evidence would answer it.
      runJudge: async ({ questions, evidence }) => {
        await step();
        return { answers: synthesizeAnswers(questions), model: "synthetic", usage: null, cost_usd: null, request_sha256: "",
          ...(evidence === "required" ? { evidence: [{ url: "https://example.invalid/dry-run", title: null, excerpts: [], scope: "dry_run" }] } : {}) };
      },
      syntheticEffects: true,
      decisionProviders: syntheticProviders(workflow),
      runEffect: async ({ node, schema }) => { await step(); return node.via === "shell"
        ? { code: 0, stdout: "{}", stderr: "", truncated: false }
        : synthesized(() => synthesize(schema ?? (workflow.schemas || {})[node.out as string] as Record<string, unknown>, (schema?.definitions as Record<string, unknown> | undefined) ?? workflow.schemas ?? {}, 0, spend)); },
    });
    if (result.status === "escalated") {
      // Synthetic values tripping an escalate predicate proves nothing about real cases.
      return { ok: true, status: "not_run", skipped: [`escalated:${result.escalation.kind}@${result.escalation.stage} on synthetic values`] };
    }
    return { ok: true, status: "passed" };
  } catch (error) {
    if (stopped) return { ok: true, status: "not_run", skipped: [stopped] };
    if (error instanceof WorkflowOutputInvalidError) {
      return { ok: false, status: "failed", problems: error.problems, stage: error.stage };
    }
    if (error instanceof WorkflowInputInvalidError) return { ok: false, status: "failed", problems: [error.message] };
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, status: "failed", problems: [`deterministic path threw over schema-conforming inputs${currentLabel ? ` (at "${currentLabel}")` : ""}: ${message.slice(0, 1200)}`], stage: currentLabel || undefined };
  }
}
