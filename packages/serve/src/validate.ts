// Structural checks of request bodies against the contract's schemas, as field issues (`422 input_invalid`).
import { type InputIssue, invalid } from "./errors.js";
import { HARNESSES } from "./harness.js";
import { THINKING_LEVELS } from "./model.js";
import { likelyModel, modelShape } from "./model-form.js";
import { placeIssues } from "./place.js";
import { computerIssues, settingConflict } from "./computer-setting.js";
import { settingsIssues } from "./tool-plane.js";
import { CAP_MODES } from "./cap.js";
import { APPROVALS } from "./approvals.js";
import { schemaCheck } from "./answer-json.js";

export const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
/** An inline agent's source or kind in its external reference (POST /runs): no colon, which the reference's key splits on. */
export const EXTERNAL_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const SKILL_PATH = /^(?!.*(?:^|\/)\.{1,2}(?:\/|$))(?!.*\/\/)(?!.*\/$)[^/\\\u0000][^\\\u0000]*$/;

export type Json = Record<string, unknown>;
export const isObject = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);

/** JSON with every object's keys sorted, so two equal values read the same. */
/** How long an Idempotency-Key answers with its first answer (capabilities' limits.idempotency_ttl_s). */
export const IDEMPOTENCY_TTL_S = 86_400;
export const stable = (value: unknown): string =>
  Array.isArray(value) ? `[${value.map(stable).join(",")}]` : isObject(value) ? `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${stable(value[k])}`).join(",")}}` : JSON.stringify(value);

export const DEFINITION_FIELDS = ["id", "version", "name", "description", "instructions", "workflow", "model", "model_tiers", "thinking", "harness", "place", "computer", "learning", "skills", "tools", "tool_settings", "approvals", "max_cost_usd", "cap_mode", "input_schema", "output_schema", "checkout", "native"];
/** What an agentic definition may ask the server to check out in each run's folder before its first turn
 *  (runner/pr-checkout.ts): `pull_request`, the pull request the run's GitHub event names, at its head, read-only, in
 *  `repo/`; `none` clears it on an edit. */
export const CHECKOUTS = ["pull_request", "none"] as const;
/** The most bytes an agent's output_schema takes, as JSON. */
export const MAX_OUTPUT_SCHEMA_BYTES = 64 * 1024;
/** The most bytes an agent's input_schema takes, as JSON. */
export const MAX_INPUT_SCHEMA_BYTES = 64 * 1024;
/** The tiers an agentic revision may name a model for (`model_tiers`): those a subagent runs on (runner/subagent.ts). */
export const MODEL_TIER_NAMES = ["fast", "strong"] as const;
/** `provider/model-id`. */
export const MODEL_REF = /^[^/\s]+\/\S+$/;

/** What a model that is no `provider/model-id` is told: the form `harness` takes, with examples, and the likely id when
 *  one is obvious. Structural, so it knows no keys here: the likely id is named in both forms (the vendor's own, and
 *  OpenRouter's), never one that a server with only the other key could not run. */
function modelFormIssue(harness: string, given: unknown): string {
  const own = typeof given === "string" ? likelyModel({}, harness, given) : undefined;
  const routed = typeof given === "string" ? likelyModel({ OPENROUTER_API_KEY: "-" }, harness, given) : undefined;
  const likely = own && routed && own !== routed ? `${own}, or ${routed} through OpenRouter` : own;
  return `${modelShape({}, harness)}: ${typeof given === "string" ? `"${given}"` : "that"} is not one.${likely ? ` Did you mean ${likely}?` : ""}`;
}
const SKILL_FILE = "/SKILL.md";

const issue = (field: string, reason: string, message: string, fix?: string): InputIssue => ({ field, reason, message, ...(fix ? { fix } : {}) });

/** A body's fields that `allowed` does not name, each as the 422's not_allowed issue. */
export const unknownFields = (body: object, allowed: readonly string[]): InputIssue[] =>
  Object.keys(body).filter((key) => !allowed.includes(key)).map((key) => ({ field: key, reason: "not_allowed", message: `The body keeps no field ${key}.` }));

function names(value: unknown, field: string, out: InputIssue[]): void {
  if (!Array.isArray(value)) return void out.push(issue(field, "wrong_type", `${field} is not a list of names`));
  if (!value.every((name) => typeof name === "string" && name !== "")) out.push(issue(field, "wrong_type", `${field} holds an item that is not a non-empty string`));
  else if (new Set(value).size !== value.length) out.push(issue(field, "duplicate", `${field} names one item twice`));
}

/** The skills a revision's files hold: each `<name>/SKILL.md`, by name, sorted. */
export const skillNames = (files: Iterable<string>): string[] => [...files].filter((path) => path.endsWith(SKILL_FILE)).map((path) => path.slice(0, -SKILL_FILE.length)).sort();

/**
 * A definition as `POST /agents` and `PUT .../definition` take it: what one revision of an agent keeps. `instructions`
 * makes an agentic revision, `workflow` (an agentrun-dsl workflow) a workflow revision. `creating` asks for a name.
 */
export function definitionIssues(definition: unknown, { at = "definition", creating = true } = {}): InputIssue[] {
  if (!isObject(definition)) return [issue(at, definition === undefined ? "missing" : "wrong_type", `${at} is not an object`)];
  const out: InputIssue[] = [];
  for (const key of Object.keys(definition)) {
    if (!DEFINITION_FIELDS.includes(key)) out.push(issue(`${at}.${key}`, "not_allowed", `The definition keeps no field ${key}.`, `Remove ${at}.${key}.`));
  }
  const d = definition;
  if (creating && d.name === undefined) out.push(issue(`${at}.name`, "missing", `${at}.name is required`));
  if (d.instructions === undefined && d.workflow === undefined) out.push(issue(`${at}.instructions`, "missing", `${at} needs instructions (an agentic revision) or a workflow (a workflow revision)`));
  if (d.instructions !== undefined && d.workflow !== undefined) out.push(issue(`${at}.workflow`, "not_allowed", `${at} has instructions or a workflow, not both`, `Remove ${at}.workflow or ${at}.instructions.`));
  if (d.id !== undefined && (typeof d.id !== "string" || !ID.test(d.id))) out.push(issue(`${at}.id`, "bad_format", `${at}.id must match ${ID.source}`));
  if (d.version !== undefined && (!Number.isSafeInteger(d.version) || (d.version as number) < 1)) out.push(issue(`${at}.version`, "wrong_type", `${at}.version is not a positive integer`));
  if (d.name !== undefined && (typeof d.name !== "string" || d.name.trim() === "")) out.push(issue(`${at}.name`, typeof d.name === "string" ? "too_short" : "wrong_type", `${at}.name is not a non-empty string`));
  if (d.description !== undefined && typeof d.description !== "string") out.push(issue(`${at}.description`, "wrong_type", `${at}.description is not a string`));
  if (d.instructions !== undefined && typeof d.instructions !== "string") out.push(issue(`${at}.instructions`, "wrong_type", `${at}.instructions is not a string`));
  if (d.workflow !== undefined && !isObject(d.workflow)) out.push(issue(`${at}.workflow`, "wrong_type", `${at}.workflow is not an object`));
  if (d.model !== undefined) {
    if (d.workflow !== undefined) out.push(issue(`${at}.model`, "not_allowed", "A workflow revision keeps no model: its model nodes run on this host's default.", `Remove ${at}.model.`));
    else if (typeof d.model !== "string" || !MODEL_REF.test(d.model)) out.push(issue(`${at}.model`, "bad_format", modelFormIssue(typeof d.harness === "string" ? d.harness : "pi", d.model)));
  }
  if (d.model_tiers !== undefined) {
    if (d.workflow !== undefined) out.push(issue(`${at}.model_tiers`, "not_allowed", "A workflow revision keeps no model tiers: each model node names its tier, run on this host's model for it.", `Remove ${at}.model_tiers.`));
    else if (!isObject(d.model_tiers) || !Object.keys(d.model_tiers).length) out.push(issue(`${at}.model_tiers`, "wrong_type", `${at}.model_tiers is an object of ${MODEL_TIER_NAMES.join(", ")} to "provider/model-id"`));
    else {
      for (const [tier, ref] of Object.entries(d.model_tiers)) {
        if (!(MODEL_TIER_NAMES as readonly string[]).includes(tier)) out.push(issue(`${at}.model_tiers.${tier}`, "not_allowed", `${at}.model_tiers names ${MODEL_TIER_NAMES.join(" and ")} alone`, `Remove ${at}.model_tiers.${tier}.`));
        else if (typeof ref !== "string" || !MODEL_REF.test(ref)) out.push(issue(`${at}.model_tiers.${tier}`, "bad_format", `${at}.model_tiers.${tier} is "provider/model-id"`));
      }
    }
  }
  if (d.harness !== undefined && !(HARNESSES as readonly unknown[]).includes(d.harness)) out.push(issue(`${at}.harness`, "not_an_option", `${at}.harness is one of ${HARNESSES.join(", ")}`));
  if (d.place !== undefined) out.push(...placeIssues(d.place, `${at}.place`));
  if (d.computer !== undefined) out.push(...computerIssues(d.computer, `${at}.computer`), ...settingConflict(d.computer, d.place, at));
  if (d.thinking !== undefined) {
    if (d.workflow !== undefined) out.push(issue(`${at}.thinking`, "not_allowed", "A workflow revision keeps no thinking level: each model node carries its own.", `Remove ${at}.thinking.`));
    else if (!(THINKING_LEVELS as readonly unknown[]).includes(d.thinking)) out.push(issue(`${at}.thinking`, "not_an_option", `${at}.thinking is one of ${THINKING_LEVELS.join(", ")}: thinking is never off`));
  }
  if (d.learning !== undefined) {
    if (d.workflow !== undefined) out.push(issue(`${at}.learning`, "not_allowed", "A workflow revision does not learn: only an agentic run reflects on its work.", `Remove ${at}.learning.`));
    else if (typeof d.learning !== "boolean" && d.learning !== "notes") out.push(issue(`${at}.learning`, "wrong_type", `${at}.learning is true, false or "notes": true learns notes, skills and workflows, "notes" notes and skills alone`));
  }
  // An agentic revision's structured answer: the JSON Schema its final answer's last fenced json block meets, read into a
  // completed run's result.output (answer-json.ts structuredAnswer). A workflow's output is its workflow's own.
  if (d.output_schema !== undefined) {
    if (d.workflow !== undefined) out.push(issue(`${at}.output_schema`, "not_allowed", "A workflow revision keeps no output_schema: its run's output is its workflow's.", `Remove ${at}.output_schema.`));
    else if (!isObject(d.output_schema)) out.push(issue(`${at}.output_schema`, "wrong_type", `${at}.output_schema is a JSON Schema object`));
    else if (Buffer.byteLength(JSON.stringify(d.output_schema)) > MAX_OUTPUT_SCHEMA_BYTES) out.push(issue(`${at}.output_schema`, "too_long", `${at}.output_schema is over ${MAX_OUTPUT_SCHEMA_BYTES} bytes as JSON`));
    else {
      const compiled = schemaCheck(d.output_schema);
      if ("why" in compiled) out.push(issue(`${at}.output_schema`, "bad_format", `${at}.output_schema ${compiled.why}`));
    }
  }
  // An agentic revision's typed input: the JSON Schema each run's input meets (inputSchemaOf, the schema in force). A
  // workflow's input is its workflow's own schema.
  if (d.input_schema !== undefined) {
    if (d.workflow !== undefined) out.push(issue(`${at}.input_schema`, "not_allowed", "A workflow revision keeps no input_schema: its runs' input is its workflow's own input schema.", `Remove ${at}.input_schema.`));
    else out.push(...inputSchemaIssues(d.input_schema, `${at}.input_schema`));
  }
  if (d.skills !== undefined) names(d.skills, `${at}.skills`, out);
  if (d.tools !== undefined) names(d.tools, `${at}.tools`, out);
  // The agent's own tool settings, over the server's (tool-plane.ts); an edit that leaves them out keeps none.
  if (d.tool_settings !== undefined) {
    // An agent's own pin among them, kept as given (the gate holds its runs to it).
    out.push(...settingsIssues(d.tool_settings, `${at}.tool_settings`, "agent"));
  }
  // Whether the agent's runs ask a person (the gate as its settings say) or run unattended, an ask allowed: never over a
  // deny. An edit that leaves it out asks, as one that leaves out tool_settings keeps none: no edit makes an agent
  // unattended by saying nothing.
  if (d.approvals !== undefined && !(APPROVALS as readonly unknown[]).includes(d.approvals)) out.push(issue(`${at}.approvals`, "not_an_option", `${at}.approvals is one of ${APPROVALS.join(", ")}: ask, the default, waits for a person where a tool is set to ask; never runs the agent unattended, each such tool allowed, while a deny still refuses`));
  // The agent's default cap of each run started without one of its own: above 0 sets it, 0 clears it (no default), and
  // an edit that leaves it out keeps the agent's (agents-store.ts), so leaving a field out never removes a spend limit.
  if (d.max_cost_usd !== undefined) {
    if (!(typeof d.max_cost_usd === "number" && Number.isFinite(d.max_cost_usd) && d.max_cost_usd >= 0)) out.push(issue(`${at}.max_cost_usd`, "wrong_type", `${at}.max_cost_usd is a number of at least 0, in US dollars: above 0 sets the agent's default cap, 0 clears it`));
  }
  // The server's checkout before each run's first turn: kept by an edit that leaves it out, cleared by `none`.
  if (d.checkout !== undefined) {
    if (d.workflow !== undefined) out.push(issue(`${at}.checkout`, "not_allowed", "A workflow revision keeps no checkout: only an agentic run starts in a checkout.", `Remove ${at}.checkout.`));
    else if (!(CHECKOUTS as readonly unknown[]).includes(d.checkout)) out.push(issue(`${at}.checkout`, "not_an_option", `${at}.checkout is one of ${CHECKOUTS.join(", ")}: pull_request checks out the pull request the run's GitHub event names, at its head, in repo/ before the first turn; none clears it`));
  }
  // How a run's cap prices its requests (cap.ts CapMode): kept, as the default cap is, by an edit that leaves it out.
  if (d.cap_mode !== undefined) {
    if (!(CAP_MODES as readonly unknown[]).includes(d.cap_mode)) out.push(issue(`${at}.cap_mode`, "not_an_option", `${at}.cap_mode is one of ${CAP_MODES.join(", ")}: expected prices a request's input from the previous request's cache, strict prices all of it uncached`));
  }
  return out;
}

