// A harness recipe (HARNESS.md#a-recipe): the one loader, refusing by RECIPE_CODES before anything is downloaded.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { isAbsolute, join, normalize, resolve, sep } from "node:path";
import { HARNESS_ID_PATTERN, RESERVED_HARNESS_IDS } from "./harness.js";
import { ARCHIVE_CODES, ARCHIVE_FORMATS, type ArchiveFormat, type ArchiveInstallOptions, archivePlatform, type ArchiveRelease, installArchive, linkOutOf } from "./harness-archive.js";
import { BUILTIN_HARNESS_IDS } from "./harness-table.js";
import { commandData } from "./harness-owned.js";
import { harnessesOf, installDirOf, shellWord } from "./harness-install.js";
import { ENV_NAME, KEY_NAME, launchEnv } from "@parcha/agentrun-kernel";
import { ACP_PACKAGE, acpPackage } from "./acp-package.js";
import { keyShaped, SECRET_SEGMENTS } from "./secret-name.js";
import { SECRET_NAMES } from "./secrets.js";

/** The codes a refused recipe carries, one per rule, and one for a file that is not a recipe at all. */
export const RECIPE_CODES = Object.freeze({
  /** Not JSON, not an object, or a field missing, of the wrong type, or unknown. */
  invalid: "RECIPE_INVALID",
  /** Rule 1: a key that is not the harness's own. */
  keys: "RECIPE_KEY_NOT_OWN",
  /** Rule 2: a binary that is not a registry archive pinned by its sha256. */
  binary: "RECIPE_BINARY_UNPINNED",
  /** Rule 3: a file, a state folder or the binary outside its private place. */
  paths: "RECIPE_PATH_OUTSIDE",
  /** Rule 4: an install step of the recipe's own. */
  install: "RECIPE_INSTALLS_ITSELF",
  /** Rule 5: an environment beyond the allowlist and the recipe's own literal values. */
  env: "RECIPE_ENV_NOT_ALLOWLIST",
} as const);
export type RecipeCode = (typeof RECIPE_CODES)[keyof typeof RECIPE_CODES];

/** One platform's release of the agent, as its vendor ships it (an ACP registry entry's `distribution.binary.<platform>`,
 *  or a release manifest's, Google's agy CLI's), pinned by its archive's sha256 or sha512, with that platform's own `args`
 *  where it lists them: they start the agent there in place of the recipe's `args`. */
export type RecipeArchive = ArchiveRelease & { readonly format: ArchiveFormat; readonly args?: readonly string[] };

/** How an agent that runs on its owner's own account signs in, with its own sign-in (Google's agy CLI: `agy acp --login
 *  --gemini-dir DIR`), as T3 Code runs it. `args`: the flags that start that sign-in (`--login`), after the release's
 *  args. `homeArg`: the flag the agent takes the folder it keeps its sign-in in by (`--gemini-dir`), given the owner's
 *  folder (signInHomeOf) on the sign-in and on every run on it. AgentRun never reads, refreshes or sends the sign-in:
 *  the agent alone writes and reads what is in that folder (HARNESS.md#sign-in). Plan billing alone, beside its keys: a
 *  proxy-billed agent runs on the server's key. `terms`: the vendor's terms for it, named in the warning each sign-in
 *  prints. */
export type RecipeSignIn = { readonly args: readonly string[]; readonly homeArg: string; readonly terms?: string };

/** The variables a proxy-billed agent may read the proxy's address from: Goose's, and the Anthropic SDKs'. */
export const PROXY_HOST_ENVS: readonly string[] = Object.freeze(["ANTHROPIC_HOST", "ANTHROPIC_BASE_URL"]);

/** The variables the agent's environment gets from the adapter and the model proxy, never from a recipe, by part: what
 *  it takes from the host (`inherited`, run-adapters-acp's INHERITED_ENV), what the adapter sets for the private HOME
 *  (`reserved`, its RESERVED_ENV), and the proxy's address and key (`proxy`). The loader refuses a recipe that names one;
 *  the check's env_allowlist expects each. */
