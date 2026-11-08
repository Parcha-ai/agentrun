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
import { MCP_SERVER_NAME } from "./mcp-servers.js";
import { chooseModel, harnessRuns, hostModel, THINKING_LEVELS, type Tier } from "./model.js";
import { isObject, type Json, MODEL_REF, unknownFields } from "./validate.js";

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
const SECRET = /^[A-Z][A-Z0-9_]{0,127}$/;
// semver.org's own expression, SemVer 2.0.0.
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;
const PLACEHOLDER = /\$\{parameters\.([^}]*)\}/g;
const FRONT = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

export type McpNeed = { server: string; tools: string[]; required: boolean };
type Parameter = { type: (typeof PARAMETER_TYPES)[number]; required: boolean; description: string; pattern?: string };
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
  /** MCP servers by the name a server saves them under, and the tools of each the agent is granted (and allowed). One
   *  `required` refuses an apply on a server that has not saved it; any other is skipped there, with a warning. */
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
  files("");
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
  const mcp: McpNeed[] = [];
  for (const [i, need] of (f.mcp === undefined ? [] : Array.isArray(f.mcp) ? f.mcp : (bad(MANIFEST, "mcp is a list of {server, tools, required?}"), [])).entries()) {
    const names = isObject(need) && Array.isArray(need.tools) ? need.tools : [];
    const ok = isObject(need) && !unknownFields(need, ["server", "tools", "required"]).length && typeof need.server === "string" && MCP_SERVER_NAME.test(need.server) && names.length > 0 && names.every((tool) => typeof tool === "string" && /^[^\s/]+$/.test(tool)) && new Set(names).size === names.length && (need.required === undefined || typeof need.required === "boolean");
    if (!ok) bad(MANIFEST, `mcp[${i}] is {server: an MCP server's name (${MCP_SERVER_NAME.source}), tools: its tool names, none twice, required?: true or false}`);
    else if (mcp.some((m) => m.server === need.server)) bad(MANIFEST, `mcp[${i}]: the server ${need.server as string} is listed twice`);
    else mcp.push({ server: need.server as string, tools: names as string[], required: need.required === true });
  }
  // Computers by name come with the computer protocol; until then a package runs where this server puts a new agent.
  if (f.computer !== undefined && f.computer !== "default") bad(MANIFEST, "computer is default (this server's own place): no other computer is known yet");
  const parameters: Record<string, Parameter> = {};
  for (const [key, p] of Object.entries(f.parameters === undefined ? {} : isObject(f.parameters) ? f.parameters : (bad(MANIFEST, "parameters is a mapping of names"), {}))) {
    const ok = PARAMETER.test(key) && isObject(p) && !unknownFields(p, ["type", "required", "pattern", "description"]).length && (PARAMETER_TYPES as readonly unknown[]).includes(p.type) && (p.required === undefined || typeof p.required === "boolean") && typeof p.description === "string" && p.description.trim() !== "" && (p.pattern === undefined || (p.type === "string" && typeof p.pattern === "string"));
    if (!ok) {
      bad(MANIFEST, `parameters.${key} is {type: ${PARAMETER_TYPES.join(" | ")}, required?, pattern? (strings), description}, its name lowercase`);
      continue;
    }
    try {
      if (typeof p.pattern === "string") new RegExp(p.pattern, "u");
    } catch {
      bad(MANIFEST, `parameters.${key}.pattern is not a regular expression`);
    }
    parameters[key] = { type: p.type as Parameter["type"], required: p.required === true, description: p.description as string, ...(typeof p.pattern === "string" ? { pattern: p.pattern } : {}) };
  }
  const secrets = list(f.secrets, "secrets", (secret) => SECRET.test(secret));
  if (f.budget !== undefined && !(isObject(f.budget) && !unknownFields(f.budget, ["per_run_usd"]).length && typeof f.budget.per_run_usd === "number" && Number.isFinite(f.budget.per_run_usd) && f.budget.per_run_usd > 0)) bad(MANIFEST, "budget is {per_run_usd: a number above 0}");
  if (f.learning !== undefined && typeof f.learning !== "boolean") bad(MANIFEST, "learning is true or false");
  const triggers = f.triggers === undefined ? [] : Array.isArray(f.triggers) ? (f.triggers as unknown[]) : (bad(MANIFEST, "triggers is a list of POST /v2/triggers bodies"), []);
  const triggerNames = new Set<string>();
  triggers.forEach((trigger, i) => {
    const target = isObject(trigger) ? trigger.target : undefined;
    if (!isObject(trigger) || typeof trigger.name !== "string" || !trigger.name.trim()) return bad(MANIFEST, `triggers[${i}] has no name: a trigger's name is how an upgrade tells it from the others`);
    if (triggerNames.has(trigger.name)) bad(MANIFEST, `triggers[${i}]: two triggers are named ${trigger.name}`);
    triggerNames.add(trigger.name);
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
  for (const value of strings([instructions, triggers, f.display_name])) {
    for (const [, used] of value.matchAll(PLACEHOLDER)) if (!Object.hasOwn(parameters, used!)) bad(MANIFEST, `\${parameters.${used}} names no parameter`);
  }

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
  return {
    name, ...(typeof f.display_name === "string" ? { displayName: f.display_name } : {}), version: f.version as string, description: f.description as string,
    ...(typeof f.license === "string" ? { license: f.license } : {}), ...(isObject(f.author) ? { author: f.author } : {}), ...(typeof f.repository === "string" ? { repository: f.repository } : {}),
    ...(harness ? { harness } : {}), ...(isObject(f.model) ? { model: f.model as { tier: string; prefer?: string } } : {}), ...(typeof f.effort === "string" ? { effort: f.effort } : {}),
    ...(tools ? { tools } : {}), mcp, parameters, secrets, ...(isObject(f.budget) ? { budget: { per_run_usd: f.budget.per_run_usd as number } } : {}), ...(typeof f.learning === "boolean" ? { learning: f.learning } : {}),
    triggers: triggers as Json[], ...(isObject(f.output) ? { output: { schema: f.output.schema as string } } : {}), checks, instructions, skills, evals,
  };
}

/** Every package in `dir`: each folder in it, by name. One that does not check throws, so a broken one never serves. */
export function readPackages(dir: string = TEMPLATES_DIR): Package[] {
  return readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => readPackage(join(dir, entry.name))).sort((a, b) => a.name.localeCompare(b.name));
}

