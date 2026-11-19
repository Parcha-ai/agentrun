// A harness recipe (door 1 of bring your own harness): a JSON file that says how to run an ACP agent AgentRun does not
// ship, read by the one loader here. Goose's recipe (run-adapters-acp's recipes/goose.json) and its owner's install
// (harness-goose.ts) are the path this generalizes: a recipe file its owner points at goes through the same five rules,
// each refused by a code of its own (RECIPE_CODES) before anything is downloaded or started:
//  1. Own keys only. `keys` names the keys saved for this harness alone (a vendor's API key). A key the server holds for
//     anything else (the launcher's secrets: every model provider's, the gateway's, the tools', the computers', serve's
//     own) is refused, and `env` names no key at all: a value in a recipe file is plain text.
//  2. A pinned binary. The binary is the release's archive for this platform, as the ACP registry lists it: an https URL
//     and its sha256. A recipe names no command, path or binary of its own. The binary's own sha256 is pinned when the
//     recipe gives it; where it does not (the registry lists only the archive's), the install records the first one it
//     unpacks from the verified archive, and a binary that differs from it later is refused (drift).
//  3. Private paths. The files it writes and the state it keeps are paths inside the session's private HOME; the binary
//     is a path inside its own folder.
//  4. The owner installs it. Only `agentrun harness install --recipe FILE` downloads and unpacks it (installRecipe), into
//     `<data>/harnesses/<id>`. A check or a run that finds it missing says that command and downloads nothing; a recipe
//     names no install step, script or hook of its own.
//  5. An allowlist environment. The agent's process gets the adapter's allowlist (PATH, LANG, TZ), its private HOME and
//     tmp, the recipe's literal `env`, its own keys, and the proxy's address: nothing else of the host's. A recipe cannot
//     ask for more (no inherit or pass-through field), names none of the variables the adapter or the proxy sets, and
//     writes its values out (no `$NAME` for the host to fill in).
// Nothing here reads the network or starts a process.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { isAbsolute, join, normalize, resolve, sep } from "node:path";
import { HARNESS_ID_PATTERN, HARNESSES, RESERVED_HARNESS_IDS } from "./harness.js";
import { type ArchiveInstallOptions, archivePlatform, type ArchiveRelease, installArchive } from "./harness-archive.js";
import { commandData } from "./harness-goose.js";
import { harnessesOf, installDirOf, shellWord } from "./harness-install.js";
import { keyShaped } from "./secret-name.js";
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

/** One platform's release of the agent, copied from its ACP registry entry (`distribution.binary.<platform>`). */
export type RecipeArchive = ArchiveRelease & { readonly format: "tar.bz2" };

/** The variables a proxy-billed agent may read the proxy's address from: Goose's, and the Anthropic SDKs'. */
export const PROXY_HOST_ENVS: readonly string[] = Object.freeze(["ANTHROPIC_HOST", "ANTHROPIC_BASE_URL"]);

/** How the agent's model is billed. `proxy`: it speaks Anthropic's Messages API to the address in `hostEnv` (default
 *  ANTHROPIC_HOST) with ANTHROPIC_API_KEY, both the session's model proxy's (the run's cap and books hold), and reads the
 *  run's model from `env`. `plan`: the vendor bills the owner's plan on the recipe's own keys; the adapter stops the run
 *  at these limits. */
export type RecipeModel =
  | { readonly billing: "proxy"; readonly wire: "anthropic-messages"; readonly env: string; readonly hostEnv?: "ANTHROPIC_HOST" | "ANTHROPIC_BASE_URL" }
  | { readonly billing: "plan"; readonly maxTurns: number; readonly maxToolCalls: number; readonly hosts?: readonly string[] };

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
  readonly release: { readonly registry: string; readonly version: string; readonly archives: Readonly<Record<string, RecipeArchive>> };
  readonly args: readonly string[];
  readonly keys: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly model: RecipeModel;
  readonly files: Readonly<Record<string, string>>;
  readonly state: readonly string[];
  readonly declares: { readonly load: boolean; readonly mcp: "http" | "stdio" };
  readonly quirks: { readonly mcpCall?: "match" | "mint" };
}

/** A recipe the loader refused: `code` is the first problem's, and the message says every one. */
export class RecipeRefused extends Error {
  constructor(readonly code: RecipeCode, readonly problems: readonly { code: RecipeCode; words: string }[]) {
    super(`${code}: ${problems.map((p) => (p.code === code ? p.words : `${p.code}: ${p.words}`)).join("; ")}`);
    this.name = "RecipeRefused";
  }
}