export const AGENT_VARS: Readonly<Record<"inherited" | "reserved" | "proxy", readonly string[]>> = Object.freeze({
  inherited: Object.freeze(["PATH", "LANG", "TZ"]),
  reserved: Object.freeze(["HOME", "TMPDIR", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_STATE_HOME", "GIT_CEILING_DIRECTORIES"]),
  proxy: Object.freeze([...PROXY_HOST_ENVS, "ANTHROPIC_API_KEY"]),
});

/** How the agent's model is billed. `proxy`: it speaks Anthropic's Messages API to the address in `hostEnv` (default
 *  ANTHROPIC_HOST) with ANTHROPIC_API_KEY, both the session's model proxy's (the run's cap and books hold), and reads the
 *  run's model from `env`. `plan`: the vendor bills the owner's plan on the recipe's own keys or its sign-in; the adapter
 *  stops the run at these limits, and `id` is the model chosen among those the agent lists (session/set_model), its own
 *  default when absent. */
export type RecipeModel =
  | { readonly billing: "proxy"; readonly wire: "anthropic-messages"; readonly env: string; readonly hostEnv?: "ANTHROPIC_HOST" | "ANTHROPIC_BASE_URL" }
  | { readonly billing: "plan"; readonly maxTurns: number; readonly maxToolCalls: number; readonly hosts?: readonly string[]; readonly id?: string };
/** A long flag as signIn.homeArg names one (`--gemini-dir`): its value is the next argument, never after an `=`. */
const LONG_FLAG = /^--[a-z0-9][a-z0-9-]{0,63}$/;
/** `items` in a sentence: `a`, `a and b`, `a, b and c`. */
const listed = (items: readonly string[]): string => (items.length < 2 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`);

/** A host a plan-billed agent's vendor is on, as model.hosts names it: a lowercase host name, with an optional port. */
const VENDOR_HOST = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*(?::([1-9][0-9]{0,4}))?$/;
const vendorHost = (host: string): boolean => {
  const port = VENDOR_HOST.exec(host)?.[1];
  return VENDOR_HOST.test(host) && (port === undefined || Number(port) <= 65535);
};

/** A recipe file, as the loader passes it. */
export interface Recipe {
  readonly id: string;
  readonly label: string;
  /** `registry`: the agent's id in the ACP registry, for a release copied from there (the agy CLI is not). */
  readonly release: { readonly registry?: string; readonly version: string; readonly archives: Readonly<Record<string, RecipeArchive>> };
  readonly args: readonly string[];
  /** The keys the agent runs on, by the names they are saved under for this harness alone. */
  readonly keys: readonly string[];
  /** The variable each key reaches the agent as, by its saved name, where it differs (a key entry's `env`): Antigravity's
   *  AI Studio key, saved as ANTIGRAVITY_GEMINI_API_KEY, reaches its runs alone as GEMINI_API_KEY, and the server's own
   *  GEMINI_API_KEY never does. */
  readonly keyEnv: Readonly<Record<string, string>>;
  /** The sign-in method the adapter sends with ACP `authenticate` on a run on the keys (Antigravity's `gemini-api-key`):
   *  none, the agent reads its keys unasked. */
  readonly keyMethod?: string;
  readonly env: Readonly<Record<string, string>>;
  readonly model: RecipeModel;
  readonly files: Readonly<Record<string, string>>;
  /** A file in the private HOME the adapter writes at each start from that start's tools, in the form the agent reads
   *  (Goose's `.config/goose/permission.yaml`, `goose-permission`): the agent runs our tools without asking. */
  readonly allowFile?: { readonly path: string; readonly form: string };
  /** Where the agent's tool_call names which tool it calls, each a dotted path into it: `tool` (with `server`, our
   *  tool's own name; without, `<prefix><tool>`), `server` (must be `agentrun`), `prefix` (without `server`: default
   *  `agentrun__`, agy's `mcp_agentrun_`; it names our server), `args` (default rawInput), and `extras`, fields beside
   *  the arguments the MCP call never carries (agy's `toolSummary`), left out when they hold text. A call it names as
   *  another tool is the agent's own; absent, calls are matched to MCP calls by their arguments alone (AcpAnnounces). */
  readonly announces?: { readonly tool: string; readonly server?: string; readonly prefix?: string; readonly args?: string; readonly extras?: readonly string[] };
  readonly state: readonly string[];
  readonly declares: { readonly load: boolean; readonly mcp: "http" | "stdio" };
  /** `permissionTie: "title"`: the adapter answers the agent's permission request for one of our announced calls
   *  allow_once (Cursor's way); absent, every request goes to the server's gate. */
  readonly quirks: { readonly mcpCall?: "match" | "mint"; readonly permissionTie?: "title" };
  readonly signIn?: RecipeSignIn;
}

/** A recipe the loader refused: `code` is the first problem's, and the message says every one. */
export class RecipeRefused extends Error {
  constructor(readonly code: RecipeCode, readonly problems: readonly { code: RecipeCode; words: string }[]) {
    super(`${code}: ${problems.map((p) => (p.code === code ? p.words : `${p.code}: ${p.words}`)).join("; ")}`);
    this.name = "RecipeRefused";
  }
}

/** The fields a recipe has. */
const FIELDS = new Set(["id", "label", "release", "args", "keys", "keyMethod", "env", "model", "files", "allowFile", "announces", "state", "declares", "quirks", "signIn", "description", "$schema"]);
/** Fields that would run something of the recipe's own at install or start (rule 4). */
const INSTALL_FIELDS = new Set(["install", "installCommand", "postinstall", "preinstall", "setup", "script", "scripts", "run", "hooks", "update"]);
/** Fields that would name a binary other than the release's archive (rule 2). */
const BINARY_FIELDS = new Set(["command", "binary", "path", "bin", "executable", "exec"]);
/** Fields that would pass the host's environment through (rule 5). */
const ENV_FIELDS = new Set(["inheritEnv", "passEnv", "envFrom", "inherit", "envPassthrough", "passthroughEnv"]);
/** Every variable of AGENT_VARS. */
const SET_BY_ADAPTER: ReadonlySet<string> = new Set(Object.values(AGENT_VARS).flat());
const SHA256 = /^[0-9a-f]{64}$/;
const SHA512 = /^[0-9a-f]{128}$/;
const ARCHIVE_FIELDS = new Set(["url", "format", "sha256", "sha512", "cmd", "binarySha256", "treeSha256", "args"]);
/** A value the host would fill in from its own environment: `$NAME` or `${NAME}`. */
const EXPANDS = /\$(?:\{[^}]*\}|[A-Za-z_])/;

/** Whether `name` is a key the server holds for anything but this harness: the launcher's secrets (model providers, the
 *  gateway, tools, computers, serve's own) and every AGENTRUN_ and AGENT_MODEL_ name. */
export const serverKey = (name: string): boolean => SECRET_NAMES.includes(name) || name.startsWith("AGENTRUN_") || name.startsWith("AGENT_MODEL_");

/** `path` inside HOME, or undefined when it leaves it (absolute, `..`, or empty); a `$HOME/` prefix is HOME. */
export function insideHome(path: string): string | undefined {
  const bare = path.startsWith("$HOME/") ? path.slice("$HOME/".length) : path;
  if (!bare || isAbsolute(bare)) return undefined;
  const clean = normalize(bare);
  if (clean === "." || clean === ".." || clean.startsWith(`..${sep}`)) return undefined;
  return clean;
}

const isPlain = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every((v) => typeof v === "string");

/** A recipe's keys as entries: each a saved name, handed as `env` (its own name, unless an entry `{ name, env }` says
 *  another); undefined when `keys` is not a list of those. */
function keyEntries(keys: unknown): { name: string; env: string }[] | undefined {
  if (keys === undefined) return [];
  if (!Array.isArray(keys)) return undefined;
  const entries: { name: string; env: string }[] = [];
  for (const key of keys) {
    if (typeof key === "string") entries.push({ name: key, env: key });
    else if (isPlain(key) && typeof key.name === "string" && typeof key.env === "string" && Object.keys(key).every((field) => field === "name" || field === "env")) entries.push({ name: key.name, env: key.env });
    else return undefined;
  }
  return entries;
}

/** Every problem with `parsed` as a recipe, by its rule's code. */
export function recipeProblems(parsed: unknown): { code: RecipeCode; words: string }[] {
  const problems: { code: RecipeCode; words: string }[] = [];
  const say = (code: RecipeCode, words: string) => problems.push({ code, words });
  if (!isPlain(parsed)) return [{ code: RECIPE_CODES.invalid, words: "a recipe is a JSON object" }];
  const r = parsed;
  for (const field of Object.keys(r)) {
    if (FIELDS.has(field)) continue;
    if (INSTALL_FIELDS.has(field)) say(RECIPE_CODES.install, `"${field}": a recipe runs no install step of its own; its owner installs its release with agentrun harness install --recipe`);
    else if (BINARY_FIELDS.has(field)) say(RECIPE_CODES.binary, `"${field}": a recipe names no binary of its own; the binary is its release's archive, pinned by sha256`);
    else if (ENV_FIELDS.has(field)) say(RECIPE_CODES.env, `"${field}": the agent's environment is an allowlist; name each variable and its value in env`);
    else say(RECIPE_CODES.invalid, `"${field}" is not a recipe field`);
  }

  const idPattern = new RegExp(HARNESS_ID_PATTERN);
  if (typeof r.id !== "string" || !idPattern.test(r.id)) say(RECIPE_CODES.invalid, `id must match ${HARNESS_ID_PATTERN}`);
  else if (BUILTIN_HARNESS_IDS.includes(r.id) || RESERVED_HARNESS_IDS.includes(r.id)) say(RECIPE_CODES.invalid, `id ${r.id} is a harness AgentRun already has, or a name its runs carry; give yours its own`);
  // Printed in sentences on a terminal (the sign-in's warning among them), so no control character reaches one.
  if (typeof r.label !== "string" || !r.label.trim() || r.label.length > 80 || /\p{Cc}/u.test(r.label)) say(RECIPE_CODES.invalid, "label is the harness's name in a sentence, 1 to 80 characters, none a control character");

  // Rule 2: the release.
  const release = r.release;
  if (!isPlain(release)) say(RECIPE_CODES.binary, "release names the agent's version and an archive per platform with its sha256 or sha512 (and its ACP registry id, where it is listed there)");
  else {
    for (const field of Object.keys(release)) if (!["registry", "version", "archives"].includes(field)) say(BINARY_FIELDS.has(field) ? RECIPE_CODES.binary : INSTALL_FIELDS.has(field) ? RECIPE_CODES.install : RECIPE_CODES.invalid, `release.${field} is not a release field`);
    if (release.registry !== undefined && (typeof release.registry !== "string" || !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(release.registry))) say(RECIPE_CODES.invalid, "release.registry, when given, is the agent's id in the ACP registry");
    if (typeof release.version !== "string" || !/^[0-9A-Za-z][0-9A-Za-z.+_-]{0,63}$/.test(release.version)) say(RECIPE_CODES.invalid, "release.version is the release's version string");
    if (!isPlain(release.archives) || !Object.keys(release.archives).length) say(RECIPE_CODES.binary, "release.archives names at least one platform's archive (linux-x86_64, darwin-aarch64, ...)");
    else {
      for (const [platform, archive] of Object.entries(release.archives)) {
        const at = `release.archives["${platform}"]`;
        if (!/^(darwin|linux|windows)-(aarch64|x86_64)$/.test(platform)) say(RECIPE_CODES.invalid, `${at}: a platform is named as the registry names it (linux-x86_64)`);
        if (!isPlain(archive)) {
          say(RECIPE_CODES.binary, `${at} is { url, format, sha256 or sha512, cmd }`);
          continue;
        }
        for (const field of Object.keys(archive)) if (!ARCHIVE_FIELDS.has(field)) say(INSTALL_FIELDS.has(field) ? RECIPE_CODES.install : RECIPE_CODES.binary, `${at}.${field} is not an archive field`);
        let url: URL | undefined;
        try {
          url = typeof archive.url === "string" ? new URL(archive.url) : undefined;
        } catch {
          url = undefined;
        }
        if (!url || url.protocol !== "https:" || url.username || url.password) say(RECIPE_CODES.binary, `${at}.url must be the vendor's https URL of the archive`);
        // The archive's one digest, as its vendor lists it: the registry's sha256, or a release manifest's sha512.
        if ((archive.sha256 === undefined) === (archive.sha512 === undefined)) say(RECIPE_CODES.binary, `${at} pins its archive by one digest: sha256 (64 lowercase hex digits) or sha512 (128), as its vendor lists it`);
        else if (archive.sha256 !== undefined && (typeof archive.sha256 !== "string" || !SHA256.test(archive.sha256))) say(RECIPE_CODES.binary, `${at}.sha256 must be the archive's sha256 as its vendor lists it, 64 lowercase hex digits`);
        else if (archive.sha512 !== undefined && (typeof archive.sha512 !== "string" || !SHA512.test(archive.sha512))) say(RECIPE_CODES.binary, `${at}.sha512 must be the archive's sha512 as its vendor lists it, 128 lowercase hex digits`);
        if (archive.binarySha256 !== undefined && (typeof archive.binarySha256 !== "string" || !SHA256.test(archive.binarySha256))) say(RECIPE_CODES.binary, `${at}.binarySha256, when given, is the unpacked binary's sha256, 64 lowercase hex digits`);
        if (archive.treeSha256 !== undefined && (typeof archive.treeSha256 !== "string" || !SHA256.test(archive.treeSha256))) say(RECIPE_CODES.binary, `${at}.treeSha256, when given, is the digest of every file the archive unpacks to (HARNESS.md), 64 lowercase hex digits`);
        if (archive.args !== undefined && !strings(archive.args)) say(RECIPE_CODES.invalid, `${at}.args, when given, is a list of strings: the release's args for that platform`);
        if (!(ARCHIVE_FORMATS as readonly unknown[]).includes(archive.format)) say(RECIPE_CODES.binary, `${at}.format: the installer unpacks ${listed(ARCHIVE_FORMATS)} archives alone`);
        if (typeof archive.cmd !== "string" || !archive.cmd || isAbsolute(archive.cmd) || !insideHome(archive.cmd)) say(RECIPE_CODES.paths, `${at}.cmd is the binary's path inside the archive (./agent), never one outside it`);
      }
    }
  }
  if (r.args !== undefined && !strings(r.args)) say(RECIPE_CODES.invalid, "args is a list of strings");

  // Rule 1: keys, each saved under a name of this harness's own, and handed under that name or the one its entry names.
  const entries = keyEntries(r.keys);
  if (!entries) say(RECIPE_CODES.keys, 'keys is a list of the key names saved for this harness alone, each a name or { "name": its saved name, "env": the variable the agent reads it from }');
  else {
    const handed = new Set<string>();
    const saved = new Set<string>();
    for (const { name, env } of entries) {
      // One saved key reaches the agent under one name: the adapter maps each saved name to a single variable.
      if (saved.has(name)) say(RECIPE_CODES.keys, `the key ${name} is named twice: a saved key is handed under one name`);
      saved.add(name);
      if (!KEY_NAME.test(name)) say(RECIPE_CODES.keys, `the key ${JSON.stringify(name)} is not a key's name (capitals, digits and _, at most 64)`);
      else if (serverKey(name)) say(RECIPE_CODES.keys, `${name} is a key this server holds for something else; a recipe names only keys saved for its own harness (save it under a name of its own, and hand it as ${name} with { "name", "env" })`);
      else if (SET_BY_ADAPTER.has(name)) say(RECIPE_CODES.env, `${name} is set by the adapter or the proxy, never by a key`);
      // Shaped as a key's name (a KEY, TOKEN, SECRET... segment), so the one cut every child's environment takes
      // (secrets.ts withoutSecrets) keeps it out of every run's tools and every other child, wherever it is set.
      else if (!keyShaped(name)) say(RECIPE_CODES.keys, `the key ${name} is not named as a key: its name needs one of the segments ${SECRET_SEGMENTS.join(", ")} (${name}_KEY, say), so no child of the server is ever handed it by its name`);
      // The variable it reaches the agent as may be a provider's name the server holds a key under (GEMINI_API_KEY): the
      // value is this harness's own, read by its saved name, so the server's never reaches the agent. Never the
      // adapter's, the proxy's, or the server's own (AGENTRUN_, AGENT_MODEL_).
      if (!KEY_NAME.test(env)) say(RECIPE_CODES.keys, `the key ${name}'s env ${JSON.stringify(env)} is not a key's name (capitals, digits and _, at most 64)`);
      else if (SET_BY_ADAPTER.has(env) || env.startsWith("AGENTRUN_") || env.startsWith("AGENT_MODEL_")) say(RECIPE_CODES.env, `the key ${name} is handed as ${env}, which the adapter, the proxy or the server sets`);
      else if (launchEnv(env)) say(RECIPE_CODES.env, `the key ${name} is handed as ${env}, which changes what the agent's process loads or runs`);
      if (handed.has(env)) say(RECIPE_CODES.keys, `two keys are handed as ${env}`);
      handed.add(env);
    }
  }
  // A sign-in method's id: the ACP package's AUTH_METHOD, the one definition, unchecked in form without it (as model.id).
  const methodId = acpPackage()?.AUTH_METHOD;
  if (r.keyMethod !== undefined && (typeof r.keyMethod !== "string" || (methodId !== undefined && !methodId.test(r.keyMethod)))) say(RECIPE_CODES.invalid, "keyMethod, when given, is the sign-in method's id the agent's initialize lists for its key (gemini-api-key)");
  else if (r.keyMethod !== undefined && !entries?.length) say(RECIPE_CODES.invalid, "keyMethod is the method the agent signs in with on its keys: name them in keys");

  // Rule 5: env, with rule 1 for a key named in it (by its saved name or the one it is handed as).
  const keys = new Set((entries ?? []).flatMap(({ name, env }) => [name, env]));
  if (r.env !== undefined && !isPlain(r.env)) say(RECIPE_CODES.env, "env is an object of variable names and their literal values");
  else for (const [name, value] of Object.entries((r.env as Record<string, unknown> | undefined) ?? {})) {
    if (!ENV_NAME.test(name)) say(RECIPE_CODES.env, `the env name ${JSON.stringify(name)} is not a variable name`);
    else if (serverKey(name) || keyShaped(name) || keys.has(name)) say(RECIPE_CODES.keys, `env names ${name}, a key: a key is never written in a recipe; name it in keys, and only a key of this harness's own`);
    else if (SET_BY_ADAPTER.has(name)) say(RECIPE_CODES.env, `env names ${name}, which the adapter or the proxy sets`);
    else if (launchEnv(name)) say(RECIPE_CODES.env, `env names ${name}, which changes what the agent's process loads or runs`);
    if (typeof value !== "string") say(RECIPE_CODES.env, `env.${name} must be a string`);
    else if (EXPANDS.test(value)) say(RECIPE_CODES.env, `env.${name} reads the host's environment ($NAME); write the value out, as nothing of the host's environment reaches the agent`);
  }

  // The model: who bills it.
  const model = r.model;
  if (!isPlain(model)) say(RECIPE_CODES.invalid, 'model is { "billing": "proxy", "wire": "anthropic-messages", "env": NAME } or { "billing": "plan", "maxTurns": N, "maxToolCalls": M }');
  else if (model.billing === "proxy") {
    if (model.wire !== "anthropic-messages") say(RECIPE_CODES.invalid, 'a proxy-billed agent speaks Anthropic\'s Messages API: model.wire is "anthropic-messages"');
    if (typeof model.env !== "string" || !ENV_NAME.test(model.env)) say(RECIPE_CODES.invalid, "model.env names the variable the agent reads its model from");
    else if (SET_BY_ADAPTER.has(model.env) || serverKey(model.env) || keyShaped(model.env)) say(RECIPE_CODES.env, `model.env names ${model.env}, which is the adapter's, the proxy's or a key`);
    else if (launchEnv(model.env)) say(RECIPE_CODES.env, `model.env names ${model.env}, which changes what the agent's process loads or runs`);
    else if (isPlain(r.env) && model.env in r.env) say(RECIPE_CODES.env, `env names ${model.env}, which the run's model sets`);
    if (model.hostEnv !== undefined && !PROXY_HOST_ENVS.includes(model.hostEnv as string)) say(RECIPE_CODES.env, `model.hostEnv is the variable the agent reads the proxy's address from: ${PROXY_HOST_ENVS.join(" or ")}`);
    for (const field of Object.keys(model)) if (!["billing", "wire", "env", "hostEnv"].includes(field)) say(RECIPE_CODES.invalid, `model.${field} is not a field of proxy billing`);
  } else if (model.billing === "plan") {
    if (!Number.isInteger(model.maxTurns) || (model.maxTurns as number) < 1) say(RECIPE_CODES.invalid, "plan billing needs maxTurns, a whole number of turns of at least 1");
    if (!Number.isInteger(model.maxToolCalls) || (model.maxToolCalls as number) < 0) say(RECIPE_CODES.invalid, "plan billing needs maxToolCalls, a whole number of calls");
    if (!entries?.length) say(RECIPE_CODES.invalid, "a plan-billed agent runs on its vendor's key, the one route its check, a schedule and a shared server take: name the key in keys (a signIn is its owner's own sign-in beside it, on their own machine alone)");
    if (model.hosts !== undefined && (!strings(model.hosts) || model.hosts.length > 16 || !model.hosts.every(vendorHost))) say(RECIPE_CODES.invalid, "model.hosts lists at most 16 hosts the vendor's model is on, each a host name with an optional :port from 1 to 65535 (default 443)");
    // A model id as an agent lists one (`gpt-5.4-nano[reasoning=medium]`): the ACP package's MODEL_ID, the one definition.
    // Without that package no recipe runs (harness-table.ts refuses it by name), so its form goes unchecked here.
    const listedId = acpPackage()?.MODEL_ID;
    if (model.id !== undefined && (typeof model.id !== "string" || (listedId !== undefined && !listedId.test(model.id)))) say(RECIPE_CODES.invalid, "model.id, when given, is the model's id as the agent lists it (session/new's availableModels): one word, no spaces");
    for (const field of Object.keys(model)) if (!["billing", "maxTurns", "maxToolCalls", "hosts", "id"].includes(field)) say(RECIPE_CODES.invalid, `model.${field} is not a field of plan billing`);
  } else say(RECIPE_CODES.invalid, 'model.billing is "proxy" or "plan"');

  // The sign-in: plan billing alone, the agent's own sign-in flags, and the one flag that names its folder, which AgentRun
  // alone gives a value (the owner's folder), so no other argument names it.
  const signIn = r.signIn;
  if (signIn !== undefined) {
    if (!isPlain(signIn)) say(RECIPE_CODES.invalid, 'signIn is { "args": the flags that start the agent\'s own sign-in (["--login"]), "homeArg": the flag it takes its sign-in folder by ("--gemini-dir") }');
    else {
      for (const field of Object.keys(signIn)) if (!["args", "homeArg", "terms"].includes(field)) say(RECIPE_CODES.invalid, `signIn.${field} is not a sign-in field`);
      // Printed as given in the sign-in's warning: printable ASCII with no space, at most 200 characters.
      if (signIn.terms !== undefined && (typeof signIn.terms !== "string" || !/^https:\/\/[\x21-\x7e]{1,192}$/.test(signIn.terms) || URL.parse(signIn.terms)?.protocol !== "https:")) say(RECIPE_CODES.invalid, "signIn.terms, when given, is the https address of the vendor's terms for a person's own sign-in, said at each sign-in: printable ASCII with no space, at most 200 characters");
      if (!strings(signIn.args) || !signIn.args.length) say(RECIPE_CODES.invalid, 'signIn.args is a list of at least one string: the flags that start the agent\'s own sign-in (["--login"])');
      else if (signIn.args.some((arg) => EXPANDS.test(arg))) say(RECIPE_CODES.env, "signIn.args reads the host's environment ($NAME); write each argument out");
      if (typeof signIn.homeArg !== "string" || !LONG_FLAG.test(signIn.homeArg)) say(RECIPE_CODES.invalid, 'signIn.homeArg is the long flag the agent takes the folder it keeps its sign-in in by ("--gemini-dir"), its value given by AgentRun');
      else {
        const archives = isPlain(release) && isPlain(release.archives) ? Object.values(release.archives) : [];
        const elsewhere = [strings(signIn.args) ? signIn.args : [], strings(r.args) ? r.args : [], ...archives.map((archive) => (isPlain(archive) && strings(archive.args) ? archive.args : []))];
        const flag = signIn.homeArg;
        if (elsewhere.some((args) => args.some((arg) => arg === flag || arg.startsWith(`${flag}=`)))) say(RECIPE_CODES.invalid, `signIn.homeArg ${flag} is in args too: AgentRun alone gives it its value, the owner's sign-in folder`);
      }
    }
    if (isPlain(model) && model.billing !== "plan") say(RECIPE_CODES.invalid, "signIn is for a plan-billed agent: a proxy-billed one runs on the server's key, through its proxy");
  }

  // Rule 3: files and state.
  if (r.files !== undefined && !isPlain(r.files)) say(RECIPE_CODES.paths, "files is an object of paths in the private HOME and their contents");
  else for (const [path, content] of Object.entries((r.files as Record<string, unknown> | undefined) ?? {})) {
    if (!insideHome(path)) say(RECIPE_CODES.paths, `the file ${JSON.stringify(path)} must be a path inside the session's private HOME`);
    if (typeof content !== "string") say(RECIPE_CODES.invalid, `the file ${JSON.stringify(path)}'s content must be a string`);
  }
  if (r.allowFile !== undefined) {
    const allow = r.allowFile;
    if (!isPlain(allow) || typeof allow.path !== "string" || typeof allow.form !== "string" || Object.keys(allow).some((k) => k !== "path" && k !== "form")) say(RECIPE_CODES.invalid, 'allowFile is { "path": a file in the private HOME, "form": the form its agent reads }');
    else {
      const path = insideHome(allow.path);
      if (!path) say(RECIPE_CODES.paths, `the allowFile ${JSON.stringify(allow.path)} must be a path inside the session's private HOME`);
      else if (isPlain(r.files) && Object.keys(r.files).some((file) => insideHome(file) === path)) say(RECIPE_CODES.invalid, `the allowFile ${JSON.stringify(allow.path)} is also one of files: the adapter writes it from each start's tools`);
      // The forms are the ACP package's (ALLOW_FILE_FORMS), the one definition. Without that package no recipe runs.
      const forms = acpPackage()?.ALLOW_FILE_FORMS;
      if (forms !== undefined && !forms.includes(allow.form)) say(RECIPE_CODES.invalid, `the allowFile form ${JSON.stringify(allow.form)} is none of ${forms.join(", ")}`);
    }
  }
  if (r.state !== undefined && !strings(r.state)) say(RECIPE_CODES.paths, "state is a list of folders in the private HOME");
  else for (const path of (r.state as string[] | undefined) ?? []) if (!insideHome(path)) say(RECIPE_CODES.paths, `the state folder ${JSON.stringify(path)} must be inside the session's private HOME`);

  const declares = r.declares;
  if (!isPlain(declares) || typeof declares.load !== "boolean" || (declares.mcp !== "http" && declares.mcp !== "stdio")) say(RECIPE_CODES.invalid, 'declares is { "load": true or false, "mcp": "http" or "stdio" }');
  // The announces field, and the title tie that needs it: the ACP package's rule (announcesProblems), the one definition.
  // Without that package no recipe runs.
  for (const words of acpPackage()?.announcesProblems(r.announces, isPlain(r.quirks) ? r.quirks.permissionTie : undefined) ?? []) say(RECIPE_CODES.invalid, words);
  if (r.quirks !== undefined && (!isPlain(r.quirks) || Object.keys(r.quirks).some((k) => k !== "mcpCall" && k !== "permissionTie") || (r.quirks.mcpCall !== undefined && r.quirks.mcpCall !== "match" && r.quirks.mcpCall !== "mint") || (r.quirks.permissionTie !== undefined && r.quirks.permissionTie !== "title"))) say(RECIPE_CODES.invalid, 'quirks is { "mcpCall": "match" or "mint", "permissionTie": "title" }');
  if (r.description !== undefined && typeof r.description !== "string") say(RECIPE_CODES.invalid, "description is a string");
  return problems;
}

/** The recipe in `text`, or RecipeRefused with every problem. */
export function parseRecipe(text: string): Recipe {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new RecipeRefused(RECIPE_CODES.invalid, [{ code: RECIPE_CODES.invalid, words: `not JSON (${(error as Error).message})` }]);
  }
  const problems = recipeProblems(parsed);
  if (problems.length) throw new RecipeRefused(problems[0]!.code, problems);
  const r = parsed as Record<string, unknown> & Omit<Recipe, "keys"> & { keys?: unknown };
  const entries = keyEntries(r.keys)!;
  return Object.freeze({
    id: r.id,
    label: r.label,
    release: r.release,
    args: r.args ?? [],
    keys: entries.map(({ name }) => name),
    keyEnv: Object.fromEntries(entries.filter(({ name, env }) => name !== env).map(({ name, env }) => [name, env])),
    ...(r.keyMethod ? { keyMethod: r.keyMethod } : {}),
    env: r.env ?? {},
    model: r.model,
    files: Object.fromEntries(Object.entries(r.files ?? {}).map(([path, content]) => [insideHome(path)!, content])),
    ...(r.allowFile ? { allowFile: Object.freeze({ path: insideHome(r.allowFile.path)!, form: r.allowFile.form }) } : {}),
    ...(r.announces ? { announces: Object.freeze({ tool: r.announces.tool, ...(r.announces.server !== undefined ? { server: r.announces.server } : {}), ...(r.announces.prefix !== undefined ? { prefix: r.announces.prefix } : {}), ...(r.announces.args !== undefined ? { args: r.announces.args } : {}), ...(r.announces.extras !== undefined ? { extras: Object.freeze([...r.announces.extras]) } : {}) }) } : {}),
    state: (r.state ?? []).map((path) => insideHome(path)!),
    declares: r.declares,
    quirks: r.quirks ?? {},
    ...(r.signIn ? { signIn: Object.freeze({ args: Object.freeze([...r.signIn.args]), homeArg: r.signIn.homeArg, ...(r.signIn.terms ? { terms: r.signIn.terms } : {}) }) } : {}),
  });
}

