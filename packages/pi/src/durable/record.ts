// The record core: how one LLM node delivers a typed record through one `submit` call, with no pi import.
//
// A submission is repaired as a transport spelling (stringified containers and scalars, a "null" where the
// field admits null), read from a workspace file when it names one, held to the host's contracts and the
// schema, and then read a second time by the node's reviewers. Every answer that is not a delivery spends
// one delivery attempt: a rejection, the second reading's one bounce, a nudge of a yield without a record.
// The second reading is feedback, once: the first record it disagrees with goes back; the next structurally
// valid record is delivered with what the reading still disagrees with beside it. A reviewer that cannot
// answer decides nothing.
//
// `deliver` is the whole decision over a `RecordStore`, the two small states a caller keeps durably or in
// memory. `gate` and `spend` are the same rules as pure functions, the ones `spec/lean` proves terminate.
import { isDeepStrictEqual } from "node:util";
import { Compile } from "typebox/compile";

/** The record a node delivered, or null while it has not, and the delivery attempts it has spent. */
export type RecordState = { record: unknown; attempts: number };
/** What the second reading disagrees with in a record: its question, the kind of reading, the verdict and why. */
export type Disagreement = { id: string; kind: string; verdict: string; reasons: string[] };
/** Whether the second reading's round was spent, and what it still disagreed with in the delivered record. */
export type GateState = { bounced: boolean; disagreements: Disagreement[] };

/** Delivery attempts a node gets: rejections, the second reading's one bounce and nudges, each once. */
export const DELIVERY_ATTEMPTS = 6;

// ─── the two rules, pure ───

/** One reviewer's reading of a structurally valid record. `no_verdict` is a reviewer that could not answer. */
export type Reading = "disagrees" | "agrees" | "no_verdict";

/** The second reading on one structurally valid submission: it sends the record back only while its round
 *  is unspent and a reviewer disagrees. A reviewer with no verdict never sends a record back. */
export function gate(bounced: boolean, readings: readonly Reading[]): "accept" | "bounce" {
  return !bounced && readings.includes("disagrees") ? "bounce" : "accept";
}

/** What a node is answered with. Only `delivered` is a delivery; each of the others spends one attempt. */
export type DeliveryEvent = "rejected" | "bounce" | "nudge" | "delivered";
/** A node's delivery, as far as the attempts count it. */
export type DeliveryCount = { attempts: number; delivered: boolean };

/** Whether a node's delivery has ended: it delivered, or its attempts are spent. */
export const deliveryEnded = (max: number, state: DeliveryCount): boolean => state.delivered || state.attempts >= max;

/** One answer applied to the count. An ended delivery takes no further answer; every other answer counts once. */
export function spend(max: number, state: DeliveryCount, event: DeliveryEvent): DeliveryCount {
  if (deliveryEnded(max, state)) return state;
  return { attempts: state.attempts + 1, delivered: event === "delivered" };
}

// ─── the schema a record is held to ───

/** What makes a schema unusable as a `submit` tool's parameters: its root is not an object schema, or it
 *  requires a field it does not declare, which a model reading the declared fields can never supply. */
export function lintRecordSchema(schema: unknown): string[] {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return ["the record schema must be a JSON Schema object"];
  const { type, properties, required } = schema as { type?: unknown; properties?: unknown; required?: unknown };
  const problems: string[] = [];
  if (type !== undefined && type !== "object") problems.push(`the record schema's root type must be "object", not ${JSON.stringify(type)}`);
  const declared = properties && typeof properties === "object" && !Array.isArray(properties) ? properties as Record<string, unknown> : null;
  const undeclared = Array.isArray(required) && declared ? required.filter((name) => typeof name !== "string" || !Object.hasOwn(declared, name)) : [];
  if (undeclared.length) problems.push(`the record schema requires ${undeclared.map((name) => JSON.stringify(name)).join(", ")}, which its properties do not declare`);
  return problems;
}

type Validator = { Check(value: unknown): boolean; Errors(value: unknown): Iterable<{ instancePath?: string; path?: string; message: string }> };
const validators = new WeakMap<object, Validator | null>();
/** The schema's compiled validator, or null for a schema the compiler refuses. */
function validatorOf(schema: unknown): Validator | null {
  if (!schema || typeof schema !== "object") return null;
  let validator = validators.get(schema);
  if (validator === undefined) {
    try { validator = Compile(schema as never) as unknown as Validator; } catch { validator = null; }
    validators.set(schema, validator);
  }
  return validator;
}

