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
// Where a package's MCP tools come from (a Composio toolkit, GitHub's MCP server, or any other server by its address): a
// saved MCP server records one too, and apply maps each need to a server whose record matches.
import { MCP_SOURCES, type McpSource } from "./mcp-sources.js";
import type { GitHubConnectionView } from "./github-connection.js";
import { HARNESSES } from "./harness.js";
import { TOOL_KEY_ROWS } from "./key-words.js";
import { harnessOf } from "./harness-table.js";
import { chooseModel, FAUX_ENV, harnessRuns, hostModel, MODEL_KEYS, providerModels, THINKING_LEVELS, type Tier } from "./model.js";
import { harnessModel } from "./runnable.js";
import { isPinKeys, type PinKeys, type PinScalar, type PinValue } from "./tool-gate.js";
import { formatToolName, isMcpName, isMonidName, MCP_SERVER_NAME, MCP_TOOL_NAME, mcpToolName, MONID_NAME_WORDS, parseToolName } from "./tool-names.js";
import { pinIssues, sortedPin } from "./tool-plane.js";
import { BASH_POLICIES, type BashPolicy } from "./bash-read-only.js";
import { BOUND_TOOLS, toolOf } from "./tools.js";
import { TRIGGER_ADAPTERS } from "./trigger-adapters.js";
import { MOVE_FIELD } from "./trigger-composio.js";
import { triggerBodyIssues } from "./triggers.js";
import { definitionBodyIssues, inputIssues, inputSchemaOf, isObject, type Json, MODEL_REF, MODEL_TIER_NAMES, unknownFields } from "./validate.js";
import { schemaCheck } from "./answer-json.js";
import { webFixtureOf } from "./web-fake.js";
import { APPROVALS, type Approvals } from "./approvals.js";
import { agreeOnOf, type LearningSetting, learningSettingIssue, learningSettingOf, pathSegments } from "./learning-setting.js";

/** The packages this server ships. */
/** What applying a template reads of the server beyond its package (server.ts wires it): the GitHub connection, the
 *  App's id, slug and installations (github-connection.ts), never a secret; undefined when GitHub is not connected. */
export type TemplatesDeps = { githubConnection: () => GitHubConnectionView | undefined };

export const TEMPLATES_DIR = fileURLToPath(new URL("../templates/", import.meta.url));
export const MANIFEST = "agent.md";

/** A package's model tier, mapped to the server's own (model.ts Tier: AGENT_MODEL_FAST, AGENT_MODEL, AGENT_MODEL_STRONG). */
export const MODEL_TIERS: Readonly<Record<string, Tier>> = { fast: "fast", balanced: "default", strong: "strong" };
const SCALAR_TYPES = ["string", "number", "integer", "boolean"] as const;
/** A case's grader types. The answer's output schema is no grader's: every graded run of a package with `output` is held
 *  to it by the server's own verdict (template-eval.ts outputVerdict). */
export const GRADER_TYPES = ["llm", "regex", "tool_used", "file_exists", "mailbox"] as const;
/** The entries of a package's `computer` preference list: `shell`, a computer that gives the agent a shell here (bash);
 *  `none`, no shell, the file tools alone. Apply takes the first this server meets now (pickComputer). */
export const COMPUTER_ENTRIES = ["shell", "none"] as const;
export type ComputerEntry = (typeof COMPUTER_ENTRIES)[number];
const FIELDS = ["name", "display_name", "version", "description", "license", "author", "repository", "category", "tags", "harness", "model", "effort", "tools", "mcp", "tool_policy", "computer", "checkout", "parameters", "inputs", "secrets", "budget", "learning", "approvals", "triggers", "output"];
/** What a package is for, shown on a marketplace page and the console's list: display only, never applied. */
export const CATEGORIES = ["engineering", "security", "sales", "marketing", "research", "finance", "operations", "compliance", "personal"] as const;
const TAG = /^[a-z0-9-]{1,32}$/;
const MAX_TAGS = 8;
/** An MCP need's reason: one line, shown on the apply screen beside its tools. */
const MAX_REASON = 280;
/** An input's or a parameter's types: a scalar, or a list of one. */
export const INPUT_TYPES = [...SCALAR_TYPES, "array"] as const;
/** What a string input's or parameter's value is: a form asks for it as such, and the server checks the JSON Schema
 *  formats it knows. cron and timezone are for the form alone (a schedule picker, a zone choice); where a parameter fills
 *  a schedule, the schedule's own check reads the value at apply. */
export const INPUT_FORMATS = ["uri", "email", "hostname", "date", "date-time", "uuid", "cron", "timezone"] as const;
/** An input's or a parameter's keys: what a form and a JSON Schema say of one field. */
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
/** A composio trigger's fields this server sets when it makes the trigger on Composio (composio-triggers.ts). */
const COMPOSIO_SET = ["instance_id", "hook", MOVE_FIELD] as const;

/** An agent id in the shape an apply gives a trigger's target, for that check. */
const SAMPLE_AGENT = `agt_${"0".repeat(24)}`;
// semver.org's own expression, SemVer 2.0.0.
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;
const PLACEHOLDER = /\$\{parameters\.([^}]*)\}/g;
/** Text that is one placeholder alone: it takes the parameter's value with its type (a pin's, a trigger's input's). */
const WHOLE = /^\$\{parameters\.([^}]*)\}$/;
const FRONT = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

/** An MCP server a package uses, by where it comes from (`source`, `toolkit`), never by the name an owner saves it under:
 *  inside the package its tools are `mcp:<toolkit>/<tool>`. `tools`, those the agent may be granted, and `allow`, those of
 *  them the package asks the owner to grant (a consent screen shows it, with `reason`). Neither the package nor an apply
 *  sets a permission: an apply's `grants`, the owner's ticks, grant the tools, and each call follows this server's tool settings
 *  (a write asks unless the owner allowed it there, a read follows the server's Allow reads, approvals never lifts an ask). `pin`, by tool: the arguments each of its calls must carry (a value, or
 *  `${parameters.<name>}`), which apply writes as the tool's pin in the agent's tool settings, so a send goes only to the
 *  destination the owner set. */
export type McpNeed = { source: McpSource; toolkit: string; tools: string[]; required: boolean; reason?: string; allow: string[]; pin: Record<string, Record<string, PinValue>> };
/** One of a package's model choices (manifest `model.choices`): a model and the harness it runs on, which an owner picks
 *  by `id` at install (apply's overrides.choice) in place of the package's tier and preference. `label` names it on the
 *  install form; `warning`, shown there word for word beside it; `note`, a setup line; `secrets`, the keys only this
 *  choice needs, refused at apply as the package's own are. Apply runs the agent on exactly this model, or refuses. */
export type ModelChoice = { id: string; label: string; model: string; harness: string; warning?: string; note?: string; secrets: string[] };
/** A package's model choices at most, a choice label's length, and a warning's or a note's. */
const MAX_CHOICES = 3;
const MAX_CHOICE_LABEL = 40;
const MAX_CHOICE_TEXT = 300;
const CHOICE_FIELDS = ["id", "label", "model", "harness", "warning", "note", "secrets"];
const CHOICE_WORDS = "{id, label, model, harness, warning?, note?, secrets?}";

/** A manifest's `model.choices`, checked: each problem said through `bad`, in words that say the rule. A choice's harness
 *  is one of the package's `harness` list (`harness`), or any this server knows when the package names none. */
