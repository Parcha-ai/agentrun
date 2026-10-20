import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createHash, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  type AgentAlias, type AgentDefinition, type AgentIdentity, type AgentSource, AliasesDoc, BindingsDoc, type BrowserProfile, canonical,
  DefinitionDoc, FORMAT_VERSION, IdentityDoc, LeasesDoc, type ProfileLease, ProfilesDoc, type PromptRule, PromptsDoc, type PromptVariant, put,
  type RunRecord, RunsDoc, type SkillFile, SkillsDoc, SourceDoc, type ToolBindings,
} from "./kinds.js";
import { AgentHomeError, HEAD_SQL, openStore, readFamily, readHead, type Store, withHome } from "./store.js";

export const AGENT_STORE_FILE = "agent.sqlite";

/** An agent home: a directory with `agent.sqlite` and `runs/`. Each call opens the store as the home's only writer
 *  and closes it before returning, so a handle holds nothing open. */
export type AgentHome = { readonly dir: string; readonly identity: AgentIdentity };

/** A definition as given: `id` is optional and becomes the agent's id when present. */
export type AgentDefinitionInput = Omit<AgentDefinition, "id"> & { id?: string };

/** Everything an agent home holds, read in one pass. */
export type AgentHomeState = {
  identity: AgentIdentity;
  definition: AgentDefinition;
  /** The repo commit the definition and skills were read from; absent for a home not tied to a repo. */
  source?: AgentSource;
  skills: Record<string, SkillFile>;
  /** The prompt variants, keyed by id. */
  prompts: Record<string, PromptVariant>;
  aliases: Record<string, AgentAlias>;
  bindings: Record<string, ToolBindings>;
  runs: Record<string, RunRecord>;
  leases: Record<string, ProfileLease>;
  profiles: Record<string, BrowserProfile>;
};