// ─── transport repair ───

/** Where the schema expects an object or an array and the submitted value is a string that parses to one, the
 *  parsed value; where it expects a number, an integer, a boolean or null and admits no string, the scalar a
 *  string spells. Some model families serialise nested tool arguments as strings: the content is valid and
 *  every submit fails on its spelling. A string the field accepts keeps its bytes. */
export function parseStringifiedContainers(value: unknown, schema: Record<string, unknown> | undefined, depth = 0, rootDefinitions?: Record<string, unknown>): unknown {
  if (depth > 6 || !schema || typeof schema !== "object") return value;
  // A `$ref` property carries no type of its own: it is read through the root schema's definitions, or the
  // repair skips exactly the fields it exists for.
  const definitions = rootDefinitions ?? (schema.definitions as Record<string, unknown> | undefined);
  const deref = (spec: any, hops = 0): any => {
    if (hops > 4 || !spec || typeof spec !== "object") return spec;
    const ref = typeof spec.$ref === "string" ? spec.$ref.match(/^#\/definitions\/(.+)$/) : null;
    if (ref && definitions && definitions[ref[1]] && typeof definitions[ref[1]] === "object") return deref(definitions[ref[1]], hops + 1);
    return spec;
  };
  const expected = (spec: any): string[] => {
    const resolved = deref(spec);
    const types = Array.isArray(resolved?.type) ? resolved.type : resolved?.type ? [resolved.type] : [];
    const anyOf: any[] = Array.isArray(resolved?.anyOf) ? resolved.anyOf : [];
    return [...types, ...anyOf.flatMap((variant) => expected(variant))];
  };
  const repair = (input: unknown, rawSpec: any): unknown => {
    const spec = deref(rawSpec);
    const wants = expected(spec);
    let current = input;
    if (typeof current === "string" && (wants.includes("object") || wants.includes("array"))) {
      const trimmed = current.trim();
      if ((trimmed.startsWith("{") && trimmed.endsWith("}")) || (trimmed.startsWith("[") && trimmed.endsWith("]"))) {
        try {
          const parsed = JSON.parse(trimmed);
          const isObject = parsed && typeof parsed === "object" && !Array.isArray(parsed);
          if ((isObject && wants.includes("object")) || (Array.isArray(parsed) && wants.includes("array"))) current = parsed;
        } catch { /* Not JSON: the string stays for the validator to report. */ }
      }
    }
    // A scalar is coerced only when the field does not accept a string. Integers must be exact; a decimal
    // becomes the float64 that JSON.parse of the same literal yields, the only value a JSON number can hold.
    if (typeof current === "string" && !wants.includes("string")) {
      const trimmed = current.trim();
      if ((wants.includes("integer") || wants.includes("number")) && /^-?\d+$/.test(trimmed) && Number.isSafeInteger(Number(trimmed))) current = Number(trimmed);
      else if (wants.includes("number") && /^-?(?:0|[1-9]\d*)\.\d+$/.test(trimmed) && Number.isFinite(Number(trimmed))) current = JSON.parse(trimmed) as number;
      else if (wants.includes("boolean") && (trimmed === "true" || trimmed === "false")) current = trimmed === "true";
      else if (wants.includes("null") && trimmed === "null") current = null;
    }
    // An `anyOf`-wrapped object's nested fields live under the branch's properties, not the wrapper's.
    const flattenBranches = (candidate: any): any[] => [candidate, ...(Array.isArray(candidate?.anyOf) ? candidate.anyOf.flatMap(flattenBranches) : [])];
    if (current && typeof current === "object" && !Array.isArray(current)) {
      const objectBranch = flattenBranches(spec).map((branch) => deref(branch)).find((branch) => branch?.properties && typeof branch.properties === "object");
      if (objectBranch) return parseStringifiedContainers(current, objectBranch, depth + 1, definitions);
    }
    if (Array.isArray(current)) {
      const arrayBranch = flattenBranches(spec).map((branch) => deref(branch)).find((branch) => branch?.items && typeof branch.items === "object");
      if (arrayBranch) return current.map((item) => repair(item, arrayBranch.items));
    }
    return current;
  };
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const properties = (schema as { properties?: Record<string, unknown> }).properties || {};
  const next: Record<string, unknown> = { ...(value as Record<string, unknown>) };
  for (const [key, spec] of Object.entries(properties)) if (key in next) next[key] = repair(next[key], spec);
  return next;
}

/** A local `$ref` (`#/definitions/<name>` or `#/$defs/<name>`) resolved against the record's root schema, so
 *  the null-spelling walk reads the field schemas the schema check does. One it cannot resolve reads as no schema. */
function deref(schema: unknown, root: unknown, hops = 0): unknown {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return schema;
  const ref = (schema as Record<string, unknown>).$ref;
  if (typeof ref !== "string") return schema;
  const match = ref.match(/^#\/(definitions|\$defs)\/([^/]+)$/);
  const table = match && root && typeof root === "object" ? (root as Record<string, unknown>)[match[1]] : undefined;
  const target = table && typeof table === "object" ? (table as Record<string, unknown>)[match![2]] : undefined;
  return target && hops < 16 ? deref(target, root, hops + 1) : undefined;
}

function admitsNull(schema: unknown, root: unknown): boolean {
  schema = deref(schema, root);
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return false;
  const spec = schema as Record<string, unknown>;
  if (spec.type === "null" || (Array.isArray(spec.type) && spec.type.includes("null"))) return true;
  if (spec.const === null || (Array.isArray(spec.enum) && spec.enum.includes(null))) return true;
  return [spec.anyOf, spec.oneOf].some((branches) => Array.isArray(branches) && branches.some((branch) => admitsNull(branch, root)));
}

function propertiesOf(schema: unknown, root: unknown): Record<string, unknown> {
  schema = deref(schema, root);
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return {};
  const spec = schema as Record<string, unknown>;
  const fieldMap = !("type" in spec) && !("properties" in spec) && !("anyOf" in spec) && !("oneOf" in spec) ? spec : {};
  const direct = spec.properties && typeof spec.properties === "object" && !Array.isArray(spec.properties) ? spec.properties as Record<string, unknown> : fieldMap;
  const branches = [...(Array.isArray(spec.anyOf) ? spec.anyOf : []), ...(Array.isArray(spec.oneOf) ? spec.oneOf : [])];
  return Object.assign({}, ...branches.map((branch) => propertiesOf(branch, root)), direct);
}

function itemsOf(schema: unknown, root: unknown): unknown {
  schema = deref(schema, root);
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return undefined;
  const spec = schema as Record<string, unknown>;
  if (spec.items) return spec.items;
  const branches = [...(Array.isArray(spec.anyOf) ? spec.anyOf : []), ...(Array.isArray(spec.oneOf) ? spec.oneOf : [])];
  return branches.map((branch) => itemsOf(branch, root)).find(Boolean);
}

// The spellings a model uses when it means "no value": one set, read by the finding and by the repair, so a
// string one recognises the other heals.
const NULL_SPELLINGS: ReadonlySet<string> = new Set(["null", "none", "n/a"]);
const spellsNull = (value: unknown): value is string => typeof value === "string" && NULL_SPELLINGS.has(value.trim().toLowerCase());

/** The path of every string that spells "no value" in a field whose schema admits JSON null. */
export function nullSpellings(value: unknown, schema: unknown, root: unknown = schema, at = ""): string[] {
  if (spellsNull(value) && admitsNull(schema, root)) return [at || "$"];
  if (Array.isArray(value)) {
    const items = itemsOf(schema, root);
    return items ? value.flatMap((item, index) => nullSpellings(item, items, root, `${at}[${index}]`)) : [];
  }
  if (!value || typeof value !== "object") return [];
  const properties = propertiesOf(schema, root);
  return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) =>
    Object.hasOwn(properties, key) ? nullSpellings(child, properties[key], root, at ? `${at}.${key}` : key) : []);
}

