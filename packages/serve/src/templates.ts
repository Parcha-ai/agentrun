// Template packages: one folder each (templates/README.md is the format). agent.md's front matter is the whole manifest
// and its body the agent's instructions; skills/<name>/SKILL.md are Agent Skills; rules/*.md ship beside each skill's
// SKILL.md; evals/<case>/ is the plugin-eval layout (prompt.md, graders/*.md). readPackage is the one validator: the
// server reads the packages it ships with it at its start, so a broken one stops the start, and `agentrun template
// validate <dir>` runs the same. Nothing in a package runs: it is read, checked, and compiled into the bodies POST
// /v2/agents and POST /v2/triggers take (server.ts makes them through those routes' own functions).
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseDocument } from "yaml";
import { type InputIssue, invalid } from "./errors.js";
import { HARNESSES } from "./harness.js";
import { TOOL_KEY_ROWS } from "./key-words.js";
import { MCP_SERVER_NAME } from "./mcp-servers.js";
import { chooseModel, harnessRuns, hostModel, MODEL_KEYS, THINKING_LEVELS, type Tier } from "./model.js";
import { mcpToolName, type PinScalar, type PinValue } from "./tool-gate.js";
import { AGENT_LAYER_PINS, pinIssues } from "./tool-plane.js";
import { BOUND_TOOLS } from "./tools.js";
import { TRIGGER_ADAPTERS } from "./trigger-adapters.js";
import { triggerBodyIssues } from "./triggers.js";
import { DEFAULT_INPUT_SCHEMA, definitionBodyIssues, inputIssues, isObject, type Json, MODEL_REF, unknownFields } from "./validate.js";

/** The packages this server ships. */
export const TEMPLATES_DIR = fileURLToPath(new URL("../templates/", import.meta.url));
export const MANIFEST = "agent.md";

/** A package's model tier, mapped to the server's own (model.ts Tier: AGENT_MODEL_FAST, AGENT_MODEL, AGENT_MODEL_STRONG). */
export const MODEL_TIERS: Readonly<Record<string, Tier>> = { fast: "fast", balanced: "default", strong: "strong" };
export const PARAMETER_TYPES = ["string", "number", "integer", "boolean"] as const;
export const GRADER_TYPES = ["llm", "regex", "tool_used", "file_exists", "schema"] as const;
const FIELDS = ["name", "display_name", "version", "description", "license", "author", "repository", "harness", "model", "effort", "tools", "mcp", "computer", "parameters", "secrets", "budget", "learning", "triggers", "output", "checks"];
const NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const PARAMETER = /^[a-z][a-z0-9_]{0,63}$/;
/** The keys a package may need: those Settings saves (a tool's or a model provider's), each one a run is handed. */
export const PACKAGE_SECRETS: readonly string[] = [...new Set([...TOOL_KEY_ROWS.flatMap((row) => row.fields as readonly string[]), ...MODEL_KEYS.map((row) => row.field)])];
/** An MCP tool's name: one tool, never the server's wildcard `*`. */
const MCP_TOOL = /^[A-Za-z0-9_.-]{1,128}$/;
/** A package's bounds: each file, all its files together (POST /agents' own body limit), and how many it holds. */
export const MAX_FILE_BYTES = 256 << 10;
export const MAX_PACKAGE_BYTES = 1 << 20;
export const MAX_PACKAGE_FILES = 256;
/** A parameter's sample, of its type, for the check that compiles a package before any apply. */
const SAMPLES = { string: "x", number: 1, integer: 1, boolean: true } as const;
/** An agent id in the shape an apply gives a trigger's target, for that check. */
const SAMPLE_AGENT = `agt_${"0".repeat(24)}`;
// semver.org's own expression, SemVer 2.0.0.
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;
const PLACEHOLDER = /\$\{parameters\.([^}]*)\}/g;
const FRONT = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

/** An MCP server a package uses: its tools, granted to the agent, and `allow`, those of them the package asks the owner to
 *  allow (a consent screen shows it). The package sets no permission itself: an apply's `grants`, the owner's answer, do.
 *  `pin`, by tool: the arguments each of its calls must carry (a value, or `${parameters.<name>}`), which apply writes as
 *  the tool's pin in the agent's tool settings, so a send goes only to the destination the owner set. */
export type McpNeed = { server: string; tools: string[]; required: boolean; allow: string[]; pin: Record<string, Record<string, PinValue>> };
type Parameter = { type: (typeof PARAMETER_TYPES)[number]; required: boolean; description: string; pattern?: string; default?: string | number | boolean };
/** Whether `value` is of the parameter type `type`. */
const ofType = (type: Parameter["type"], value: unknown): boolean => (type === "integer" ? Number.isSafeInteger(value) : type === "number" ? typeof value === "number" && Number.isFinite(value) : typeof value === type);
/** Whether `text` matches `pattern`; a pattern that does not compile matches nothing (it is reported on its own). */
const safeTest = (pattern: string, text: string): boolean => {
  try {
    return new RegExp(pattern, "u").test(text);
  } catch {
    return false;
  }
};
/** A schedule's fields a parameter may fill: its time, read by the server as the schedule, and checked at apply. */
const SCHEDULE_FIELDS = ["cron", "timezone"];
export type Package = {
  name: string;
  /** The agent's name, placeholders unfilled; absent, the package's name. */
  displayName?: string;
  version: string;
  description: string;
  license?: string;
  author?: Json;
  repository?: string;
  /** Harness ids in the order the package prefers them; absent, any (the server's default). */
  harness?: string[];
  model?: { tier: string; prefer?: string };
  effort?: string;
  /** Absent, the tools the server gives a new agent that names none. */
  tools?: string[];
  /** MCP servers by the name a server saves them under, and the tools of each the agent is granted. One `required`
   *  refuses an apply on a server that has not saved it; any other is skipped there, with a warning. */
  mcp: McpNeed[];
  parameters: Record<string, Parameter>;
  secrets: string[];
  budget?: { per_run_usd: number };
  learning?: boolean;
  /** POST /v2/triggers bodies, placeholders unfilled, each target a start_run with no agent_id. */
  triggers: Json[];
  output?: { schema: string };
  checks: string[];
  instructions: string;
  /** Skill files by path under the agent's skills folder (`review/SKILL.md`), each rule beside each SKILL.md. */
  skills: Record<string, string>;
  evals: string[];
};