/** A UUIDv7: 48 bits of Unix milliseconds, then random bits, so ids sort by creation time. */
export function uuidv7(now = Date.now()): string {
  const bytes = randomBytes(16);
  bytes.writeUIntBE(now, 0, 6);
  bytes[6] = (bytes[6]! & 0x0f) | 0x70;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export const sha256 = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

const invalid = (message: string) => new AgentHomeError("invalid", message);

/** An agent id or a run id: one URL path segment. A minted UUIDv7 is one. */
export const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const isNames = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((name) => typeof name === "string" && name !== "") && new Set(value).size === value.length;

const REQUIRED = ["version", "name", "instructions", "skills", "tools"] as const;
const FIELDS = new Set<string>(["id", ...REQUIRED, "description", "input_schema", "output_schema", "workflow", "max_cost_usd"]);

/** The definition with exactly the stored fields, or a refusal naming the first field that is wrong. */
export function checkDefinition(input: AgentDefinitionInput, id: string): AgentDefinition {
  if (!isObject(input)) throw invalid("the definition is not an object");
  const extra = Object.keys(input).filter((key) => !FIELDS.has(key));
  if (extra.length) throw invalid(`the definition has fields it does not keep: ${extra.join(", ")} (the host picks the model and thinking level; tools are names)`);
  for (const key of REQUIRED) if (input[key] === undefined) throw invalid(`the definition has no ${key}`);
  if (!Number.isSafeInteger(input.version) || input.version < 1) throw invalid("the definition's version is not a positive integer");
  if (typeof input.name !== "string" || input.name === "") throw invalid("the definition's name is not a non-empty string");
  if (typeof input.instructions !== "string") throw invalid("the definition's instructions are not a string");
  if (!isNames(input.skills)) throw invalid("the definition's skills are not distinct, non-empty names");
  if (!isNames(input.tools)) throw invalid("the definition's tools are not distinct, non-empty names");
  if (input.description !== undefined && typeof input.description !== "string") throw invalid("the definition's description is not a string");
  for (const key of ["input_schema", "output_schema", "workflow"] as const) if (input[key] !== undefined && !isObject(input[key])) throw invalid(`the definition's ${key} is not an object`);
  if (input.max_cost_usd !== undefined && !(typeof input.max_cost_usd === "number" && Number.isFinite(input.max_cost_usd) && input.max_cost_usd >= 0)) throw invalid("the definition's max_cost_usd is not a non-negative number");
  return JSON.parse(JSON.stringify({ ...input, id })) as AgentDefinition;
}

/** A skill path is relative, with `/` between non-empty segments, and never leaves `.agents/skills/`. */
export const isSkillPath = (value: string): boolean =>
  typeof value === "string" && value !== "" && !value.includes("\\") && !value.includes("\0") && value.split("/").every((part) => part !== "" && part !== "." && part !== "..");

/** The skill files as `[path, content]`, or a refusal naming the first path or content that is wrong. */
function checkSkills(skills: Record<string, string> | undefined): [string, string][] {
  if (skills !== undefined && !isObject(skills)) throw invalid("the skills are not paths to text");
  const entries = Object.entries(skills ?? {});
  for (const [file, content] of entries) {
    if (!isSkillPath(file)) throw invalid(`the skill path ${JSON.stringify(file)} is not a relative path inside .agents/skills/`);
    if (typeof content !== "string") throw invalid(`the skill ${file} is not text`);
  }
  return entries;
}

const SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
/** A git commit sha: 40 (SHA-1) or 64 (SHA-256) lowercase hex digits. */
export function checkSha(sha: unknown): string {
  if (typeof sha !== "string" || !SHA.test(sha)) throw invalid(`${JSON.stringify(sha)} is not a commit sha (40 or 64 lowercase hex digits)`);
  return sha;
}

export async function readState(store: Store): Promise<AgentHomeState> {
  const identity = await store.session.snapshot(IdentityDoc, BACKGROUND_CONTEXT);
  const definition = await store.session.snapshot(DefinitionDoc, BACKGROUND_CONTEXT);
  if (!identity?.id || !definition) throw new AgentHomeError("format", "the agent store has no identity or definition");
  if (identity.formatVersion !== FORMAT_VERSION) throw new AgentHomeError("format", `the agent home is format ${String(identity.formatVersion)}; this version reads ${FORMAT_VERSION}`);
  const source = await store.session.snapshot(SourceDoc, BACKGROUND_CONTEXT);
  return {
    identity: structuredClone(identity) as AgentIdentity,
    definition: structuredClone(definition) as AgentDefinition,
    ...(source ? { source: structuredClone(source) as AgentSource } : {}),
    skills: await readFamily(store, SkillsDoc),
    prompts: await readFamily(store, PromptsDoc),
    aliases: await readFamily(store, AliasesDoc),
    bindings: await readFamily(store, BindingsDoc),
    runs: await readFamily(store, RunsDoc),
    leases: await readFamily(store, LeasesDoc),
    profiles: await readFamily(store, ProfilesDoc),
  };
}

/** Open the agent store as the home's only writer, run `work` on it, and close it. */
export async function inHome<T>(dir: string, work: (store: Store) => Promise<T>): Promise<T> {
  return withHome(dir, async () => {
    const store = await openStore(path.join(dir, AGENT_STORE_FILE));
    try { return await work(store); } finally { await store.close(); }
  });
}

export const RUN_STORE_FILE = "run.sqlite";
/** A run directory's store, in pi-durable-disk's run layout. */
export const runStoreIn = (runDir: string): string => path.join(runDir, "store", RUN_STORE_FILE);

/**
 * How a host reaches an agent home's own files. `claim(fn)` runs `fn` with the directory that holds `agent.sqlite`
 * while the host holds it alone (a local directory; on a disk, a claim of the home's `agent/`); the package takes
 * `owner.lock` there too, inside the claim. `runStore(run)` gives a local, closed copy of a released run's
 * `run.sqlite`, or the file itself; the package only reads it, from a copy of its own.
 */
export type HomeAccess = {
  claim<T>(fn: (agentDir: string) => Promise<T>): Promise<T>;
  runStore(run: { runId: string; path: string }): Promise<string>;
};

/** The home as a directory of this machine, `home.dir`, with its runs under it: what every call does by default. */
export function localAccess(home: AgentHome): HomeAccess {
  return {
    claim: (fn) => fn(homeDir(home.dir)),
    runStore: async (run) => runStoreIn(path.join(homeDir(home.dir), run.path)),
  };
}

/** `work` on the home's agent store as its only writer: inside `access`'s claim, under `owner.lock` in the claimed
 *  directory. */
export async function inClaimedHome<T>(home: AgentHome, access: HomeAccess | undefined, work: (store: Store) => Promise<T>): Promise<T> {
  return (access ?? localAccess(home)).claim(async (agentDir) => {
    if (!existsSync(path.join(agentDir, AGENT_STORE_FILE))) throw new AgentHomeError("missing", `the claimed directory holds no ${AGENT_STORE_FILE}`);
    return inHome(agentDir, work);
  });
}

export function homeDir(dir: string): string {
  const resolved = path.resolve(dir);
  if (!existsSync(path.join(resolved, AGENT_STORE_FILE))) throw new AgentHomeError("missing", `${dir} is not an agent home (no ${AGENT_STORE_FILE})`);
  return resolved;
}

/** Create an agent home in `dir`: its identity (the definition's `id`, or a new UUIDv7), its definition and its skill
 *  files (path to content), and, with `sha`, the repo commit they were read from, in one commit. A directory that
 *  already holds an agent home is refused. */
export async function createAgentHome(dir: string, options: { definition: AgentDefinitionInput; skills?: Record<string, string>; sha?: string; now?: number }): Promise<AgentHome> {
  const given = options?.definition?.id;
  if (given !== undefined && (typeof given !== "string" || !ID_PATTERN.test(given))) {
    throw invalid(`the definition's id ${JSON.stringify(given)} does not match ${ID_PATTERN.source}: letters, digits, ".", "_" or "-", at most 128, so it fits a URL`);
  }
  const id = given ?? uuidv7();
  const definition = checkDefinition(options.definition, id);
  const skills = checkSkills(options.skills);
  const source: AgentSource | undefined = options.sha === undefined ? undefined : { sha: checkSha(options.sha), refreshedAt: new Date(options.now ?? Date.now()).toISOString() };
  const resolved = path.resolve(dir);
  await mkdir(path.join(resolved, "runs"), { recursive: true });
  const identity: AgentIdentity = { id, name: definition.name, formatVersion: FORMAT_VERSION };
  await inHome(resolved, async (store) => {
    if ((await store.session.snapshot(IdentityDoc, BACKGROUND_CONTEXT))?.id) throw new AgentHomeError("exists", `${dir} already holds an agent home`);
    await store.session.commit(async (tx) => {
      put(await tx.doc(IdentityDoc), identity);
      put(await tx.doc(DefinitionDoc), definition);
      for (const [file, content] of skills) put(await tx.doc(SkillsDoc, file, null), { content, sha256: sha256(content) });
      if (source) put(await tx.doc(SourceDoc), source);
    }, BACKGROUND_CONTEXT);
  });
  return { dir: resolved, identity };
}

/** Replace the cached definition and skills with the ones the host read from the agent's repo at `sha`, in one commit
 *  with `agent.source`: a skill path absent from `skills` is removed. The definition's `id`, when given, must be the
 *  home's; `identity.name` follows the definition's `name`. With `from`, a compare-and-swap: the home's sha must be
 *  `from` (`null`: the home has none yet), or the refresh is refused (`stale`) before anything is written, so a host
 *  that read an older commit cannot move the cache back over a newer one; ancestry is the host's to judge. With
 *  `ifRevision`, a compare-and-swap on `homeRevision`, checked first: a home whose head commit moved since the caller
 *  read it is refused (`stale`) the same way. A home already at `sha` is then left as it is (`changed` false): a sha
 *  names one content. Runs already started keep the skills their workspace got. */
export async function refreshAgentHome(home: AgentHome, options: { sha: string; from?: string | null; ifRevision?: number; definition: AgentDefinitionInput; skills: Record<string, string>; now?: number }): Promise<{ changed: boolean }> {
  const sha = checkSha(options?.sha);
  const from = options.from === undefined || options.from === null ? options.from : checkSha(options.from);
  const ifRevision = checkRevision(options.ifRevision);
  const given = options.definition?.id;
  if (given !== undefined && (typeof given !== "string" || given === "")) throw invalid("the definition's id is not a non-empty string");
  if (options.skills === undefined) throw invalid("a refresh names its skills: the set replaces the cached one");
  const skills = checkSkills(options.skills);
  return inHome(homeDir(home.dir), async (store) => {
    const state = await readState(store);
    if (given !== undefined && given !== state.identity.id) throw invalid(`the definition's id ${given} is not this agent's id ${state.identity.id}`);
    const definition = checkDefinition(options.definition, state.identity.id);
    if (ifRevision !== undefined) {
      const revision = await store.head();
      if (revision !== ifRevision) throw new AgentHomeError("stale", `the agent home is at revision ${revision}, not ${ifRevision} as the refresh expected; nothing was written`);
    }
    const current = state.source?.sha ?? null;
    if (from !== undefined && from !== current) {
      throw new AgentHomeError("stale", `the agent home's cache is at ${current ?? "no commit"}, not ${from ?? "no commit"} as the refresh expected; nothing was written`);
    }
    if (current === sha) return { changed: false };
    const kept = new Set(skills.map(([file]) => file));
    await store.session.commit(async (tx) => {
      put(await tx.doc(IdentityDoc), { ...state.identity, name: definition.name });
      put(await tx.doc(DefinitionDoc), definition);
      for (const file of Object.keys(state.skills)) if (!kept.has(file)) await tx.retireDoc(SkillsDoc, file);
      for (const [file, content] of skills) put(await tx.doc(SkillsDoc, file, null), { content, sha256: sha256(content) });
      put(await tx.doc(SourceDoc), { sha, refreshedAt: new Date(options.now ?? Date.now()).toISOString() });
    }, BACKGROUND_CONTEXT);
    return { changed: true };
  });
}

/** A compare-and-swap's expected `homeRevision`, when given. */
function checkRevision(ifRevision: unknown): number | undefined {
  if (ifRevision !== undefined && !(Number.isSafeInteger(ifRevision) && (ifRevision as number) >= 0)) throw invalid(`ifRevision ${JSON.stringify(ifRevision)} is not a home revision (a non-negative integer)`);
  return ifRevision as number | undefined;
}

/** A prompt variant as `setPrompts` takes it: with its `id`. */
export type PromptVariantInput = PromptVariant & { id: string };

const ROLES = new Set(["base", "overlay", "generic", "question"]);
const VARIANT_FIELDS = new Set(["id", "role", "label", "text", "when", "criteria"]);
/** The option every question has, for an input no overlay fits. */
export const OTHER_OPTION = "other";
const RULE_FIELDS = new Set(["question", "option", "threshold"]);
const MAX_VARIANTS = 64;
const MAX_LABEL = 200;
const MAX_QUESTION = 2_000;
const MAX_TEXT_BYTES = 64 * 1024;
const isText = (value: unknown, max: number): value is string => typeof value === "string" && value.trim() !== "" && value.length <= max;
const extraField = (value: Record<string, unknown>, fields: Set<string>) => Object.keys(value).find((key) => !fields.has(key));

function checkRule(id: string, when: unknown): PromptRule {
  if (!isObject(when)) throw invalid(`the prompt ${id}'s when is not an object`);
  const extra = extraField(when, RULE_FIELDS);
  if (extra !== undefined) throw invalid(`the prompt ${id}'s when has a field a rule does not keep: ${extra}`);
  const { question, option, threshold } = when;
  if (typeof question !== "string" || !ID_PATTERN.test(question)) throw invalid(`the prompt ${id}'s question ${JSON.stringify(question)} is not a prompt id`);
  if (!isText(option, MAX_LABEL)) throw invalid(`the prompt ${id}'s option is not a non-empty string of at most ${MAX_LABEL} characters`);
  if (option === OTHER_OPTION) throw invalid(`the prompt ${id}'s option is "${OTHER_OPTION}", which every question has for an input no overlay fits`);
  if (typeof threshold !== "number" || !(threshold >= 0 && threshold <= 1)) throw invalid(`the prompt ${id}'s threshold ${String(threshold)} is not a number from 0 to 1`);
  return { question, option, threshold };
}

function checkCriteria(id: string, criteria: unknown): Record<string, string> {
  if (!isObject(criteria)) throw invalid(`the prompt ${id}'s criteria are not option names to descriptions`);
  for (const [option, description] of Object.entries(criteria)) {
    if (!isText(description, MAX_QUESTION)) throw invalid(`the prompt ${id}'s criterion for ${option} is not a non-empty string of at most ${MAX_QUESTION} characters`);
  }
  return { ...(criteria as Record<string, string>) };
}

/** A prompt set as stored, in the given order, or a refusal naming the first thing that is wrong: one `base`, one
 *  `generic`, any number of `overlay`s, at most one `question`, each id one URL segment and given once, the stated
 *  sizes, and rules that name the question row and an option no other overlay needs. */
export function checkPrompts(variants: unknown): [string, PromptVariant][] {
  if (!Array.isArray(variants)) throw invalid("the prompts are not a list of variants");
  if (variants.length > MAX_VARIANTS) throw invalid(`the prompts are ${variants.length} variants; a set has at most ${MAX_VARIANTS}`);
  const checked: [string, PromptVariant][] = [];
  for (const [index, variant] of variants.entries()) {
    if (!isObject(variant)) throw invalid(`prompt ${index} is not an object`);
    const { id, role, label, text, when } = variant;
    if (typeof id !== "string" || !ID_PATTERN.test(id)) throw invalid(`prompt ${index}'s id ${JSON.stringify(id)} does not match ${ID_PATTERN.source}`);
    if (checked.some(([seen]) => seen === id)) throw invalid(`the prompt id ${id} is given twice`);
    const extra = extraField(variant, VARIANT_FIELDS);
    if (extra !== undefined) throw invalid(`the prompt ${id} has a field a variant does not keep: ${extra}`);
    if (typeof role !== "string" || !ROLES.has(role)) throw invalid(`the prompt ${id}'s role ${JSON.stringify(role)} is not base, overlay, generic or question`);
    if (!isText(label, MAX_LABEL)) throw invalid(`the prompt ${id}'s label is not a non-empty string of at most ${MAX_LABEL} characters`);
    if (typeof text !== "string" || text.trim() === "" || Buffer.byteLength(text, "utf8") > MAX_TEXT_BYTES) throw invalid(`the prompt ${id}'s text is not a non-empty string of at most ${MAX_TEXT_BYTES} bytes`);
    if (when !== undefined && role !== "overlay") throw invalid(`the prompt ${id} is the ${role}; only an overlay has a when`);
    if (variant.criteria !== undefined && role !== "question") throw invalid(`the prompt ${id} is the ${role}; only a question has criteria`);
    checked.push([id, {
      role: role as PromptVariant["role"], label, text,
      ...(when === undefined ? {} : { when: checkRule(id, when) }),
      ...(variant.criteria === undefined ? {} : { criteria: checkCriteria(id, variant.criteria) }),
    }]);
  }
  for (const role of ["base", "generic"]) {
    const count = checked.filter(([, variant]) => variant.role === role).length;
    if (count !== 1) throw invalid(`the prompts have ${count} ${role} variants; a set has exactly one`);
  }
  const questions = checked.filter(([, variant]) => variant.role === "question").map(([id]) => id);
  if (questions.length > 1) throw invalid(`the prompts have ${questions.length} questions (${questions.join(", ")}); a set has at most one`);
  const options = new Map<string, string>();
  for (const [id, { when }] of checked) {
    if (!when) continue;
    if (when.question !== questions[0]) throw invalid(`the prompt ${id}'s question ${when.question} is not the set's question row`);
    if (options.has(when.option)) throw invalid(`the option ${when.option} is needed by both ${options.get(when.option)} and ${id}`);
    options.set(when.option, id);
  }
  for (const [id, { criteria }] of checked) {
    const unknown = Object.keys(criteria ?? {}).find((option) => option !== OTHER_OPTION && !options.has(option));
    if (unknown !== undefined) throw invalid(`the question ${id} describes ${unknown}, which no overlay needs`);
  }
  return checked;
}

/** Replace the agent's prompt variants with `variants`, in one commit under the home's lock: an id absent from them is
 *  removed. A set the checks refuse (`invalid`) touches nothing. With `ifRevision`, a compare-and-swap on
 *  `homeRevision`: a home whose head commit moved since the caller read it is refused (`stale`) and nothing is written.
 *  A set equal to the stored one writes nothing (`changed` false). */
export async function setPrompts(home: AgentHome, variants: PromptVariantInput[], options: { ifRevision?: number; access?: HomeAccess } = {}): Promise<{ changed: boolean }> {
  const prompts = checkPrompts(variants);
  const ifRevision = checkRevision(options.ifRevision);
  return inClaimedHome(home, options.access, async (store) => {
    if (ifRevision !== undefined) {
      const revision = await store.head();
      if (revision !== ifRevision) throw new AgentHomeError("stale", `the agent home is at revision ${revision}, not ${ifRevision} as the prompts' writer expected; nothing was written`);
    }
    const stored = await readFamily<PromptVariant>(store, PromptsDoc);
    const next = Object.fromEntries(prompts);
    if (canonical(stored) === canonical(next)) return { changed: false };
    await store.session.commit(async (tx) => {
      for (const id of Object.keys(stored)) if (!Object.hasOwn(next, id)) await tx.retireDoc(PromptsDoc, id);
      for (const [id, variant] of prompts) put(await tx.doc(PromptsDoc, id, null), variant);
    }, BACKGROUND_CONTEXT);
    return { changed: true };
  });
}

/** Open the agent home in `dir`. */
export async function openAgentHome(dir: string): Promise<AgentHome> {
  const resolved = homeDir(dir);
  const { identity } = await inHome(resolved, readState);
  return { dir: resolved, identity };
}

/** Everything the agent home holds now. */
export async function readAgentHome(home: AgentHome, options: { access?: HomeAccess } = {}): Promise<AgentHomeState> {
  return inClaimedHome(home, options.access, readState);
}

/** The agent store's head commit number: every write that changes the home moves it, so with the identity's id it is
 *  the home's version (an ETag). One read-only query (`HEAD_SQL`): under no lock by default, inside the claim with
 *  `access`. */
export async function homeRevision(home: AgentHome, options: { access?: HomeAccess } = {}): Promise<number> {
  const read = async (agentDir: string) => {
    const db = new DatabaseSync(path.join(agentDir, AGENT_STORE_FILE), { readOnly: true, timeout: 5_000 });
    try {
      return await readHead(() => db.prepare(HEAD_SQL).get());
    } finally {
      db.close();
    }
  };
  return options.access ? options.access.claim(read) : read(homeDir(home.dir));
}

/** Record the agent's id in `host` (Parcha's expert id, for one). */
export async function setAlias(home: AgentHome, host: string, externalId: string): Promise<void> {
  if (typeof host !== "string" || host === "") throw invalid("the host is not a non-empty string");
  if (typeof externalId !== "string" || externalId === "") throw invalid("the external id is not a non-empty string");
  await inHome(homeDir(home.dir), (store) => store.session.commit(async (tx) => { put(await tx.doc(AliasesDoc, host, null), { externalId }); }, BACKGROUND_CONTEXT));
}

/** Record where each tool name runs in `host`; replaces that host's bindings. */
export async function setBindings(home: AgentHome, host: string, bindings: ToolBindings): Promise<void> {
  if (typeof host !== "string" || host === "") throw invalid("the host is not a non-empty string");
  if (!isObject(bindings) || !Object.values(bindings).every((target) => typeof target === "string" && target !== "")) throw invalid("the bindings are not tool names to non-empty targets");
  await inHome(homeDir(home.dir), (store) => store.session.commit(async (tx) => { put(await tx.doc(BindingsDoc, host, null), bindings); }, BACKGROUND_CONTEXT));
}