/** The record with every such string replaced by JSON null, in place. A repair the record as a whole refuses
 *  (it satisfied its schema before and does not after) is undone in full, so a spelling stays only where null
 *  is inadmissible. `""` is a value and stays. */
export function healNullSpellings<T>(record: T, schema: Record<string, unknown>): T {
  if (!record || typeof record !== "object" || Array.isArray(record) || Object.getPrototypeOf(record) !== Object.prototype) return record;
  if (!nullSpellings(record, schema).length) return record;
  const validator = validatorOf(schema);
  const before = validator?.Check(record) ? structuredClone(record) : null;
  const heal = (value: unknown, spec: unknown): unknown => {
    if (spellsNull(value) && admitsNull(spec, schema)) return null;
    if (Array.isArray(value)) {
      const items = itemsOf(spec, schema);
      if (items) value.forEach((item, index) => { value[index] = heal(item, items); });
      return value;
    }
    if (!value || typeof value !== "object") return value;
    const properties = propertiesOf(spec, schema);
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (Object.hasOwn(properties, key)) (value as Record<string, unknown>)[key] = heal(child, properties[key]);
    }
    return value;
  };
  heal(record, schema);
  if (before && validator && !validator.Check(record)) {
    const fields = record as Record<string, unknown>;
    for (const key of Object.keys(fields)) delete fields[key];
    Object.assign(fields, before);
  }
  return record;
}