/** The file `given` names, from `cwd`: the recipe the ACP package ships (bundledRecipePath: Google Antigravity's) when
 *  `given` is its name, else the file at that path. A name a file in `cwd` also holds is refused, saying both, so the
 *  owner's own file is never passed over silently (`./<name>` names the file). A bundled name is never a built-in
 *  harness's id: the recipe's own id is that name, and a built-in id is refused as a recipe's (parseRecipe). */
export function resolveRecipe(given: string, cwd: string = process.cwd()): { file: string; bundled: boolean } {
  const local = resolve(cwd, given);
  const shipped = acpPackage()?.bundledRecipePath?.(given);
  // The shipped file named by its path is the shipped recipe too.
  if (!shipped) return { file: local, bundled: bundledName(local) !== undefined };
  if (existsSync(local)) throw new RecipeRefused(RECIPE_CODES.invalid, [{ code: RECIPE_CODES.invalid, words: `${given} names both the recipe AgentRun ships (${shipped}) and the file ${local} in this directory: write ./${given} for your file, or name the shipped one from another directory` }]);
  return { file: shipped, bundled: true };
}

/** The name of the recipe at `file` when the ACP package ships it, else undefined. */
const bundledName = (file: string): string | undefined => {
  const acp = acpPackage();
  return acp?.BUNDLED_RECIPES?.find((each) => acp.bundledRecipePath?.(each) === resolve(file));
};

