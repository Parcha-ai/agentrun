import { isDeepStrictEqual } from "node:util";
import type { Repo } from "@parcha/pi-git-remote";
import { Type } from "typebox";
import { Compile } from "typebox/compile";
import { LearnError } from "./errors.js";
import { CAPS, LAYOUT, RUN_ID } from "./layout.js";

/** A workflow name the DSL's store accepts and pi accepts as a skill name: the skill folder carries the same name. */
export const WORKFLOW_SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const MAX_NAME = 64;
const SHA256 = /^[0-9a-f]{64}$/;
const STAMP = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/;
const POINTER = /^(?:\/(?:[^~/]|~[01])*)*$/;

/** A saved revision's standing under its name. `trial` and `active` are the live ones, at most one at a time. `superseded`
 *  was active until a newer revision took its place and can be restored; `retired` was a trial replaced before it proved
 *  itself and is never restored; `demoted` was judged by its uses and is never promoted again. */
export const REVISION_STATUSES = Object.freeze(["trial", "active", "superseded", "retired", "demoted"] as const);
export type RevisionStatus = (typeof REVISION_STATUSES)[number];
/** The name's standing: that of its live revision, or `demoted` when it has none. */
export const TRIAL_STATUSES = Object.freeze(["trial", "active", "demoted"] as const);
export type TrialStatus = (typeof TRIAL_STATUSES)[number];
/** How a use of a workflow ended: `frozen`, the workflow finished the case by itself; `escalated`, a gate fired and the agent
 *  continued; `failed`, the workflow did not finish. */
export const USE_OUTCOMES = Object.freeze(["frozen", "escalated", "failed"] as const);
export type UseOutcome = (typeof USE_OUTCOMES)[number];
export const PRECONDITION_OPS = Object.freeze(["eq", "in", "exists", "gte", "lte"] as const);

export const LIMITS = Object.freeze({
  /** Revisions kept under one name; admission stops at the cap, never forgets a demoted digest. */
  revisions: 60,
  /** The newest uses kept; promotion and demotion thresholds never reach further back than `thresholds`. */
  uses: 80,
  preconditions: 16,
  inValues: 32,
  /** Largest promotion or demotion threshold. */
  threshold: 40,
});

export type Json = null | boolean | number | string | readonly Json[] | { readonly [key: string]: Json };

/** A typed structural check on the run's input: a JSON pointer into it and an operator, never a pattern over prose. */
export type Precondition =
  | { readonly pointer: string; readonly op: "exists" }
  | { readonly pointer: string; readonly op: "eq"; readonly value: Json }
  | { readonly pointer: string; readonly op: "in"; readonly value: readonly Json[] }
  | { readonly pointer: string; readonly op: "gte" | "lte"; readonly value: number };

export type Revision = {
  readonly sha256: string;
  readonly status: RevisionStatus;
  /** When the revision took this status. */
  readonly since: string;
  /** The run that proposed it. Its own uses are never evidence for it. */
  readonly run: string;
};

export type Use = { readonly run: string; readonly sha256: string; readonly outcome: UseOutcome; readonly at: string };

/** `.agents/skills/<name>/trial.json`: written by the host only, never by a run. */
export type Trial = {
  readonly name: string;
  readonly status: TrialStatus;
  /** Every check must hold for the workflow to be tried on a run's input; none means any input. */
  readonly when: readonly Precondition[];
  readonly revisions: readonly Revision[];
  /** Oldest first. */
  readonly uses: readonly Use[];
};

const Stamp = Type.String({ pattern: STAMP.source });
const Pointer = Type.String({ pattern: POINTER.source, maxLength: 256 });
const Hash = Type.String({ pattern: SHA256.source });
const Run = Type.String({ pattern: RUN_ID.source });
const exact = { additionalProperties: false } as const;

export const PreconditionSchema = Type.Union([
  Type.Object({ pointer: Pointer, op: Type.Literal("exists") }, exact),
  Type.Object({ pointer: Pointer, op: Type.Literal("eq"), value: Type.Unknown() }, exact),
  Type.Object({ pointer: Pointer, op: Type.Literal("in"), value: Type.Array(Type.Unknown(), { minItems: 1, maxItems: LIMITS.inValues }) }, exact),
  Type.Object({ pointer: Pointer, op: Type.Union([Type.Literal("gte"), Type.Literal("lte")]), value: Type.Number() }, exact),
]);