/** A package that does not check: every problem, each naming its file. */
export class PackageError extends Error {
  constructor(readonly dir: string, readonly problems: string[]) {
    super(`${dir} is not a valid package:\n${problems.map((p) => `- ${p}`).join("\n")}`);
  }
}

/** Every string in `value`, deep. */
const strings = (value: unknown): string[] => (typeof value === "string" ? [value] : Array.isArray(value) ? value.flatMap(strings) : isObject(value) ? Object.values(value).flatMap(strings) : []);

/** `value` with each `${parameters.x}` in its strings replaced by the value given for x (its own: never an inherited
 *  name such as constructor), else nothing. */
const filled = (value: unknown, given: Record<string, unknown>): unknown =>
  typeof value === "string" ? value.replace(PLACEHOLDER, (_, name: string) => String(Object.hasOwn(given, name) ? given[name] ?? "" : ""))
  : Array.isArray(value) ? value.map((item) => filled(item, given))
  : isObject(value) ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, filled(item, given)]))
  : value;

/** An mcp entry's `pin` read: by tool, each one of the entry's `tools`, its arguments checked by the one rule every pin
 *  is (tool-plane.ts pinIssues, on the tool's gate name), text in it may hold `${parameters.<name>}` (checked with the
 *  other placeholders). Each problem is told through `bad`; a tool whose pin reads is kept. */
function pinOf(pin: unknown, server: string, tools: readonly string[], at: string, bad: (message: string) => void): Record<string, Record<string, PinValue>> {
  const out: Record<string, Record<string, PinValue>> = {};
  if (!isObject(pin)) return bad(`${at} is {<tool>: {<argument>: <value or \${parameters.<name>}, or a list of them>}}, by the entry's tools`), out;
  for (const [tool, args] of Object.entries(pin)) {
    if (!tools.includes(tool)) {
      bad(`${at}.${tool}: ${tool} is not one of this entry's tools (${tools.join(", ")}): a pin fixes the arguments of a tool the package lists`);
      continue;
    }
    const issues = pinIssues(args, `${at}.${tool}`, mcpToolName(server, tool));
    for (const issue of issues) bad(issue.message);
    if (!issues.length) out[tool] = args as Record<string, PinValue>;
  }
  return out;
}

/** A pin's scalar filled from the apply's `given` parameters: text that is one placeholder alone takes the parameter's
 *  value as given (its type kept: an integer pins an integer); other text is filled as text. `empty`: the parameters its
 *  placeholders name that were given no value (absent, or ""), so the pin cannot hold what the owner meant. */
function scalarFilled(value: PinScalar, given: Record<string, unknown>): { value: PinScalar; empty: string[] } {
  if (typeof value !== "string") return { value, empty: [] };
  const named = [...value.matchAll(PLACEHOLDER)].map((match) => match[1]!);
  const empty = named.filter((name) => !Object.hasOwn(given, name) || given[name] === undefined || given[name] === null || given[name] === "");
  const whole = /^\$\{parameters\.([^}]*)\}$/.exec(value);
  if (whole && !empty.length) {
    const one = given[whole[1]!];
    if (typeof one === "string" || typeof one === "number" || typeof one === "boolean") return { value: one, empty };
  }
  return { value: filled(value, given) as string, empty };
}
/** A pin's value filled (scalarFilled), each of a one-of list's in its order. */
function pinFilled(value: PinValue, given: Record<string, unknown>): { value: PinValue; empty: string[] } {
  if (!Array.isArray(value)) return scalarFilled(value as PinScalar, given);
  const each = value.map((one) => scalarFilled(one, given));
  return { value: each.map((one) => one.value), empty: each.flatMap((one) => one.empty) };
}