/** The word a printed command names the recipe at `file` by: its bundled name, else the file. */
const recipeWord = (file: string): string => bundledName(file) ?? shellWord(file);

/** Which recipe resolved, as a command says it before anything else: the one AgentRun ships, or the owner's file. */
export const recipeSaid = (label: string, file: string, bundled: boolean): string =>
  `${label}: ${bundled ? `the recipe AgentRun ships (${file})` : `the recipe file ${file}`}`;

/** The recipe at `path` (a file, or the name of a recipe AgentRun ships: resolveRecipe), read and loaded. */
export function loadRecipe(path: string): { recipe: Recipe; file: string; sha256: string; bundled: boolean } {
  const { file, bundled } = resolveRecipe(path);
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    throw new RecipeRefused(RECIPE_CODES.invalid, [{ code: RECIPE_CODES.invalid, words: `the recipe file ${file} cannot be read (${(error as NodeJS.ErrnoException).code ?? (error as Error).message})` }]);
  }
  return { recipe: parseRecipe(text), file, sha256: createHash("sha256").update(text).digest("hex"), bundled };
}

/** The recipe's release for `platform` (this host's by default), or undefined where it lists none. */
export const releaseFor = (recipe: Recipe, platform: string | undefined = archivePlatform()): RecipeArchive | undefined => (platform ? recipe.release.archives[platform] : undefined);