function modelChoices(given: unknown, harness: readonly string[] | undefined, bad: (message: string) => void): ModelChoice[] {
  if (!Array.isArray(given) || !given.length || given.length > MAX_CHOICES) return bad(`model.choices is a list of 1 to ${MAX_CHOICES} choices, each ${CHOICE_WORDS}: the models an owner may pick one of at install`), [];
  const text = (value: unknown, max: number) => typeof value === "string" && value.trim() !== "" && value.length <= max;
  const ids = new Set<unknown>();
  const out: ModelChoice[] = [];
  given.forEach((choice, i) => {
    const at = `model.choices[${i}]`;
    if (!isObject(choice)) return bad(`${at} is ${CHOICE_WORDS}`);
    let ok = true;
    const no = (message: string) => { ok = false; bad(message); };
    for (const issue of unknownFields(choice, CHOICE_FIELDS)) no(`${at} has no field ${issue.field}: a choice is ${CHOICE_WORDS}`);
    if (typeof choice.id !== "string" || !NAME.test(choice.id) || choice.id.length > 64) no(`${at}.id is lowercase letters, digits and dashes, at most 64: what an apply's overrides.choice names`);
    else if (ids.has(choice.id)) no(`${at}.id ${choice.id} is an earlier choice's: each choice has its own id`);
    ids.add(choice.id);
    if (!text(choice.label, MAX_CHOICE_LABEL)) no(`${at}.label is text of 1 to ${MAX_CHOICE_LABEL} characters, shown beside the choice at install`);
    if (typeof choice.model !== "string" || !MODEL_REF.test(choice.model)) no(`${at}.model is "provider/model-id"`);
    const harnesses: readonly string[] = harness ?? HARNESSES;
    if (typeof choice.harness !== "string" || !harnesses.includes(choice.harness)) no(`${at}.harness is one of ${harness ? `the package's harness list (${harness.join(", ")})` : HARNESSES.join(", ")}: the choice runs on it`);
    if (choice.warning !== undefined && !text(choice.warning, MAX_CHOICE_TEXT)) no(`${at}.warning is text of 1 to ${MAX_CHOICE_TEXT} characters, shown word for word beside the choice at install`);
    if (choice.note !== undefined && !text(choice.note, MAX_CHOICE_TEXT)) no(`${at}.note is text of 1 to ${MAX_CHOICE_TEXT} characters, a setup line shown beside the choice at install`);
    const secrets = choice.secrets ?? [];
    if (!Array.isArray(secrets) || !secrets.every((name) => typeof name === "string" && /^[A-Z][A-Z0-9_]{0,127}$/.test(name))) no(`${at}.secrets is a list of key names, as the package's secrets`);
    else {
      if (new Set(secrets).size !== secrets.length) no(`${at}.secrets names one key twice`);
      for (const name of secrets.filter((one) => !PACKAGE_SECRETS.includes(one))) no(`${at}.secrets names ${name}, a key this server cannot hold: a choice needs the keys Settings saves and a run is handed (${PACKAGE_SECRETS.join(", ")})`);
    }
    if (ok) out.push({ id: choice.id as string, label: choice.label as string, model: choice.model as string, harness: choice.harness as string, ...(typeof choice.warning === "string" ? { warning: choice.warning } : {}), ...(typeof choice.note === "string" ? { note: choice.note } : {}), secrets: secrets as string[] });
  });
  return out;
}

/** A need mapped to the saved MCP server an apply gives it (`server`, its saved name). */
export type McpServed = McpNeed & { server: string };
type ScalarType = (typeof SCALAR_TYPES)[number];
/** Whether `value` is of the scalar type `type`. */
const ofType = (type: ScalarType, value: unknown): boolean => (type === "integer" ? Number.isSafeInteger(value) : type === "number" ? typeof value === "number" && Number.isFinite(value) : typeof value === type);
/** A compiled field schema's (fieldsSchema's) properties, by name. */
export const fieldsOf = (schema: Json): Record<string, Json> => schema.properties as Record<string, Json>;
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
  /** What it is for and its tags (CATEGORIES, TAG): display only. */
  category?: (typeof CATEGORIES)[number];
  tags: string[];
  /** Harness ids in the order the package prefers them; absent, any (the server's default). */
  harness?: string[];
  /** The agent's tier and the model it prefers on it; `fast` and `strong`, the model it prefers for each of those tiers
   *  when a subagent runs on it (runner/subagent.ts), compiled into the definition's model_tiers (packageTiers);
   *  `choices`, the named models an owner may pick one of at install instead (apply's overrides.choice). */
  model?: { tier: string; prefer?: string; fast?: string; strong?: string; choices?: ModelChoice[] };
  effort?: string;
  /** Absent, the tools the server gives a new agent that names none. */
  tools?: string[];
  /** MCP servers by their source and toolkit, and the tools of each the agent is granted. One `required` refuses an apply
   *  on a server that has saved none that matches; any other is skipped there, with a warning. */
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
  /** The setup an apply takes (manifest `parameters`), compiled as `inputs` are (fieldsSchema): a closed object schema,
   *  with no properties when the package names none. */
  parameters: Json;
  /** Each run's typed input (manifest `inputs`), compiled: the agent's input_schema. Absent, a run takes {content}. */
  inputSchema?: Json;
  secrets: string[];
  /** Each run's limit: its spend cap (the agent's max_cost_usd). */
  budget?: { per_run_usd: number };
  /** The agent's `learning`, as a definition takes it: true, false, or the loop's settings (agree_on, each path a required
   *  field of the output schema). */
  learning?: LearningSetting;
  /** Whether the agent asks its person before a tool runs (`ask`) or runs unattended (`never`): the package's default,
   *  shown to the owner at apply. A template whose job runs on triggers says never. Deny and pins hold either way. */
  approvals?: "ask" | "never";
  /** POST /v2/triggers bodies, placeholders unfilled, each target a start_run with no agent_id. */
  triggers: Json[];
  output?: { schema: string };
  /** The output schema's JSON, parsed (GET /v2/templates shows it). */
  outputSchema?: Json;
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

/** Why an agree_on path is not a required field of the answer's JSON Schema at every level, in words; undefined when it
 *  is (each segment a property of an object schema's `properties`, named in its `required`). */
function undeclaredPath(schema: Json, path: string): string | undefined {
  let node: unknown = schema;
  const segments = pathSegments(path);
  for (const [i, segment] of segments.entries()) {
    const of = i ? segments.slice(0, i).join(".") : "the answer";
    const properties = isObject(node) && isObject(node.properties) ? node.properties : undefined;
    if (!properties || !Object.hasOwn(properties, segment)) return `does not declare: ${segment} is no property of ${of}`;
    const required = (node as Json).required;
    if (!(Array.isArray(required) && required.includes(segment))) return `does not require: an answer may leave ${segment} out of ${of}, and a path missing on both sides never agrees`;
    node = properties[segment];
  }
  return undefined;
}

/** The source kinds whose accept rules a parameter may fill: a github trigger's, a webhook trigger's (a provider that
 *  sends every trigger of a project to one URL is filtered to the owner's own repository by them), a composio
 *  trigger's, and a feed trigger's (the pull requests of one author, say). */
const FILTERED_KINDS = ["github", "webhook", "composio", "feed"];

/** A github, webhook, composio or feed source split at its where conditions' `in` values, the one place a parameter may fill it: `ins`, each
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

/** The refusals of a trigger's create that mean this server can't set it up yet, by the trigger's source kind: an apply
 *  skips that trigger, never the apply, and says so under triggers.<i> (not_set_up_here). Any other refusal (a bad event
 *  or config, a 422, Composio's own error on the create) undoes the apply. GitHub's: no GitHub App here. Composio's: no
 *  public URL to send to, no connected account (or several) for the saved server's user, or the project's subscription
 *  at another address, which only the owner moves, from the console. */
export const TRIGGER_NOT_SET_UP_YET: Readonly<Record<string, readonly string[]>> = {
  github: ["github_not_connected"],
  composio: ["composio_no_public_url", "composio_not_connected", "composio_account_ambiguous", "composio_subscription_elsewhere"],
};

/** Whether refusal `code` of a trigger of source kind `kind` is one TRIGGER_NOT_SET_UP_YET skips. */
export const notSetUpYet = (kind: unknown, code: string): boolean => typeof kind === "string" && Object.hasOwn(TRIGGER_NOT_SET_UP_YET, kind) && TRIGGER_NOT_SET_UP_YET[kind]!.includes(code);

/** What an apply says of a composio trigger it skipped (notSetUpYet): which trigger, and the refusal's own words. */
export function composioTriggerSkipped(packageName: string, trigger: Json, why: string): string {
  const source = isObject(trigger.source) ? trigger.source : {};
  return `The ${packageName} template's trigger ${String(trigger.name)} (Composio ${String(source.event)} on ${String(source.server)}) was not made: ${why}`;
}

/** Whether a feed trigger, its parameters filled, reads no feed: its urls one whole array parameter the apply was given
 *  empty. An apply skips it, never itself, as it skips a github trigger with GitHub not connected (a warning under
 *  triggers.<i>): the agent stands. */
export const feedLeftEmpty = (trigger: Json): boolean => isObject(trigger.source) && trigger.source.kind === "feed" && Array.isArray(trigger.source.urls) && !trigger.source.urls.length;

/** What an apply says of a feed trigger it skipped (feedLeftEmpty): which, and the parameter to set. `declared` is the
 *  package's own urls ("${parameters.status_feeds}"). */
export function feedTriggerEmpty(packageName: string, trigger: Json, declared: unknown): string {
  const named = (typeof declared === "string" ? [...declared.matchAll(PLACEHOLDER)][0]?.[1] : undefined) ?? "its feeds parameter";
  return `The ${packageName} template's feed trigger ${String(trigger.name)} was not made: no feeds given in ${named}. Apply again with ${named} set to the feeds it should read.`;
}

/** Where the owner makes a composio trigger an apply skipped, once what refused it is fixed. */
export const COMPOSIO_TRIGGER_FIX = "Once that's fixed, make it from Triggers → New app trigger for this agent, with the same event and config.";

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

/** Text filled from `given`, the one rule a trigger's input and a pin share: text that is one placeholder alone takes the
 *  parameter's value with its type (a list stays a list, an integer an integer), undefined when it was given none; other
 *  text is filled as text. Each caller keeps its own rule for a value given none. */
const typedFilled = (text: string, given: Record<string, unknown>): unknown => {
  const whole = WHOLE.exec(text);
  return whole ? givenOf(given, whole[1]!) : filled(text, given);
};

/** A trigger's target.input filled (typedFilled): a whole placeholder given no value is dropped, so the input schema
 *  sees the field absent. */
const inputFilled = (value: unknown, given: Record<string, unknown>): unknown => {
  if (typeof value === "string") return typedFilled(value, given);
  if (Array.isArray(value)) return value.map((item) => inputFilled(item, given)).filter((item) => item !== undefined);
  if (isObject(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, inputFilled(item, given)]).filter(([, item]) => item !== undefined));
  return value;
};

/** A trigger filled from the apply's parameters: its target.input and a composio source's config typed (inputFilled),
 *  its enabled the boolean its one placeholder names, the rest as text. */