/** The skill files a body names: an object of relative paths inside `.agents/skills/` to text. */
function skillFileIssues(skills: unknown, out: InputIssue[]): void {
  if (!isObject(skills)) return void out.push(issue("skills", "wrong_type", "skills is not an object of paths to text"));
  for (const [path, text] of Object.entries(skills)) {
    if (path.length > 512 || !SKILL_PATH.test(path)) out.push(issue(`skills.${path}`, "bad_format", `the skill path ${JSON.stringify(path)} is not a relative path inside .agents/skills/`));
    else if (typeof text !== "string") out.push(issue(`skills.${path}`, "wrong_type", `the skill ${path} is not text`));
  }
}

/** A definition's skill names against the files its revision holds: each named skill has its SKILL.md, and each
 *  SKILL.md is named. */
export function skillIssues(named: unknown, files: Iterable<string>): InputIssue[] {
  if (!Array.isArray(named)) return [];
  const held = skillNames(files);
  return [
    ...named.filter((name) => !held.includes(name)).map((name) => issue(`skills.${name}${SKILL_FILE}`, "missing", `the definition names the skill ${name}, and skills holds no ${name}${SKILL_FILE}`)),
    ...held.filter((name) => !named.includes(name)).map((name) => issue(`skills.${name}${SKILL_FILE}`, "not_allowed", `skills holds ${name}${SKILL_FILE}, a skill the definition does not name`, `Name ${name} in definition.skills, or leave it out.`)),
  ];
}