/** The owner's command that installs the recipe at `file` into `data` (one AgentRun ships by its name, as goose's is). */
export const recipeInstallLine = (file: string, data: string, env: NodeJS.ProcessEnv = process.env): string =>
  `agentrun harness install ${bundledName(file) ?? `--recipe ${shellWord(file)}`}${resolve(data) === commandData(env) ? "" : ` --data ${shellWord(data)}`}`;

/** Where the recipe's binary is once installed: `<data>/harnesses/<id>/<cmd>`. */
export const recipeBinaryOf = (data: string, recipe: Recipe, release: RecipeArchive): string => join(installDirOf(data, recipe.id), insideHome(release.cmd)!);

/** A first-seen digest record in a file of its own (one line, the sha256), written once and never over another's. */
export function firstSeenRecord(file: string): { read(): string | undefined; write(sha256: string): void } {
  return {
    read() {
      if (!existsSync(file)) return undefined;
      const recorded = readFileSync(file, "utf8").trim();
      if (!SHA256.test(recorded)) throw new Error(`the recorded digest in ${file} is not a sha256`);
      return recorded;
    },
    write(sha256) {
      mkdirSync(join(file, ".."), { recursive: true, mode: 0o700 });
      writeFileSync(file, `${sha256}\n`, { mode: 0o600, flag: "wx" });
    },
  };
}

