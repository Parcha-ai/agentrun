import { Compile } from "typebox/compile";
import { runWorkflow, validateWorkflow, WorkflowInvalidError, WorkflowInputInvalidError, WorkflowOutputInvalidError, type Workflow } from "./workflow.js";
import { resolveSchemaForWorkflow } from "./schema-references.js";
import { synthesizeAnswers } from "./system-one.js";

export type DryRunResult =
  | { ok: true; skipped?: string[] }
  | { ok: false; problems: string[]; stage?: string };

export function synthesizeInstance(schema: unknown, definitions: Record<string, unknown> = {}, depth = 0): unknown {
  if (depth > 12 || !schema || typeof schema !== "object") return null;
  const spec = schema as Record<string, any>;
  if (typeof spec.$ref === "string") {
    const match = /^#\/definitions\/(.+)$/.exec(spec.$ref);
    return match && definitions[match[1]] ? synthesizeInstance(definitions[match[1]], definitions, depth + 1) : null;
  }
  if (spec.const !== undefined) return spec.const;
  if (Array.isArray(spec.enum) && spec.enum.length) return spec.enum[0];
  if (Array.isArray(spec.anyOf) && spec.anyOf.length) {
    const branch = spec.anyOf.find((candidate: any) => candidate?.type !== "null") ?? spec.anyOf[0];
    return synthesizeInstance(branch, definitions, depth + 1);
  }
  if (Array.isArray(spec.oneOf) && spec.oneOf.length) return synthesizeInstance(spec.oneOf[0], definitions, depth + 1);
  const type = Array.isArray(spec.type) ? spec.type[0] : spec.type;
  if (type === "object" || (!type && spec.properties)) {
    const out: Record<string, unknown> = Object.create(null);
    for (const [key, property] of Object.entries((spec.properties as Record<string, unknown>) || {})) {
      out[key] = synthesizeInstance(property, definitions, depth + 1);
    }
    return { ...out };
  }
  if (type === "array") {
    const min = Number.isInteger(spec.minItems) ? spec.minItems : 1;
    if (!spec.items) return [];
    return Array.from({ length: Math.max(1, min) }, () => synthesizeInstance(spec.items, definitions, depth + 1));
  }
  if (type === "string") {
    const min = Number.isInteger(spec.minLength) ? spec.minLength : 1;
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
};

export async function dryRunWorkflow(workflow: Workflow, opts: DryRunOptions = {}): Promise<DryRunResult> {
  const valid = validateWorkflow(workflow, opts.input === undefined ? undefined : { input: opts.input });
  if (!valid.ok) return { ok: false, problems: [new WorkflowInvalidError(String(workflow?.name), valid.errors).message] };
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
  if (skipped.length) return { ok: true, skipped };

  let input: Record<string, unknown> = opts.input ?? {};
  if (opts.input === undefined && workflow.input) {
    const schema = resolveSchemaForWorkflow(workflow, workflow.schemas[workflow.input.schemaId]);
    const generated = synthesizeInstance(schema, (schema.definitions as Record<string, unknown> | undefined) ?? workflow.schemas);
    if (!generated || typeof generated !== "object" || Array.isArray(generated) || !Compile(schema as never).Check(generated)) {
      return { ok: true, skipped: ["Could not synthesize a valid input object. Supply input explicitly to dryRunWorkflow or the dry-run CLI."] };
    }
    input = generated as Record<string, unknown>;
  }
  if (opts.probeContext && !Object.prototype.hasOwnProperty.call(input, "context")) {
    input = { ...input, context: {
      references: opts.probeContext?.references ?? {},
      references_parsed: opts.probeContext?.references_parsed ?? {},
    } };
  }
  let currentLabel = "";
  try {
    const result = await runWorkflow(workflow, input, {
      sop: opts.sop,
      onEvent: (event) => { if (typeof event.label === "string") currentLabel = event.label; },
      runNode: async ({ schema, review }) => {
        const candidate = synthesizeInstance(schema, (schema.definitions as Record<string, unknown> | undefined) ?? workflow.schemas);
        if (review) await review(candidate);
        return candidate;
      },
      runJudge: async ({ questions }) => ({ answers: synthesizeAnswers(questions), model: "synthetic", usage: null, cost_usd: null, request_sha256: "" }),
      syntheticEffects: true,
      runEffect: async ({ node, schema }) => node.via === "shell"
        ? { code: 0, stdout: "{}", stderr: "", truncated: false }
        : synthesizeInstance(schema ?? (workflow.schemas || {})[node.out as string] as Record<string, unknown>, (schema?.definitions as Record<string, unknown> | undefined) ?? workflow.schemas ?? {}),
    });
    if (result.status === "escalated") {
      // Synthetic values tripping an escalate predicate proves nothing about real cases.
      return { ok: true, skipped: [`escalated:${result.escalation.kind}@${result.escalation.stage} on synthetic values`] };
    }
    return { ok: true };
  } catch (error) {
    if (error instanceof WorkflowOutputInvalidError) {
      return { ok: false, problems: error.problems, stage: error.stage };
    }
    if (error instanceof WorkflowInputInvalidError) return { ok: false, problems: [error.message] };
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, problems: [`deterministic path threw over schema-conforming inputs${currentLabel ? ` (at "${currentLabel}")` : ""}: ${message.slice(0, 1200)}`], stage: currentLabel || undefined };
  }
}