const triggerFilled = (trigger: Json, given: Record<string, unknown>): Json => {
  const out = filled(trigger, given) as Json;
  if (isObject(trigger.target) && trigger.target.input !== undefined) out.target = { ...(out.target as Json), input: inputFilled(trigger.target.input, given) };
  if (typeof trigger.enabled === "string" && WHOLE.test(trigger.enabled)) out.enabled = typedFilled(trigger.enabled, given);
  // A composio trigger's config is typed as a pin's values are: a value that is one placeholder alone takes the
  // parameter's type (an integer config field gets an integer).
  if (isObject(trigger.source) && trigger.source.kind === "composio" && isObject(trigger.source.config)) out.source = { ...(out.source as Json), config: inputFilled(trigger.source.config, given) };
  // A feed trigger's urls as one placeholder alone take the array its parameter names, whole; a list's URLs are text.
  if (isObject(trigger.source) && trigger.source.kind === "feed" && typeof trigger.source.urls === "string") out.source = { ...(out.source as Json), urls: typedFilled(trigger.source.urls, given) };
  return out;
};

/** The source of the package's trigger `name`, filled from the apply's `parameters` as an apply fills it (each parameter
 *  left out given its default): a template eval reads the feed URLs its case's trigger will read before it applies. */
export function filledSource(p: Package, name: string, parameters: Json): Json | undefined {
  const trigger = p.triggers.find((one) => one.name === name);
  if (!trigger) return undefined;
  const filledOne = triggerFilled(trigger, applyBodyOf(p, { parameters }).parameters);
  return isObject(filledOne.source) ? filledOne.source : undefined;
}

/** An mcp entry's `pin` read: by tool, each one of the entry's `tools`, its arguments checked by the one rule every pin
 *  is (tool-plane.ts pinIssues, on the tool's gate name), text in it may hold `${parameters.<name>}` (checked with the
 *  other placeholders). Each problem is told through `bad`; a tool whose pin reads is kept. */