/** Where the first digest of every file the archive unpacked to (acp's treeDigest), the binary among them, is kept for a
 *  recipe that pins no treeSha256: beside the harnesses' folders, never inside the one an install replaces, so a
 *  reinstall that unpacks another binary or sidecar (Antigravity's) is seen. One per id, version and platform. */
export const firstSeenTreeOf = (data: string, recipe: Recipe, platform: string): string => join(harnessesOf(data), ".first-seen", `${recipe.id}@${recipe.release.version}-${platform}.tree.sha256`);

/** A recipe's install on `data` as every reader holds it (harness-check, `harness sign-in`, a server's entry and each of
 *  its starts): its release for `platform`, its binary and folder, the owner's command that installs it (`line`), and the
 *  digest every file in the folder must have together (treeDigest, the binary among them): the recipe's treeSha256, else
 *  the first one its install recorded. Nothing is downloaded. */
export type RecipeInstall = { readonly platform: string; readonly release: RecipeArchive; readonly binary: string; readonly dir: string; readonly line: string; readonly tree: { readonly sha256: string; readonly by: "recipe" | "first-seen" } };
/** Why a recipe's install does not run, by code, in words that end with the command that fixes it. */
export type InstallRefusal = { readonly code: string; readonly message: string };

/** The recipe's install (RecipeInstall), or why there is none to hold: no release for the platform, nothing installed, or
 *  an install from before every file beside its binary was recorded. */