/** Reads `dir` checked whole: a valid package, or PackageError with every problem found. */
export function readPackage(dir: string): Package {
  const problems: string[] = [];
  const bad = (where: string, message: string) => void problems.push(`${where}: ${message}`);
  /** The regular files under `sub`, by path from it with forward slashes; a link or any other kind of entry is a
   *  problem (a package is read from disk, and a link would carry a file from outside it into an agent). */
  const files = (sub: string): string[] =>
    readdirSync(join(dir, sub), { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1)).flatMap((entry) => {
      const path = sub ? `${sub}/${entry.name}` : entry.name;
      if (entry.isDirectory()) return files(path);
      if (!entry.isFile()) return bad(path, "is not a regular file or a folder (links are refused)"), [];
      return [path];
    });
  const kind = (path: string) => {
    const stat = lstatSync(join(dir, path), { throwIfNoEntry: false });
    return stat?.isDirectory() ? "dir" : stat?.isFile() ? "file" : stat ? "other" : undefined;
  };
  const text = (path: string) => readFileSync(join(dir, path), "utf8");
  /** A file's YAML front matter and body. */
  const front = (path: string, required = true): { data: Json; body: string } | undefined => {
    const content = text(path);
    const match = FRONT.exec(content);
    if (!match) {
      if (required) bad(path, "has no YAML front matter between --- lines");
      return required ? undefined : { data: {}, body: content };
    }
    const doc = parseDocument(match[1]!, { schema: "core", merge: false, uniqueKeys: true, strict: true });
    if (doc.errors.length) return bad(path, `its front matter is not YAML: ${doc.errors[0]!.message.split("\n")[0]}`), undefined;
    let data: unknown;
    try {
      data = doc.toJS({ maxAliasCount: 0 });
    } catch (error) {
      return bad(path, `its front matter is refused: ${(error as Error).message}`), undefined;
    }
    if (!isObject(data)) return bad(path, "its front matter is not a mapping"), undefined;
    return { data, body: content.slice(match[0].length) };
  };
  const list = (value: unknown, field: string, test: (item: string) => boolean = (item) => item !== ""): string[] => {
    if (value === undefined) return [];
    if (!Array.isArray(value) || !value.every((item) => typeof item === "string" && test(item))) return bad(MANIFEST, `${field} is a list of names`), [];
    if (new Set(value).size !== value.length) bad(MANIFEST, `${field} names one item twice`);
    return value as string[];
  };
  /** `path` is a regular file inside the package. */
  const inside = (path: unknown) => typeof path === "string" && !path.startsWith("/") && !path.split("/").some((part) => part === ".." || part === "." || part === "") && kind(path) === "file";

  const name = basename(dir);
  if (!lstatSync(dir, { throwIfNoEntry: false })?.isDirectory()) throw new PackageError(dir, ["it is not a folder: a package is one"]);
  if (kind(MANIFEST) !== "file") throw new PackageError(dir, [`${MANIFEST}: missing: a package is a folder with agent.md (its manifest in the front matter, the agent's instructions in the body)`]);
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory() && !["skills", "rules", "evals"].includes(entry.name)) bad(`${entry.name}/`, "a package's folders are skills/, rules/ and evals/");
  }
  // Bounded before anything is read: a file, the files together, and how many there are.
  const all = files("");
  const sizes = all.map((path) => [path, lstatSync(join(dir, path)).size] as const);
  const limits = [
    ...sizes.filter(([, size]) => size > MAX_FILE_BYTES).map(([path]) => `${path}: is over ${MAX_FILE_BYTES} bytes, a package file's limit`),
    ...(sizes.reduce((sum, [, size]) => sum + size, 0) > MAX_PACKAGE_BYTES ? [`the package's files are over ${MAX_PACKAGE_BYTES} bytes together, POST /v2/agents' own limit`] : []),
    ...(all.length > MAX_PACKAGE_FILES ? [`the package holds over ${MAX_PACKAGE_FILES} files`] : []),
  ];
  if (limits.length) throw new PackageError(dir, [...problems, ...limits]);
  const manifest = front(MANIFEST);
  const f = manifest?.data ?? {};
  for (const issue of unknownFields(f, FIELDS)) bad(MANIFEST, `no field ${issue.field}: the fields are ${FIELDS.join(", ")}`);
  if (f.display_name !== undefined && (typeof f.display_name !== "string" || !f.display_name.trim())) bad(MANIFEST, "display_name is the agent's name, text (it may hold ${parameters.<name>})");
  if (typeof f.name !== "string" || !NAME.test(f.name) || f.name.length > 64 || f.name !== name) bad(MANIFEST, `name is the folder's name, ${JSON.stringify(name)}: lowercase letters, digits and dashes, at most 64`);
  if (typeof f.version === "number") bad(MANIFEST, `version is ${f.version}, a number: a package's version is SemVer text ("1.2.3"), kept as package.version, never as definition.version, which is the agent's revision number`);
  else if (typeof f.version !== "string" || !SEMVER.test(f.version)) bad(MANIFEST, "version is SemVer 2 (1.2.3)");
  if (typeof f.description !== "string" || !f.description.trim() || f.description.length > 1024) bad(MANIFEST, "description is text of 1 to 1024 characters");
  if (f.license !== undefined && typeof f.license !== "string") bad(MANIFEST, "license is an SPDX id");
  if (f.author !== undefined && !(isObject(f.author) && !unknownFields(f.author, ["name", "email", "url"]).length && typeof f.author.name === "string" && Object.values(f.author).every((v) => typeof v === "string"))) bad(MANIFEST, "author is {name, email?, url?}");
  if (f.repository !== undefined && !(typeof f.repository === "string" && URL.canParse(f.repository) && /^https?:$/.test(new URL(f.repository).protocol))) bad(MANIFEST, "repository is an http(s) URL");
  const harness = f.harness === undefined ? undefined : list(f.harness, "harness", (id) => (HARNESSES as readonly string[]).includes(id));
  if (harness && !harness.length) bad(MANIFEST, `harness is a non-empty preference list of ${HARNESSES.join(", ")}; leave it out for any`);
  if (f.model !== undefined && !(isObject(f.model) && !unknownFields(f.model, ["tier", "prefer"]).length && typeof f.model.tier === "string" && Object.hasOwn(MODEL_TIERS, f.model.tier) && (f.model.prefer === undefined || (typeof f.model.prefer === "string" && MODEL_REF.test(f.model.prefer))))) bad(MANIFEST, `model is {tier: ${Object.keys(MODEL_TIERS).join(" | ")}, prefer?: "provider/model-id"}`);
  if (f.effort !== undefined && !(THINKING_LEVELS as readonly unknown[]).includes(f.effort)) bad(MANIFEST, `effort is one of ${THINKING_LEVELS.join(", ")}`);
  const tools = f.tools === undefined ? undefined : list(f.tools, "tools");
  if (tools?.some((tool) => tool.startsWith("mcp:"))) bad(MANIFEST, "tools grants no MCP tool: mcp lists them, by server");
  for (const tool of tools?.filter((tool) => !tool.startsWith("mcp:") && !BOUND_TOOLS.includes(tool)) ?? []) bad(MANIFEST, `tools: ${tool} is not a tool this server binds (${BOUND_TOOLS.join(", ")})`);
  const mcp: McpNeed[] = [];
  for (const [i, need] of (f.mcp === undefined ? [] : Array.isArray(f.mcp) ? f.mcp : (bad(MANIFEST, "mcp is a list of {server, tools, required?}"), [])).entries()) {
    const names = isObject(need) && Array.isArray(need.tools) ? need.tools : [];
    const allow = isObject(need) && need.allow !== undefined ? need.allow : [];
    const pin = isObject(need) && need.pin !== undefined ? need.pin : {};
    const ok = isObject(need) && !unknownFields(need, ["server", "tools", "required", "allow", "pin"]).length && typeof need.server === "string" && MCP_SERVER_NAME.test(need.server) && names.length > 0 && names.every((tool) => typeof tool === "string" && MCP_TOOL.test(tool)) && new Set(names).size === names.length && (need.required === undefined || typeof need.required === "boolean")
      && Array.isArray(allow) && allow.every((tool) => names.includes(tool)) && new Set(allow).size === allow.length;
    if (!ok) bad(MANIFEST, `mcp[${i}] is {server: an MCP server's name (${MCP_SERVER_NAME.source}), tools: its tool names (${MCP_TOOL.source}), none twice, required?: true or false, allow?: the tools of its tools it asks the owner to allow, pin?: {<tool>: {<argument>: <value>}}}`);
    else if (mcp.some((m) => m.server === need.server)) bad(MANIFEST, `mcp[${i}]: the server ${need.server as string} is listed twice`);
    else {
      const pinned = pinOf(pin, need.server as string, names as string[], `mcp[${i}].pin`, (message) => bad(MANIFEST, message));
      mcp.push({ server: need.server as string, tools: names as string[], required: need.required === true, allow: allow as string[], pin: pinned });
    }
  }
  // Computers by name come with the computer protocol; until then a package runs where this server puts a new agent.
  if (f.computer !== undefined && f.computer !== "default") bad(MANIFEST, "computer is default (this server's own place): no other computer is known yet");
  const parameters: Record<string, Parameter> = {};
  for (const [key, p] of Object.entries(f.parameters === undefined ? {} : isObject(f.parameters) ? f.parameters : (bad(MANIFEST, "parameters is a mapping of names"), {}))) {
    const ok = PARAMETER.test(key) && isObject(p) && !unknownFields(p, ["type", "required", "pattern", "description", "default"]).length && (PARAMETER_TYPES as readonly unknown[]).includes(p.type) && (p.required === undefined || typeof p.required === "boolean") && typeof p.description === "string" && p.description.trim() !== "" && (p.pattern === undefined || (p.type === "string" && typeof p.pattern === "string"));
    if (!ok) {
      bad(MANIFEST, `parameters.${key} is {type: ${PARAMETER_TYPES.join(" | ")}, required?, pattern? (strings), default?, description}, its name lowercase`);
      continue;
    }
    try {
      if (typeof p.pattern === "string") new RegExp(p.pattern, "u");
    } catch {
      bad(MANIFEST, `parameters.${key}.pattern is not a regular expression`);
    }
    if (p.default !== undefined) {
      if (!ofType(p.type as Parameter["type"], p.default)) bad(MANIFEST, `parameters.${key}.default is a ${p.type as string}, as the parameter is`);
      else if (typeof p.pattern === "string" && typeof p.default === "string" && !safeTest(p.pattern, p.default)) bad(MANIFEST, `parameters.${key}.default does not match its pattern`);
      if (p.required === true) bad(MANIFEST, `parameters.${key} is required and has a default: a default is for a parameter apply may leave out`);
    }
    parameters[key] = { type: p.type as Parameter["type"], required: p.required === true, description: p.description as string, ...(typeof p.pattern === "string" ? { pattern: p.pattern } : {}), ...(p.default !== undefined && ofType(p.type as Parameter["type"], p.default) ? { default: p.default as string | number | boolean } : {}) };
  }
  const secrets = list(f.secrets, "secrets", (secret) => /^[A-Z][A-Z0-9_]{0,127}$/.test(secret));
  for (const secret of secrets.filter((name) => !PACKAGE_SECRETS.includes(name))) bad(MANIFEST, `secrets names ${secret}, a key this server cannot hold: a package needs the keys Settings saves and a run is handed (${PACKAGE_SECRETS.join(", ")})`);
  if (f.budget !== undefined && !(isObject(f.budget) && !unknownFields(f.budget, ["per_run_usd"]).length && typeof f.budget.per_run_usd === "number" && Number.isFinite(f.budget.per_run_usd) && f.budget.per_run_usd > 0)) bad(MANIFEST, "budget is {per_run_usd: a number above 0}");
  if (f.learning !== undefined && typeof f.learning !== "boolean") bad(MANIFEST, "learning is true or false");
  const triggers = f.triggers === undefined ? [] : Array.isArray(f.triggers) ? (f.triggers as unknown[]) : (bad(MANIFEST, "triggers is a list of POST /v2/triggers bodies"), []);
  const triggerNames = new Set<string>();
  triggers.forEach((trigger, i) => {
    const target = isObject(trigger) ? trigger.target : undefined;
    if (!isObject(trigger) || typeof trigger.name !== "string" || !trigger.name.trim()) return bad(MANIFEST, `triggers[${i}] has no name: a trigger's name is how an upgrade tells it from the others`);
    // Compared as a trigger keeps its name, trimmed (triggers.ts): the store holds one trigger of a name per agent
    // (UNIQUE (agent_id, name)), and an apply's agent is new, so a package that passes here never meets it.
    const name = trigger.name.trim();
    if (triggerNames.has(name)) bad(MANIFEST, `triggers[${i}]: two triggers are named ${name}`);
    triggerNames.add(name);
    if (!isObject(target) || target.kind !== "start_run" || target.agent_id !== undefined) bad(MANIFEST, `triggers[${i}].target is a start_run with no agent_id: the agent is the one the package makes`);
  });
  if (triggers.length && f.budget === undefined) bad(MANIFEST, "budget is required when the package has triggers: {per_run_usd}, each run's cap");
  if (f.output !== undefined) {
    if (!isObject(f.output) || unknownFields(f.output, ["schema"]).length || !inside(f.output.schema)) bad(MANIFEST, "output is {schema: a JSON Schema file in the package}");
    else {
      try {
        if (!isObject(JSON.parse(text(f.output.schema as string)))) throw new Error();
      } catch {
        bad(f.output.schema as string, "is not a JSON object");
      }
    }
  }
  const checks = list(f.checks, "checks", (check) => NAME.test(check));
  const instructions = manifest?.body.trim() ?? "";
  if (manifest && !instructions) bad(MANIFEST, "its body is empty: the body is the agent's instructions");
  for (const value of strings([instructions, triggers, f.display_name, mcp.map((need) => need.pin)])) {
    for (const [, used] of value.matchAll(PLACEHOLDER)) if (!Object.hasOwn(parameters, used!)) bad(MANIFEST, `\${parameters.${used}} names no parameter`);
  }
  // A placeholder fills text a run reads, and a schedule's time (its cron and timezone, read as the schedule at apply);
  // a trigger's other settings are the package's own, checked here. A parameter that sets a time has a default, so the
  // schedule the package ships is checked here too.
  triggers.forEach((trigger, i) => {
    if (!isObject(trigger)) return;
    const timed = isObject(trigger.source) && trigger.source.kind === "schedule";
    const fixed = Object.entries(trigger).flatMap(([key, value]) =>
      key === "target" && isObject(value) ? Object.entries(value).filter(([k]) => k !== "input").map(([k, v]) => [`target.${k}`, v] as const)
      : key === "source" && timed && isObject(value) ? Object.entries(value).filter(([k]) => !SCHEDULE_FIELDS.includes(k)).map(([k, v]) => [`source.${k}`, v] as const)
      : [[key, value] as const]);
    for (const [at, value] of fixed) for (const [used] of strings(value).flatMap((text) => [...text.matchAll(PLACEHOLDER)])) bad(MANIFEST, `triggers[${i}].${at} holds ${used}: a placeholder goes in display_name, the instructions, a trigger's target.input, a schedule's cron and timezone, or an mcp pin's values`);
    if (!timed) return;
    for (const field of SCHEDULE_FIELDS) {
      for (const [, used] of strings((trigger.source as Json)[field]).flatMap((text) => [...text.matchAll(PLACEHOLDER)])) {
        if (Object.hasOwn(parameters, used!) && parameters[used!]!.default === undefined) bad(MANIFEST, `parameters.${used} is used in triggers[${i}].source.${field}, so it needs a default: the schedule the package ships is checked with it`);
      }
    }
  });

  // skills/<name>/SKILL.md, each named as its folder and described, as Agent Skills are; rules/*.md beside each.
  const skills: Record<string, string> = {};
  const skillDirs = kind("skills") === "dir" ? readdirSync(join(dir, "skills"), { withFileTypes: true }) : [];
  for (const entry of skillDirs) {
    if (!entry.isDirectory() || !NAME.test(entry.name)) {
      bad(`skills/${entry.name}`, "skills/ holds only skill folders, each named in lowercase letters, digits and dashes");
      continue;
    }
    const own = files(`skills/${entry.name}`).map((path) => path.slice(`skills/${entry.name}/`.length));
    if (!own.includes("SKILL.md")) {
      bad(`skills/${entry.name}`, "has no SKILL.md");
      continue;
    }
    const skill = front(`skills/${entry.name}/SKILL.md`);
    if (skill && (skill.data.name !== entry.name || typeof skill.data.description !== "string" || !skill.data.description.trim())) bad(`skills/${entry.name}/SKILL.md`, `its front matter names the skill (${entry.name}) and describes it`);
    for (const path of own) skills[`${entry.name}/${path}`] = text(`skills/${entry.name}/${path}`);
  }
  const rules = kind("rules") === "dir" ? readdirSync(join(dir, "rules"), { withFileTypes: true }) : [];
  if (rules.length && !skillDirs.length) bad("rules/", "rules ship beside each skill's SKILL.md, and the package has no skill");
  for (const entry of rules) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) {
      bad(`rules/${entry.name}`, "rules/ holds only .md files");
      continue;
    }
    for (const skill of skillDirs.filter((d) => d.isDirectory())) {
      const path = `${skill.name}/${entry.name}`;
      if (Object.hasOwn(skills, path)) bad(`rules/${entry.name}`, `skills/${path} has the same name, and a rule ships beside each SKILL.md`);
      else skills[path] = text(`rules/${entry.name}`);
    }
  }

  // evals/<case>/: prompt.md (the run's input), graders/*.md (each its type in its front matter), case.yaml and
  // fixtures/ if it has them. The layout only: no eval runs here.
  const evals: string[] = [];
  for (const entry of kind("evals") === "dir" ? readdirSync(join(dir, "evals"), { withFileTypes: true }) : []) {
    const at = `evals/${entry.name}`;
    if (!entry.isDirectory() || !NAME.test(entry.name)) {
      bad(at, "evals/ holds only case folders, each named in lowercase letters, digits and dashes");
      continue;
    }
    evals.push(entry.name);
    const own = files(at).map((path) => path.slice(at.length + 1));
    for (const path of own.filter((p) => !(p === "prompt.md" || p === "case.yaml" || /^graders\/[^/]+\.md$/.test(p) || p.startsWith("fixtures/")))) bad(`${at}/${path}`, "a case holds prompt.md, graders/*.md, case.yaml and fixtures/ only");
    if (!own.includes("prompt.md")) bad(at, "has no prompt.md");
    else if (!front(`${at}/prompt.md`, false)?.body.trim()) bad(`${at}/prompt.md`, "its body is empty: the body is the run's input");
    if (own.includes("case.yaml") && parseDocument(text(`${at}/case.yaml`), { uniqueKeys: true }).errors.length) bad(`${at}/case.yaml`, "is not YAML");
    const graders = own.filter((p) => p.startsWith("graders/"));
    if (!graders.length) bad(at, "has no graders/*.md");
    for (const path of graders) {
      const grader = front(`${at}/${path}`);
      if (!grader) continue;
      if (!(GRADER_TYPES as readonly unknown[]).includes(grader.data.type)) bad(`${at}/${path}`, `type is one of ${GRADER_TYPES.join(", ")}`);
      else if (grader.data.type === "schema" && !inside(grader.data.schema)) bad(`${at}/${path}`, "a schema grader names its schema: a JSON Schema file in the package");
    }
  }

  if (problems.length) throw new PackageError(dir, [...new Set(problems)]);
  const p: Package = {
    name, ...(typeof f.display_name === "string" ? { displayName: f.display_name } : {}), version: f.version as string, description: f.description as string,
    ...(typeof f.license === "string" ? { license: f.license } : {}), ...(isObject(f.author) ? { author: f.author } : {}), ...(typeof f.repository === "string" ? { repository: f.repository } : {}),
    ...(harness ? { harness } : {}), ...(isObject(f.model) ? { model: f.model as { tier: string; prefer?: string } } : {}), ...(typeof f.effort === "string" ? { effort: f.effort } : {}),
    ...(tools ? { tools } : {}), mcp, parameters, secrets, ...(isObject(f.budget) ? { budget: { per_run_usd: f.budget.per_run_usd as number } } : {}), ...(typeof f.learning === "boolean" ? { learning: f.learning } : {}),
    triggers: triggers as Json[], ...(isObject(f.output) ? { output: { schema: f.output.schema as string } } : {}), checks, instructions, skills, evals,
  };
  // What an apply makes, made here with each parameter's default, else a sample of its type, and checked as POST
  // /v2/agents and POST /v2/triggers check their bodies (all but the agent the trigger names, which an apply makes). A
  // trigger's times are read as of the epoch, so its form is checked here and a date that has passed is the apply's
  // refusal, never a server's start.
  const samples = Object.fromEntries(Object.entries(parameters).map(([key, spec]) => [key, spec.default ?? SAMPLES[spec.type]]));
  const made = compiled(p, samples, { ...(harness ? { harness: harness[0]! } : {}), ...(p.model?.prefer ? { model: p.model.prefer } : {}), mcp, defaultTools: [], grants: [] });
  for (const issue of definitionBodyIssues(made.agent)) bad(issue.field.startsWith("skills.") ? `skills/${issue.field.slice("skills.".length)}` : MANIFEST, `${issue.field.startsWith("skills.") ? "" : `the agent it makes: ${issue.field}: `}${issue.message}`);
  for (const issue of madeTriggerIssues(made.triggers, 0)) bad(MANIFEST, `${issue.field.replace(/^triggers\.(\d+)\./, "triggers[$1].")}: ${issue.message}`);
  if (problems.length) throw new PackageError(dir, [...new Set(problems)]);
  return p;
}

