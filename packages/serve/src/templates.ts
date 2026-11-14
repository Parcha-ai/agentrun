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
import type { GitHubConnectionView } from "./github-connection.js";
import { HARNESSES } from "./harness.js";
import { TOOL_KEY_ROWS } from "./key-words.js";
import { chooseModel, harnessRuns, hostModel, MODEL_KEYS, THINKING_LEVELS, type Tier } from "./model.js";
import type { PinScalar, PinValue } from "./tool-gate.js";
import { isMcpName, isMonidName, MCP_SERVER_NAME, MCP_TOOL_NAME, mcpToolName, MONID_NAME_WORDS, parseToolName } from "./tool-names.js";
import { pinIssues, sortedPin } from "./tool-plane.js";
import { BASH_POLICIES, type BashPolicy } from "./bash-read-only.js";
import { BOUND_TOOLS, toolOf } from "./tools.js";
import { TRIGGER_ADAPTERS } from "./trigger-adapters.js";
import { triggerBodyIssues } from "./triggers.js";
import { definitionBodyIssues, inputIssues, inputSchemaOf, isObject, type Json, MAX_TOOL_CALLS, MODEL_REF, MODEL_TIER_NAMES, unknownFields } from "./validate.js";
import { schemaCheck } from "./answer-json.js";
import { APPROVALS, type Approvals } from "./approvals.js";

/** The packages this server ships. */
/** What applying a template reads of the server beyond its package (server.ts wires it): the GitHub connection, the
 *  App's id, slug and installations (github-connection.ts), never a secret; undefined when GitHub is not connected. */
export type TemplatesDeps = { githubConnection: () => GitHubConnectionView | undefined };

export const TEMPLATES_DIR = fileURLToPath(new URL("../templates/", import.meta.url));
export const MANIFEST = "agent.md";

/** A package's model tier, mapped to the server's own (model.ts Tier: AGENT_MODEL_FAST, AGENT_MODEL, AGENT_MODEL_STRONG). */
export const MODEL_TIERS: Readonly<Record<string, Tier>> = { fast: "fast", balanced: "default", strong: "strong" };
export const PARAMETER_TYPES = ["string", "number", "integer", "boolean"] as const;
/** What a string parameter's value is, for a form to ask for it as such: a schedule's cron line, or an IANA time zone
 *  (market-monitor's schedule). A form shows a schedule picker and a time-zone choice; the value is the same text. */
export const PARAMETER_FORMATS = ["cron", "timezone"] as const;
export const GRADER_TYPES = ["llm", "regex", "tool_used", "file_exists", "schema"] as const;
/** The entries of a package's `computer` preference list: `shell`, a computer that gives the agent a shell here (bash);
 *  `none`, no shell, the file tools alone. Apply takes the first this server meets now (pickComputer). */
export const COMPUTER_ENTRIES = ["shell", "none"] as const;
export type ComputerEntry = (typeof COMPUTER_ENTRIES)[number];
const FIELDS = ["name", "display_name", "version", "description", "license", "author", "repository", "harness", "model", "effort", "tools", "mcp", "tool_policy", "computer", "checkout", "parameters", "inputs", "secrets", "budget", "learning", "approvals", "triggers", "output", "checks"];
/** A run input's types (`inputs`): a parameter's, and a list of one of them. */
export const INPUT_TYPES = [...PARAMETER_TYPES, "array"] as const;
/** What a string input's value is: a form asks for it as such, and the server checks the JSON Schema formats it knows
 *  (cron and timezone, as a parameter's, are for the form alone). */
export const INPUT_FORMATS = ["uri", "email", "hostname", "date", "date-time", "uuid", ...PARAMETER_FORMATS] as const;
/** An input's keys: a parameter's, and what a run form and a JSON Schema say beside them. */
const INPUT_KEYS = ["type", "required", "pattern", "enum", "format", "default", "description", "title", "examples", "minimum", "maximum", "minLength", "maxLength", "items"];
/** A list input's `items`: a scalar's keys alone. */
const ITEM_KEYS = ["type", "pattern", "enum", "format", "minimum", "maximum", "minLength", "maxLength"];
const NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const PARAMETER = /^[a-z][a-z0-9_]{0,63}$/;
/** The keys a package may need: those Settings saves (a tool's or a model provider's), each one a run is handed. */
export const PACKAGE_SECRETS: readonly string[] = [...new Set([...TOOL_KEY_ROWS.flatMap((row) => row.fields as readonly string[]), ...MODEL_KEYS.map((row) => row.field)])];
/** A package's bounds: each file, all its files together (POST /agents' own body limit), and how many it holds. */
export const MAX_FILE_BYTES = 256 << 10;
export const MAX_PACKAGE_BYTES = 1 << 20;
export const MAX_PACKAGE_FILES = 256;
/** A file of a package's evals/ (a case's fake MCP server fixture, say), which no agent is given: its own bound, apart
 *  from the agent's files' limits above. The answer's schema is given to the agent, so under evals/ too it keeps those. */
export const MAX_EVAL_FILE_BYTES = 32 << 20;
/** A parameter's sample, of its type, for the check that compiles a package before any apply. */
const SAMPLES = { string: "x", number: 1, integer: 1, boolean: true } as const;
/** A string of each format a parameter (or a list parameter's items) may say, for that check. */
const FORMAT_SAMPLES: Record<string, string> = { uri: "https://example.com", email: "someone@example.com", hostname: "example.com", date: "2026-01-01", "date-time": "2026-01-01T00:00:00Z", uuid: "00000000-0000-4000-8000-000000000000", cron: "0 9 * * *", timezone: "UTC" };
/** A scalar's sample: its first choice, else one of its format, else one of its type. */
const sampleOf = (spec: { type?: unknown; enum?: unknown; format?: unknown }): unknown => (Array.isArray(spec.enum) ? spec.enum[0] : FORMAT_SAMPLES[spec.format as string] ?? SAMPLES[spec.type as ScalarType]);
/** An agent id in the shape an apply gives a trigger's target, for that check. */
const SAMPLE_AGENT = `agt_${"0".repeat(24)}`;
// semver.org's own expression, SemVer 2.0.0.
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;
const PLACEHOLDER = /\$\{parameters\.([^}]*)\}/g;
/** Text that is one placeholder alone: it takes the parameter's value with its type (a pin's, a trigger's input's). */
const WHOLE = /^\$\{parameters\.([^}]*)\}$/;
const FRONT = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

/** An MCP server a package uses: its tools, granted to the agent, and `allow`, those of them the package asks the owner to
 *  allow (a consent screen shows it). The package sets no permission itself: an apply's `grants`, the owner's answer, do.
 *  `pin`, by tool: the arguments each of its calls must carry (a value, or `${parameters.<name>}`), which apply writes as
 *  the tool's pin in the agent's tool settings, so a send goes only to the destination the owner set. */
export type McpNeed = { server: string; tools: string[]; required: boolean; allow: string[]; pin: Record<string, Record<string, PinValue>> };
type Scalar = string | number | boolean;
type ScalarType = (typeof PARAMETER_TYPES)[number];
/** A parameter: a scalar, or (`type: array`) a list of one, its `items` that scalar's JSON Schema (an input's vocabulary). */
type Parameter = { type: (typeof INPUT_TYPES)[number]; items?: Json; required: boolean; description: string; pattern?: string; enum?: Scalar[]; format?: (typeof PARAMETER_FORMATS)[number]; default?: Scalar | Scalar[] };
/** Whether `value` is of the scalar type `type`. */
const ofType = (type: ScalarType, value: unknown): boolean => (type === "integer" ? Number.isSafeInteger(value) : type === "number" ? typeof value === "number" && Number.isFinite(value) : typeof value === type);
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
/** Where an imported package came from (POST /v2/templates/import): its source as given, ref and all (the ref an upgrade
 *  reads again), the full commit SHA that ref was at when it was read, which is what was imported, and the GitHub account
 *  that publishes it. */
