// What the adapter is told about one ACP agent (design TDD §3.3, door 1): how to start it, what it declares, where it
// keeps its sessions and who bills its model. The loader's own rules (keys, registry archives, owner installs) are S5's;
// these are the checks the adapter itself needs before it starts anything. Written for AgentRun.
import { isAbsolute, normalize, sep } from "node:path";

/** Who pays for the agent's model requests. `plan`: the vendor bills the owner's plan (Cursor), no request reaches us, so
 *  the adapter itself stops the run at these limits. `proxy`: the agent's model goes through the host's proxy, which the
 *  adapter's `proxy` option starts for each agent process (Goose, S3). */
export type AcpBilling = { readonly kind: "plan"; readonly maxTurns: number; readonly maxToolCalls: number } | { readonly kind: "proxy" };

/** One of the agent's own refusals: the words it says (`says`, matched as they are), the code a host reads, and the
 *  words the host says instead. */
export type AcpRefusal = { readonly says: string; readonly code: string; readonly words: string };

/** An environment variable's name, as a key's. */
const KEY_NAME = /^[A-Z][A-Z0-9_]{0,63}$/;
/** A model id as an agent lists one (`gpt-5.4-nano[reasoning=medium]`): one line, no spaces, not an option. */
export const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/=,[\]-]{0,199}$/;
/** A refusal's code: capitals, digits and `_`. */
const CODE = /^[A-Z][A-Z0-9_]{1,63}$/;

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
  /** Files in HOME the agent derives from its keys (Cursor's `.config/cursor/auth.json`): never mirrored, and once a
   *  recipe names one, the agent's whole private HOME and tmp are removed when its process ends (the drive's end, the
   *  session's close, a stop past the plan's limit). The next start makes them again from the session's records. */
  readonly credentials?: readonly string[];
  /** The agent's own refusals, by words it prints (on stderr, or in an error it answers): a start or a turn that fails
   *  saying `says` is said as `<code>: <words>`, so a host tells it apart without reading the agent's words. */
  readonly refusals?: readonly AcpRefusal[];
  /** The run's model, by the agent's id (`gpt-5.4-nano[reasoning=medium]`) or its name before the brackets
   *  (`gpt-5.4-nano`): chosen with session/set_model among those session/new lists, before the first prompt. One it
   *  does not list is refused with ACP_CODES.modelUnlisted. Absent: the agent's own default. */
  readonly model?: string;
  /** Files written into its private HOME before it starts, by their path in HOME (`.config/goose/config.yaml`). */
  readonly files?: Readonly<Record<string, string>>;
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
  const reserved = Object.keys(recipe.env ?? {}).filter((name) => RESERVED_ENV.has(name));
  if (reserved.length) problems.push(`the env names ${reserved.join(", ")}, which the adapter sets`);
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
  if (recipe.model !== undefined && (typeof recipe.model !== "string" || !MODEL_ID.test(recipe.model))) problems.push(`the model ${JSON.stringify(String(recipe.model).slice(0, 80))} is not a model id`);
  return problems;
}

/** The variables the adapter sets itself: a recipe never names them. */
export const RESERVED_ENV = new Set(["HOME", "TMPDIR", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_STATE_HOME", "GIT_CEILING_DIRECTORIES"]);