/** What is wrong with the trigger bodies an apply makes (compiled's `triggers`), as POST /v2/triggers checks a body, all
 *  but the agent each names (the one the apply makes), as of `now`, each field under `triggers.<i>`. A trigger's input is
 *  its runs' input, and a package's agent is agentic, so each input is checked against DEFAULT_INPUT_SCHEMA too. The
 *  validator runs it as of the epoch (a time's form only); an apply runs it before it makes anything. */
export function madeTriggerIssues(made: Json[], now: number): InputIssue[] {
  return made.flatMap((trigger, i) => {
    const issues = triggerBodyIssues(TRIGGER_ADAPTERS, { ...trigger, target: { ...(trigger.target as Json), agent_id: SAMPLE_AGENT } }, now);
    const input = isObject(trigger.target) ? trigger.target.input : undefined;
    if (isObject(input)) issues.push(...inputIssues(input, DEFAULT_INPUT_SCHEMA, "target.input"));
    return issues.map((issue) => ({ ...issue, field: `triggers.${i}.${issue.field}` }));
  });
}

/** Every package in `dir`: each folder in it, by name. One that does not check throws, so a broken one never serves. */
export function readPackages(dir: string = TEMPLATES_DIR): Package[] {
  return readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => readPackage(join(dir, entry.name))).sort((a, b) => a.name.localeCompare(b.name));
}