/** The fields a recipe has. */
const FIELDS = new Set(["id", "label", "release", "args", "keys", "env", "model", "files", "state", "declares", "quirks", "description", "$schema"]);
/** Fields that would run something of the recipe's own at install or start (rule 4). */
const INSTALL_FIELDS = new Set(["install", "installCommand", "postinstall", "preinstall", "setup", "script", "scripts", "run", "hooks", "update"]);
/** Fields that would name a binary other than the release's archive (rule 2). */
const BINARY_FIELDS = new Set(["command", "binary", "path", "bin", "executable", "exec"]);
/** Fields that would pass the host's environment through (rule 5). */
const ENV_FIELDS = new Set(["inheritEnv", "passEnv", "envFrom", "inherit", "envPassthrough", "passthroughEnv"]);
/** The variables the adapter sets itself (run-adapters-acp's RESERVED_ENV), its allowlist's, and the proxy's. */
const SET_BY_ADAPTER = new Set(["HOME", "TMPDIR", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_STATE_HOME", "GIT_CEILING_DIRECTORIES", "PATH", "LANG", "TZ", "ANTHROPIC_HOST", "ANTHROPIC_BASE_URL", "ANTHROPIC_API_KEY"]);
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const ARCHIVE_FIELDS = new Set(["url", "format", "sha256", "cmd", "binarySha256"]);
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
  else if ((HARNESSES as readonly string[]).includes(r.id) || r.id === "goose" || RESERVED_HARNESS_IDS.includes(r.id)) say(RECIPE_CODES.invalid, `id ${r.id} is a harness AgentRun already has, or a name its runs carry; give yours its own`);
  if (typeof r.label !== "string" || !r.label.trim() || r.label.length > 80) say(RECIPE_CODES.invalid, "label is the harness's name in a sentence, 1 to 80 characters");

  // Rule 2: the release.
  const release = r.release;
  if (!isPlain(release)) say(RECIPE_CODES.binary, "release names the agent's registry id, its version and an archive per platform with its sha256");
  else {
    for (const field of Object.keys(release)) if (!["registry", "version", "archives"].includes(field)) say(BINARY_FIELDS.has(field) ? RECIPE_CODES.binary : INSTALL_FIELDS.has(field) ? RECIPE_CODES.install : RECIPE_CODES.invalid, `release.${field} is not a release field`);
    if (typeof release.registry !== "string" || !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(release.registry)) say(RECIPE_CODES.invalid, "release.registry is the agent's id in the ACP registry");
    if (typeof release.version !== "string" || !/^[0-9A-Za-z][0-9A-Za-z.+_-]{0,63}$/.test(release.version)) say(RECIPE_CODES.invalid, "release.version is the registry's version string");
    if (!isPlain(release.archives) || !Object.keys(release.archives).length) say(RECIPE_CODES.binary, "release.archives names at least one platform's archive (linux-x86_64, darwin-aarch64, ...)");
    else {
      for (const [platform, archive] of Object.entries(release.archives)) {
        const at = `release.archives["${platform}"]`;
        if (!/^(darwin|linux|windows)-(aarch64|x86_64)$/.test(platform)) say(RECIPE_CODES.invalid, `${at}: a platform is named as the registry names it (linux-x86_64)`);
        if (!isPlain(archive)) {
          say(RECIPE_CODES.binary, `${at} is { url, format, sha256, cmd }`);
          continue;
        }
        for (const field of Object.keys(archive)) if (!ARCHIVE_FIELDS.has(field)) say(INSTALL_FIELDS.has(field) ? RECIPE_CODES.install : RECIPE_CODES.binary, `${at}.${field} is not an archive field`);
        let url: URL | undefined;
        try {
          url = typeof archive.url === "string" ? new URL(archive.url) : undefined;
        } catch {
          url = undefined;
        }
        if (!url || url.protocol !== "https:" || url.username || url.password) say(RECIPE_CODES.binary, `${at}.url must be the registry's https URL of the archive`);
        if (typeof archive.sha256 !== "string" || !SHA256.test(archive.sha256)) say(RECIPE_CODES.binary, `${at}.sha256 must be the archive's sha256 as the registry lists it, 64 lowercase hex digits`);
        if (archive.binarySha256 !== undefined && (typeof archive.binarySha256 !== "string" || !SHA256.test(archive.binarySha256))) say(RECIPE_CODES.binary, `${at}.binarySha256, when given, is the unpacked binary's sha256, 64 lowercase hex digits`);
        if (archive.format !== "tar.bz2") say(RECIPE_CODES.binary, `${at}.format: the installer unpacks tar.bz2 archives alone`);
        if (typeof archive.cmd !== "string" || !archive.cmd || isAbsolute(archive.cmd) || !insideHome(archive.cmd)) say(RECIPE_CODES.paths, `${at}.cmd is the binary's path inside the archive (./agent), never one outside it`);
      }
    }
  }
  if (r.args !== undefined && !strings(r.args)) say(RECIPE_CODES.invalid, "args is a list of strings");

  // Rule 1: keys.
  if (r.keys !== undefined && !strings(r.keys)) say(RECIPE_CODES.keys, "keys is a list of the key names saved for this harness alone");
  else for (const name of (r.keys as string[] | undefined) ?? []) {
    if (!ENV_NAME.test(name)) say(RECIPE_CODES.keys, `the key ${JSON.stringify(name)} is not a variable name`);
    else if (serverKey(name)) say(RECIPE_CODES.keys, `${name} is a key this server holds for something else; a recipe names only keys saved for its own harness`);
    else if (SET_BY_ADAPTER.has(name)) say(RECIPE_CODES.env, `${name} is set by the adapter or the proxy, never by a key`);
  }

  // Rule 5: env, with rule 1 for a key named in it.
  const keys = new Set(strings(r.keys) ? r.keys : []);
  if (r.env !== undefined && !isPlain(r.env)) say(RECIPE_CODES.env, "env is an object of variable names and their literal values");
  else for (const [name, value] of Object.entries((r.env as Record<string, unknown> | undefined) ?? {})) {
    if (!ENV_NAME.test(name)) say(RECIPE_CODES.env, `the env name ${JSON.stringify(name)} is not a variable name`);
    else if (serverKey(name) || keyShaped(name) || keys.has(name)) say(RECIPE_CODES.keys, `env names ${name}, a key: a key is never written in a recipe; name it in keys, and only a key of this harness's own`);
    else if (SET_BY_ADAPTER.has(name)) say(RECIPE_CODES.env, `env names ${name}, which the adapter or the proxy sets`);
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
    else if (isPlain(r.env) && model.env in r.env) say(RECIPE_CODES.env, `env names ${model.env}, which the run's model sets`);
    if (model.hostEnv !== undefined && !PROXY_HOST_ENVS.includes(model.hostEnv as string)) say(RECIPE_CODES.env, `model.hostEnv is the variable the agent reads the proxy's address from: ${PROXY_HOST_ENVS.join(" or ")}`);
    for (const field of Object.keys(model)) if (!["billing", "wire", "env", "hostEnv"].includes(field)) say(RECIPE_CODES.invalid, `model.${field} is not a field of proxy billing`);
  } else if (model.billing === "plan") {
    if (!Number.isInteger(model.maxTurns) || (model.maxTurns as number) < 1) say(RECIPE_CODES.invalid, "plan billing needs maxTurns, a whole number of turns of at least 1");
    if (!Number.isInteger(model.maxToolCalls) || (model.maxToolCalls as number) < 0) say(RECIPE_CODES.invalid, "plan billing needs maxToolCalls, a whole number of calls");
    if (!strings(r.keys) || !r.keys.length) say(RECIPE_CODES.keys, "a plan-billed agent runs on its vendor's key: name it in keys");
    if (model.hosts !== undefined && (!strings(model.hosts) || model.hosts.length > 16 || !model.hosts.every(vendorHost))) say(RECIPE_CODES.invalid, "model.hosts lists at most 16 hosts the vendor's model is on, each a host name with an optional :port from 1 to 65535 (default 443)");
    for (const field of Object.keys(model)) if (!["billing", "maxTurns", "maxToolCalls", "hosts"].includes(field)) say(RECIPE_CODES.invalid, `model.${field} is not a field of plan billing`);
  } else say(RECIPE_CODES.invalid, 'model.billing is "proxy" or "plan"');

  // Rule 3: files and state.
  if (r.files !== undefined && !isPlain(r.files)) say(RECIPE_CODES.paths, "files is an object of paths in the private HOME and their contents");
  else for (const [path, content] of Object.entries((r.files as Record<string, unknown> | undefined) ?? {})) {
    if (!insideHome(path)) say(RECIPE_CODES.paths, `the file ${JSON.stringify(path)} must be a path inside the session's private HOME`);
    if (typeof content !== "string") say(RECIPE_CODES.invalid, `the file ${JSON.stringify(path)}'s content must be a string`);
  }
  if (r.state !== undefined && !strings(r.state)) say(RECIPE_CODES.paths, "state is a list of folders in the private HOME");
  else for (const path of (r.state as string[] | undefined) ?? []) if (!insideHome(path)) say(RECIPE_CODES.paths, `the state folder ${JSON.stringify(path)} must be inside the session's private HOME`);

  const declares = r.declares;
  if (!isPlain(declares) || typeof declares.load !== "boolean" || (declares.mcp !== "http" && declares.mcp !== "stdio")) say(RECIPE_CODES.invalid, 'declares is { "load": true or false, "mcp": "http" or "stdio" }');
  if (r.quirks !== undefined && (!isPlain(r.quirks) || Object.keys(r.quirks).some((k) => k !== "mcpCall") || (r.quirks.mcpCall !== undefined && r.quirks.mcpCall !== "match" && r.quirks.mcpCall !== "mint"))) say(RECIPE_CODES.invalid, 'quirks is { "mcpCall": "match" or "mint" }');
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
  const r = parsed as Record<string, unknown> & Recipe;
  return Object.freeze({
    id: r.id,
    label: r.label,
    release: r.release,
    args: r.args ?? [],
    keys: r.keys ?? [],
    env: r.env ?? {},
    model: r.model,
    files: Object.fromEntries(Object.entries(r.files ?? {}).map(([path, content]) => [insideHome(path)!, content])),
    state: (r.state ?? []).map((path) => insideHome(path)!),
    declares: r.declares,
    quirks: r.quirks ?? {},
  });
}

/** The recipe file at `path`, read and loaded. */
export function loadRecipe(path: string): { recipe: Recipe; file: string; sha256: string } {
  const file = resolve(path);
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    throw new RecipeRefused(RECIPE_CODES.invalid, [{ code: RECIPE_CODES.invalid, words: `the recipe file ${file} cannot be read (${(error as NodeJS.ErrnoException).code ?? (error as Error).message})` }]);
  }
  return { recipe: parseRecipe(text), file, sha256: createHash("sha256").update(text).digest("hex") };
}