export function recipeInstall(data: string, recipe: Recipe, file: string, env: NodeJS.ProcessEnv = process.env, platform: string | undefined = archivePlatform()): RecipeInstall | InstallRefusal {
  const release = releaseFor(recipe, platform);
  if (!platform || !release) return { code: "HARNESS_PLATFORM_UNSUPPORTED", message: `${recipe.label} ${recipe.release.version} has no release for ${platform ?? `${process.platform}-${process.arch}`}` };
  const dir = installDirOf(data, recipe.id);
  const binary = recipeBinaryOf(data, recipe, release);
  const line = recipeInstallLine(file, data, env);
  const recorded = release.treeSha256 ? undefined : firstSeenRecord(firstSeenTreeOf(data, recipe, platform)).read();
  const tree = release.treeSha256 ? { sha256: release.treeSha256, by: "recipe" as const } : recorded ? { sha256: recorded, by: "first-seen" as const } : undefined;
  if (!existsSync(binary)) return { code: "HARNESS_NOT_INSTALLED", message: `${recipe.label} ${recipe.release.version} is not installed in ${dir}. Install it with: ${line}` };
  if (!tree) return { code: "HARNESS_NOT_INSTALLED", message: `${recipe.label} ${recipe.release.version}'s files in ${dir} were never recorded by its install, so they cannot be checked. Install it again with: ${line}` };
  return { platform, release, binary, dir, line, tree };
}

/** Whether every file of the install is still its tree's (RecipeInstall), digested now: undefined, or the refusal
 *  (HARNESS_BINARY_MISMATCH; HARNESS_NOT_INSTALLED where the ACP adapter that takes the digest is not beside this server).
 *  The tree digest holds a link by its target's name, never the file it leads to, so a folder with a link out of it
 *  (linkOutOf: the executable behind a linked folder, code it loads from elsewhere) is refused: those bytes would be
 *  checked by nothing. */