function pinOf(pin: unknown, server: string, tools: readonly string[], at: string, bad: (message: string) => void): Record<string, Record<string, PinValue>> {
  const out: Record<string, Record<string, PinValue>> = {};
  if (!isObject(pin)) return bad(`${at} is {<tool>: {<argument>: <value or \${parameters.<name>}, a list of them, or {keys: [<key or \${parameters.<name>}>]}>}}, by the entry's tools`), out;
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

/** A pin's scalar filled from the apply's `given` parameters (typedFilled: an integer pins an integer), a list's items
 *  as text. `empty`: the parameters its placeholders name that were given no value (absent, or ""), so the pin cannot
 *  hold what the owner meant. */
function scalarFilled(value: PinScalar, given: Record<string, unknown>): { value: PinScalar; empty: string[] } {
  if (typeof value !== "string") return { value, empty: [] };
  const empty = [...value.matchAll(PLACEHOLDER)].map((match) => match[1]!).filter((name) => unset(givenOf(given, name)));
  const one = typedFilled(value, given);
  return { value: !empty.length && (typeof one === "string" || typeof one === "number" || typeof one === "boolean") ? one : (filled(value, given) as string), empty };
}
/** A keys pin's keys filled as text (scalarFilled), in their order; a key that is one placeholder alone of a list
 *  parameter adds each of its items: any of the fields the owner named. */
function keysFilled(keys: readonly string[], given: Record<string, unknown>): { value: PinKeys; empty: string[] } {
  const each = keys.map((key) => {
    const whole = WHOLE.exec(key);
    const list = whole ? givenOf(given, whole[1]!) : undefined;
    if (Array.isArray(list) && list.length) return { value: list.map(asText), empty: [] };
    const one = scalarFilled(key, given);
    return { value: [asText(one.value)], empty: one.empty };
  });
  return { value: { keys: each.flatMap((one) => one.value) }, empty: each.flatMap((one) => one.empty) };
}
/** A pin's value filled (scalarFilled), each of a one-of list's in its order, a keys pin's keys (keysFilled). One
 *  placeholder alone of a list parameter pins the list as a one-of: any of the values the owner gave. */
function pinFilled(value: PinValue, given: Record<string, unknown>): { value: PinValue; empty: string[] } {
  if (isPinKeys(value)) return keysFilled(value.keys, given);
  const list = typeof value === "string" ? typedFilled(value, given) : undefined;
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
function scalarSchema(type: ScalarType, f: Json, at: string, bad: (message: string) => void): Json {
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
 * A package's `inputs` (each run's typed input, the agent's input_schema) or `parameters` (the setup an apply takes),
 * compiled: a closed object schema of each field by its machine name, required unless it says `required: false`. The
 * vocabulary: type, required, title, description, examples, default, enum, pattern, format, minimum/maximum,
 * minLength/maxLength, and `type: array` of a scalar (`items`); nothing else. A default (on a field that is not
 * required) and each example meet their own field. An input named `content` is the run's message: a string. Undefined
 * when the package names none.
 */
function fieldsSchema(value: unknown, of: "inputs" | "parameters", bad: (message: string) => void): Json | undefined {
  if (value === undefined) return undefined;
  if (!isObject(value) || !Object.keys(value).length) return bad(`${of} is a mapping of each field, by its name`), undefined;
  const properties: Record<string, Json> = {};
  const required: string[] = [];
  for (const [key, f] of Object.entries(value)) {
    const at = `${of}.${key}`;
    if (!PARAMETER.test(key)) {
      bad(`${at}: a name is lowercase letters, digits and _, starting with a letter, at most 64`);
      continue;
    }
    if (!isObject(f) || !(INPUT_TYPES as readonly unknown[]).includes(f.type)) {
      bad(`${at} is {type: ${INPUT_TYPES.join(" | ")}, required?, title?, description?, examples?, default?, enum?, pattern?, format?, minimum?, maximum?, minLength?, maxLength?, items? (an array's scalar)}`);
      continue;
    }
    for (const issue of unknownFields(f, INPUT_KEYS)) bad(`${at} has no field ${issue.field}: the fields are ${INPUT_KEYS.join(", ")}`);
    if (of === "inputs" && key === "content" && f.type !== "string") bad(`${at} is a string: content is the run's message`);
    if (f.required !== undefined && typeof f.required !== "boolean") bad(`${at}.required is true or false`);
    for (const word of ["title", "description"]) if (f[word] !== undefined && !(typeof f[word] === "string" && (f[word] as string).trim())) bad(`${at}.${word} is text`);
    let schema: Json;
    if (f.type === "array") {
      const items = f.items;
      for (const word of ["pattern", "format", "enum", "minimum", "maximum", "minLength", "maxLength"]) if (f[word] !== undefined) bad(`${at}.${word} goes on its items: a list's keys are type, items and the words`);
      if (!isObject(items) || !(SCALAR_TYPES as readonly unknown[]).includes(items.type) || unknownFields(items, ITEM_KEYS).length) {
        bad(`${at}.items is {type: ${SCALAR_TYPES.join(" | ")}} and that scalar's keys: a list is a list of a scalar`);
        continue;
      }
      schema = { type: "array", items: scalarSchema(items.type as ScalarType, items, `${at}.items`, bad) };
    } else {
      if (f.items !== undefined) bad(`${at}.items is for type: array`);
      schema = scalarSchema(f.type as ScalarType, f, at, bad);
    }
    if (typeof f.title === "string") schema.title = f.title;
    if (typeof f.description === "string") schema.description = f.description;
    // A default and each example meet the field they are of, as the server checks a value given for it.
    const compiled = schemaCheck(schema);
    const meets = (one: unknown) => !("why" in compiled) && !compiled.check(one).length;
    if (f.examples !== undefined) {
      if (Array.isArray(f.examples) && f.examples.length && f.examples.every(meets)) schema.examples = f.examples;
      else bad(`${at}.examples is a list of one or more values it takes`);
    }
    if (f.default !== undefined) {
      if (f.required !== false) bad(`${at} is required and has a default: a default is for one that may be left out (required: false)`);
      else if (!meets(f.default)) bad(`${at}.default is not a value it takes`);
      else schema.default = f.default;
    }
    properties[key] = schema;
    if (f.required !== false) required.push(key);
  }
  return { type: "object", additionalProperties: false, ...(required.length ? { required } : {}), properties };
}

/** Reads the package at `from` (its folder, or its files: PackageFiles) checked whole: a valid package, or PackageError
 *  with every problem found. */
export function readPackage(from: string | PackageFiles, { evalFixtures = true }: { evalFixtures?: boolean } = {}): Package {
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
  // Display only: what a marketplace page and the console's list file it under, and its tags.
  if (f.category !== undefined && !(CATEGORIES as readonly unknown[]).includes(f.category)) bad(MANIFEST, `category is one of ${CATEGORIES.join(", ")}`);
  const tags = f.tags === undefined ? [] : Array.isArray(f.tags) && f.tags.length <= MAX_TAGS && f.tags.every((tag) => typeof tag === "string" && TAG.test(tag)) && new Set(f.tags).size === f.tags.length ? (f.tags as string[]) : (bad(MANIFEST, `tags is a list of at most ${MAX_TAGS} tags, each once, each lowercase letters, digits and dashes (${TAG.source})`), []);
  const harness = f.harness === undefined ? undefined : list(f.harness, "harness", (id) => (HARNESSES as readonly string[]).includes(id));
  if (harness && !harness.length) bad(MANIFEST, `harness is a non-empty preference list of ${HARNESSES.join(", ")}; leave it out for any`);
  const ref = (value: unknown) => value === undefined || (typeof value === "string" && MODEL_REF.test(value));
  if (f.model !== undefined && !(isObject(f.model) && !unknownFields(f.model, ["tier", "prefer", ...MODEL_TIER_NAMES, "choices"]).length && typeof f.model.tier === "string" && Object.hasOwn(MODEL_TIERS, f.model.tier) && ref(f.model.prefer) && MODEL_TIER_NAMES.every((tier) => ref((f.model as Record<string, unknown>)[tier])))) bad(MANIFEST, `model is {tier: ${Object.keys(MODEL_TIERS).join(" | ")}, prefer?: "provider/model-id", ${MODEL_TIER_NAMES.map((tier) => `${tier}?: "provider/model-id"`).join(", ")}, choices?: [${CHOICE_WORDS}]}`);
  // The named models an owner may pick one of at install; the package's own tier and preference stay the default.
  const choices = isObject(f.model) && f.model.choices !== undefined ? modelChoices(f.model.choices, harness, (message) => bad(MANIFEST, message)) : undefined;
  if (f.effort !== undefined && !(THINKING_LEVELS as readonly unknown[]).includes(f.effort)) bad(MANIFEST, `effort is one of ${THINKING_LEVELS.join(", ")}`);
  const tools = f.tools === undefined ? undefined : list(f.tools, "tools");
  if (tools?.some(isMcpName)) bad(MANIFEST, "tools grants no MCP tool: mcp lists them, by server");
  // A monid endpoint (monid:<provider>/<endpoint> or monid:<provider>/*) is granted as written and pinned at the apply's save.
  for (const tool of tools?.filter((tool) => !isMcpName(tool) && !(isMonidName(tool) && parseToolName(tool)) && !BOUND_TOOLS.includes(tool)) ?? []) bad(MANIFEST, isMonidName(tool) ? `tools: ${MONID_NAME_WORDS(tool)}` : `tools: ${tool} is not a tool this server binds (${BOUND_TOOLS.join(", ")})`);
  const mcp: McpNeed[] = [];
  // Each need by where its tools come from (source, toolkit), never by a saved server's name: the package names its tools
  // mcp:<toolkit>/<tool>, and apply maps the toolkit to the server the owner saved for it.
  for (const [i, need] of (f.mcp === undefined ? [] : Array.isArray(f.mcp) ? f.mcp : (bad(MANIFEST, "mcp is a list of {source, toolkit, tools, required?, reason?, allow?, pin?}"), [])).entries()) {
    const names = isObject(need) && Array.isArray(need.tools) ? need.tools : [];
    const allow = isObject(need) && need.allow !== undefined ? need.allow : [];
    const pin = isObject(need) && need.pin !== undefined ? need.pin : {};
    const reason = isObject(need) ? need.reason : undefined;
    const ok = isObject(need) && !unknownFields(need, ["source", "toolkit", "tools", "required", "reason", "allow", "pin"]).length && (MCP_SOURCES as readonly unknown[]).includes(need.source) && typeof need.toolkit === "string" && MCP_SERVER_NAME.test(need.toolkit)
      && names.length > 0 && names.every((tool) => typeof tool === "string" && MCP_TOOL_NAME.test(tool)) && new Set(names).size === names.length && (need.required === undefined || typeof need.required === "boolean")
      && (reason === undefined || (typeof reason === "string" && reason.trim() !== "" && reason.length <= MAX_REASON && !/[\r\n]/.test(reason)))
      && Array.isArray(allow) && allow.every((tool) => names.includes(tool)) && new Set(allow).size === allow.length;
    // A toolkit is held to the MCP server name rule (tool-names.ts), so mcp:<toolkit>/<tool> inside the package is a catalog
    // name every place that checks one (an agent's grant, a tool setting, a learned workflow) takes.
    if (isObject(need) && need.toolkit !== undefined && (typeof need.toolkit !== "string" || !MCP_SERVER_NAME.test(need.toolkit))) bad(MANIFEST, `mcp[${i}].toolkit ${JSON.stringify(need.toolkit)} is not a toolkit name: ${MCP_SERVER_NAME.source}, the MCP server name rule, since the package names its tools mcp:<toolkit>/<tool>`);
    else if (!ok) bad(MANIFEST, `mcp[${i}] is {source: ${MCP_SOURCES.join(" | ")}, toolkit: the toolkit its tools come from, the name the package calls them by (mcp:<toolkit>/<tool>, ${MCP_SERVER_NAME.source}), tools: its tool names (${MCP_TOOL_NAME.source}), none twice, required?: true or false, reason?: one line of at most ${MAX_REASON} characters on why the agent needs them, allow?: the tools of its tools it asks the owner to allow, pin?: {<tool>: {<argument>: <value>}}}`);
    else if (need.source === "github" && need.toolkit !== "github") bad(MANIFEST, `mcp[${i}]: a github source's toolkit is github (GitHub's MCP server), not ${need.toolkit as string}`);
    else if (mcp.some((m) => m.toolkit === need.toolkit)) bad(MANIFEST, `mcp[${i}]: the toolkit ${need.toolkit as string} is listed twice: its tools are all mcp:${need.toolkit as string}/<tool>, so they are one entry`);
    else {
      const pinned = pinOf(pin, need.toolkit as string, names as string[], `mcp[${i}].pin`, (message) => bad(MANIFEST, message));
      mcp.push({ source: need.source as McpSource, toolkit: need.toolkit as string, tools: names as string[], required: need.required === true, ...(typeof reason === "string" ? { reason } : {}), allow: allow as string[], pin: pinned });
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
  // The setup an apply takes, in the inputs' grammar, by the same compiler; none, a schema of no fields.
  const parameters = fieldsSchema(f.parameters, "parameters", (message) => bad(MANIFEST, message)) ?? { type: "object", additionalProperties: false, properties: {} };
  const fields = fieldsOf(parameters);
  const inputSchema = fieldsSchema(f.inputs, "inputs", (message) => bad(MANIFEST, message));
  const secrets = list(f.secrets, "secrets", (secret) => /^[A-Z][A-Z0-9_]{0,127}$/.test(secret));
  for (const secret of secrets.filter((name) => !PACKAGE_SECRETS.includes(name))) bad(MANIFEST, `secrets names ${secret}, a key this server cannot hold: a package needs the keys Settings saves and a run is handed (${PACKAGE_SECRETS.join(", ")})`);
  // Each run's limit: its spend cap (per_run_usd, the agent's max_cost_usd), required once a budget is given.
  const perRun = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value > 0;
  if (f.budget !== undefined && !(isObject(f.budget) && !unknownFields(f.budget, ["per_run_usd"]).length && perRun(f.budget.per_run_usd))) bad(MANIFEST, "budget is {per_run_usd: a number above 0}");
  const learningIssue = f.learning === undefined ? undefined : learningSettingIssue(f.learning, "learning");
  if (learningIssue) bad(MANIFEST, learningIssue);
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
    // What makes a composio trigger on Composio is this server's to set, at the create: a package carrying it would run on
    // an instance made elsewhere, or move the project's subscription here unasked.
    const source = isObject(trigger) ? trigger.source : undefined;
    const set = isObject(source) && source.kind === "composio" ? COMPOSIO_SET.filter((field) => source[field] !== undefined) : [];
    if (set.length) bad(MANIFEST, `triggers[${i}].source holds ${set.join(" and ")}, which this server sets when it makes a composio trigger on Composio: a template can't carry ${set.length > 1 ? "them" : "it"}. Leave ${set.length > 1 ? "them" : "it"} out, or make the trigger from the console on this server (Triggers → New app trigger) once the agent is made.`);
    // Its server is one of the package's own needs, by its toolkit, as mcp:<toolkit>/<tool> names its tools: no saved
    // server's name, which is only the author's. The apply makes it on the saved server that need resolves to
    // (onServers). A required need: one with no saved server refuses the apply, so the trigger is never made without one.
    if (isObject(source) && source.kind === "composio") {
      const need = mcp.find((one) => one.toolkit === source.server);
      if (!need || need.source !== "composio") bad(MANIFEST, `triggers[${i}].source.server ${JSON.stringify(source.server)} names no MCP need of the package with source: composio: a template's composio trigger names that need's toolkit (server: github for the need {source: composio, toolkit: github}), and the apply makes it on the saved Composio server the need resolves to`);
      else if (!need.required) bad(MANIFEST, `triggers[${i}].source.server ${need.toolkit}: the trigger's server is the mcp need of the toolkit ${need.toolkit}, so that need is required: true. An optional one may have no saved server here, and the trigger would have none`);
    }
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
  // Each agree_on path is a required field of the answer's schema at every level: one an answer may leave out is
  // missing on both sides, and a missing path never agrees, so the check could never promote on it.
  if (!learningIssue && isObject(outputSchema)) {
    for (const [i, path] of (agreeOnOf(f.learning) ?? []).entries()) {
      const why = undeclaredPath(outputSchema, path);
      if (why) bad(MANIFEST, `learning.agree_on[${i}] is ${path}, which ${(f.output as { schema: string }).schema} ${why}`);
    }
  }
  const instructions = manifest?.body.trim() ?? "";
  if (manifest && !instructions) bad(MANIFEST, "its body is empty: the body is the agent's instructions");
  for (const value of strings([instructions, triggers, f.display_name, mcp.map((need) => need.pin)])) {
    for (const [, used] of value.matchAll(PLACEHOLDER)) if (!Object.hasOwn(fields, used!)) bad(MANIFEST, `\${parameters.${used}} names no parameter`);
  }
  // A placeholder fills text a run reads, a schedule's time (its cron and timezone, read as the schedule at apply), a
  // github, webhook, composio or feed trigger's where `in` values (the repository it takes, say), a composio trigger's
  // config values (what Composio watches for it: the owner's repository, team or label), and a feed trigger's urls (a
  // placeholder inside a URL, or the whole list as one naming an array parameter); a trigger's other settings, a
  // composio trigger's server and event and a feed trigger's every_s, items and id among them, are the package's own,
  // checked here. A parameter that sets a time has a default, so the schedule the package ships is checked here too; one
  // a where, a composio config or a feed's urls take is required or has a default, so the trigger never fills empty.
  triggers.forEach((trigger, i) => {
    if (!isObject(trigger)) return;
    const timed = isObject(trigger.source) && trigger.source.kind === "schedule";
    const filtered = isObject(trigger.source) && FILTERED_KINDS.includes(trigger.source.kind as string);
    const fixed = Object.entries(trigger).flatMap(([key, value]) =>
      key === "target" && isObject(value) ? Object.entries(value).filter(([k]) => k !== "input").map(([k, v]) => [`target.${k}`, v] as const)
      : key === "source" && timed && isObject(value) ? Object.entries(value).filter(([k]) => !SCHEDULE_FIELDS.includes(k)).map(([k, v]) => [`source.${k}`, v] as const)
      : key === "source" && filtered && isObject(value) && value.kind === "composio" ? Object.entries(whereIns(value).rest).filter(([k]) => k !== "config").map(([k, v]) => [`source.${k}`, v] as const)
      : key === "source" && filtered && isObject(value) && value.kind === "feed" ? Object.entries(whereIns(value).rest).filter(([k]) => k !== "urls").map(([k, v]) => [`source.${k}`, v] as const)
      : key === "source" && filtered && isObject(value) ? [[key, whereIns(value).rest] as const]
      : key === "enabled" && typeof value === "string" ? []
      : [[key, value] as const]);
    for (const [at, value] of fixed) for (const [used] of strings(value).flatMap((text) => [...text.matchAll(PLACEHOLDER)])) bad(MANIFEST, `triggers[${i}].${at} holds ${used}: a placeholder goes in display_name, the instructions, a trigger's target.input, a schedule's cron and timezone, a github, webhook, composio or feed trigger's where in values, a composio trigger's config values, a feed trigger's urls, or an mcp pin's values`);
    // enabled is true, false, or one boolean parameter with a default, filled at apply (triggerFilled): the trigger is on
    // or off by the owner's answer, and by the package's default when the apply leaves it out.
    if (typeof trigger.enabled === "string") {
      const rule = `triggers[${i}].enabled is true, false, or one placeholder alone, "\${parameters.<name>}", naming a boolean parameter with a default`;
      const whole = WHOLE.exec(trigger.enabled);
      const spec = whole && Object.hasOwn(fields, whole[1]!) ? fields[whole[1]!] : undefined;
      if (!whole) bad(MANIFEST, rule);
      else if (spec && spec.type !== "boolean") bad(MANIFEST, `${rule}: parameters.${whole[1]} is a ${spec.type as string}`);
      else if (spec && spec.default === undefined) bad(MANIFEST, `${rule}: parameters.${whole[1]} has no default, and the trigger is on or off even when the apply leaves it out`);
    }
    if (filtered) {
      for (const used of new Set(strings(whereIns(trigger.source as Json).ins).flatMap((text) => [...text.matchAll(PLACEHOLDER)].map((m) => m[1]!)))) {
        if (Object.hasOwn(fields, used) && !(parameters.required as string[] | undefined)?.includes(used) && fields[used]!.default === undefined) bad(MANIFEST, `parameters.${used} is used in triggers[${i}].source.accept, so it is required or has a default: a ${(trigger.source as Json).kind as string} trigger filled empty takes no event`);
      }
    }
    // A feed's urls: a list whose URLs may hold placeholders, or one placeholder alone naming an array-of-strings
    // parameter, filled whole; each parameter they name required or with a default, so the trigger never reads none.
    if (isObject(trigger.source) && trigger.source.kind === "feed") {
      const urls = trigger.source.urls;
      if (typeof urls === "string") {
        const rule = `triggers[${i}].source.urls is a list of URLs, or one placeholder alone, "\${parameters.<name>}", naming an array parameter of strings`;
        const whole = WHOLE.exec(urls);
        const spec = whole && Object.hasOwn(fields, whole[1]!) ? fields[whole[1]!] : undefined;
        if (!whole) bad(MANIFEST, rule);
        else if (spec && (spec.type !== "array" || !isObject(spec.items) || spec.items.type !== "string")) bad(MANIFEST, `${rule}: parameters.${whole[1]} is ${spec.type === "array" ? "an array of other than strings" : `a ${String(spec.type)}`}`);
      }
      for (const used of new Set(strings(urls).flatMap((text) => [...text.matchAll(PLACEHOLDER)].map((m) => m[1]!)))) {
        if (Object.hasOwn(fields, used) && !(parameters.required as string[] | undefined)?.includes(used) && fields[used]!.default === undefined) bad(MANIFEST, `parameters.${used} is used in triggers[${i}].source.urls, so it is required or has a default: a feed trigger filled empty reads no feed`);
      }
    }
    if (isObject(trigger.source) && trigger.source.kind === "composio") {
      for (const used of new Set(strings(trigger.source.config).flatMap((text) => [...text.matchAll(PLACEHOLDER)].map((m) => m[1]!)))) {
        if (Object.hasOwn(fields, used) && !(parameters.required as string[] | undefined)?.includes(used) && fields[used]!.default === undefined) bad(MANIFEST, `parameters.${used} is used in triggers[${i}].source.config, so it is required or has a default: a composio trigger filled empty watches nothing of the owner's (Composio refuses a required config value left empty)`);
      }
    }
    if (!timed) return;
    for (const field of SCHEDULE_FIELDS) {
      for (const [, used] of strings((trigger.source as Json)[field]).flatMap((text) => [...text.matchAll(PLACEHOLDER)])) {
        if (Object.hasOwn(fields, used!) && fields[used!]!.default === undefined) bad(MANIFEST, `parameters.${used} is used in triggers[${i}].source.${field}, so it needs a default: the schedule the package ships is checked with it`);
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
    const caseDoc = own.includes("case.yaml") ? parseDocument(text(`${at}/case.yaml`), { uniqueKeys: true }) : undefined;
    if (caseDoc?.errors.length) bad(`${at}/case.yaml`, "is not YAML");
    // An email or feed case's run is its trigger's, on the trigger's input (template-eval.ts): its prompt.md has no body.
    const caseJs = !!caseDoc && !caseDoc.errors.length && isObject(caseDoc.toJS()) ? (caseDoc.toJS() as Json) : undefined;
    const triggeredCase = caseJs !== undefined && (caseJs.email !== undefined || caseJs.feed !== undefined);
    if (!own.includes("prompt.md")) bad(at, "has no prompt.md");
    else if (!triggeredCase && !front(`${at}/prompt.md`, false)?.body.trim()) bad(`${at}/prompt.md`, "its body is empty: the body is the run's input");
    // A case's web fixture is checked as eval-template checks it, in the same words (web-fake.ts).
    if (evalFixtures && caseJs !== undefined && typeof caseJs.web === "string" && caseJs.web !== "unavailable" && own.includes(caseJs.web) && caseJs.web.startsWith("fixtures/")) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(text(`${at}/${caseJs.web}`));
      } catch (error) {
        bad(`${at}/${caseJs.web}`, `is not JSON (${(error as Error).message})`);
      }
      if (parsed !== undefined) webFixtureOf(parsed, `${at}/${caseJs.web}`, (message) => void problems.push(message));
    }
    const graders = own.filter((p) => p.startsWith("graders/"));
    if (!graders.length) bad(at, "has no graders/*.md");
    for (const path of graders) {
      const grader = front(`${at}/${path}`);
      if (!grader) continue;
      if (!(GRADER_TYPES as readonly unknown[]).includes(grader.data.type)) bad(`${at}/${path}`, `type is one of ${GRADER_TYPES.join(", ")}`);
    }
  }

  if (problems.length) throw new PackageError(dir, [...new Set(problems)]);
  const p: Package = {
    id: name, origin: null, name, ...(typeof f.display_name === "string" ? { displayName: f.display_name } : {}), version: f.version as string, description: f.description as string,
    ...(typeof f.license === "string" ? { license: f.license } : {}), ...(isObject(f.author) ? { author: f.author } : {}), ...(typeof f.repository === "string" ? { repository: f.repository } : {}),
    ...(typeof f.category === "string" ? { category: f.category as NonNullable<Package["category"]> } : {}), tags,
    ...(harness ? { harness } : {}), ...(isObject(f.model) ? { model: { ...(f.model as NonNullable<Package["model"]>), ...(choices ? { choices } : {}) } } : {}), ...(typeof f.effort === "string" ? { effort: f.effort } : {}),
    ...(tools ? { tools } : {}), mcp, ...(computer ? { computer } : {}), ...(toolPolicy ? { toolPolicy } : {}), ...(f.checkout === "pull_request" ? { checkout: "pull_request" as const } : {}), parameters, ...(inputSchema ? { inputSchema } : {}), secrets, ...(isObject(f.budget) ? { budget: { per_run_usd: f.budget.per_run_usd as number } } : {}), ...(f.learning !== undefined ? { learning: learningSettingOf(f.learning as LearningSetting) } : {}), ...(f.approvals === "ask" || f.approvals === "never" ? { approvals: f.approvals } : {}),
    triggers: triggers as Json[], ...(isObject(f.output) ? { output: { schema: f.output.schema as string } } : {}), ...(isObject(outputSchema) ? { outputSchema } : {}), instructions, skills, evals,
  };
  // What an apply makes, made here with each parameter's default, else a sample of its type, and checked as POST
  // /v2/agents and POST /v2/triggers check their bodies (all but the agent the trigger names, which an apply makes). A
  // trigger's times are read as of the epoch, so its form is checked here and a date that has passed is the apply's
  // refusal, never a server's start.
  const samples = Object.fromEntries(Object.entries(fields).map(([key, spec]) => [key, spec.default ?? (spec.type === "array" ? [sampleOf(spec.items as Json)] : sampleOf(spec))]));
  const declared = Object.fromEntries(MODEL_TIER_NAMES.flatMap((tier) => (p.model?.[tier] ? [[tier, p.model[tier]!]] : [])));
  // Every MCP tool ticked, each served under its toolkit's name: the widest agent an apply can make, so each tool the
  // package lists is checked as a grant.
  const every = mcp.flatMap(({ toolkit, tools: listed }) => listed.map((tool) => mcpToolName(toolkit, tool)));
  const made = compiled(p, samples, { ...(harness ? { harness: harness[0]! } : {}), ...(p.model?.prefer ? { model: p.model.prefer } : {}), ...(Object.keys(declared).length ? { modelTiers: declared } : {}), mcp: mcp.map((need) => ({ ...need, server: need.toolkit })), defaultTools: [], grants: every });
  for (const issue of definitionBodyIssues(made.agent)) bad(issue.field.startsWith("skills.") ? `skills/${issue.field.slice("skills.".length)}` : MANIFEST, `${issue.field.startsWith("skills.") ? "" : `the agent it makes: ${issue.field}: `}${issue.message}`);
  // A sample stands in for a value apply is given: at a target.input field a parameter with no default fills whole, what
  // hangs on the value (a pattern, a bound, a choice) is the apply's, on the value given. Its type, and whether the
  // inputs name the field at all, are checked here.
  const sampled = (field: string): boolean => {
    // A feed's URL filled from a parameter with no default holds a sample, no URL: the apply checks the value given.
    const url = /^triggers\.(\d+)\.source\.urls(?:\[(\d+)\])?$/.exec(field);
    if (url) {
      const urls = (p.triggers[Number(url[1])]?.source as Json | undefined)?.urls;
      const named = (text: unknown) => strings(text).flatMap((one) => [...one.matchAll(PLACEHOLDER)].map((m) => m[1]!));
      const used = typeof urls === "string" ? named(urls) : Array.isArray(urls) && url[2] !== undefined ? named(urls[Number(url[2])]) : [];
      return used.some((name) => Object.hasOwn(fields, name) && fields[name]!.default === undefined);
    }
    const at = /^triggers\.(\d+)\.target\.input\.([^.]+)/.exec(field);
    const target = at ? (p.triggers[Number(at[1])]?.target as Json | undefined) : undefined;
    const value = at && isObject(target) && isObject(target.input) ? target.input[at[2]!] : undefined;
    const whole = typeof value === "string" ? WHOLE.exec(value) : null;
    return !!whole && Object.hasOwn(fields, whole[1]!) && fields[whole[1]!]!.default === undefined;
  };
  // A trigger's enabled given as text is said above, by its own rule, not again as POST /v2/triggers words it.
  const saidEnabled = (field: string): boolean => {
    const at = /^triggers\.(\d+)\.enabled$/.exec(field);
    return !!at && typeof p.triggers[Number(at[1])]?.enabled === "string";
  };
  // A feed trigger a parameter's default leaves with no feeds is skipped at apply (feedLeftEmpty), never refused: so its
  // urls are not refused here. Every other field of it is checked, as the apply makes it once the owner sets urls.
  const skippedAtApply = (field: string): boolean => {
    const at = /^triggers\.(\d+)\.source\.urls(?:\[\d+\])?$/.exec(field);
    const trigger = at ? made.triggers[Number(at[1])] : undefined;
    return !!trigger && feedLeftEmpty(trigger);
  };
  for (const issue of madeTriggerIssues(made.triggers, 0, p.inputSchema)) if (!saidEnabled(issue.field) && !skippedAtApply(issue.field) && (["wrong_type", "not_allowed", "missing"].includes(issue.reason) || !sampled(issue.field))) bad(MANIFEST, `${issue.field.replace(/^triggers\.(\d+)\./, "triggers[$1].")}: ${issue.message}`);
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
    category: p.category ?? null, tags: p.tags,
    output: p.output ? { schema: p.output.schema, json_schema: p.outputSchema ?? null } : null,
    harness: p.harness ?? null, model: modelView(p.model), effort: p.effort ?? null, tools: p.tools ?? null, tool_policy: p.toolPolicy ?? null, computer: p.computer ?? null, checkout: p.checkout ?? null,
    mcp: p.mcp.map(({ source, toolkit, tools, required, reason, allow, pin }) => ({ source, toolkit, required, reason: reason ?? null, tools: tools.map((name) => ({ name, tool: mcpToolName(toolkit, name), asks: allow.includes(name) ? "allow" : "ask", ...(Object.hasOwn(pin, name) ? { pin: pin[name]! } : {}) })) })), parameters: p.parameters, input_schema: p.inputSchema ?? null, secrets: p.secrets,
    budget: p.budget ?? null, learning: p.learning ?? false, approvals_default: p.approvals ?? "ask", triggers: p.triggers, skills: Object.keys(p.skills).filter((path) => /^[^/]+\/SKILL\.md$/.test(path)).map((path) => path.slice(0, -"/SKILL.md".length)), evals: p.evals,
  };
}

/** A package's model as GET /v2/templates lists it: each choice whole, a warning or note it has none of null. */
function modelView(model: Package["model"]) {
  if (!model) return null;
  const { choices, ...rest } = model;
  return { ...rest, ...(choices ? { choices: choices.map(({ id, label, model: ref, harness, warning, note, secrets }) => ({ id, label, model: ref, harness, warning: warning ?? null, note: note ?? null, secrets })) } : {}) };
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

/** POST /v2/templates/{name}/apply's body (`{parameters, grants?, servers?, overrides?: {model?, choice?, approvals?}, agent_id?}`), checked
 *  against the package: the parameters as given (a blank one at its default), the MCP tools the owner allows (each one the
 *  package lists, by its gate name), and the model asked for in place of the package's: one of its own (`model`), or one
 *  of the package's model choices by id (`choice`), never both. 422 naming every field that is wrong. */
export function applyBodyOf(p: Package, body: Json): { parameters: Json; grants: string[]; servers: Record<string, string>; model?: string; choice?: ModelChoice; approvals?: Approvals; agentId?: string } {
  const issues: InputIssue[] = unknownFields(body, ["parameters", "grants", "servers", "overrides", "agent_id"]);
  // The agent an update writes onto (the server checks it was made from this package): text, else a 422 with the rest.
  if (body.agent_id !== undefined && !(typeof body.agent_id === "string" && body.agent_id.trim())) issues.push({ field: "agent_id", reason: "wrong_type", message: `agent_id is the id of an agent the ${p.name} template made: the apply writes a new revision of it in place of making another` });
  const listed = p.mcp.flatMap(({ toolkit, tools }) => tools.map((tool) => mcpToolName(toolkit, tool)));
  const grants: string[] = [];
  if (body.grants !== undefined && !Array.isArray(body.grants)) issues.push({ field: "grants", reason: "wrong_type", message: "grants is a list of the package's MCP tools, by the package's own names (mcp:<toolkit>/<tool>), the owner allows" });
  // The owner's pick of a saved server for a toolkit (when several match): checked against what is saved at apply.
  const servers: Record<string, string> = {};
  if (body.servers !== undefined && !isObject(body.servers)) issues.push({ field: "servers", reason: "wrong_type", message: "servers is an object: {<toolkit>: <the saved MCP server's name>}, for a need several saved servers match" });
  for (const [toolkit, name] of Object.entries(isObject(body.servers) ? body.servers : {})) {
    if (!p.mcp.some((need) => need.toolkit === toolkit)) issues.push({ field: `servers.${toolkit}`, reason: "not_allowed", message: `The package ${p.name} uses no toolkit ${toolkit}: its MCP needs are ${p.mcp.map((need) => need.toolkit).join(", ") || "none"}.` });
    else if (typeof name !== "string" || !MCP_SERVER_NAME.test(name)) issues.push({ field: `servers.${toolkit}`, reason: "wrong_type", message: `servers.${toolkit} is the name of a saved MCP server` });
    else servers[toolkit] = name;
  }
  for (const [i, grant] of (Array.isArray(body.grants) ? body.grants : []).entries()) {
    if (typeof grant !== "string" || !listed.includes(grant)) issues.push({ field: `grants.${i}`, reason: "not_allowed", message: `grants.${i} is not a tool of the package ${p.name}: it grants ${listed.join(", ") || "no MCP tool"}.` });
    else if (!grants.includes(grant)) grants.push(grant);
  }
  const given = body.parameters ?? {};
  if (!isObject(given)) issues.push({ field: "parameters", reason: "wrong_type", message: "parameters is an object of the package's parameters, by name" });
  // A parameter left blank (left out, or "") takes its default; then they are checked as a run's input is (the same
  // compiler, the same words), so a blank required one is missing.
  // A declared parameter given blank is left out (its default filled); an undeclared one stays, for the check to refuse.
  const fields = fieldsOf(p.parameters);
  const blank = (key: string) => !isObject(given) || givenOf(given, key) === undefined || given[key] === "";
  const parameters: Json = Object.fromEntries([
    ...Object.entries(isObject(given) ? given : {}).filter(([key]) => !blank(key) || !Object.hasOwn(fields, key)),
    ...Object.entries(fields).filter(([key, spec]) => blank(key) && spec.default !== undefined).map(([key, spec]) => [key, spec.default]),
  ]);
  if (isObject(given)) issues.push(...inputIssues(parameters, p.parameters, "parameters"));
  const overrides = body.overrides ?? {};
  if (!isObject(overrides)) issues.push({ field: "overrides", reason: "wrong_type", message: "overrides is an object: {model?, choice?, approvals?}" });
  const choices = p.model?.choices ?? [];
  const choice = isObject(overrides) ? choices.find((one) => one.id === overrides.choice) : undefined;
  if (isObject(overrides)) {
    issues.push(...unknownFields(overrides, ["model", "choice", "approvals"]).map((i) => ({ ...i, field: `overrides.${i.field}`, message: "An apply overrides the model (one of its own, or one of the package's choices) and the approvals alone." })));
    if (overrides.approvals !== undefined && !(APPROVALS as readonly unknown[]).includes(overrides.approvals)) issues.push({ field: "overrides.approvals", reason: "not_an_option", message: `overrides.approvals is one of ${APPROVALS.join(", ")}: never runs the agent unattended, while a deny still refuses` });
    if (overrides.model !== undefined && !(typeof overrides.model === "string" && MODEL_REF.test(overrides.model))) issues.push({ field: "overrides.model", reason: "bad_format", message: 'overrides.model is "provider/model-id"' });
    // A choice is the package's model and harness together; a model of the owner's own says something else: never both.
    if (overrides.choice !== undefined && overrides.model !== undefined) issues.push({ field: "overrides.choice", reason: "not_allowed", message: "overrides.choice and overrides.model say different things: send one, a choice of the package's by its id or a model of your own." });
    else if (overrides.choice !== undefined && !choice) issues.push({ field: "overrides.choice", reason: "not_an_option", message: choices.length ? `overrides.choice is one of ${choices.map((one) => one.id).join(", ")}: the package's model choices, by id.` : `The package ${p.name} offers no model choices: leave overrides.choice out.` });
  }
  if (issues.length) throw invalid(issues);
  return { parameters, grants, servers, ...(typeof body.agent_id === "string" ? { agentId: body.agent_id.trim() } : {}), ...(isObject(overrides) && typeof overrides.model === "string" ? { model: overrides.model } : {}), ...(choice ? { choice } : {}), ...(isObject(overrides) && (overrides.approvals === "ask" || overrides.approvals === "never") ? { approvals: overrides.approvals } : {}) };
}

/** The model a package's agent gets here, as `{model?, warning?}`: its `prefer` when this server runs it on `harness`
 *  with a key for its provider, else `refused` (preferUnrunnable): apply makes nothing, never the tier's model in its
 *  place. Through a gateway (AGENT_MODEL_BASE_URL), which never said it serves `prefer`, it is not used and a warning says
 *  so. With no `prefer`, or one skipped there, the server's model for its tier (hostModel: AGENT_MODEL_FAST, AGENT_MODEL
 *  or AGENT_MODEL_STRONG, else the default of a model key it holds), unless that is a gateway's own id with no provider,
 *  which no definition can name: then no model, and the agent runs on the server's default (a warning when the tier's
 *  model is not that default). No model either when the package names none or the server has none. */
export async function packageModel(env: NodeJS.ProcessEnv, model: Package["model"], harness: string): Promise<{ model?: string; warning?: string; refused?: { why: string; fix: string } }> {
  if (!model) return {};
  // Through a gateway, only the gateway knows what it serves: a preferred model it never named is not picked, and the
  // owner is told (overrides.model picks one it serves).
  const gateway = Boolean(env.AGENT_MODEL_BASE_URL);
  const skipped = model.prefer && gateway ? `model.prefer ${model.prefer} is not used: this server reaches its models through a gateway, which has not said it serves that model.` : undefined;
  if (model.prefer && !gateway) {
    const refused = await preferUnrunnable(env, model.prefer, harness, Boolean(model.choices?.length));
    return refused ? { refused } : { model: model.prefer };
  }
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

/** `model` on `harness` as a save and a run take it (runnable.ts harnessModel, on the harness's own route), and where it
 *  runs, refused all the same when no catalog here lists the entry its runs are priced by (the harness's priceModel):
 *  claude-agent takes any Anthropic id on its own, and a package's model no catalog knows makes an agent whose runs fail
 *  at the provider. A faux model server runs any. */
async function modelHere(env: NodeJS.ProcessEnv, harness: string, model: string): ReturnType<typeof harnessModel> {
  const chosen = await harnessModel(env, harness, model, true);
  if (!chosen || !("model" in chosen) || env[FAUX_ENV]) return chosen;
  const priced = harnessOf(env, harness)?.priceModel(env, chosen.model) ?? chosen.model;
  if ((await providerModels(env)).getModel(priced.provider, priced.modelId)) return chosen;
  return { why: `${model} is not a model ${harness} runs here: no model catalog here lists it`, host: false, needs: "model" };
}

/** Why this server can't run a package's `prefer` on `harness`, and what the owner does about it, as `{why, fix}` in
 *  words; undefined when it can. Asked as a save and a run ask it (runnable.ts harnessModel), on the harness's own
 *  route: codex reaches an OpenAI model through OpenRouter's key alone. A missing key names its provider and Settings → Model keys; a model no catalog here
 *  lists, or one the harness does not run, only another model: overrides.model, or a model choice where the package
 *  has them (`choices`). */
async function preferUnrunnable(env: NodeJS.ProcessEnv, prefer: string, harness: string, choices: boolean): Promise<{ why: string; fix: string } | undefined> {
  const other = `apply with overrides.model${choices ? " or one of the package's model choices (overrides.choice)" : ""}.`;
  const another = `${other[0]!.toUpperCase()}${other.slice(1)}`;
  if (!harnessRuns(env, prefer, harness)) return { why: `${harness} does not run it`, fix: another };
  const chosen = await modelHere(env, harness, prefer);
  if (chosen && "model" in chosen) return undefined;
  if (chosen && "why" in chosen && chosen.needs === "model") return { why: "no model catalog here lists it", fix: another };
  const row = MODEL_KEYS.find((one) => one.id === prefer.slice(0, prefer.indexOf("/")));
  if (chosen && "why" in chosen && chosen.needs === "key" && row && !env[row.field]) return { why: `no ${row.label} key is saved here`, fix: `Save ${/^[AEIOU]/.test(row.label) ? "an" : "a"} ${row.label} key in Settings → Model keys, or ${other}` };
  return { why: (chosen === undefined ? `${harness} does not run here` : "refused" in chosen ? chosen.refused : chosen.why).replace(/\.$/, ""), fix: another };
}

/** Why this server can't run a model choice's model on its harness, in words; undefined when it can. As with `prefer`
 *  (packageModel), a choice is never swapped for the tier's model: the owner who picked it gets it, or apply refuses. The
 *  harness is the server's offer of it (`offer`, capabilities' harnesses): one not available here runs nothing. The model
 *  is asked of the harness's own route, as a save and a run ask it (runnable.ts harnessModel). A gateway
 *  (AGENT_MODEL_BASE_URL) never said it serves the model, so a choice is refused there, as `prefer` is skipped. */
export async function choiceUnrunnable(env: NodeJS.ProcessEnv, choice: ModelChoice, offer: { available: boolean; reason?: string } | undefined): Promise<string | undefined> {
  if (!offer?.available) return `${choice.harness} is not available here${offer?.reason ? `: ${offer.reason.replace(/\.$/, "")}` : ""}`;
  if (env.AGENT_MODEL_BASE_URL) return "this server reaches its models through a gateway, which has not said it serves that model; overrides.model picks one it serves";
  if (!harnessRuns(env, choice.model, choice.harness)) return `${choice.harness} does not run that model here`;
  const chosen = await modelHere(env, choice.harness, choice.model);
  return chosen === undefined ? `${choice.harness} does not run here` : "refused" in chosen ? chosen.refused : "why" in chosen ? chosen.why : undefined;
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
 *  every `${parameters.x}` filled. `grants`, the owner's answer at apply (the tools ticked, by the saved servers' names):
 *  of the package's tools on `mcp`, its needs each served by a saved server, those alone are granted, beside the package's
 *  tools (or, when it names none, `defaultTools`, those this server gives a new agent). A grant writes no permission: each
 *  call follows this server's tool settings, so under approvals ask a write asks the owner unless the owner allowed it
 *  there, a read runs where the owner turned on Allow reads for its server and asks otherwise, and a deny the owner set on this server still holds; approvals
 *  never lifts those asks. A tool left unticked is not the agent's at all, so no harness offers it and approvals never,
 *  which lifts an ask of a tool the agent has, has nothing to lift: the owner grants it later in the agent's tools. A
 *  tool the package pins gets its pin, filled, in the agent's tool settings, ticked or not (it holds once the tool is
 *  granted later); one whose pin fills empty (its parameter not given) is set to deny instead, and named in `unpinned`
 *  (by gate name, with the parameters not given): a send with no destination set never runs. */
export function compiled(p: Package, parameters: Json, chosen: { harness?: string; model?: string; modelTiers?: Record<string, string>; mcp: McpServed[]; defaultTools: readonly string[]; grants: readonly string[]; approvals?: Approvals; computer?: ComputerPick }, _deps?: TemplatesDeps): { agent: Json; triggers: Json[]; unpinned: { tool: string; parameters: string[] }[] } {
  const skills = Object.keys(p.skills).filter((path) => /^[^/]+\/SKILL\.md$/.test(path)).map((path) => path.slice(0, -"/SKILL.md".length));
  // The ticks, in the package's order: never a tool of a server not saved here, nor one the owner did not tick.
  const granted = chosen.mcp.flatMap(({ server, tools }) => tools.map((tool) => mcpToolName(server, tool))).filter((tool) => chosen.grants.includes(tool));
  // The computer its list picked (pickComputer): its tools less the shell tools that computer does not run; a package
  // that names none is given that computer's shell tools, as a new agent in a box is given the box's.
  const pick = chosen.computer;
  const own = pick ? (p.tools ?? pick.defaults).filter((tool) => !pick.dropped.includes(tool)) : p.tools;
  const named = own && (p.tools || own.length) ? own : undefined;
  const tools = granted.length ? [...(named ?? (pick ? [] : chosen.defaultTools)), ...granted] : named;
  // No permission for a tick: a grant is no allow (this server's tool settings decide). Only a pin, or a pin's empty fill's deny.
  const settings: Record<string, { permission?: "deny"; pin?: Record<string, PinValue>; policy?: BashPolicy }> = {};
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
    ...(p.learning !== undefined ? { learning: p.learning } : {}), ...(p.budget?.per_run_usd ? { max_cost_usd: p.budget.per_run_usd } : {}), skills,
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
export function filledPins(mcp: readonly McpServed[], parameters: Json): { tool: string; pin: Record<string, PinValue>; empty: string[] }[] {
  return mcp.flatMap(({ server, pin }) => Object.entries(pin).map(([tool, args]) => {
    const each = Object.entries(args).map(([arg, value]) => [arg, pinFilled(value, parameters)] as const);
    return { tool: mcpToolName(server, tool), pin: Object.fromEntries(each.map(([arg, one]) => [arg, one.value])), empty: [...new Set(each.flatMap(([, one]) => one.empty))] };
  }));
}

/** How the owner sets up a need no saved server matches, in words: the Composio preset with its toolkit and actions,
 *  GitHub's MCP on the App, or any server marked with the toolkit in Settings. */
export function mcpSetUp(need: Pick<McpNeed, "source" | "toolkit" | "tools">): string {
  const tools = need.tools.join(", ");
  return need.source === "composio" ? `Add it in Settings → MCP servers → Add from Composio, toolkit ${need.toolkit}, actions ${tools}, then apply the template again.`
    : need.source === "github" ? "Connect GitHub in Settings, then add GitHub's MCP server in Settings → MCP servers with GitHub App access, and apply the template again."
    : `Add the MCP server that serves ${tools} in Settings → MCP servers and set its toolkit to ${need.toolkit}, then apply the template again.`;
}

/** A saved MCP server as an apply matches it: its name and the source and toolkit it records (mcp-sources.ts). */
export type SavedSource = { name: string; source: McpSource; toolkit: string | null };

/** Each MCP need of `p` mapped to a saved server here: `candidates`, those whose record is the need's {source, toolkit},
 *  by name; `server`, the owner's pick among them (`picks`, by toolkit), else the one candidate, else none. Never picked
 *  silently: several candidates and no pick is refused (422 under servers.<toolkit>, naming them), and so is a pick that
 *  is not a candidate (an owner never maps a need to a server that says it is something else). */
export function serversFor(p: Package, saved: readonly SavedSource[], picks: Readonly<Record<string, string>>): { need: McpNeed; server: string | null; candidates: string[] }[] {
  const issues: InputIssue[] = [];
  const mapped = p.mcp.map((need) => {
    const candidates = saved.filter((one) => one.source === need.source && one.toolkit === need.toolkit).map((one) => one.name).sort();
    const pick = Object.hasOwn(picks, need.toolkit) ? picks[need.toolkit] : undefined;
    if (pick !== undefined && !candidates.includes(pick)) issues.push({ field: `servers.${need.toolkit}`, reason: "not_an_option", message: `${pick} is not a saved MCP server that is ${need.source} ${need.toolkit}: ${candidates.length ? `${candidates.join(", ")} ${candidates.length === 1 ? "is" : "are"}` : "none is saved here"}.` });
    else if (pick === undefined && candidates.length > 1) issues.push({ field: `servers.${need.toolkit}`, reason: "missing", message: `Saved MCP servers ${new Intl.ListFormat("en", { type: "conjunction" }).format(candidates)} are each ${need.source} ${need.toolkit}: servers.${need.toolkit} says which one the agent uses.` });
    const server = pick ?? (candidates.length === 1 ? candidates[0]! : null);
    return { need, server, candidates };
  });
  if (issues.length) throw invalid(issues);
  return mapped;
}

const SERVER_PART = MCP_SERVER_NAME.source.slice(1, -1);
const TOOL_PART = MCP_TOOL_NAME.source.slice(1, -1);
/** A catalog MCP name in prose (`mcp:<server>/<tool>` or `mcp:<server>/*`), whole: not the tail of a longer word
 *  (`xmcp:gmail/x`), nor cut short of a longer tool name. */
const MCP_NAME_IN_TEXT = new RegExp(`(?<![A-Za-z0-9_.:/-])mcp:${SERVER_PART}/(?:\\*|${TOOL_PART}(?![A-Za-z0-9_-]))`, "g");

/** Catalog name `name` on the saved servers of `servers` ({toolkit: saved name}): read (parseToolName), its server swapped
 *  when it is one of the package's toolkits, and written again (formatToolName); a wildcard `mcp:<toolkit>/*` the same
 *  way. Any other name, or one outside the grammar, as it is. */
export function onServerName(name: string, servers: Readonly<Record<string, string>>): string {
  const parsed = parseToolName(name);
  if (!parsed || (parsed.kind !== "mcp" && parsed.kind !== "mcp-server") || !Object.hasOwn(servers, parsed.server)) return name;
  return formatToolName({ ...parsed, server: servers[parsed.server]! });
}

/** `text` with each whole catalog MCP name in it on the saved servers' (onServerName), in one pass, so a server named as
 *  another of the package's toolkits is never rewritten twice. */
export function onServerNames(text: string, servers: Readonly<Record<string, string>>): string {
  if (!Object.keys(servers).some((toolkit) => servers[toolkit] !== toolkit)) return text;
  return text.replace(MCP_NAME_IN_TEXT, (name) => onServerName(name, servers));
}

/** `p` as the agent an apply makes on `servers` sees it: its instructions and each skill file with the package's tool
 *  names on the saved servers' (onServerNames), and each composio trigger's server, its need's toolkit, the saved server
 *  that need resolved to (onServerTrigger). Nothing else of it names a server: its pins and allow are by tool. */
export function onServers(p: Package, servers: Readonly<Record<string, string>>): Package {
  return { ...p, instructions: onServerNames(p.instructions, servers), skills: Object.fromEntries(Object.entries(p.skills).map(([path, text]) => [path, onServerNames(text, servers)])), triggers: p.triggers.map((trigger) => onServerTrigger(trigger, servers)) };
}

/** Trigger `trigger` on the saved servers of `servers` ({toolkit: saved name}): a composio one's `source.server`, the
 *  toolkit of the package's need (readPackage), the saved server the apply resolved that need to. Any other as it is. */
function onServerTrigger(trigger: Json, servers: Readonly<Record<string, string>>): Json {
  const source = trigger.source;
  if (!isObject(source) || source.kind !== "composio" || typeof source.server !== "string" || !Object.hasOwn(servers, source.server)) return trigger;
  return { ...trigger, source: { ...source, server: servers[source.server]! } };
}