export const TrialSchema = Type.Object({
  name: Type.String({ pattern: WORKFLOW_SKILL_NAME.source, maxLength: MAX_NAME }),
  status: Type.Union([Type.Literal("trial"), Type.Literal("active"), Type.Literal("demoted")]),
  when: Type.Array(PreconditionSchema, { maxItems: LIMITS.preconditions }),
  revisions: Type.Array(Type.Object({ sha256: Hash, status: Type.Union([Type.Literal("trial"), Type.Literal("active"), Type.Literal("superseded"), Type.Literal("retired"), Type.Literal("demoted")]), since: Stamp, run: Run }, exact), { minItems: 1, maxItems: LIMITS.revisions }),
  uses: Type.Array(Type.Object({ run: Run, sha256: Hash, outcome: Type.Union([Type.Literal("frozen"), Type.Literal("escalated"), Type.Literal("failed")]), at: Stamp }, exact), { maxItems: LIMITS.uses }),
}, exact);

const checker = Compile(TrialSchema);

const bad = (message: string) => new LearnError("format", message);
const validStamp = (value: string) => STAMP.test(value) && new Date(value).toISOString() === value;

function isJson(value: unknown, depth = 0): value is Json {
  if (depth > 8) return false;
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.length <= 64 && value.every((item) => isJson(item, depth + 1));
  if (typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) return Object.values(value as object).every((item) => isJson(item, depth + 1));
  return false;
}

/** Throws a `format` error unless `value` is a well formed trial: the schema, then what a schema cannot say. */
export function checkTrial(value: unknown): asserts value is Trial {
  if (!checker.Check(value)) {
    const first = [...checker.Errors(value)][0] as { instancePath?: string; keyword?: string } | undefined;
    throw bad(`trial.json does not match its schema${first ? ` at ${first.instancePath || "/"} (${first.keyword})` : ""}`);
  }
  const trial = value as Trial;
  for (const { op, value: operand } of trial.when as readonly { op: string; value?: unknown }[]) {
    if (op !== "exists" && !isJson(operand)) throw bad("a precondition's value is not plain JSON");
    if (op !== "exists" && JSON.stringify(operand).length > 512) throw bad("a precondition's value is over 512 characters");
  }
  const seen = new Set<string>();
  let live: Revision | undefined;
  for (const revision of trial.revisions) {
    if (seen.has(revision.sha256)) throw bad("a revision appears twice");
    seen.add(revision.sha256);
    if (!validStamp(revision.since)) throw bad("a revision's since is not a time");
    if (revision.status === "trial" || revision.status === "active") {
      if (live) throw bad("more than one revision is live");
      live = revision;
    }
  }
  if (trial.status !== (live?.status ?? "demoted")) throw bad("the status is not that of the live revision");
  for (const use of trial.uses) {
    if (!seen.has(use.sha256)) throw bad("a use names a revision the trial does not hold");
    if (!validStamp(use.at)) throw bad("a use's at is not a time");
  }
}

export const trialPath = (name: string): string => `${LAYOUT.skills}/${skillName(name)}/trial.json`;
export const skillPath = (name: string): string => `${LAYOUT.skills}/${skillName(name)}/SKILL.md`;
export const workflowDir = (name: string): string => `${LAYOUT.workflows}/${skillName(name)}`;

export function skillName(name: string): string {
  if (typeof name !== "string" || name.length > MAX_NAME || !WORKFLOW_SKILL_NAME.test(name)) {
    throw new LearnError("invalid", `a workflow name is lowercase letters and digits in words joined by single hyphens, at most ${MAX_NAME} characters`);
  }
  return name;
}

/** The file for a trial: byte-stable, under the curator's file cap. */
export function renderTrial(trial: Trial): string {
  checkTrial(trial);
  const text = `${JSON.stringify(trial, null, 2)}\n`;
  const size = Buffer.byteLength(text, "utf8");
  if (size > CAPS.file) throw new LearnError("too_large", `trial.json is ${size} bytes; the cap is ${CAPS.file}`);
  return text;
}

/** Reads a trial file as `renderTrial` writes it, and nothing looser. With `name`, the file must be that name's. */
export function parseTrial(text: string, name?: string): Trial {
  if (typeof text !== "string") throw bad("trial.json is text");
  if (Buffer.byteLength(text, "utf8") > CAPS.file) throw new LearnError("too_large", `trial.json holds at most ${CAPS.file} bytes`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw bad("trial.json is not JSON");
  }
  checkTrial(parsed);
  if (name !== undefined && parsed.name !== name) throw bad("trial.json names another workflow than its folder");
  return parsed;
}