export type DefinitionBody = { definition: Json; skills?: Record<string, string>; note?: string };

/** What is wrong with `{definition, skills?, note?}`, as checkDefinitionBody refuses it: every field issue. */
export function definitionBodyIssues(body: Json, { creating = true } = {}): InputIssue[] {
  const out: InputIssue[] = [];
  for (const key of Object.keys(body)) if (!["definition", "skills", "note"].includes(key)) out.push(issue(key, "not_allowed", `The body keeps no field ${key}.`, `Remove ${key}.`));
  out.push(...definitionIssues(body.definition, { creating }));
  if (body.skills !== undefined || creating) skillFileIssues(body.skills ?? {}, out);
  if (body.note !== undefined && !(typeof body.note === "string" && body.note.length <= 2_000)) out.push(issue("note", "wrong_type", "note is text of at most 2000 characters"));
  return out;
}

/**
 * `{definition, skills?, note?}`, as `POST /agents` and `PUT .../definition` take it. `skills` are the revision's skill
 * files (absent on an edit: the current revision's); `note` says what the revision changes. Throws `422 input_invalid`
 * naming every field that is wrong.
 */
export function checkDefinitionBody(body: Json, { creating = true } = {}): DefinitionBody {
  const out = definitionBodyIssues(body, { creating });
  if (out.length) throw invalid(out);
  return { definition: body.definition as Json, ...(body.skills !== undefined || creating ? { skills: (body.skills ?? {}) as Record<string, string> } : {}), ...(typeof body.note === "string" ? { note: body.note } : {}) };
}