export type PackageOrigin = { source: string; sha: string; publisher: string };
export type Package = {
  /** Its identity here, the one apply and delete take: a bundled package's name (`kyb`); an imported one's source without
   *  its ref (`github:<owner>/<repo>[/<path>]`), so the bundled kyb and an imported kyb are two packages. */
  id: string;
  /** Null for a package this server ships. */
  origin: PackageOrigin | null;
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
  /** The agent's tier and the model it prefers on it; `fast` and `strong`, the model it prefers for each of those tiers
   *  when a subagent runs on it (runner/subagent.ts), compiled into the definition's model_tiers (packageTiers). */
  model?: { tier: string; prefer?: string; fast?: string; strong?: string };
  effort?: string;
  /** Absent, the tools the server gives a new agent that names none. */
  tools?: string[];
  /** MCP servers by the name a server saves them under, and the tools of each the agent is granted. One `required`
   *  refuses an apply on a server that has not saved it; any other is skipped there, with a warning. */
  mcp: McpNeed[];
  /** The computers it prefers, in order (`[shell, none]`): apply takes the first this server meets now (pickComputer)
   *  and writes it as the agent's computer. Absent (or `default` in the manifest): where this server puts a new agent. */
  computer?: ComputerEntry[];
  /** A policy by tool (bash only: `read-only`, bash-read-only.ts), which apply writes as the tool's `policy` in the
   *  agent's tool settings, so the gate holds its runs to it whatever the tool's permission. */
  toolPolicy?: { bash: BashPolicy };
  /** What the server checks out in each run's folder before its first turn (the definition's `checkout`,
   *  runner/pr-checkout.ts): the pull request the run's GitHub event names. */
  checkout?: "pull_request";
  parameters: Record<string, Parameter>;
  /** Each run's typed input (manifest `inputs`), compiled: the agent's input_schema. Absent, a run takes {content}. */
  inputSchema?: Json;
  secrets: string[];
  /** Each run's limits: its spend cap (the agent's max_cost_usd) and the tool calls each of its conversations may make
   *  (the agent's max_tool_calls, tool-budget.ts). */
  budget?: { per_run_usd?: number; tool_calls?: number };
  learning?: boolean;
  /** Whether the agent asks its person before a tool runs (`ask`) or runs unattended (`never`): the package's default,
   *  shown to the owner at apply. A template whose job runs on triggers says never. Deny and pins hold either way. */
  approvals?: "ask" | "never";
  /** POST /v2/triggers bodies, placeholders unfilled, each target a start_run with no agent_id. */
  triggers: Json[];
  output?: { schema: string };
  /** The output schema's JSON, parsed (GET /v2/templates shows it). */
  outputSchema?: Json;
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

/** The source kinds whose accept rules a parameter may fill: a github trigger's, and a webhook trigger's (a provider that
 *  sends every trigger of a project to one URL, as Composio does, is filtered to the owner's own repository by them). */
const FILTERED_KINDS = ["github", "webhook"];

/** A github or webhook source split at its where conditions' `in` values, the one place a parameter may fill it: `ins`, each
 *  condition's list, and `rest`, the source without them. */
function whereIns(source: Json): { ins: unknown[]; rest: Json } {
  const ins: unknown[] = [];
  const accept = Array.isArray(source.accept)
    ? source.accept.map((rule) => (isObject(rule) && Array.isArray(rule.where)
      ? { ...rule, where: rule.where.map((condition) => (isObject(condition) && Object.hasOwn(condition, "in") ? (ins.push(condition.in), Object.fromEntries(Object.entries(condition).filter(([key]) => key !== "in"))) : condition)) }
      : rule))
    : source.accept;
  return { ins, rest: { ...source, accept } };
}

/** What a github trigger an apply made runs on, in words, for the apply's answer: "Code review runs on each pull request
 *  to acme/widgets." The package's name says what runs; the events are its accept's, the repositories its where
 *  conditions on /repository/full_name, when every rule names some. */
export function githubTriggerWords(packageName: string, source: Json): string {
  const subject = `${packageName.charAt(0).toUpperCase()}${packageName.slice(1).replace(/-/g, " ")}`;
  const rules = Array.isArray(source.accept) ? source.accept.filter(isObject) : [];
  const events = [...new Set(rules.map((rule) => GITHUB_EVENT_WORDS[String(rule.event)] ?? String(rule.event).replace(/_/g, " ")))];
  const reposOf = (rule: Json) => (Array.isArray(rule.where) ? rule.where : []).flatMap((c) => (isObject(c) && c.pointer === "/repository/full_name" && Array.isArray(c.in) ? c.in.filter((v): v is string => typeof v === "string") : []));
  const repos = rules.every((rule) => reposOf(rule).length) ? [...new Set(rules.flatMap(reposOf))] : [];
  const or = (words: string[]) => (words.length < 2 ? words.join("") : `${words.slice(0, -1).join(", ")} or ${words.at(-1)}`);
  return `${subject} runs on each ${or(events)} ${repos.length ? `to ${or(repos)}` : "to a repository the GitHub App is installed on"}.`;
}
const GITHUB_EVENT_WORDS: Record<string, string> = { pull_request: "pull request", pull_request_review: "pull request review", pull_request_review_comment: "review comment", issue_comment: "comment", issues: "issue", release: "release" };

/** What an apply says of a github trigger it skipped because GitHub is not connected here: what to do, and what the
 *  trigger would then run on, in the package's own words ("Code review runs on each pull request to acme/widgets."). */
export const githubTriggerUnconnected = (packageName: string, source: Json): string =>
  `Connect GitHub in Settings, then apply again so it runs by itself: ${githubTriggerWords(packageName, source)}`;

/** Every string in `value`, deep. */
const strings = (value: unknown): string[] => (typeof value === "string" ? [value] : Array.isArray(value) ? value.flatMap(strings) : isObject(value) ? Object.values(value).flatMap(strings) : []);

/** The value given for the parameter `name` (its own: never an inherited name such as constructor), else undefined. */
const givenOf = (given: Record<string, unknown>, name: string): unknown => (Object.hasOwn(given, name) ? given[name] ?? undefined : undefined);
/** Whether a pin's parameter was given no value it can pin: none, "", or an empty list. */
const unset = (value: unknown): boolean => value === undefined || value === "" || (Array.isArray(value) && !value.length);
/** A parameter's value as text: a list's items joined by ", " (an empty one, ""), nothing as "". */
const asText = (value: unknown): string => (value === undefined ? "" : Array.isArray(value) ? value.map(asText).join(", ") : String(value));

/** `value` with each `${parameters.x}` in its strings replaced by the value given for x as text (asText). */
const filled = (value: unknown, given: Record<string, unknown>): unknown =>
  typeof value === "string" ? value.replace(PLACEHOLDER, (_, name: string) => asText(givenOf(given, name)))
  : Array.isArray(value) ? value.map((item) => filled(item, given))
  : isObject(value) ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, filled(item, given)]))
  : value;

/** A trigger's target.input filled: a value that is one placeholder alone takes the parameter's value with its type (a
 *  list stays a list, an integer an integer), and is dropped when the parameter was given none, so the input schema sees
 *  the field absent; other text is filled as text. */
const inputFilled = (value: unknown, given: Record<string, unknown>): unknown => {
  if (typeof value === "string") {
    const whole = WHOLE.exec(value);
    return whole ? givenOf(given, whole[1]!) : filled(value, given);
  }
  if (Array.isArray(value)) return value.map((item) => inputFilled(item, given)).filter((item) => item !== undefined);
  if (isObject(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, inputFilled(item, given)]).filter(([, item]) => item !== undefined));
  return value;
};

/** A trigger filled from the apply's parameters: its target.input typed (inputFilled), the rest as text. */
const triggerFilled = (trigger: Json, given: Record<string, unknown>): Json => {
  const out = filled(trigger, given) as Json;
  if (isObject(trigger.target) && trigger.target.input !== undefined) out.target = { ...(out.target as Json), input: inputFilled(trigger.target.input, given) };
  return out;
};

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
  const empty = named.filter((name) => unset(givenOf(given, name)));
  const whole = WHOLE.exec(value);
  if (whole && !empty.length) {
    const one = given[whole[1]!];
    if (typeof one === "string" || typeof one === "number" || typeof one === "boolean") return { value: one, empty };
  }
  return { value: filled(value, given) as string, empty };
}
/** A pin's value filled (scalarFilled), each of a one-of list's in its order. One placeholder alone of a list parameter
 *  pins the list as a one-of: any of the values the owner gave. */
function pinFilled(value: PinValue, given: Record<string, unknown>): { value: PinValue; empty: string[] } {
  const whole = typeof value === "string" ? WHOLE.exec(value) : null;
  const list = whole ? givenOf(given, whole[1]!) : undefined;
  if (Array.isArray(list) && list.length) return { value: list as PinValue, empty: [] };
  if (!Array.isArray(value)) return scalarFilled(value as PinScalar, given);
  const each = value.map((one) => scalarFilled(one, given));
  return { value: each.map((one) => one.value), empty: each.flatMap((one) => one.empty) };
}

/** One entry of a package's folder, as readdirSync's withFileTypes gives it. */
export type PackageEntry = { name: string; isDirectory(): boolean; isFile(): boolean };
/** Where readPackage reads a package's files from: a folder on disk (the packages a server ships, `agentrun template
 *  validate`), or files held in memory (a package imported from GitHub, template-source.ts), which never touch the disk.
 *  Paths are from the package's folder, with forward slashes; "" is the folder itself. */
export type PackageFiles = {
  /** The package's name: its folder's. */
  readonly name: string;
  /** Where it is, as a refusal names it. */
  readonly where: string;
  /** The entries of the folder at `sub`. */
  entries(sub: string): PackageEntry[];
  kind(path: string): "dir" | "file" | "other" | undefined;
  size(path: string): number;
  text(path: string): string;
};

