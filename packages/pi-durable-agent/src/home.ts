import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createHash, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  type AgentAlias, type AgentDefinition, type AgentIdentity, type AgentSource, AliasesDoc, BindingsDoc, type BrowserProfile,
  DefinitionDoc, FORMAT_VERSION, IdentityDoc, LeasesDoc, type ProfileLease, ProfilesDoc, put, type RunRecord, RunsDoc,
  type SkillFile, SkillsDoc, SourceDoc, type ToolBindings,
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
  const ifRevision = options.ifRevision;
  if (ifRevision !== undefined && !(Number.isSafeInteger(ifRevision) && ifRevision >= 0)) throw invalid(`ifRevision ${JSON.stringify(ifRevision)} is not a home revision (a non-negative integer)`);
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

/** Open the agent home in `dir`. */
export async function openAgentHome(dir: string): Promise<AgentHome> {
  const resolved = homeDir(dir);
  const { identity } = await inHome(resolved, readState);
  return { dir: resolved, identity };
}

/** Everything the agent home holds now. */
export async function readAgentHome(home: AgentHome): Promise<AgentHomeState> {
  return inHome(homeDir(home.dir), readState);
}

/** The agent store's head commit number: every write that changes the home moves it, so with the identity's id it is
 *  the home's version (an ETag). One read-only query, under no lock (`HEAD_SQL`). */
export async function homeRevision(home: AgentHome): Promise<number> {
  const file = path.join(homeDir(home.dir), AGENT_STORE_FILE);
  const db = new DatabaseSync(file, { readOnly: true, timeout: 5_000 });
  try {
    return await readHead(() => db.prepare(HEAD_SQL).get());
  } finally {
    db.close();
  }
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