/** A record's transport spellings repaired against its schema, without touching `args`. */
export function repairRecord(args: unknown, schema: Record<string, unknown>): unknown {
  if (!args || typeof args !== "object" || Array.isArray(args)) return args;
  return healNullSpellings(structuredClone(parseStringifiedContainers(args, schema)), schema);
}

// ─── the file envelope ───

/** The file a submission names and nothing else: `{ <key>: "relative/path.json" }`. */
export function fileSubmission(args: unknown, key: string): string | null {
  if (!args || typeof args !== "object" || Array.isArray(args)) return null;
  const fields = args as Record<string, unknown>;
  return Object.keys(fields).length === 1 && typeof fields[key] === "string" ? fields[key] as string : null;
}

/** A submission with fields beside the file key. Fields that form a whole record on their own are that record;
 *  otherwise the file holds the record, and each field beside it may only restate the file's value. A schema
 *  that declares the file key as its own field keeps it inline. */
export function mixedFileSubmission(args: unknown, schema: Record<string, unknown> | undefined, key: string): { file: string; extras: Record<string, unknown> } | null {
  if (!args || typeof args !== "object" || Array.isArray(args)) return null;
  const { [key]: file, ...extras } = args as Record<string, unknown>;
  if (typeof file !== "string" || !Object.keys(extras).length) return null;
  const properties = schema && typeof schema.properties === "object" && schema.properties ? schema.properties as Record<string, unknown> : {};
  return Object.hasOwn(properties, key) ? null : { file, extras };
}

/** The fields beside the file key that the file's record does not hold with the same value. */
export function extrasNotInRecord(record: unknown, extras: Record<string, unknown>): string[] {
  const held = record && typeof record === "object" && !Array.isArray(record) ? record as Record<string, unknown> : {};
  return Object.keys(extras).filter((key) => !Object.hasOwn(held, key) || !isDeepStrictEqual(held[key], extras[key])).sort();
}

// ─── one submission, decided ───

/** One host check's refusal of a candidate: the problems the model must fix, and the reason they are grouped under. */
export type Refusal = { problems: string[]; reason?: string };
/** A second reader of a structurally valid record. It returns what it disagrees with (nothing when it agrees or
 *  has no verdict). `round` says whether a disagreement still sends the record back. A reviewer that throws
 *  decides nothing, unless the contract's `fatal` claims the error. */
export type Reviewer = (candidate: unknown, context: { round: boolean }) => Disagreement[] | Promise<Disagreement[]>;