/** A package's folder on disk: each entry as lstat sees it, so a link is an entry of its own kind, never followed. */
export function folderFiles(dir: string): PackageFiles {
  return {
    name: basename(dir),
    where: dir,
    entries: (sub) => readdirSync(join(dir, sub), { withFileTypes: true }),
    kind: (path) => {
      const stat = lstatSync(join(dir, path), { throwIfNoEntry: false });
      return stat?.isDirectory() ? "dir" : stat?.isFile() ? "file" : stat ? "other" : undefined;
    },
    size: (path) => lstatSync(join(dir, path)).size,
    text: (path) => readFileSync(join(dir, path), "utf8"),
  };
}

/** A package held in memory, by path (template-source.ts keeps regular files alone): its folders are those its files'
 *  paths name. */
export function memoryFiles(name: string, where: string, files: ReadonlyMap<string, Buffer>): PackageFiles {
  const kind = (path: string) => (files.has(path) ? "file" as const : path === "" || [...files.keys()].some((one) => one.startsWith(`${path}/`)) ? "dir" as const : undefined);
  return {
    name,
    where,
    entries: (sub) => {
      const prefix = sub ? `${sub}/` : "";
      const names = new Set([...files.keys()].filter((path) => path.startsWith(prefix)).map((path) => path.slice(prefix.length).split("/")[0]!));
      return [...names].map((one) => {
        const at = `${prefix}${one}`;
        return { name: one, isDirectory: () => kind(at) === "dir", isFile: () => kind(at) === "file" };
      });
    },
    kind,
    size: (path) => files.get(path)?.length ?? 0,
    text: (path) => files.get(path)?.toString("utf8") ?? "",
  };
}

/** A scalar input's (or a list's item's) JSON Schema from its manifest keys, each checked by `bad` (said at `at`):
 *  pattern, format and lengths for a string, bounds for a number, an enum of distinct values of its type. */
function scalarSchema(type: (typeof PARAMETER_TYPES)[number], f: Json, at: string, bad: (message: string) => void): Json {
  const out: Json = { type };
  const text = type === "string";
  const numeric = type === "number" || type === "integer";
  if (f.pattern !== undefined) {
    if (!text || typeof f.pattern !== "string") bad(`${at}.pattern is a regular expression, on a string`);
    else {
      try {
        new RegExp(f.pattern, "u");
        out.pattern = f.pattern;
      } catch {
        bad(`${at}.pattern is not a regular expression`);
      }
    }
  }
  if (f.format !== undefined) {
    if (!text || !(INPUT_FORMATS as readonly unknown[]).includes(f.format)) bad(`${at}.format is one of ${INPUT_FORMATS.join(", ")}, on a string`);
    else out.format = f.format;
  }
  for (const key of ["minLength", "maxLength"]) {
    if (f[key] === undefined) continue;
    if (!text || !(Number.isSafeInteger(f[key]) && (f[key] as number) >= 0)) bad(`${at}.${key} is a whole number of 0 or more, on a string`);
    else out[key] = f[key];
  }
  for (const key of ["minimum", "maximum"]) {
    if (f[key] === undefined) continue;
    if (!numeric || !(typeof f[key] === "number" && Number.isFinite(f[key]))) bad(`${at}.${key} is a number, on a number or an integer`);
    else out[key] = f[key];
  }
  if (f.enum !== undefined) {
    if (Array.isArray(f.enum) && f.enum.length > 0 && f.enum.every((one) => ofType(type, one)) && new Set(f.enum).size === f.enum.length) out.enum = f.enum;
    else bad(`${at}.enum is a list of one or more distinct ${type} values`);
  }
  return out;
}

/**
 * A package's `inputs`, each run's typed input, compiled to the agent's input_schema: a closed object schema of each
 * input by its machine name, required unless it says `required: false`. The vocabulary is a parameter's (type, required,
 * pattern, enum, format, default, description) plus title, examples, minimum/maximum, minLength/maxLength, and `type:
 * array` of a scalar (`items`); nothing else. A default and each example meet their own input. `content` is the run's
 * message: named, it is a string. Undefined when the package names none.
 */
function inputsSchema(value: unknown, bad: (message: string) => void): Json | undefined {
  if (value === undefined) return undefined;
  if (!isObject(value) || !Object.keys(value).length) return bad("inputs is a mapping of each run input, by its name"), undefined;
  const properties: Record<string, Json> = {};
  const required: string[] = [];
  for (const [key, f] of Object.entries(value)) {
    const at = `inputs.${key}`;
    if (!PARAMETER.test(key)) {
      bad(`${at}: an input's name is lowercase letters, digits and _, starting with a letter, at most 64`);
      continue;
    }
    if (!isObject(f) || !(INPUT_TYPES as readonly unknown[]).includes(f.type)) {
      bad(`${at} is {type: ${INPUT_TYPES.join(" | ")}, required?, title?, description?, examples?, default?, enum?, pattern?, format?, minimum?, maximum?, minLength?, maxLength?, items? (an array's scalar)}`);
      continue;
    }
    for (const issue of unknownFields(f, INPUT_KEYS)) bad(`${at} has no field ${issue.field}: an input's fields are ${INPUT_KEYS.join(", ")}`);
    if (key === "content" && f.type !== "string") bad(`${at} is a string: content is the run's message`);
    if (f.required !== undefined && typeof f.required !== "boolean") bad(`${at}.required is true or false`);
    for (const word of ["title", "description"]) if (f[word] !== undefined && !(typeof f[word] === "string" && (f[word] as string).trim())) bad(`${at}.${word} is text`);
    let schema: Json;
    if (f.type === "array") {
      const items = f.items;
      for (const word of ["pattern", "format", "enum", "minimum", "maximum", "minLength", "maxLength"]) if (f[word] !== undefined) bad(`${at}.${word} goes on its items: a list's keys are type, items and the words`);
      if (!isObject(items) || !(PARAMETER_TYPES as readonly unknown[]).includes(items.type) || unknownFields(items, ITEM_KEYS).length) {
        bad(`${at}.items is {type: ${PARAMETER_TYPES.join(" | ")}} and that scalar's keys: a list input is a list of a scalar`);
        continue;
      }
      schema = { type: "array", items: scalarSchema(items.type as (typeof PARAMETER_TYPES)[number], items, `${at}.items`, bad) };
    } else {
      if (f.items !== undefined) bad(`${at}.items is for type: array`);
      schema = scalarSchema(f.type as (typeof PARAMETER_TYPES)[number], f, at, bad);
    }
    if (typeof f.title === "string") schema.title = f.title;
    if (typeof f.description === "string") schema.description = f.description;
    // A default and each example meet the input they are of, as the server checks a run's value of it.
    const compiled = schemaCheck(schema);
    const meets = (one: unknown) => !("why" in compiled) && !compiled.check(one).length;
    if (f.examples !== undefined) {
      if (Array.isArray(f.examples) && f.examples.length && f.examples.every(meets)) schema.examples = f.examples;
      else bad(`${at}.examples is a list of one or more values the input takes`);
    }
    if (f.default !== undefined) {
      if (f.required !== false) bad(`${at} is required and has a default: a default is for an input a run may leave out (required: false)`);
      else if (!meets(f.default)) bad(`${at}.default is not a value the input takes`);
      else schema.default = f.default;
    }
    properties[key] = schema;
    if (f.required !== false) required.push(key);
  }
  return { type: "object", additionalProperties: false, ...(required.length ? { required } : {}), properties };
}

/** Reads the package at `from` (its folder, or its files: PackageFiles) checked whole: a valid package, or PackageError
 *  with every problem found. */