/** A package as GET /v2/templates lists it: what an apply asks for and makes. */
export function packageView(p: Package) {
  return {
    name: p.name, display_name: p.displayName ?? null, version: p.version, description: p.description, license: p.license ?? null, repository: p.repository ?? null,
    harness: p.harness ?? null, model: p.model ?? null, effort: p.effort ?? null, tools: p.tools ?? null,
    mcp: p.mcp.map(({ server, tools, required, allow, pin }) => ({ server, required, tools: tools.map((name) => ({ name, tool: mcpToolName(server, name), asks: allow.includes(name) ? "allow" : "ask", ...(Object.hasOwn(pin, name) ? { pin: pin[name]! } : {}) })) })), parameters: p.parameters, secrets: p.secrets,
    budget: p.budget ?? null, learning: p.learning ?? false, triggers: p.triggers, skills: Object.keys(p.skills).filter((path) => /^[^/]+\/SKILL\.md$/.test(path)).map((path) => path.slice(0, -"/SKILL.md".length)), evals: p.evals,
  };
}

/** POST /v2/templates/{name}/apply's body (`{parameters, grants?, overrides?: {model}}`), checked against the package:
 *  the parameters as given, the MCP tools the owner allows (each one the package lists, by its gate name), and the model
 *  asked for in place of the package's. 422 naming every field that is wrong. */