/** A package as GET /v2/templates lists it: what an apply asks for and makes. */
export function packageView(p: Package) {
  return {
    name: p.name, display_name: p.displayName ?? null, version: p.version, description: p.description, license: p.license ?? null, repository: p.repository ?? null,
    harness: p.harness ?? null, model: p.model ?? null, effort: p.effort ?? null, tools: p.tools ?? null, mcp: p.mcp, parameters: p.parameters, secrets: p.secrets,
    budget: p.budget ?? null, learning: p.learning ?? false, triggers: p.triggers, skills: Object.keys(p.skills).filter((path) => /^[^/]+\/SKILL\.md$/.test(path)).map((path) => path.slice(0, -"/SKILL.md".length)), evals: p.evals,
  };
}

/** POST /v2/templates/{name}/apply's body (`{parameters, overrides?: {model}}`), checked against the package: the
 *  parameters as given, and the model asked for in place of the package's. 422 naming every field that is wrong. */
export function applyBodyOf(p: Package, body: Json): { parameters: Record<string, string | number | boolean>; model?: string } {
  const issues: InputIssue[] = unknownFields(body, ["parameters", "overrides"]);
  const given = body.parameters ?? {};
  if (!isObject(given)) issues.push({ field: "parameters", reason: "wrong_type", message: "parameters is an object of the package's parameters, by name" });
  const parameters: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(isObject(given) ? given : {})) {
    const spec = Object.hasOwn(p.parameters, key) ? p.parameters[key] : undefined;
    const typed = spec && (spec.type === "integer" ? Number.isSafeInteger(value) : spec.type === "number" ? typeof value === "number" && Number.isFinite(value) : typeof value === spec.type);
    if (!spec) issues.push({ field: `parameters.${key}`, reason: "not_allowed", message: `The package ${p.name} takes no parameter ${key}.` });
    else if (!typed) issues.push({ field: `parameters.${key}`, reason: "wrong_type", message: `parameters.${key} is a ${spec.type}: ${spec.description}` });
    else if (spec.pattern && !new RegExp(spec.pattern, "u").test(value as string)) issues.push({ field: `parameters.${key}`, reason: "bad_format", message: `parameters.${key} is ${spec.description}` });
    else parameters[key] = value as string | number | boolean;
  }
  for (const [key, spec] of Object.entries(p.parameters)) {
    if (spec.required && isObject(given) && (!Object.hasOwn(given, key) || given[key] === undefined || given[key] === "")) issues.push({ field: `parameters.${key}`, reason: "missing", message: `parameters.${key} is required: ${spec.description}` });
  }
  const overrides = body.overrides ?? {};
  if (!isObject(overrides)) issues.push({ field: "overrides", reason: "wrong_type", message: "overrides is an object: {model?}" });
  else {
    issues.push(...unknownFields(overrides, ["model"]).map((i) => ({ ...i, field: `overrides.${i.field}`, message: "An apply overrides the model alone." })));
    if (overrides.model !== undefined && !(typeof overrides.model === "string" && MODEL_REF.test(overrides.model))) issues.push({ field: "overrides.model", reason: "bad_format", message: 'overrides.model is "provider/model-id"' });
  }
  if (issues.length) throw invalid(issues);
  return { parameters, ...(isObject(overrides) && typeof overrides.model === "string" ? { model: overrides.model } : {}) };
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
 *  every `${parameters.x}` filled. `mcp`: the package's MCP servers this server has saved, whose tools are granted and
 *  set to allow (a triggered run never waits on an ask); beside the package's tools, or, when it names none,
 *  `defaultTools`, those this server gives a new agent. */
export function compiled(p: Package, parameters: Json, chosen: { harness?: string; model?: string; mcp: McpNeed[]; defaultTools: readonly string[] }): { agent: Json; triggers: Json[] } {
  const skills = Object.keys(p.skills).filter((path) => /^[^/]+\/SKILL\.md$/.test(path)).map((path) => path.slice(0, -"/SKILL.md".length));
  const granted = chosen.mcp.flatMap(({ server, tools }) => tools.map((tool) => `mcp:${server}/${tool}`));
  const tools = granted.length ? [...(p.tools ?? chosen.defaultTools), ...granted] : p.tools;
  const definition = {
    name: p.displayName ? filled(p.displayName, parameters) : p.name, description: p.description, instructions: filled(p.instructions, parameters),
    ...(chosen.harness ? { harness: chosen.harness } : {}), ...(chosen.model ? { model: chosen.model } : {}), ...(p.effort ? { thinking: p.effort } : {}),
    ...(tools ? { tools } : {}), ...(granted.length ? { tool_settings: Object.fromEntries(granted.map((tool) => [tool, { permission: "allow" }])) } : {}),
    ...(p.learning !== undefined ? { learning: p.learning } : {}), ...(p.budget ? { max_cost_usd: p.budget.per_run_usd } : {}), skills,
  };
  return { agent: { definition, skills: { ...p.skills } }, triggers: p.triggers.map((trigger) => filled(trigger, parameters) as Json) };
}