export function readPackage(from: string | PackageFiles): Package {
  const src = typeof from === "string" ? folderFiles(from) : from;
  const dir = src.where;
  const problems: string[] = [];
  const bad = (where: string, message: string) => void problems.push(`${where}: ${message}`);
  /** The regular files under `sub`, by path from it with forward slashes; a link or any other kind of entry is a
   *  problem (a package is read from disk, and a link would carry a file from outside it into an agent). */
  const files = (sub: string): string[] =>
    src.entries(sub).sort((a, b) => (a.name < b.name ? -1 : 1)).flatMap((entry) => {
      const path = sub ? `${sub}/${entry.name}` : entry.name;
      if (entry.isDirectory()) return files(path);
      if (!entry.isFile()) return bad(path, "is not a regular file or a folder (links are refused)"), [];
      return [path];
    });
  const kind = (path: string) => src.kind(path);
  const text = (path: string) => src.text(path);
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

  const name = src.name;
  if (src.kind("") !== "dir") throw new PackageError(dir, ["it is not a folder: a package is one"]);
  if (kind(MANIFEST) !== "file") throw new PackageError(dir, [`${MANIFEST}: missing: a package is a folder with agent.md (its manifest in the front matter, the agent's instructions in the body)`]);
  for (const entry of src.entries("")) {
    if (entry.isDirectory() && !["skills", "rules", "evals"].includes(entry.name)) bad(`${entry.name}/`, "a package's folders are skills/, rules/ and evals/");
  }
  // Bounded before anything is read: a file, the files together, and how many there are.
  // The agent's files' bytes (evals/ is the package's own test data, never part of an agent) under POST /v2/agents'
  // limits, an eval's file under MAX_EVAL_FILE_BYTES alone; every file, evals/ too, counts toward MAX_PACKAGE_FILES. A
  // file under evals/ an agent is given all the same (the answer's schema, which becomes its output_schema and is in its
  // instructions) keeps the agent's limits: checked once the manifest names it, before it is read.
  const listed = files("");
  const all = listed.filter((path) => !path.startsWith("evals/"));
  const sizes = all.map((path) => [path, src.size(path)] as const);
  const agentBytes = sizes.reduce((sum, [, size]) => sum + size, 0);
  const limits = [
    ...listed.filter((path) => path.startsWith("evals/") && src.size(path) > MAX_EVAL_FILE_BYTES).map((path) => `${path}: is over ${MAX_EVAL_FILE_BYTES} bytes, an eval file's limit`),
    ...sizes.filter(([, size]) => size > MAX_FILE_BYTES).map(([path]) => `${path}: is over ${MAX_FILE_BYTES} bytes, a package file's limit`),
    ...(agentBytes > MAX_PACKAGE_BYTES ? [`the package's files are over ${MAX_PACKAGE_BYTES} bytes together, POST /v2/agents' own limit`] : []),
    ...(listed.length > MAX_PACKAGE_FILES ? [`the package holds over ${MAX_PACKAGE_FILES} files`] : []),
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
  const ref = (value: unknown) => value === undefined || (typeof value === "string" && MODEL_REF.test(value));
  if (f.model !== undefined && !(isObject(f.model) && !unknownFields(f.model, ["tier", "prefer", ...MODEL_TIER_NAMES]).length && typeof f.model.tier === "string" && Object.hasOwn(MODEL_TIERS, f.model.tier) && ref(f.model.prefer) && MODEL_TIER_NAMES.every((tier) => ref((f.model as Record<string, unknown>)[tier])))) bad(MANIFEST, `model is {tier: ${Object.keys(MODEL_TIERS).join(" | ")}, prefer?: "provider/model-id", ${MODEL_TIER_NAMES.map((tier) => `${tier}?: "provider/model-id"`).join(", ")}}`);
  if (f.effort !== undefined && !(THINKING_LEVELS as readonly unknown[]).includes(f.effort)) bad(MANIFEST, `effort is one of ${THINKING_LEVELS.join(", ")}`);
  const tools = f.tools === undefined ? undefined : list(f.tools, "tools");
  if (tools?.some(isMcpName)) bad(MANIFEST, "tools grants no MCP tool: mcp lists them, by server");
  // A monid endpoint (monid:<provider>/<endpoint> or monid:<provider>/*) is granted as written and pinned at the apply's save.
  for (const tool of tools?.filter((tool) => !isMcpName(tool) && !(isMonidName(tool) && parseToolName(tool)) && !BOUND_TOOLS.includes(tool)) ?? []) bad(MANIFEST, isMonidName(tool) ? `tools: ${MONID_NAME_WORDS(tool)}` : `tools: ${tool} is not a tool this server binds (${BOUND_TOOLS.join(", ")})`);
  const mcp: McpNeed[] = [];
  for (const [i, need] of (f.mcp === undefined ? [] : Array.isArray(f.mcp) ? f.mcp : (bad(MANIFEST, "mcp is a list of {server, tools, required?}"), [])).entries()) {
    const names = isObject(need) && Array.isArray(need.tools) ? need.tools : [];
    const allow = isObject(need) && need.allow !== undefined ? need.allow : [];
    const pin = isObject(need) && need.pin !== undefined ? need.pin : {};
    const ok = isObject(need) && !unknownFields(need, ["server", "tools", "required", "allow", "pin"]).length && typeof need.server === "string" && MCP_SERVER_NAME.test(need.server) && names.length > 0 && names.every((tool) => typeof tool === "string" && MCP_TOOL_NAME.test(tool)) && new Set(names).size === names.length && (need.required === undefined || typeof need.required === "boolean")
      && Array.isArray(allow) && allow.every((tool) => names.includes(tool)) && new Set(allow).size === allow.length;
    if (!ok) bad(MANIFEST, `mcp[${i}] is {server: an MCP server's name (${MCP_SERVER_NAME.source}), tools: its tool names (${MCP_TOOL_NAME.source}), none twice, required?: true or false, allow?: the tools of its tools it asks the owner to allow, pin?: {<tool>: {<argument>: <value>}}}`);
    else if (mcp.some((m) => m.server === need.server)) bad(MANIFEST, `mcp[${i}]: the server ${need.server as string} is listed twice`);
    else {
      const pinned = pinOf(pin, need.server as string, names as string[], `mcp[${i}].pin`, (message) => bad(MANIFEST, message));
      mcp.push({ server: need.server as string, tools: names as string[], required: need.required === true, allow: allow as string[], pin: pinned });
    }
  }
  // A policy by tool: bash's alone (bash-read-only.ts), on a package that grants bash or names no tools (a new agent's
  // tools, the box's shell among them where there is one).
  let toolPolicy: { bash: BashPolicy } | undefined;
  if (f.tool_policy !== undefined) {
    const given = f.tool_policy;
    if (!isObject(given) || !Object.keys(given).length || unknownFields(given, ["bash"]).length || !(BASH_POLICIES as readonly unknown[]).includes(given.bash)) bad(MANIFEST, `tool_policy is {bash: ${BASH_POLICIES.join(" | ")}}: read-only refuses, before it runs, any command that could write, run code or read outside the run's folder`);
    else if (tools && !tools.includes("bash")) bad(MANIFEST, "tool_policy.bash: the package's tools grant no bash, so its policy would hold nothing: add bash to tools, or leave tool_policy out");
    else toolPolicy = { bash: given.bash as BashPolicy };
  }
  // The computer: default (where this server puts a new agent), or a preference list apply takes the first it meets of
  // (pickComputer). none is always met, so an entry after it is never picked; a list without shell never gives a shell,
  // so a shell tool in tools would never be granted.
  let computer: ComputerEntry[] | undefined;
  if (f.computer !== undefined && f.computer !== "default") {
    const given = f.computer;
    if (!Array.isArray(given) || !given.length || !given.every((entry) => (COMPUTER_ENTRIES as readonly unknown[]).includes(entry)) || new Set(given).size !== given.length) bad(MANIFEST, `computer is default (where this server puts a new agent), or a preference list of ${COMPUTER_ENTRIES.join(", ")}, each once ([shell, none]): apply takes the first this server meets now. shell: a computer that gives the agent a shell here; none: no shell, the file tools alone`);
    else if (given.indexOf("none") !== -1 && given.indexOf("none") < given.length - 1) bad(MANIFEST, "computer: none is always met, so nothing after it is ever picked: end the list with it");
    else {
      computer = given as ComputerEntry[];
      const shellOnly = tools?.filter((tool) => toolOf(tool)?.sandboxOnly) ?? [];
      if (!computer.includes("shell") && shellOnly.length) bad(MANIFEST, `computer: [none] gives no shell, so ${shellOnly.join(", ")} would never be granted: add shell to computer, or take ${shellOnly.length === 1 ? "it" : "them"} out of tools`);
    }
  }
  // The server's checkout before each run's first turn: the pull request the run's GitHub event names, at its head.
  if (f.checkout !== undefined && f.checkout !== "pull_request") bad(MANIFEST, "checkout is pull_request: the server checks out the pull request the run's GitHub event names, at its head, in repo/ before the first turn");
  const parameters: Record<string, Parameter> = {};
  for (const [key, p] of Object.entries(f.parameters === undefined ? {} : isObject(f.parameters) ? f.parameters : (bad(MANIFEST, "parameters is a mapping of names"), {}))) {
    // A list of a scalar (a watch's companies), its items in an input's vocabulary: what apply takes, and a trigger's
    // target.input fills whole.
    if (isObject(p) && p.type === "array") {
      const items = p.items;
      if (!PARAMETER.test(key) || unknownFields(p, ["type", "required", "items", "description", "default"]).length || !(p.required === undefined || typeof p.required === "boolean") || !(typeof p.description === "string" && p.description.trim()) || !isObject(items) || !(PARAMETER_TYPES as readonly unknown[]).includes(items.type) || unknownFields(items, ITEM_KEYS).length) {
        bad(MANIFEST, `parameters.${key} is {type: array, items: {type: ${PARAMETER_TYPES.join(" | ")}, and that scalar's ${ITEM_KEYS.slice(1).join(", ")}}, required?, default?, description}, its name lowercase`);
        continue;
      }
      const schema = { type: "array", items: scalarSchema(items.type as ScalarType, items, `parameters.${key}.items`, (message) => bad(MANIFEST, message)) };
      const check = schemaCheck(schema);
      const takes = (value: unknown) => !("why" in check) && !check.check(value).length;
      if (p.default !== undefined) {
        if (!takes(p.default)) bad(MANIFEST, `parameters.${key}.default is a list its items take`);
        if (p.required === true) bad(MANIFEST, `parameters.${key} is required and has a default: a default is for a parameter apply may leave out`);
      }
      parameters[key] = { type: "array", items: schema.items, required: p.required === true, description: p.description as string, ...(p.default !== undefined && takes(p.default) ? { default: p.default as Scalar[] } : {}) };
      continue;
    }
    const ok =PARAMETER.test(key) && isObject(p) && !unknownFields(p, ["type", "required", "pattern", "enum", "format", "description", "default"]).length && (PARAMETER_TYPES as readonly unknown[]).includes(p.type) && (p.required === undefined || typeof p.required === "boolean") && typeof p.description === "string" && p.description.trim() !== "" && (p.pattern === undefined || (p.type === "string" && typeof p.pattern === "string"));
    if (!ok) {
      bad(MANIFEST, `parameters.${key} is {type: ${PARAMETER_TYPES.join(" | ")}, required?, pattern? (strings), enum?, format? (strings), default?, description} (or type: array, items: a scalar), its name lowercase`);
      continue;
    }
    try {
      if (typeof p.pattern === "string") new RegExp(p.pattern, "u");
    } catch {
      bad(MANIFEST, `parameters.${key}.pattern is not a regular expression`);
    }
    // What a string's value is (a cron line, a time zone), for a form to ask for it as such.
    const format = p.format === undefined ? undefined : p.type === "string" && (PARAMETER_FORMATS as readonly unknown[]).includes(p.format) ? (p.format as Parameter["format"]) : (bad(MANIFEST, `parameters.${key}.format is one of ${PARAMETER_FORMATS.join(", ")}, on a string parameter`), undefined);
    // A closed set of values (a form shows a choice, never a pattern): one or more, each of the parameter's type, once.
    const choices = p.enum === undefined ? undefined : Array.isArray(p.enum) && p.enum.length > 0 && p.enum.every((one) => ofType(p.type as ScalarType, one)) && new Set(p.enum).size === p.enum.length ? (p.enum as Scalar[]) : (bad(MANIFEST, `parameters.${key}.enum is a list of one or more distinct ${p.type as string} values`), undefined);
    if (choices && typeof p.pattern === "string") bad(MANIFEST, `parameters.${key} has an enum and a pattern: the enum says the values, so leave the pattern out`);
    if (choices && p.default !== undefined && !choices.includes(p.default as Scalar)) bad(MANIFEST, `parameters.${key}.default is not one of its enum`);
    if (p.default !== undefined) {
      if (!ofType(p.type as ScalarType, p.default)) bad(MANIFEST, `parameters.${key}.default is a ${p.type as string}, as the parameter is`);
      else if (typeof p.pattern === "string" && typeof p.default === "string" && !safeTest(p.pattern, p.default)) bad(MANIFEST, `parameters.${key}.default does not match its pattern`);
      if (p.required === true) bad(MANIFEST, `parameters.${key} is required and has a default: a default is for a parameter apply may leave out`);
    }
    parameters[key] = { type: p.type as ScalarType, required: p.required === true, description: p.description as string, ...(typeof p.pattern === "string" ? { pattern: p.pattern } : {}), ...(choices ? { enum: choices } : {}), ...(format ? { format } : {}), ...(p.default !== undefined && ofType(p.type as ScalarType, p.default) ? { default: p.default as Scalar } : {}) };
  }
  const inputSchema = inputsSchema(f.inputs, (message) => bad(MANIFEST, message));
  const secrets = list(f.secrets, "secrets", (secret) => /^[A-Z][A-Z0-9_]{0,127}$/.test(secret));
  for (const secret of secrets.filter((name) => !PACKAGE_SECRETS.includes(name))) bad(MANIFEST, `secrets names ${secret}, a key this server cannot hold: a package needs the keys Settings saves and a run is handed (${PACKAGE_SECRETS.join(", ")})`);
  // Each run's limits: its spend cap (per_run_usd, the agent's max_cost_usd) and its tool-call budget (tool_calls, the
  // agent's max_tool_calls: each conversation's calls), one of them at least.
  const perRun = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value > 0;
  const toolCalls = (value: unknown) => Number.isSafeInteger(value) && (value as number) > 0 && (value as number) <= MAX_TOOL_CALLS;
  if (f.budget !== undefined && !(isObject(f.budget) && Object.keys(f.budget).length && !unknownFields(f.budget, ["per_run_usd", "tool_calls"]).length && (f.budget.per_run_usd === undefined || perRun(f.budget.per_run_usd)) && (f.budget.tool_calls === undefined || toolCalls(f.budget.tool_calls)))) bad(MANIFEST, `budget is {per_run_usd?: a number above 0, tool_calls?: a whole number from 1 to ${MAX_TOOL_CALLS}}, one of them at least`);
  if (f.learning !== undefined && typeof f.learning !== "boolean") bad(MANIFEST, "learning is true or false");
  if (f.approvals !== undefined && f.approvals !== "ask" && f.approvals !== "never") bad(MANIFEST, "approvals is ask (the agent asks its person before a tool runs) or never (it runs unattended; deny and pins still hold)");
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
  if (triggers.length && !(isObject(f.budget) && f.budget.per_run_usd !== undefined)) bad(MANIFEST, "budget is required when the package has triggers: {per_run_usd}, each run's cap");
  let outputSchema: unknown;
  if (f.output !== undefined) {
    const at = isObject(f.output) ? f.output.schema : undefined;
    const evalSize = typeof at === "string" && at.startsWith("evals/") && inside(at) ? src.size(at) : 0;
    if (!isObject(f.output) || unknownFields(f.output, ["schema"]).length || !inside(at)) bad(MANIFEST, "output is {schema: a JSON Schema file in the package}");
    else if (evalSize > MAX_FILE_BYTES || agentBytes + evalSize > MAX_PACKAGE_BYTES) {
      bad(at as string, evalSize > MAX_FILE_BYTES ? `is over ${MAX_FILE_BYTES} bytes, a package file's limit: the answer's schema is given to the agent, so it keeps an agent file's limits, under evals/ too` : `takes the agent's files over ${MAX_PACKAGE_BYTES} bytes together, POST /v2/agents' own limit: the answer's schema is given to the agent, so it counts as an agent file, under evals/ too`);
    } else {
      try {
        outputSchema = JSON.parse(text(f.output.schema as string));
        if (!isObject(outputSchema)) throw new Error();
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
  // A placeholder fills text a run reads, a schedule's time (its cron and timezone, read as the schedule at apply), and a
  // github or webhook trigger's where `in` values (the repository it takes, say); a trigger's other settings are the
  // package's own, checked here. A parameter that sets a time has a default, so the schedule the package ships is checked
  // here too; one a github or webhook trigger's where takes is required or has a default, so the trigger never fills
  // empty and takes no event.
  triggers.forEach((trigger, i) => {
    if (!isObject(trigger)) return;
    const timed = isObject(trigger.source) && trigger.source.kind === "schedule";
    const filtered = isObject(trigger.source) && FILTERED_KINDS.includes(trigger.source.kind as string);
    const fixed = Object.entries(trigger).flatMap(([key, value]) =>
      key === "target" && isObject(value) ? Object.entries(value).filter(([k]) => k !== "input").map(([k, v]) => [`target.${k}`, v] as const)
      : key === "source" && timed && isObject(value) ? Object.entries(value).filter(([k]) => !SCHEDULE_FIELDS.includes(k)).map(([k, v]) => [`source.${k}`, v] as const)
      : key === "source" && filtered && isObject(value) ? [[key, whereIns(value).rest] as const]
      : [[key, value] as const]);
    for (const [at, value] of fixed) for (const [used] of strings(value).flatMap((text) => [...text.matchAll(PLACEHOLDER)])) bad(MANIFEST, `triggers[${i}].${at} holds ${used}: a placeholder goes in display_name, the instructions, a trigger's target.input, a schedule's cron and timezone, a github or webhook trigger's where in values, or an mcp pin's values`);
    if (filtered) {
      for (const used of new Set(strings(whereIns(trigger.source as Json).ins).flatMap((text) => [...text.matchAll(PLACEHOLDER)].map((m) => m[1]!)))) {
        if (Object.hasOwn(parameters, used) && !parameters[used]!.required && parameters[used]!.default === undefined) bad(MANIFEST, `parameters.${used} is used in triggers[${i}].source.accept, so it is required or has a default: a ${(trigger.source as Json).kind as string} trigger filled empty takes no event`);
      }
    }
    if (!timed) return;
    for (const field of SCHEDULE_FIELDS) {
      for (const [, used] of strings((trigger.source as Json)[field]).flatMap((text) => [...text.matchAll(PLACEHOLDER)])) {
        if (Object.hasOwn(parameters, used!) && parameters[used!]!.default === undefined) bad(MANIFEST, `parameters.${used} is used in triggers[${i}].source.${field}, so it needs a default: the schedule the package ships is checked with it`);
      }
    }
  });

  // skills/<name>/SKILL.md, each named as its folder and described, as Agent Skills are; rules/*.md beside each.
  const skills: Record<string, string> = {};
  const skillDirs = kind("skills") === "dir" ? src.entries("skills") : [];
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
  const rules = kind("rules") === "dir" ? src.entries("rules") : [];
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
  // The answer's schema is not copied beside each SKILL.md: it becomes the agent's output_schema, which the runner puts in
  // the instructions on every harness (answer-json.ts outputContract). A skill that reads the file itself (a reviewer
  // subagent's guide) keeps it in its own folder.

  // evals/<case>/: prompt.md (the run's input), graders/*.md (each its type in its front matter), case.yaml and
  // fixtures/ if it has them. The layout only: no eval runs here.
  const evals: string[] = [];
  for (const entry of kind("evals") === "dir" ? src.entries("evals") : []) {
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
    id: name, origin: null, name, ...(typeof f.display_name === "string" ? { displayName: f.display_name } : {}), version: f.version as string, description: f.description as string,
    ...(typeof f.license === "string" ? { license: f.license } : {}), ...(isObject(f.author) ? { author: f.author } : {}), ...(typeof f.repository === "string" ? { repository: f.repository } : {}),
    ...(harness ? { harness } : {}), ...(isObject(f.model) ? { model: f.model as NonNullable<Package["model"]> } : {}), ...(typeof f.effort === "string" ? { effort: f.effort } : {}),
    ...(tools ? { tools } : {}), mcp, ...(computer ? { computer } : {}), ...(toolPolicy ? { toolPolicy } : {}), ...(f.checkout === "pull_request" ? { checkout: "pull_request" as const } : {}), parameters, ...(inputSchema ? { inputSchema } : {}), secrets, ...(isObject(f.budget) ? { budget: { ...(typeof f.budget.per_run_usd === "number" ? { per_run_usd: f.budget.per_run_usd } : {}), ...(typeof f.budget.tool_calls === "number" ? { tool_calls: f.budget.tool_calls } : {}) } } : {}), ...(typeof f.learning === "boolean" ? { learning: f.learning } : {}), ...(f.approvals === "ask" || f.approvals === "never" ? { approvals: f.approvals } : {}),
    triggers: triggers as Json[], ...(isObject(f.output) ? { output: { schema: f.output.schema as string } } : {}), ...(isObject(outputSchema) ? { outputSchema } : {}), checks, instructions, skills, evals,
  };
  // What an apply makes, made here with each parameter's default, else a sample of its type, and checked as POST
  // /v2/agents and POST /v2/triggers check their bodies (all but the agent the trigger names, which an apply makes). A
  // trigger's times are read as of the epoch, so its form is checked here and a date that has passed is the apply's
  // refusal, never a server's start.
  const samples = Object.fromEntries(Object.entries(parameters).map(([key, spec]) => [key, spec.default ?? (spec.type === "array" ? [sampleOf(spec.items!)] : sampleOf(spec))]));
  const declared = Object.fromEntries(MODEL_TIER_NAMES.flatMap((tier) => (p.model?.[tier] ? [[tier, p.model[tier]!]] : [])));
  // Every MCP tool ticked: the widest agent an apply can make, so each tool the package lists is checked as a grant.
  const every = mcp.flatMap(({ server, tools: listed }) => listed.map((tool) => mcpToolName(server, tool)));
  const made = compiled(p, samples, { ...(harness ? { harness: harness[0]! } : {}), ...(p.model?.prefer ? { model: p.model.prefer } : {}), ...(Object.keys(declared).length ? { modelTiers: declared } : {}), mcp, defaultTools: [], grants: every });
  for (const issue of definitionBodyIssues(made.agent)) bad(issue.field.startsWith("skills.") ? `skills/${issue.field.slice("skills.".length)}` : MANIFEST, `${issue.field.startsWith("skills.") ? "" : `the agent it makes: ${issue.field}: `}${issue.message}`);
  // A sample stands in for a value apply is given: at a target.input field a parameter with no default fills whole, what
  // hangs on the value (a pattern, a bound, a choice) is the apply's, on the value given. Its type, and whether the
  // inputs name the field at all, are checked here.
  const sampled = (field: string): boolean => {
    const at = /^triggers\.(\d+)\.target\.input\.([^.]+)/.exec(field);
    const target = at ? (p.triggers[Number(at[1])]?.target as Json | undefined) : undefined;
    const value = at && isObject(target) && isObject(target.input) ? target.input[at[2]!] : undefined;
    const whole = typeof value === "string" ? WHOLE.exec(value) : null;
    return !!whole && Object.hasOwn(parameters, whole[1]!) && parameters[whole[1]!]!.default === undefined;
  };
  for (const issue of madeTriggerIssues(made.triggers, 0, p.inputSchema)) if (["wrong_type", "not_allowed", "missing"].includes(issue.reason) || !sampled(issue.field)) bad(MANIFEST, `${issue.field.replace(/^triggers\.(\d+)\./, "triggers[$1].")}: ${issue.message}`);
  if (problems.length) throw new PackageError(dir, [...new Set(problems)]);
  return p;
}

/** What is wrong with the trigger bodies an apply makes (compiled's `triggers`), as POST /v2/triggers checks a body, all
 *  but the agent each names (the one the apply makes), as of `now`, each field under `triggers.<i>`. A trigger's input is
 *  its runs' input, and a package's agent is agentic, so each input is checked against the package's input schema in
 *  force too (`inputSchema`, its `inputs` compiled: inputSchemaOf). The validator runs it as of the epoch (a time's form
 *  only); an apply runs it before it makes anything. */
export function madeTriggerIssues(made: Json[], now: number, inputSchema?: Json): InputIssue[] {
  const schema = inputSchemaOf(inputSchema);
  return made.flatMap((trigger, i) => {
    const issues = triggerBodyIssues(TRIGGER_ADAPTERS, { ...trigger, target: { ...(trigger.target as Json), agent_id: SAMPLE_AGENT } }, now);
    const input = isObject(trigger.target) ? trigger.target.input : undefined;
    if (isObject(input)) issues.push(...inputIssues(input, schema, "target.input"));
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
    id: p.id, bundled: p.origin === null, source: p.origin?.source ?? null, sha: p.origin?.sha ?? null, publisher: p.origin?.publisher ?? null,
    name: p.name, display_name: p.displayName ?? null, version: p.version, description: p.description, license: p.license ?? null, author: p.author ?? null, repository: p.repository ?? null,
    output: p.output ? { schema: p.output.schema, json_schema: p.outputSchema ?? null } : null,
    harness: p.harness ?? null, model: p.model ?? null, effort: p.effort ?? null, tools: p.tools ?? null, tool_policy: p.toolPolicy ?? null, computer: p.computer ?? null, checkout: p.checkout ?? null,
    mcp: p.mcp.map(({ server, tools, required, allow, pin }) => ({ server, required, tools: tools.map((name) => ({ name, tool: mcpToolName(server, name), asks: allow.includes(name) ? "allow" : "ask", ...(Object.hasOwn(pin, name) ? { pin: pin[name]! } : {}) })) })), parameters: p.parameters, input_schema: p.inputSchema ?? null, secrets: p.secrets,
    budget: p.budget ?? null, learning: p.learning ?? false, approvals_default: p.approvals ?? "ask", triggers: p.triggers, skills: Object.keys(p.skills).filter((path) => /^[^/]+\/SKILL\.md$/.test(path)).map((path) => path.slice(0, -"/SKILL.md".length)), evals: p.evals,
  };
}

/** A package as an import answers it: its listing, and every text its agent would be given, the instructions and each
 *  skill file by path (a rule and the answer's schema beside each SKILL.md among them), so a person reads what a third
 *  party's package would tell their agent before it is installed. */
export function packageDetail(p: Package) {
  return { ...packageView(p), instructions: p.instructions, skill_files: { ...p.skills } };
}

/** The packages this server serves: the ones it ships, read at its start, and the ones imported here (the store keeps
 *  them; the server loads them beside the bundled ones at its start). An id is one package; a bundled one is never
 *  replaced or removed, and an imported id (`github:…`) is never a bundled one's name. */
export class TemplateRegistry {
  private readonly imported = new Map<string, Package>();
  constructor(private readonly bundled: readonly Package[]) {}
  /** The bundled packages by name, then the imported ones by id. */
  list(): Package[] {
    return [...this.bundled, ...[...this.imported.values()].sort((a, b) => a.id.localeCompare(b.id))];
  }
  get(id: string): Package | undefined {
    return this.bundled.find((p) => p.id === id) ?? this.imported.get(id);
  }
  /** An imported package, in place of the one under its id. */
  put(p: Package): void {
    if (p.origin === null || this.bundled.some((one) => one.id === p.id)) throw new TypeError(`${p.id} is a bundled package's id`);
    this.imported.set(p.id, p);
  }
  /** Whether an imported package of that id was there to remove. */
  remove(id: string): boolean {
    return this.imported.delete(id);
  }
}

/** POST /v2/templates/{name}/apply's body (`{parameters, grants?, overrides?: {model}}`), checked against the package:
 *  the parameters as given, the MCP tools the owner allows (each one the package lists, by its gate name), and the model
 *  asked for in place of the package's. 422 naming every field that is wrong. */
export function applyBodyOf(p: Package, body: Json): { parameters: Record<string, Scalar | Scalar[]>; grants: string[]; model?: string; approvals?: Approvals } {
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
  const parameters: Record<string, Scalar | Scalar[]> = {};
  for (const [key, value] of Object.entries(isObject(given) ? given : {})) {
    const spec = Object.hasOwn(p.parameters, key) ? p.parameters[key] : undefined;
    const typed = spec && (spec.type === "array" ? Array.isArray(value) : ofType(spec.type, value));
    // A list's items, each checked as an input's are (the full compiler): the first problem, said at the parameter.
    const itemIssue = spec?.type === "array" && typed ? inputIssues({ [key]: value }, { type: "object", properties: { [key]: { type: "array", items: spec.items } } }, "parameters")[0] : undefined;
    if (!spec) issues.push({ field: `parameters.${key}`, reason: "not_allowed", message: `The package ${p.name} takes no parameter ${key}.` });
    else if (!typed) issues.push({ field: `parameters.${key}`, reason: "wrong_type", message: `parameters.${key} is ${spec.type === "array" ? `a list of ${(spec.items as Json).type as string}` : `a ${spec.type}`}: ${spec.description}` });
    else if (itemIssue) issues.push({ ...itemIssue, field: `parameters.${key}`, message: `${itemIssue.message}: ${spec.description}` });
    else if (spec.type === "array") parameters[key] = value as Scalar[];
    else if (spec.enum && !spec.enum.includes(value as string | number | boolean)) issues.push({ field: `parameters.${key}`, reason: "not_an_option", message: `parameters.${key} is one of ${spec.enum.join(", ")}: ${spec.description}` });
    else if (spec.pattern && !new RegExp(spec.pattern, "u").test(value as string)) issues.push({ field: `parameters.${key}`, reason: "bad_format", message: `parameters.${key} is ${spec.description}` });
    else parameters[key] = value as string | number | boolean;
  }
  for (const [key, spec] of Object.entries(p.parameters)) {
    const absent = isObject(given) && (!Object.hasOwn(given, key) || given[key] === undefined || given[key] === "");
    if (spec.required && absent) issues.push({ field: `parameters.${key}`, reason: "missing", message: `parameters.${key} is required: ${spec.description}` });
    else if (absent && spec.default !== undefined) parameters[key] = spec.default;
  }
  const overrides = body.overrides ?? {};
  if (!isObject(overrides)) issues.push({ field: "overrides", reason: "wrong_type", message: "overrides is an object: {model?, approvals?}" });
  else {
    issues.push(...unknownFields(overrides, ["model", "approvals"]).map((i) => ({ ...i, field: `overrides.${i.field}`, message: "An apply overrides the model and the approvals alone." })));
    if (overrides.approvals !== undefined && !(APPROVALS as readonly unknown[]).includes(overrides.approvals)) issues.push({ field: "overrides.approvals", reason: "not_an_option", message: `overrides.approvals is one of ${APPROVALS.join(", ")}: never runs the agent unattended, while a deny still refuses` });
    if (overrides.model !== undefined && !(typeof overrides.model === "string" && MODEL_REF.test(overrides.model))) issues.push({ field: "overrides.model", reason: "bad_format", message: 'overrides.model is "provider/model-id"' });
  }
  if (issues.length) throw invalid(issues);
  return { parameters, grants, ...(isObject(overrides) && typeof overrides.model === "string" ? { model: overrides.model } : {}), ...(isObject(overrides) && (overrides.approvals === "ask" || overrides.approvals === "never") ? { approvals: overrides.approvals } : {}) };
}

/** The model a package's agent gets here, as `{model?, warning?}`: its `prefer` when this server runs it on `harness`
 *  with a key for its provider, but never through a gateway (AGENT_MODEL_BASE_URL), which never said it serves it: then
 *  a warning says so. Else the server's model for its tier (hostModel: AGENT_MODEL_FAST, AGENT_MODEL or
 *  AGENT_MODEL_STRONG, else the default of a model key it holds), unless that is a gateway's own id with no provider,
 *  which no definition can name: then no model, and the agent runs on the server's default (a warning when the tier's
 *  model is not that default). No model either when the package names none or the server has none. */
export async function packageModel(env: NodeJS.ProcessEnv, model: Package["model"], harness: string): Promise<{ model?: string; warning?: string }> {
  if (!model) return {};
  // Through a gateway, only the gateway knows what it serves: a preferred model it never named is not picked, and the
  // owner is told (overrides.model picks one it serves).
  const gateway = Boolean(env.AGENT_MODEL_BASE_URL);
  const skipped = model.prefer && gateway ? `model.prefer ${model.prefer} is not used: this server reaches its models through a gateway, which has not said it serves that model.` : undefined;
  if (!skipped && model.prefer && harnessRuns(env, model.prefer, harness) && !("why" in (await chooseModel(env, model.prefer, "default", harness)))) return { model: model.prefer };
  const tier = MODEL_TIERS[model.tier]!;
  const id = hostModel(env, tier, harness);
  // A gateway's own id (no provider) is no "provider/model-id" a definition can name: the agent is left to the server's
  // default, which is the gateway's model, and a tier model other than the default is said. The warning says the one
  // model the agent runs on, never the tier's when it is left out.
  const bare = Boolean(id && !MODEL_REF.test(id));
  const runsOn = bare && id !== env.AGENT_MODEL ? `The ${model.tier} tier's model ${id} is this gateway's own id, which an agent's definition can't name, so the agent runs on this server's default model.`
    : skipped ? (bare || !id ? "The agent runs on this server's default model." : `The agent runs on this server's model for the ${model.tier} tier.`)
    : undefined;
  const warning = [skipped, runsOn, skipped ? "overrides.model picks another the gateway serves." : undefined].filter(Boolean).join(" ");
  return { ...(id && !bare ? { model: id } : {}), ...(warning ? { warning } : {}) };
}

/** A computer setting as a definition names it (`definition.computer`). */
export type PickedSetting = { kind: string; provider?: string };
/** The shell this server can give an agent now (server.ts shellHere): the computer setting that gives it, the shell
 *  tools a run there has (tools.ts shellTools), and the shell in words; else, `none`, why it has none. */
export type ShellHere = { computer: PickedSetting; tools: readonly string[]; words: string } | { none: string };
/** What a package's computer list picks here: the entry, the setting the agent is saved with, the shell in words (null
 *  for none), the package's shell tools that shell does not run (`dropped`, never granted), the shell tools a package
 *  that names no tools is given (`defaults`), and the words an apply says of it (`note`: a fallback, or a tool dropped). */
export type ComputerPick = { entry: ComputerEntry; computer: PickedSetting; shell: string | null; dropped: string[]; defaults: string[]; note: string | null };

/** What to do where a package's computer list has no shell to take: in the apply's refusal and its fallback warning. */
export const COMPUTER_FIX = "Turn on Archil in Settings → Workspace, or run AgentRun where Docker answers, then apply again to give it a shell.";

/** The first entry of a package's computer list (`[shell, none]`) this server meets now, given the shell it has
 *  (`here`): shell, where it has one; none, always (kind none, and no shell tool: a run on the runner in Mode 2 has bash,
 *  so a shell tool is dropped rather than left to it). Undefined for a package with no list (it runs where a new agent
 *  does); `refused`, in words, when no entry is met. The rule is the package's preference alone: nothing here knows a
 *  template. */
export function pickComputer(p: Pick<Package, "name" | "computer" | "tools">, here: ShellHere): ComputerPick | { refused: string } | undefined {
  if (!p.computer) return undefined;
  // A shell that is a sandbox runs the agent in the box, where a runner-only tool (browser) is refused: such a package
  // cannot take that shell, so its list falls to the next entry, as it does where there is no shell at all.
  const runnerOnly = (p.tools ?? []).filter((tool) => toolOf(tool)?.runnerOnly);
  const found = "none" in here ? undefined : here;
  const clash = found && found.computer.kind === "sandbox" && runnerOnly.length ? `${found.words} runs ${runnerOnly.join(", ")} nowhere` : undefined;
  const shell = clash ? undefined : found;
  const lack = "none" in here ? here.none : clash ?? "this server has none";
  const entry = p.computer.find((one) => one === "none" || shell);
  if (!entry) return { refused: `The ${p.name} template needs a shell, and ${lack}. Nothing was created.` };
  const runs = entry === "shell" && shell ? shell.tools : [];
  const dropped = (p.tools ?? []).filter((tool) => toolOf(tool)?.sandboxOnly && !runs.includes(tool));
  const without = new Intl.ListFormat("en", { type: "conjunction" }).format(dropped);
  const note = entry === "none" && p.computer[0] === "shell" && !shell
    ? `${lack.charAt(0).toUpperCase()}${lack.slice(1)}, so the agent was made with the template's next choice, no computer${dropped.length ? `, and without ${without}` : ""}. ${COMPUTER_FIX}`
    : dropped.length && shell ? `The shell here is ${shell.words}, which runs ${runs.join(", ")} alone, so the agent was made without ${without}.` : null;
  return entry === "shell" && shell
    ? { entry, computer: { ...shell.computer }, shell: shell.words, dropped, defaults: [...shell.tools], note }
    : { entry, computer: { kind: "none" }, shell: null, dropped, defaults: [], note };
}

/** The model of each tier a package's subagents run on here (the definition's model_tiers), as `{modelTiers?, warning?}`:
 *  a tier's model the package names (`model.fast`, `model.strong`) when this server runs it on `harness` with a key for its
 *  provider, never through a gateway, as packageModel keeps `prefer`; else none, the tier then this server's own
 *  (AGENT_MODEL_FAST, AGENT_MODEL_STRONG), and a warning says so. The agent's own tier, named nowhere else, is the model
 *  the agent itself got (`own`), so a subagent on the agent's tier runs on the agent's model. */
export async function packageTiers(env: NodeJS.ProcessEnv, model: Package["model"], harness: string, own?: string): Promise<{ modelTiers?: Record<string, string>; warning?: string }> {
  if (!model) return {};
  const gateway = Boolean(env.AGENT_MODEL_BASE_URL);
  const tiers: Record<string, string> = {};
  const skipped: string[] = [];
  for (const tier of MODEL_TIER_NAMES) {
    const named = model[tier];
    if (!named) continue;
    if (!gateway && harnessRuns(env, named, harness) && !("why" in (await chooseModel(env, named, tier, harness)))) tiers[tier] = named;
    else skipped.push(`model.${tier} ${named} is not used: ${gateway ? "this server reaches its models through a gateway, which has not said it serves that model" : "this server cannot run it"}, so the agent's ${tier} subagents run on this server's model for the tier.`);
  }
  const mine = (MODEL_TIER_NAMES as readonly string[]).includes(model.tier) ? (model.tier as (typeof MODEL_TIER_NAMES)[number]) : undefined;
  if (mine && !model[mine] && own) tiers[mine] = own;
  return { ...(Object.keys(tiers).length ? { modelTiers: tiers } : {}), ...(skipped.length ? { warning: skipped.join(" ") } : {}) };
}

/** The bodies an apply makes: POST /v2/agents' (its definition and skill files) and each trigger's, with no agent_id,
 *  every `${parameters.x}` filled. `grants`, the owner's answer at apply (the tools ticked): of the package's tools on
 *  `mcp`, the MCP servers this server has saved, those alone are granted, beside the package's tools (or, when it names
 *  none, `defaultTools`, those this server gives a new agent), each set to allow but those `held` (a deny the owner set on
 *  this server holds them: granted, never allowed). A tool left unticked is not the agent's at all, so no harness offers
 *  it and approvals never, which lifts an ask of a tool the agent has, has nothing to lift: the owner grants it later in
 *  the agent's tools. A tool the package pins gets its pin, filled, in the agent's tool settings, whatever its permission
 *  and ticked or not (it holds once the tool is granted later); one whose pin fills empty (its parameter not given) is set
 *  to deny instead, and named in `unpinned` (by gate name, with the parameters not given): a send with no destination set
 *  never runs. */
export function compiled(p: Package, parameters: Json, chosen: { harness?: string; model?: string; modelTiers?: Record<string, string>; mcp: McpNeed[]; defaultTools: readonly string[]; grants: readonly string[]; held?: readonly string[]; approvals?: Approvals; computer?: ComputerPick }, _deps?: TemplatesDeps): { agent: Json; triggers: Json[]; unpinned: { tool: string; parameters: string[] }[] } {
  const skills = Object.keys(p.skills).filter((path) => /^[^/]+\/SKILL\.md$/.test(path)).map((path) => path.slice(0, -"/SKILL.md".length));
  // The ticks, in the package's order: never a tool of a server not saved here, nor one the owner did not tick.
  const granted = chosen.mcp.flatMap(({ server, tools }) => tools.map((tool) => mcpToolName(server, tool))).filter((tool) => chosen.grants.includes(tool));
  const allowed = granted.filter((tool) => !chosen.held?.includes(tool));
  // The computer its list picked (pickComputer): its tools less the shell tools that computer does not run; a package
  // that names none is given that computer's shell tools, as a new agent in a box is given the box's.
  const pick = chosen.computer;
  const own = pick ? (p.tools ?? pick.defaults).filter((tool) => !pick.dropped.includes(tool)) : p.tools;
  const named = own && (p.tools || own.length) ? own : undefined;
  const tools = granted.length ? [...(named ?? (pick ? [] : chosen.defaultTools)), ...granted] : named;
  const settings: Record<string, { permission?: "allow" | "deny"; pin?: Record<string, PinValue>; policy?: BashPolicy }> = Object.fromEntries(allowed.map((tool) => [tool, { permission: "allow" as const }]));
  // A tool's policy (bash's read-only), written as its setting, whatever its permission: never one an apply grants. With
  // a picked computer, only where the agent's tools hold bash: none for a bash the computer dropped, or never gave.
  if (p.toolPolicy && (!pick || tools?.includes("bash"))) settings.bash = { ...settings.bash, policy: p.toolPolicy.bash };
  const unpinned: { tool: string; parameters: string[] }[] = [];
  for (const { tool: name, pin, empty } of filledPins(chosen.mcp, parameters)) {
    if (empty.length) {
      settings[name] = { permission: "deny" };
      unpinned.push({ tool: name, parameters: empty });
    } else settings[name] = { ...settings[name], pin: sortedPin(pin) as Record<string, PinValue> };
  }
  const definition = {
    name: p.displayName ? filled(p.displayName, parameters) : p.name, description: p.description, instructions: filled(p.instructions, parameters),
    ...(chosen.harness ? { harness: chosen.harness } : {}), ...(chosen.model ? { model: chosen.model } : {}), ...(chosen.modelTiers && Object.keys(chosen.modelTiers).length ? { model_tiers: chosen.modelTiers } : {}), ...(p.effort ? { thinking: p.effort } : {}),
    ...(pick ? { computer: pick.computer } : {}), ...(tools ? { tools } : {}), ...(Object.keys(settings).length ? { tool_settings: settings } : {}),
    ...(p.learning !== undefined ? { learning: p.learning } : {}), ...(p.budget?.per_run_usd ? { max_cost_usd: p.budget.per_run_usd } : {}), ...(p.budget?.tool_calls ? { max_tool_calls: p.budget.tool_calls } : {}), skills,
    // The apply's choice: unattended only when it says never (none given: the agent asks).
    ...(chosen.approvals === "never" ? { approvals: "never" } : {}),
    // The package's typed input (manifest `inputs`): what each run's input is checked against, and how the model reads it.
    ...(isObject(p.inputSchema) ? { input_schema: p.inputSchema } : {}),
    // The package's answer schema (manifest `output`): each completed run's structured answer, checked, is its result.output.
    ...(isObject(p.outputSchema) ? { output_schema: p.outputSchema } : {}),
    // The package's checkout (manifest `checkout`): the server fetches it before each run's first turn.
    ...(p.checkout ? { checkout: p.checkout } : {}),
  };
  return { agent: { definition, skills: { ...p.skills } }, triggers: p.triggers.map((trigger) => triggerFilled(trigger, parameters)), unpinned };
}

/** Each pin the package's MCP servers (`mcp`) set, by the tool's gate name, its values filled from `parameters`, and the
 *  parameters it names that were not given (`empty`, none when it fills whole). */
export function filledPins(mcp: readonly McpNeed[], parameters: Json): { tool: string; pin: Record<string, PinValue>; empty: string[] }[] {
  return mcp.flatMap(({ server, pin }) => Object.entries(pin).map(([tool, args]) => {
    const each = Object.entries(args).map(([arg, value]) => [arg, pinFilled(value, parameters)] as const);
    return { tool: mcpToolName(server, tool), pin: Object.fromEntries(each.map(([arg, one]) => [arg, one.value])), empty: [...new Set(each.flatMap(([, one]) => one.empty))] };
  }));
}
