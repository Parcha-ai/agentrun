// What the adapter is told about one ACP agent (design TDD §3.3, door 1): how to start it, what it declares, where it
// keeps its sessions and who bills its model. The loader's own rules (keys, registry archives, owner installs) are S5's;
// these are the checks the adapter itself needs before it starts anything. Written for AgentRun.
import { isAbsolute, normalize, sep } from "node:path";
import { KEY_NAME, launchEnv } from "@parcha/agentrun-kernel";
import { type AcpAnnounces, ANNOUNCES_PATH, MCP_SERVER } from "./calls.js";

/** Who pays for the agent's model requests. `plan`: the vendor bills the owner's plan (Cursor), no request reaches us, so
 *  the adapter itself stops the run at these limits. `proxy`: the agent's model goes through the host's proxy, which the
 *  adapter's `proxy` option starts for each agent process (Goose, S3). */
export type AcpBilling = { readonly kind: "plan"; readonly maxTurns: number; readonly maxToolCalls: number } | { readonly kind: "proxy" };

/** One of the agent's own refusals: the words it says (`says`, matched as they are), the code a host reads, and the
 *  words the host says instead. */
export type AcpRefusal = { readonly says: string; readonly code: string; readonly words: string };

/** A model id as an agent lists one (`gpt-5.4-nano[reasoning=medium]`): one line, no spaces, not an option. */
export const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/=,[\]-]{0,199}$/;
/** A refusal's code: capitals, digits and `_`. */
const CODE = /^[A-Z][A-Z0-9_]{1,63}$/;
/** A sign-in method's id as an agent lists one in authMethods (`gemini-api-key`). */
const AUTH_METHOD = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** The forms an allowFile is written in, by the agent that reads it: each makes the file's text from the names of the
 *  tools a start lists. A second agent with another format adds a form here. */
const ALLOW_FORMS = {
  /** Goose 1.59.2's permission file (PermissionConfig under `user`, every field present: none has a default, and a
   *  file that does not parse stops Goose at its start): each tool always allowed by the name Goose calls it,
   *  `agentrun__<tool>`, nothing asked before or never allowed. Written as JSON, which YAML reads. Goose's own tools are
   *  not named, so they still ask. */
  "goose-permission": (tools: readonly string[]) => `${JSON.stringify({ user: { always_allow: tools.map((tool) => `${MCP_SERVER}__${tool}`), ask_before: [], never_allow: [] } })}\n`,
} satisfies Record<string, (tools: readonly string[]) => string>;

/** The forms an allowFile may take, by name: a recipe loader's check (serve's) reads them from here. */
export const ALLOW_FILE_FORMS: readonly string[] = Object.freeze(Object.keys(ALLOW_FORMS));

/** The form of a recipe's allowFile. */
export type AcpAllowForm = keyof typeof ALLOW_FORMS;

/** A recipe's allowFile: where in HOME the agent reads which tools run unasked, and in what form. */
export type AcpAllowFile = { readonly path: string; readonly form: AcpAllowForm };

/** The text of an allowFile in `form` for a start whose MCP server lists `tools`. */
export function allowFileText(form: AcpAllowForm, tools: readonly string[]): string {
  return ALLOW_FORMS[form](tools);
}