export function applyBodyOf(p: Package, body: Json): { parameters: Record<string, string | number | boolean>; grants: string[]; model?: string } {
  const issues: InputIssue[] = unknownFields(body, ["parameters", "grants", "overrides"]);
  const listed = p.mcp.flatMap(({ server, tools }) => tools.map((tool) => mcpToolName(server, tool)));
  const grants: string[] = [];
  if (body.grants !== undefined && !Array.isArray(body.grants)) issues.push({ field: "grants", reason: "wrong_type", message: "grants is a list of the package's MCP tools, by gate name (mcp:<server>/<tool>), the owner allows" });
  for (const [i, grant] of (Array.isArray(body.grants) ? body.grants : []).entries()) {
    if (typeof grant !== "string" || !listed.includes(grant)) issues.push({ field: `grants.${i}`, reason: "not_allowed", message: `grants.${i} is not a tool of the package ${p.name}: it grants ${listed.join(", ") || "no MCP tool"}.` });
    else if (!grants.includes(grant)) grants.push(grant);
  }
  const given = body.parameters ?? {};
  if (!isObject(given)) issues.push({ field: "parameters", reason: "wrong_type", message: "parameters is an object of the package's parameters, by name" });
  const parameters: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(isObject(given) ? given : {})) {
    const spec = Object.hasOwn(p.parameters, key) ? p.parameters[key] : undefined;
    const typed = spec && ofType(spec.type, value);
    if (!spec) issues.push({ field: `parameters.${key}`, reason: "not_allowed", message: `The package ${p.name} takes no parameter ${key}.` });
    else if (!typed) issues.push({ field: `parameters.${key}`, reason: "wrong_type", message: `parameters.${key} is a ${spec.type}: ${spec.description}` });
    else if (spec.pattern && !new RegExp(spec.pattern, "u").test(value as string)) issues.push({ field: `parameters.${key}`, reason: "bad_format", message: `parameters.${key} is ${spec.description}` });
    else parameters[key] = value as string | number | boolean;
  }
  for (const [key, spec] of Object.entries(p.parameters)) {
    const absent = isObject(given) && (!Object.hasOwn(given, key) || given[key] === undefined || given[key] === "");
    if (spec.required && absent) issues.push({ field: `parameters.${key}`, reason: "missing", message: `parameters.${key} is required: ${spec.description}` });
    else if (absent && spec.default !== undefined) parameters[key] = spec.default;
  }
  const overrides = body.overrides ?? {};
  if (!isObject(overrides)) issues.push({ field: "overrides", reason: "wrong_type", message: "overrides is an object: {model?}" });
  else {
    issues.push(...unknownFields(overrides, ["model"]).map((i) => ({ ...i, field: `overrides.${i.field}`, message: "An apply overrides the model alone." })));
    if (overrides.model !== undefined && !(typeof overrides.model === "string" && MODEL_REF.test(overrides.model))) issues.push({ field: "overrides.model", reason: "bad_format", message: 'overrides.model is "provider/model-id"' });
  }
  if (issues.length) throw invalid(issues);
  return { parameters, grants, ...(isObject(overrides) && typeof overrides.model === "string" ? { model: overrides.model } : {}) };
}