export type RecordContract = {
  /** The node's record schema, the `submit` tool's contract. */
  schema: Record<string, unknown>;
  /** Delivery attempts the node gets (default `DELIVERY_ATTEMPTS`). */
  maxAttempts?: number;
  /** A record may be delivered as a workspace file named under `key`; `read` returns the file's parsed JSON or
   *  throws (an error whose `code` is `ENOENT` for a file that is not there). Absent, a record is inline only. */
  file?: { key: string; read(path: string): Promise<unknown> };
  /** Contracts the host owns, held before the schema: each problem is said with the core's own findings. */
  contracts?: (candidate: unknown) => string[] | Promise<string[]>;
  /** Checks held after the schema, in order; the first refusal is the rejection. One that throws refuses with
   *  what it threw. */
  checks?: ReadonlyArray<(candidate: unknown) => Refusal | null | Promise<Refusal | null>>;
  /** The second reading, in order. */
  reviewers?: readonly Reviewer[];
  /** Whether a reviewer's error is the caller's own failure, to be thrown and not absorbed. */
  fatal?: (error: unknown) => boolean;
};

/** The two states behind a node's delivery. Each write is one atomic change; `reject` and `bounce` return the
 *  attempts spent after it. The bounce spends the round before the model is told, so a crash cannot grant it twice. */
export type RecordStore = {
  read(): Promise<{ record: RecordState; gate: GateState }>;
  reject(): Promise<number>;
  bounce(): Promise<number>;
  accept(record: unknown, disagreements: Disagreement[]): Promise<void>;
};

/** What one submission came to. `spent` says the delivery attempts are gone and the node's run ends here. */
export type Delivery =
  | { status: "already" }
  | { status: "rejected"; attempts: number; spent: boolean; reason: string; problems: string[] }
  | { status: "bounced"; attempts: number; spent: boolean; disagreements: Disagreement[] }
  | { status: "accepted"; record: unknown; disagreements: Disagreement[] };

const SCHEMA_REASON = "submission does not satisfy the schema";
const messageOf = (error: unknown): string => error instanceof Error ? error.message : String(error);

/** Decide one `submit` call. `args` are the call's arguments as the model sent them, or as `repairRecord`
 *  already repaired them. */
export async function deliver(contract: RecordContract, store: RecordStore, args: unknown): Promise<Delivery> {
  const max = contract.maxAttempts ?? DELIVERY_ATTEMPTS;
  const key = contract.file?.key;
  const state = await store.read();
  if (state.record.record != null) return { status: "already" };
  const reject = async (problems: string[], reason = SCHEMA_REASON): Promise<Delivery> => {
    const attempts = await store.reject();
    return { status: "rejected", attempts, spent: attempts >= max, reason, problems };
  };
  const validator = validatorOf(contract.schema);
  let candidate = args;
  const file = key === undefined ? null : fileSubmission(candidate, key);
  const mixed = key === undefined ? null : mixedFileSubmission(candidate, contract.schema, key);
  // Fields beside the file key that are a whole record on their own are that record, as an inline submission.
  const inlineBeside = mixed ? repairRecord(mixed.extras, contract.schema) : undefined;
  if (mixed && validator?.Check(inlineBeside)) candidate = inlineBeside;
  else if (mixed) {
    const exact = `call submit with exactly {"${key}": ${JSON.stringify(mixed.file)}} and nothing beside it`;
    let record: unknown;
    try { record = await contract.file!.read(mixed.file); }
    catch (error) {
      if ((error as { code?: string })?.code === "ENOENT") return reject([`${key} names a file that does not exist in the workspace; write the complete JSON there first, then ${exact}`]);
      return reject([`${messageOf(error)}; then ${exact}`]);
    }
    const stray = extrasNotInRecord(record, mixed.extras);
    if (stray.length) {
      return reject([`the record is read from ${mixed.file} alone, and these fields beside ${key} are missing from that file or differ from it: ${stray.join(", ")}. Write every field into the file, then ${exact}`], "the submission mixes a file with inline fields");
    }
    candidate = repairRecord(record, contract.schema);
  } else if (file !== null) {
    // The file's record takes the same transport repair as an inline one.
    try { candidate = repairRecord(await contract.file!.read(file), contract.schema); }
    catch (error) {
      if ((error as { code?: string })?.code === "ENOENT") return reject([`${key} names a file that does not exist in the workspace; write the complete JSON there first, then resubmit`]);
      return reject([messageOf(error)]);
    }
  }
  // A "null" the repair could not heal sits where the record's other fields rule null out: the model writes the value.
  const unhealed = (candidate && typeof candidate === "object" && !Array.isArray(candidate) ? nullSpellings(candidate, contract.schema) : []).map((path) =>
    `${path}: violates "this field cannot be null in this record: the schema admits null for the field alone, but the record's other fields rule it out" — write the real value`);
  const owned = [...unhealed, ...(contract.contracts ? await contract.contracts(candidate) : [])];
  if (owned.length) return reject(owned, "the record violates host-owned contracts");
  if (!validator || !validator.Check(candidate)) {
    return reject(validator ? [...validator.Errors(candidate)].slice(0, 8).map((error) => `${error.instancePath || error.path || "/"}: ${error.message}`) : ["the record schema does not compile"]);
  }
  for (const check of contract.checks ?? []) {
    let refusal: Refusal | null;
    try { refusal = await check(candidate); } catch (error) { refusal = { problems: [`host validation gate threw: ${messageOf(error)}`] }; }
    if (refusal?.problems.length) return reject(refusal.problems, refusal.reason);
  }
  // The second reading, once.
  const round = !state.gate.bounced;
  const disagreements: Disagreement[] = [];
  for (const reviewer of contract.reviewers ?? []) {
    try { disagreements.push(...await reviewer(candidate, { round })); }
    catch (error) { if (contract.fatal?.(error)) throw error; }
  }
  if (gate(state.gate.bounced, [disagreements.length ? "disagrees" : "agrees"]) === "bounce") {
    const attempts = await store.bounce();
    return { status: "bounced", attempts, spent: attempts >= max, disagreements };
  }
  await store.accept(candidate, disagreements);
  return { status: "accepted", record: candidate, disagreements };
}