/** The recipe's release for `platform` (this host's by default), or undefined where it lists none. */
export const releaseFor = (recipe: Recipe, platform: string | undefined = archivePlatform()): RecipeArchive | undefined => (platform ? recipe.release.archives[platform] : undefined);

/** The owner's command that installs the recipe at `file` into `data`. */
export const recipeInstallLine = (file: string, data: string, env: NodeJS.ProcessEnv = process.env): string =>
  `agentrun harness install --recipe ${shellWord(file)}${resolve(data) === commandData(env) ? "" : ` --data ${shellWord(data)}`}`;

/** Where the recipe's binary is once installed: `<data>/harnesses/<id>/<cmd>`. */
export const recipeBinaryOf = (data: string, recipe: Recipe, release: RecipeArchive): string => join(installDirOf(data, recipe.id), insideHome(release.cmd)!);

/** Where the first sha256 of a binary the recipe does not pin is kept: beside the harnesses' folders, never inside the
 *  one an install replaces, so a reinstall that unpacks a different binary is seen. One per id, version and platform. */
export const firstSeenOf = (data: string, recipe: Recipe, platform: string): string => join(harnessesOf(data), ".first-seen", `${recipe.id}@${recipe.release.version}-${platform}.sha256`);

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

/** The sha256 the installed binary must have: the recipe's pin, else the first one its install recorded; undefined when it
 *  pins none and none was recorded (never installed by the owner's command). */