/** The default input schema: `{content: string}`. */
export const DEFAULT_INPUT_SCHEMA = { type: "object", required: ["content"], properties: { content: { type: "string" } } };

/** What is wrong with an agentic definition's `input_schema`: an object schema (`type: object` at its top), at most
 *  MAX_INPUT_SCHEMA_BYTES as JSON, that compiles (the compiler output_schema uses), and that names `content`, if at all,
 *  as text: content is the run's message, its follow-ups' and a trigger's line. */
export function inputSchemaIssues(schema: unknown, at = "definition.input_schema"): InputIssue[] {
  if (!isObject(schema)) return [issue(at, "wrong_type", `${at} is a JSON Schema object`)];
  if (Buffer.byteLength(JSON.stringify(schema)) > MAX_INPUT_SCHEMA_BYTES) return [issue(at, "too_long", `${at} is over ${MAX_INPUT_SCHEMA_BYTES} bytes as JSON`)];
  if (schema.type !== "object") return [issue(at, "bad_format", `${at} is an object schema: its type is "object", as a run's input is an object`)];
  const content = isObject(schema.properties) ? schema.properties.content : undefined;
  if (content !== undefined && !(isObject(content) && content.type === "string")) return [issue(`${at}.properties.content`, "bad_format", `${at}.properties.content is {type: "string"}: content is reserved for the run's message`)];
  const compiled = schemaCheck(schema);
  return "why" in compiled ? [issue(at, "bad_format", `${at} ${compiled.why}`)] : [];
}