/** The `submit` tool's answer to the model for one delivery. */
export function deliveryText(delivery: Delivery, maxAttempts = DELIVERY_ATTEMPTS, say: (disagreement: Disagreement) => string = disagreementText): string {
  const spentLine = "The delivery attempts are spent; the run stops here.";
  switch (delivery.status) {
    case "already": return "Already submitted; the first valid record is authoritative.";
    case "accepted": return "Submitted. You are DONE; end your turn.";
    case "rejected": return `REJECTED (${delivery.attempts}/${maxAttempts}) — ${delivery.reason}: ${delivery.problems.join("; ")}.${delivery.spent ? ` ${spentLine}` : " Fix exactly those and resubmit."}`;
    case "bounced": return `${delivery.disagreements.map(say).join("\n")}${delivery.spent ? `\n${spentLine}` : ""}`;
  }
}

/** One disagreement as the model reads it. */
export const disagreementText = (d: Disagreement): string => `${d.id} (${d.kind}): ${d.verdict}${d.reasons.length ? ` - ${d.reasons.join("; ")}` : ""}`;

/** Whether a delivery ends the node's run: a record was delivered, or the attempts are spent. */
export const deliveryTerminates = (delivery: Delivery): boolean =>
  delivery.status === "already" || delivery.status === "accepted" || ((delivery.status === "rejected" || delivery.status === "bounced") && delivery.spent);

/** The delivery contract a node's task ends with: the label, the file envelope when one is offered, the
 *  authoritative schema and the host's own delivery instructions. The model sees the exact schema only here. */
export function submitFooter(record: { label: string; schema: Record<string, unknown>; fileKey?: string; instructions?: string; reviewed?: boolean }): string {
  return [
    `When you are done, call the \`submit\` tool ONCE with ${record.label} as its arguments. The arguments are validated against the required schema; if validation fails you get the problems back and may fix and resubmit.`,
    ...(record.reviewed ? ["A schema-valid record is then reviewed against the procedure that governs this run before it is accepted; violations come back to you, with the rule each one breaks, to fix and resubmit."] : []),
    ...(record.fileKey ? [`For a large record, write the complete JSON to a fresh file inside the workspace, then call \`submit\` once with {"${record.fileKey}":"relative/path.json"}. The harness reads and validates that file directly; do not paste the record back into the tool call.`] : []),
    `Required JSON Schema (authoritative): ${JSON.stringify(record.schema)}`,
    record.instructions || "",
    "Only a successful `submit` call counts as delivering. Do not answer in plain text.",
  ].filter(Boolean).join("\n");
}

/** What a yield without a record is answered with, when the delivery has an attempt left for it. */
export const nudgeText = (label: string): string => `You stopped without submitting. Call submit with ${label}, complete.`;