export function pinnedDigest(data: string, recipe: Recipe, release: RecipeArchive, platform: string): { sha256: string; by: "recipe" | "first-seen" } | undefined {
  if (release.binarySha256) return { sha256: release.binarySha256, by: "recipe" };
  const recorded = firstSeenRecord(firstSeenOf(data, recipe, platform)).read();
  return recorded ? { sha256: recorded, by: "first-seen" } : undefined;
}

/** Installs the recipe's release into `<data>/harnesses/<id>` (the owner's command, rule 4): its archive downloaded and
 *  checked against the recipe's sha256, unpacked, and its binary checked against the recipe's pin, or recorded as the
 *  first one seen where the recipe pins none (a later one that differs is refused). */
export async function installRecipe(recipe: Recipe, file: string, data: string, options: ArchiveInstallOptions = {}, env: NodeJS.ProcessEnv = process.env) {
  const platform = options.platform ?? archivePlatform();
  const release = releaseFor(recipe, platform);
  const record = platform ? firstSeenRecord(firstSeenOf(data, recipe, platform)) : undefined;
  const binary = release && !release.binarySha256 && record ? { binaryRecord: record } : {};
  const before = release && !release.binarySha256 ? record?.read() : undefined;
  const done = await installArchive({ id: recipe.id, label: recipe.label, retry: recipeInstallLine(file, data, env), pin: { version: recipe.release.version, archives: recipe.release.archives } }, installDirOf(data, recipe.id), { ...options, ...binary });
  // What the binary was held to: the recipe's pin, the first digest an earlier install recorded, or this one's, recorded now.
  const pinnedBy: "recipe" | "first-seen" | "recorded" = release?.binarySha256 ? "recipe" : before ? "first-seen" : "recorded";
  return { version: recipe.release.version, pinnedBy, ...done };
}

/** The owner's command that checks the recipe at `file`, installed into `data`. */
export const recipeCheckLine = (file: string, data: string, env: NodeJS.ProcessEnv = process.env): string =>
  `agentrun harness-check --recipe ${shellWord(file)}${resolve(data) === commandData(env) ? "" : ` --data ${shellWord(data)}`}`;