/**
 * The input schema in force for an agentic revision whose definition has `schema` (none: DEFAULT_INPUT_SCHEMA). `content`
 * is always taken, as text: a run's message, which a follow-up and a trigger's line add to. It stays required when the
 * schema requires nothing else, as an agent with no schema requires it.
 */
export function inputSchemaOf(schema: unknown): Json {
  if (!isObject(schema)) return DEFAULT_INPUT_SCHEMA;
  const properties = isObject(schema.properties) ? schema.properties : {};
  const required = Array.isArray(schema.required) ? schema.required.filter((key): key is string => typeof key === "string") : [];
  return {
    ...schema,
    properties: { ...properties, content: properties.content ?? { type: "string" } },
    required: required.some((key) => key !== "content") ? required : [...new Set([...required, "content"])],
  };
}

/** Each JSON Schema keyword's issue reason (InputIssue.reason): a keyword not named here is `invalid`. */
const KEYWORD_REASON: Record<string, string> = {
  type: "wrong_type", enum: "not_an_option", const: "not_an_option", pattern: "bad_format", format: "bad_format",
  minLength: "too_short", maxLength: "too_long", minItems: "too_few", maxItems: "too_many", minProperties: "too_few", maxProperties: "too_many", uniqueItems: "duplicate",
};