/** The trial of workflow `name` at `ref`, or undefined when the commit holds none. */
export async function readTrial(repo: Pick<Repo, "read">, name: string, ref: string): Promise<Trial | undefined> {
  const text = await repo.read(trialPath(name), ref);
  return text === undefined ? undefined : parseTrial(text, name);
}

export function currentRevision(trial: Trial): Revision | undefined {
  return trial.revisions.find((revision) => revision.status === "trial" || revision.status === "active");
}

function resolve(input: unknown, pointer: string): { found: boolean; value?: unknown } {
  if (pointer === "") return { found: true, value: input };
  let at: unknown = input;
  for (const raw of pointer.slice(1).split("/")) {
    const key = raw.replaceAll("~1", "/").replaceAll("~0", "~");
    if (Array.isArray(at)) {
      if (!/^(?:0|[1-9][0-9]*)$/.test(key) || Number(key) >= at.length) return { found: false };
      at = at[Number(key)];
    } else if (at !== null && typeof at === "object" && Object.hasOwn(at, key)) {
      at = (at as Record<string, unknown>)[key];
    } else return { found: false };
  }
  return { found: true, value: at };
}

/** True when every precondition holds on `input`. `gte` and `lte` hold for numbers only: a string is never coerced. */
export function matches(when: readonly Precondition[], input: unknown): boolean {
  return when.every((check) => {
    const at = resolve(input, check.pointer);
    if (check.op === "exists") return at.found;
    if (!at.found) return false;
    if (check.op === "eq") return isDeepStrictEqual(at.value, check.value);
    if (check.op === "in") return check.value.some((candidate) => isDeepStrictEqual(at.value, candidate));
    if (typeof at.value !== "number" || !Number.isFinite(at.value)) return false;
    return check.op === "gte" ? at.value >= check.value : at.value <= check.value;
  });
}

const pointerOf = (key: string) => `/${key.replaceAll("~", "~0").replaceAll("/", "~1")}`;
const scalar = (value: unknown): value is string | number | boolean | null => value === null || ["string", "number", "boolean"].includes(typeof value);

/**
 * The preconditions a workflow's own input schema states about the top level of its input: each required property
 * must exist, a constant must be equal, an enumeration of scalars must contain the value, and a number's bounds hold.
 * Properties that are not required add nothing, since the input may leave them out. Read from the document, never from
 * prose. A schema this does not understand gives none.
 */
export function deriveWhen(workflow: unknown, resolveSchema?: (schema: Record<string, unknown>) => Record<string, unknown>): Precondition[] {
  const doc = workflow as { input?: { schemaId?: unknown }; schemas?: Record<string, unknown> } | null;
  const id = doc?.input?.schemaId;
  const raw = typeof id === "string" && doc?.schemas && Object.hasOwn(doc.schemas, id) ? doc.schemas[id] : undefined;
  if (raw === null || typeof raw !== "object") return [];
  let schema = raw as Record<string, unknown>;
  try {
    schema = resolveSchema ? resolveSchema(schema) : schema;
  } catch {
    return [];
  }
  const properties = schema.properties;
  const required = Array.isArray(schema.required) ? schema.required.filter((key): key is string => typeof key === "string") : [];
  if (schema.type !== "object" || properties === null || typeof properties !== "object") return [];
  const out: Precondition[] = [];
  for (const key of [...new Set(required)]) {
    const pointer = pointerOf(key);
    if (pointer.length > 256) continue;
    out.push({ pointer, op: "exists" });
    const property = Object.hasOwn(properties, key) ? (properties as Record<string, unknown>)[key] : undefined;
    if (property === null || typeof property !== "object") continue;
    const p = property as Record<string, unknown>;
    if (Object.hasOwn(p, "const") && isJson(p.const) && JSON.stringify(p.const).length <= 512) out.push({ pointer, op: "eq", value: p.const });
    else if (Array.isArray(p.enum) && p.enum.length >= 1 && p.enum.length <= LIMITS.inValues && p.enum.every(scalar) && p.enum.every(isJson)) out.push({ pointer, op: "in", value: p.enum as Json[] });
    if (typeof p.minimum === "number" && Number.isFinite(p.minimum)) out.push({ pointer, op: "gte", value: p.minimum });
    if (typeof p.maximum === "number" && Number.isFinite(p.maximum)) out.push({ pointer, op: "lte", value: p.maximum });
  }
  return out.slice(0, LIMITS.preconditions);
}