export interface AcpRecipe {
  /** The harness's id: the adapter's. */
  readonly id: string;
  /** Its name in a sentence. */
  readonly label?: string;
  /** The agent's binary (absolute) and the arguments that start it as an ACP agent over stdio. */
  readonly command: string;
  readonly args?: readonly string[];
  /** Variables the agent gets beyond the allowlist (PATH, LANG, TZ). */
  readonly env?: Readonly<Record<string, string>>;
  /** The keys the agent runs on (Cursor's CURSOR_API_KEY), by name: each is read from the host's environment at every
   *  start and handed to the agent under the same name, never written in the recipe. A start whose host lacks one of
   *  them is refused with ACP_CODES.keyMissing before anything starts. */
  readonly keys?: readonly string[];
  /** The variable a key reaches the agent as, by its name in `keys`, where it differs: a key saved for this harness alone
   *  (ANTIGRAVITY_GEMINI_API_KEY) handed under the name the agent reads (GEMINI_API_KEY). The value is always read by the
   *  key's own name, so a value the host holds under the handed name never reaches the agent. */
  readonly keyEnv?: Readonly<Record<string, string>>;
  /** The sign-in method the agent is told with ACP `authenticate` after initialize and before any session opens (its
   *  authMethods id: Antigravity's `gemini-api-key`; on its owner's sign-in, none, the agent reading its own). One its initialize does
   *  not list is refused with ACP_CODES.authUnlisted, one it refuses with ACP_CODES.authFailed. Absent: none is sent. */
  readonly authMethod?: string;
  /** `none`: nothing the agent prints on stderr is read or kept, nor the words of an error it answers; a failure says
   *  its exit status and the adapter's own code alone. For an agent on a person's sign-in, whose token no key cut knows.
   *  Default `tail`. */
  readonly stderr?: "tail" | "none";
  /** Files in HOME the agent derives from its keys (Cursor's `.config/cursor/auth.json`): never written, since each
   *  start makes every one an empty folder the agent cannot write a file at (an agent named here must run on the key in
   *  its env when its save fails, as Cursor 2026.11.13 does), so a hard kill leaves none on disk; never mirrored; and
   *  once a recipe names one, the agent's whole private HOME and tmp are also removed when its process ends (the
   *  drive's end, the session's close, a stop past the plan's limit). The next start makes them again from the
   *  session's records. */
  readonly credentials?: readonly string[];
  /** The agent's own refusals, by words it prints (on stderr, or in an error it answers): a start or a turn that fails
   *  saying `says` is said as `<code>: <words>`, so a host tells it apart without reading the agent's words. */
  readonly refusals?: readonly AcpRefusal[];
  /** Words the agent prints on stderr that never say why it failed (Cursor's warning that it could not save the
   *  credential the adapter keeps unwritable, and the error line under it): a stderr line holding one is left out of a
   *  failure's words, as are the terminal's escapes. Matched as they are. */
  readonly quiet?: readonly string[];
  /** The run's model, by the agent's id (`gpt-5.4-nano[reasoning=medium]`) or its name before the brackets
   *  (`gpt-5.4-nano`): chosen with session/set_model among those session/new lists, before the first prompt. One it
   *  does not list is refused with ACP_CODES.modelUnlisted. Absent: the agent's own default. */
  readonly model?: string;
  /** Files written into its private HOME before it starts, by their path in HOME (`.config/goose/config.yaml`). */
  readonly files?: Readonly<Record<string, string>>;
  /** A file in HOME, written at each start from the tools that start's MCP server lists, that tells the agent to run
   *  them without asking permission (Goose's `.config/goose/permission.yaml`, form `goose-permission`): our tools'
   *  gate is the host's, at the MCP call. Nothing else is in it, so the agent's own tools still ask. */
  readonly allowFile?: AcpAllowFile;
  /** Where the agent's tool_call names which tool it calls (AcpAnnounces): Goose 1.59.2's
   *  `{ tool: "_meta.goose.toolCall.toolName" }`, Cursor 2026.11.13's
   *  `{ tool: "rawInput.toolName", server: "rawInput.providerIdentifier", args: "rawInput.args" }`. A call it names as
   *  another tool is the agent's own; one it names as ours is matched to the MCP call by that tool and its arguments.
   *  Absent: every call is matched by its arguments alone. A title is never read for this. */
  readonly announces?: AcpAnnounces;
  /** Where in HOME the agent keeps its own sessions: mirrored into the session's records, so another runner's agent
   *  loads them (session/load). Credential files under them are never mirrored. */
  readonly state?: readonly string[];
  /** What the agent is expected to advertise at initialize: a mismatch refuses with ACP_CODES.capabilityMismatch.
   *  `load`: it resumes a session with session/load. `mcp`: the transport our tools go over. */
  readonly declares: { readonly load: boolean; readonly mcp: "http" | "stdio" };
  readonly billing: AcpBilling;
  readonly quirks?: {
    /** How an MCP call finds its id. `match` (default): the agent's own tool_call for it, by tool and arguments; `mint`:
     *  an id of the adapter's, for an agent that announces no tool_call for an MCP call. */
    readonly mcpCall?: "match" | "mint";
    /** `title`: a permission request whose title names one of our tools (ourTool), for a call the agent announced as
     *  that tool, is answered allow_once without the host's gate, which the bridge asks at the MCP call. For an agent
     *  that asks for every MCP call whatever its config says (Cursor 2026.11.13: its allowlist with allow: [], which keeps
     *  it from writing files unasked, asks for each). Absent: every permission request goes to the host's gate. */
    readonly permissionTie?: "title";
  };
}