/**
 * A run's input against the schema in force (inputSchemaOf), with the full compiler: every keyword, at every depth. Each
 * problem is an issue at its own path under `at` (`input.company`, `input.topics.1`), a required property missing at
 * its own name and a property a closed object does not take at its own, as a 422 names a field.
 */
export function inputIssues(input: Json, schema: Json, at = "input"): InputIssue[] {
  const out: InputIssue[] = [];
  const seen = new Set<string>();
  const add = (path: string, reason: string, message: string, fix?: string) => {
    if (seen.has(`${path}\n${reason}`)) return;
    seen.add(`${path}\n${reason}`);
    out.push(issue(path, reason, message, fix));
  };
  // The schema in force compiles: a save checks it (inputSchemaIssues).
  const compiled = schemaCheck(schema);
  if ("why" in compiled) throw new Error(`the input schema ${compiled.why}`);
  for (const error of compiled.validator.Errors(input)[1]) {
    const where = [at, ...error.instancePath.split("/").slice(1).map((part) => part.replace(/~1/g, "/").replace(/~0/g, "~"))].join(".");
    const params = error.params as Record<string, unknown>;
    if (error.keyword === "required") for (const key of (params.requiredProperties as string[] | undefined) ?? []) add(`${where}.${key}`, "missing", `${where}.${key} is required`);
    else if (error.keyword === "additionalProperties") for (const key of (params.additionalProperties as string[] | undefined) ?? []) add(`${where}.${key}`, "not_allowed", `${where} keeps no field ${key}`, `Remove ${where}.${key}.`);
    // A closed object's own refusal of each extra property, said once above by its name.
    else if (error.keyword === "boolean" && error.schemaPath.endsWith("/additionalProperties")) continue;
    // A required text sent empty is one left blank (a form sends it so): said as a missing one is, never as its length.
    else if (error.keyword === "minLength" && emptyRequired(input, schema, error.instancePath, error.schemaPath)) add(where, "missing", `${where} is required`);
    else add(where, KEYWORD_REASON[error.keyword] ?? "invalid", `${where} ${error.message}`);
  }
  return out;
}

/** The parts of a JSON Pointer as the compiler writes it (`/topics/0`, `#/properties/company`). */
const pointerParts = (pointer: string) => pointer.replace(/^#/, "").split("/").slice(1).map((part) => part.replace(/~1/g, "/").replace(/~0/g, "~"));
/** What `parts` name in `root`, or undefined. */
const pointed = (root: unknown, parts: string[]): unknown => parts.reduce<unknown>((x, part) => (isObject(x) || Array.isArray(x) ? (x as Json)[part] : undefined), root);

/** Whether the value at `instancePath` is "" and its object schema (`schemaPath` is `…/properties/<name>`) requires it. */
function emptyRequired(input: Json, schema: Json, instancePath: string, schemaPath: string): boolean {
  const at = pointerParts(schemaPath);
  if (pointed(input, pointerParts(instancePath)) !== "" || at.at(-2) !== "properties") return false;
  const parent = pointed(schema, at.slice(0, -2));
  return isObject(parent) && Array.isArray(parent.required) && parent.required.includes(at.at(-1));
}