/** The model a package's agent gets here: its `prefer` when this server runs it on `harness` (a key for its provider, or
 *  a gateway), else the server's model for its tier (hostModel: AGENT_MODEL_FAST, AGENT_MODEL or AGENT_MODEL_STRONG,
 *  else the default of a model key it holds). Undefined when the package names none, or the server has none: the agent
 *  then runs on the server's default, as one made with no model does. */
export async function packageModel(env: NodeJS.ProcessEnv, model: Package["model"], harness: string): Promise<string | undefined> {
  if (!model) return undefined;
  if (model.prefer && harnessRuns(env, model.prefer, harness) && !("why" in (await chooseModel(env, model.prefer, "default", harness)))) return model.prefer;
  return hostModel(env, MODEL_TIERS[model.tier], harness);
}

/** The bodies an apply makes: POST /v2/agents' (its definition and skill files) and each trigger's, with no agent_id,
 *  every `${parameters.x}` filled. `mcp`: the package's MCP servers this server has saved, whose tools are granted beside
 *  the package's tools (or, when it names none, `defaultTools`, those this server gives a new agent), each at the
 *  owner's own setting; `grants`, the owner's answer at apply, alone are set to allow. A tool the package pins gets its
 *  pin, filled, in the agent's tool settings, whatever its permission; one whose pin fills empty (its parameter not
 *  given) is set to deny instead, granted or not, and named in `unpinned` (by gate name, with the parameters not given):
 *  a send with no destination set never runs. While an agent's own settings keep no pin (`pins`, AGENT_LAYER_PINS by
 *  default) a filled pin is not written: it is named in `unkept`, with its values, for the server's settings. */