/** `path` in HOME, normalized, or undefined when it leaves HOME (absolute, `..`, or a `$HOME/` prefix spelled out). */
export function homePath(path: string): string | undefined {
  const bare = path.startsWith("$HOME/") ? path.slice("$HOME/".length) : path;
  if (!bare || isAbsolute(bare)) return undefined;
  const clean = normalize(bare);
  if (clean === "." || clean === ".." || clean.startsWith(`..${sep}`)) return undefined;
  return clean;
}

/** What is wrong with `recipe`, each in words; none when it may run. */
export function recipeProblems(recipe: AcpRecipe): string[] {
  const problems: string[] = [];
  if (!/^[a-z][a-z0-9-]{0,62}$/.test(recipe.id ?? "")) problems.push(`the id ${JSON.stringify(recipe.id)} is not lowercase letters, digits and dashes`);
  if (typeof recipe.command !== "string" || !isAbsolute(recipe.command)) problems.push("the command must be an absolute path");
  if (!recipe.declares || typeof recipe.declares.load !== "boolean" || (recipe.declares.mcp !== "http" && recipe.declares.mcp !== "stdio")) problems.push('declares needs load (true or false) and mcp ("http" or "stdio")');
  const billing = recipe.billing as { kind?: unknown; maxTurns?: unknown; maxToolCalls?: unknown } | undefined;
  if (billing?.kind === "plan") {
    if (!Number.isInteger(billing.maxTurns) || (billing.maxTurns as number) < 1) problems.push("plan billing needs maxTurns, a whole number of turns of at least 1");
    if (!Number.isInteger(billing.maxToolCalls) || (billing.maxToolCalls as number) < 0) problems.push("plan billing needs maxToolCalls, a whole number of calls");
  } else if (billing?.kind !== "proxy") problems.push('billing is { kind: "plan", maxTurns, maxToolCalls } or { kind: "proxy" }');
  for (const path of Object.keys(recipe.files ?? {})) if (!homePath(path)) problems.push(`the file ${JSON.stringify(path)} must be inside the private HOME`);
  for (const path of recipe.state ?? []) if (!homePath(path)) problems.push(`the state path ${JSON.stringify(path)} must be inside the private HOME`);
  if (recipe.allowFile !== undefined) {
    const allow = recipe.allowFile as { path?: unknown; form?: unknown } | null;
    const path = typeof allow?.path === "string" ? homePath(allow.path) : undefined;
    if (!path) problems.push(`the allowFile ${JSON.stringify(allow?.path ?? null)} must be a path inside the private HOME`);
    if (typeof allow?.form !== "string" || !Object.hasOwn(ALLOW_FORMS, allow.form)) problems.push(`the allowFile form ${JSON.stringify(allow?.form ?? null)} is none of ${Object.keys(ALLOW_FORMS).join(", ")}`);
    if (path && Object.keys(recipe.files ?? {}).some((file) => homePath(file) === path)) problems.push(`the allowFile ${JSON.stringify(allow!.path)} is also one of the recipe's files`);
  }
  if (recipe.announces !== undefined) {
    const given: unknown = recipe.announces;
    const said = typeof given === "object" && given !== null && !Array.isArray(given) ? (given as Record<string, unknown>) : undefined;
    const path = (value: unknown) => typeof value === "string" && ANNOUNCES_PATH.test(value);
    const shaped = said !== undefined && Object.keys(said).every((key) => key === "tool" || key === "server" || key === "args");
    if (!said || !shaped || !path(said.tool) || (said.server !== undefined && !path(said.server)) || (said.args !== undefined && !path(said.args))) problems.push('announces is { "tool": a dotted path inside _meta or rawInput of the agent\'s tool_call, "server"?: one, "args"?: one }');
  }
  const quirks = recipe.quirks as { mcpCall?: unknown; permissionTie?: unknown } | undefined;
  if (quirks?.permissionTie !== undefined && quirks.permissionTie !== "title") problems.push(`the quirk permissionTie ${JSON.stringify(quirks.permissionTie)} is not "title"`);
  if (quirks?.permissionTie === "title" && recipe.announces === undefined) problems.push("the title tie (quirks.permissionTie) needs announces: it answers only a request for a call that field named");
  const reserved = Object.keys(recipe.env ?? {}).filter((name) => RESERVED_ENV.has(name));
  if (reserved.length) problems.push(`the env names ${reserved.join(", ")}, which the adapter sets`);
  const launching = Object.keys(recipe.env ?? {}).filter((name) => !RESERVED_ENV.has(name) && launchEnv(name));
  if (launching.length) problems.push(`the env names ${launching.join(", ")}, which change what the agent's process loads or runs`);
  for (const name of recipe.keys ?? []) {
    if (typeof name !== "string" || !KEY_NAME.test(name)) problems.push(`the key ${JSON.stringify(name)} is not a variable's name (capitals, digits and _)`);
    else if (RESERVED_ENV.has(name)) problems.push(`the key ${name} is a variable the adapter sets`);
    else if (Object.hasOwn(recipe.env ?? {}, name)) problems.push(`the key ${name} is also in env: a key is read from the host by name, never written in the recipe`);
  }
  for (const path of recipe.credentials ?? []) if (!homePath(path)) problems.push(`the credential ${JSON.stringify(path)} must be inside the private HOME`);
  for (const refusal of recipe.refusals ?? []) {
    const ok = typeof refusal?.says === "string" && refusal.says.trim() !== "" && typeof refusal.code === "string" && CODE.test(refusal.code) && typeof refusal.words === "string" && refusal.words.trim() !== "";
    if (!ok) problems.push(`the refusal ${JSON.stringify(refusal ?? null).slice(0, 120)} needs says, a code (capitals, digits and _) and words`);
  }
  if (recipe.quiet !== undefined && (!Array.isArray(recipe.quiet) || recipe.quiet.some((words) => typeof words !== "string" || words.trim() === ""))) problems.push("quiet is a list of words, none empty");
  if (recipe.model !== undefined && (typeof recipe.model !== "string" || !MODEL_ID.test(recipe.model))) problems.push(`the model ${JSON.stringify(String(recipe.model).slice(0, 80))} is not a model id`);
  const handed = new Set<string>();
  for (const name of recipe.keys ?? []) {
    const as = recipe.keyEnv?.[name] ?? name;
    if (typeof as !== "string" || !KEY_NAME.test(as)) problems.push(`the key ${name} is handed as ${JSON.stringify(as)}, which is not a variable's name`);
    else if (RESERVED_ENV.has(as)) problems.push(`the key ${name} is handed as ${as}, a variable the adapter sets`);
    else if (launchEnv(as)) problems.push(`the key ${name} is handed as ${as}, which changes what the agent's process loads or runs`);
    else if (as !== name && Object.hasOwn(recipe.env ?? {}, as)) problems.push(`the key ${name} is handed as ${as}, which is also in env`);
    if (handed.has(as)) problems.push(`two keys are handed as ${as}`);
    handed.add(as);
  }
  for (const name of Object.keys(recipe.keyEnv ?? {})) if (!(recipe.keys ?? []).includes(name)) problems.push(`keyEnv names ${name}, which is not one of the keys`);
  if (recipe.authMethod !== undefined && (typeof recipe.authMethod !== "string" || !AUTH_METHOD.test(recipe.authMethod))) problems.push(`the sign-in method ${JSON.stringify(String(recipe.authMethod).slice(0, 80))} is not a method's id`);
  if (recipe.stderr !== undefined && recipe.stderr !== "tail" && recipe.stderr !== "none") problems.push('stderr is "tail" or "none"');
  return problems;
}

/** The variables the adapter sets itself: a recipe never names them. */
export const RESERVED_ENV = new Set(["HOME", "TMPDIR", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_STATE_HOME", "GIT_CEILING_DIRECTORIES"]);