export async function installHolds(install: RecipeInstall): Promise<InstallRefusal | undefined> {
  const acp = acpPackage();
  if (!acp) return { code: "HARNESS_NOT_INSTALLED", message: `the ACP adapter (${ACP_PACKAGE}) is not installed beside this server` };
  const outward = await linkOutOf(install.dir).catch(() => "(unreadable)");
  if (outward !== undefined) return { code: ARCHIVE_CODES.binary, message: `${install.dir} holds a link that leads outside it (${outward}), so the digest of its files does not hold what it leads to. Install it again with: ${install.line}` };
  const found = await acp.treeDigest(install.dir).catch(() => undefined);
  if (found === install.tree.sha256) return undefined;
  return { code: ARCHIVE_CODES.binary, message: `${install.dir} has the tree sha256 ${found ?? "(unreadable)"}, and ${install.tree.by === "recipe" ? "the recipe pins" : "its first install recorded"} ${install.tree.sha256}. Install it again with: ${install.line}` };
}

/** The folder the agent keeps its owner's sign-in in (given by signIn.homeArg on `agentrun harness sign-in` and on every
 *  run on that sign-in): `<data>/harnesses/<id>.sign-in`, 0700, beside the install and never inside it (a reinstall keeps
 *  the sign-in). The agent alone writes and reads what is in it: AgentRun hands it the path, and never lists, opens,
 *  copies or sends anything in it. */
export const signInHomeOf = (data: string, id: string): string => join(harnessesOf(data), `${id}.sign-in`);

/** AgentRun's own note that the agent's sign-in ended well (its exit status 0), beside the folder and never in it:
 *  `<data>/harnesses/<id>.signed-in`, holding when and on which version. It holds nothing of the sign-in. */
export const signedInNoteOf = (data: string, id: string): string => join(harnessesOf(data), `${id}.signed-in`);

/** The owner's command that signs the recipe at `file` in, on `data`. */
export const recipeSignInLine = (file: string, data: string, env: NodeJS.ProcessEnv = process.env): string =>
  `agentrun harness sign-in --recipe ${recipeWord(file)}${resolve(data) === commandData(env) ? "" : ` --data ${shellWord(data)}`}`;

/** Whether the agent's own sign-in ended well on `data` (signedInNoteOf): nothing in its folder is read to say so.
 *  Whether the sign-in still holds is the agent's to say when it runs (an ACP -32000, Authentication required). */
export const signedIn = (data: string, recipe: Recipe): boolean => recipe.signIn !== undefined && existsSync(signedInNoteOf(data, recipe.id));

/** What a passing harness-check proved, by digest: the recipe file (its version in it) and every file of the install, the
 *  binary among them, on `platform`. A server runs the recipe only while all three are still these
 *  (harness-recipe-entry.ts). */
export type RecipeChecked = { readonly recipe: string; readonly tree: string; readonly platform: string };

/** AgentRun's own note of the last harness-check that passed for the recipe `id` on `data`: `<data>/harnesses/<id>.checked`,
 *  beside the install and never in it. */
export const checkedNoteOf = (data: string, id: string): string => join(harnessesOf(data), `${id}.checked`);

/** Writes the note of a passing check (checkedNoteOf), over the one before it: open to its owner alone. */
export function writeChecked(data: string, id: string, checked: RecipeChecked): void {
  mkdirSync(harnessesOf(data), { recursive: true, mode: 0o700 });
  writeFileSync(checkedNoteOf(data, id), `${JSON.stringify({ ...checked, at: new Date().toISOString() })}\n`, { mode: 0o600 });
}

/** The note of the last check that passed for `id` on `data`, or undefined where there is none or it is not one. */
export function checkedOf(data: string, id: string): RecipeChecked | undefined {
  try {
    const note = JSON.parse(readFileSync(checkedNoteOf(data, id), "utf8")) as Partial<Record<keyof RecipeChecked, unknown>>;
    const fields = ["recipe", "tree", "platform"] as const;
    return fields.every((field) => typeof note[field] === "string") ? (Object.fromEntries(fields.map((field) => [field, note[field]])) as RecipeChecked) : undefined;
  } catch {
    return undefined;
  }
}

/** Installs the recipe's release into `<data>/harnesses/<id>` (the owner's command, rule 4): its archive downloaded and
 *  checked against the recipe's sha256, unpacked, its binary checked against the recipe's binarySha256 where it pins one,
 *  and every file it unpacked to, the binary among them, held to the recipe's treeSha256, else recorded as the first tree
 *  seen (a later one that differs is refused), so nothing in the archive runs unpinned. */
export async function installRecipe(recipe: Recipe, file: string, data: string, options: ArchiveInstallOptions = {}, env: NodeJS.ProcessEnv = process.env) {
  const platform = options.platform ?? archivePlatform();
  const release = releaseFor(recipe, platform);
  const acp = acpPackage();
  const record = release && !release.treeSha256 && platform && acp ? firstSeenRecord(firstSeenTreeOf(data, recipe, platform)) : undefined;
  const before = record?.read();
  const done = await installArchive({ id: recipe.id, label: recipe.label, retry: recipeInstallLine(file, data, env), pin: { version: recipe.release.version, archives: recipe.release.archives }, ...(acp ? { tree: (root: string) => acp.treeDigest(root) } : {}) }, installDirOf(data, recipe.id), { ...options, ...(record ? { treeRecord: record } : {}) });
  // What its files were held to: the recipe's tree pin, the first tree an earlier install recorded, or this one's, recorded now.
  const pinnedBy: "recipe" | "first-seen" | "recorded" = release?.treeSha256 ? "recipe" : before ? "first-seen" : "recorded";
  return { version: recipe.release.version, pinnedBy, ...done };
}

/** The owner's command that checks the recipe at `file`, installed into `data`. */
export const recipeCheckLine = (file: string, data: string, env: NodeJS.ProcessEnv = process.env): string =>
  `agentrun harness-check --recipe ${recipeWord(file)}${resolve(data) === commandData(env) ? "" : ` --data ${shellWord(data)}`}`;