export function compiled(p: Package, parameters: Json, chosen: { harness?: string; model?: string; mcp: McpNeed[]; defaultTools: readonly string[]; grants: readonly string[]; pins?: boolean }): { agent: Json; triggers: Json[]; unpinned: { tool: string; parameters: string[] }[]; unkept: { tool: string; pin: Record<string, PinValue> }[] } {
  const skills = Object.keys(p.skills).filter((path) => /^[^/]+\/SKILL\.md$/.test(path)).map((path) => path.slice(0, -"/SKILL.md".length));
  const granted = chosen.mcp.flatMap(({ server, tools }) => tools.map((tool) => mcpToolName(server, tool)));
  const allowed = chosen.grants.filter((tool) => granted.includes(tool));
  const tools = granted.length ? [...(p.tools ?? chosen.defaultTools), ...granted] : p.tools;
  const settings: Record<string, { permission?: "allow" | "deny"; pin?: Record<string, PinValue> }> = Object.fromEntries(allowed.map((tool) => [tool, { permission: "allow" as const }]));
  const unpinned: { tool: string; parameters: string[] }[] = [];
  const unkept: { tool: string; pin: Record<string, PinValue> }[] = [];
  for (const { server, pin } of chosen.mcp) {
    for (const [tool, args] of Object.entries(pin)) {
      const name = mcpToolName(server, tool);
      const each = Object.entries(args).map(([arg, value]) => [arg, pinFilled(value, parameters)] as const);
      const empty = [...new Set(each.flatMap(([, one]) => one.empty))];
      if (empty.length) {
        settings[name] = { permission: "deny" };
        unpinned.push({ tool: name, parameters: empty });
      } else {
        const filledPin = Object.fromEntries(each.map(([arg, one]) => [arg, one.value]));
        if (chosen.pins ?? AGENT_LAYER_PINS) settings[name] = { ...settings[name], pin: filledPin };
        else unkept.push({ tool: name, pin: filledPin });
      }
    }
  }
  const definition = {
    name: p.displayName ? filled(p.displayName, parameters) : p.name, description: p.description, instructions: filled(p.instructions, parameters),
    ...(chosen.harness ? { harness: chosen.harness } : {}), ...(chosen.model ? { model: chosen.model } : {}), ...(p.effort ? { thinking: p.effort } : {}),
    ...(tools ? { tools } : {}), ...(Object.keys(settings).length ? { tool_settings: settings } : {}),
    ...(p.learning !== undefined ? { learning: p.learning } : {}), ...(p.budget ? { max_cost_usd: p.budget.per_run_usd } : {}), skills,
  };
  return { agent: { definition, skills: { ...p.skills } }, triggers: p.triggers.map((trigger) => filled(trigger, parameters) as Json), unpinned, unkept };
}
