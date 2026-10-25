// The agents this server holds: one agent store of @parcha/pi-durable-agent in the data directory (`store.sqlite`), many
// agents in it, each with revisions written once. A definition is one revision; an edit commits the next, its parent
// the current one, and makes it current.
import { createHash } from "node:crypto";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { type Agent, AgentHomeError, type AgentStore, type NewRevision, openStore, type Revision, type RevisionRow, type RunRow, STORE_FILE } from "@parcha/pi-durable-agent";
import { ApiError, invalid } from "./errors.js";
import { type DefinitionBody, isObject, type Json, skillIssues, skillNames, stable } from "./validate.js";

/** One agent as the routes show it: its row, its current revision and that revision's number (the oldest is 1). */
export type AgentEntry = { agent: Agent; revision: Revision | null; version: number; revisions: number; runs: { count: number; live: number }; sizes: Map<string, number> };

/** SQLITE_BUSY or SQLITE_LOCKED: another connection holds the database. */
export const sqliteBusy = (error: unknown) => isObject(error) && error.code === "ERR_SQLITE_ERROR" && typeof error.errcode === "number" && [5, 6].includes(error.errcode & 0xff);

/** A store error as the request's answer: a busy store is retryable, a refusal names the field it refused. */
export function storeError(error: unknown, field = "definition"): never {
  if (sqliteBusy(error) || (error instanceof AgentHomeError && error.code === "busy")) throw new ApiError("home_busy", "the agent store is busy with another write; try again", { retry_after_ms: 500 });
  if (error instanceof AgentHomeError && error.code === "invalid") throw invalid([{ field, reason: "invalid", message: error.message }]);
  if (error instanceof AgentHomeError && error.code === "missing") throw new ApiError("not_found", error.message);
  if (error instanceof AgentHomeError && error.code === "stale") throw new ApiError("precondition_failed", "the agent's current revision moved since the If-Match it was read at: read the agent again");
  throw error;
}

export class Agents {
  readonly store: AgentStore;
  /** Read-only, for the store's skill texts, which its reads do not return. */
  private readonly skills: DatabaseSync;
  constructor(readonly dir: string) {
    this.store = openStore(dir);
    this.skills = new DatabaseSync(join(dir, STORE_FILE), { readOnly: true, timeout: 5_000 });
  }

  private closed = false;
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.skills.close();
    this.store.close();
  }

  /** Skill texts by their SHA-256. */
  private texts(shas: Iterable<string>): Map<string, string> {
    const out = new Map<string, string>();
    const read = this.skills.prepare("SELECT content FROM skills WHERE sha256 = ?");
    for (const sha of shas) {
      const row = read.get(sha) as { content?: unknown } | undefined;
      if (typeof row?.content === "string") out.set(sha, row.content);
    }
    return out;
  }

  /** The revision a checked definition makes; `files` are its skill files by path. */
  private revisionOf(definition: Json, files: Record<string, string>, note: string | undefined): NewRevision {
    const issues = skillIssues(definition.skills, Object.keys(files));
    if (issues.length) throw invalid(issues);
    const common = { skills: files, tools: (definition.tools as string[] | undefined) ?? [], ...(note !== undefined ? { note } : {}) };
    if (isObject(definition.workflow)) return { kind: "workflow", workflow: definition.workflow as never, ...common };
    return { kind: "agentic", instructions: definition.instructions as string, ...(typeof definition.model === "string" ? { model: definition.model } : {}), ...(typeof definition.thinking === "string" ? { thinking: definition.thinking } : {}), ...common };
  }

  /** `definition.version`, when given, is the number of the revision the request leaves current. */
  private checkVersion(definition: Json, version: number): void {
    if (definition.version !== undefined && definition.version !== version) throw invalid([{ field: "definition.version", reason: "not_an_option", message: `definition.version is ${version} here: the number of the revision this definition leaves current` }]);
  }

  /** A workflow revision is checked before anything is written, so a refusal makes no agent. */
  private async checked(revision: NewRevision): Promise<void> {
    if (revision.kind !== "workflow") return;
    const { checkWorkflowBody } = await import("@parcha/pi-durable-agent/workflow");
    await checkWorkflowBody({ workflow: revision.workflow, tools: revision.tools ?? [] }).catch((error) => storeError(error, "definition.workflow"));
  }

  /** A new agent and its first revision, current. A definition id already here is `409 agent_exists`. */
  async create({ definition, skills = {}, note }: DefinitionBody): Promise<AgentEntry> {
    const given = typeof definition.id === "string" ? definition.id : undefined;
    if (given !== undefined && this.store.readAgent(given)) throw new ApiError("agent_exists", `an agent ${given} exists here`);
    const revision = this.revisionOf(definition, skills, note);
    this.checkVersion(definition, 1);
    await this.checked(revision);
    let agent: Agent;
    try {
      agent = this.store.createAgent({ name: definition.name as string, ...(typeof definition.description === "string" ? { description: definition.description } : {}), ...(given !== undefined ? { id: given } : {}) });
    } catch (error) {
      if (error instanceof AgentHomeError && error.code === "exists") throw new ApiError("agent_exists", `an agent ${given} exists here`);
      storeError(error);
    }
    await this.store.commitRevision(agent.id, revision, { setCurrent: true }).catch((error) => storeError(error));
    return this.get(agent.id)!;
  }

  /** An edit: a new revision of the agent, its parent the current one, made current. Without `skills` the current
   *  revision's skill files carry over. An edit that is the current revision writes nothing, so a PUT sent twice makes
   *  one revision. The store keeps an agent's id, name and description from its creation. `ifCurrent` (from If-Match)
   *  is the current revision the caller read, null for none: the store compares it in the commit's own transaction. */
  async commit(read: AgentEntry, { definition, skills, note }: DefinitionBody, { ifCurrent }: { ifCurrent?: string | null } = {}): Promise<AgentEntry> {
    const entry = this.get(read.agent.id) ?? read;
    if (ifCurrent !== undefined && (entry.revision?.id ?? null) !== ifCurrent) storeError(new AgentHomeError("stale", "the agent's current revision is not the one the commit expects"));
    const { agent } = entry;
    const kept = [
      ...(definition.id !== undefined && definition.id !== agent.id ? [{ field: "definition.id", reason: "not_an_option", message: `definition.id is ${agent.id}, the agent's id` }] : []),
      ...(["name", "description"] as const)
        .filter((key) => definition[key] !== undefined && definition[key] !== agent[key])
        .map((key) => ({ field: `definition.${key}`, reason: "not_allowed", message: `The agent store keeps an agent's ${key} from its creation; an edit does not change it.`, fix: `Remove definition.${key}.` })),
    ];
    if (kept.length) throw invalid(kept);
    let files = skills;
    if (files === undefined) {
      const held = Object.entries(entry.revision?.body.skills ?? {});
      const texts = this.texts(held.map(([, sha]) => sha));
      files = Object.fromEntries(held.map(([path, sha]) => [path, texts.get(sha) ?? ""]));
    }
    const revision = this.revisionOf(definition, files, note);
    if (entry.revision && sameRevision(entry.revision, revision)) {
      this.checkVersion(definition, entry.version);
      return entry;
    }
    this.checkVersion(definition, entry.revisions + 1);
    await this.checked(revision);
    await this.store.commitRevision(agent.id, revision, { setCurrent: true, ...(ifCurrent !== undefined ? { ifCurrent } : {}) }).catch((error) => storeError(error));
    return this.get(agent.id)!;
  }

  /** Makes `revision`, one of the agent's own, its current one. */
  setCurrent(entry: AgentEntry, revision: string): AgentEntry {
    try {
      this.store.setCurrent(entry.agent.id, revision);
    } catch (error) {
      storeError(error, "revision");
    }
    return this.get(entry.agent.id)!;
  }

  /** The agent's revisions, newest first, each with its number. */
  revisions(id: string): Array<RevisionRow & { version: number }> {
    const rows = this.store.listRevisions(id);
    return rows.map((row, index) => ({ ...row, version: rows.length - index }));
  }

  /** Revision `id` and its number, or null when it is not one of `agent`'s. */
  revision(agent: string, id: string): { revision: Revision; version: number } | null {
    const row = this.revisions(agent).find((r) => r.id === id);
    return row ? { revision: this.store.readRevision(id), version: row.version } : null;
  }

  /** The agent `id`, or null. `runs` saves a read when the caller holds every run already. */
  get(id: string, runs?: readonly RunRow[]): AgentEntry | null {
    const found = this.store.readAgent(id);
    if (!found) return null;
    const at = found.revisions.findIndex((revision) => revision.current);
    const revision = at < 0 ? null : (({ current: _, ...rest }) => rest as Revision)(found.revisions[at]!);
    const own = (runs ?? this.store.listRuns({ agent: id })).filter((run) => run.agent === id);
    const sizes = new Map<string, number>();
    if (revision) for (const [sha, text] of this.texts(Object.values(revision.body.skills))) sizes.set(sha, Buffer.byteLength(text, "utf8"));
    const live = own.filter((run) => run.state === "running").length;
    return { agent: found.agent, revision, version: at < 0 ? 0 : found.revisions.length - at, revisions: found.revisions.length, runs: { count: own.length, live }, sizes };
  }

  /** Every agent here, newest first. */
  list(): AgentEntry[] {
    const runs = this.store.listRuns();
    return this.store
      .listAgents()
      .map((row) => this.get(row.id, runs)!)
      .sort((a, b) => b.agent.createdAt.localeCompare(a.agent.createdAt) || a.agent.id.localeCompare(b.agent.id));
  }
}

/** Whether `next` would be `current` again: the same kind and body, skills by their SHA-256. */
function sameRevision(current: Revision, next: NewRevision): boolean {
  const { kind, note: _, skills = {}, ...rest } = next;
  const body = { ...rest, skills: Object.fromEntries(Object.entries(skills).map(([path, text]) => [path, createHash("sha256").update(text).digest("hex")])), tools: next.tools ?? [] };
  return current.kind === kind && stable(current.body) === stable(body);
}

/** The agent's ETag: its current revision, which only an edit or `POST .../current` moves. */
export const etagOf = (entry: AgentEntry) => `"${entry.revision?.id ?? "none"}"`;

/** A revision as a definition, as `POST /agents` takes one, numbered. */
export function definitionOf(agent: Agent, revision: Revision, version: number): Json {
  const body = revision.kind === "agentic"
    ? { instructions: revision.body.instructions, ...(revision.body.model ? { model: revision.body.model } : {}), ...(revision.body.thinking ? { thinking: revision.body.thinking } : {}) }
    : { workflow: revision.body.workflow };
  return { id: agent.id, version, name: agent.name, ...(agent.description !== undefined ? { description: agent.description } : {}), ...body, skills: skillNames(Object.keys(revision.body.skills)), tools: revision.body.tools };
}

/** `Agent` as the contract shows it, with its current revision. */
export function agentView(entry: AgentEntry) {
  const { agent, revision } = entry;
  return {
    agent_id: agent.id,
    definition: revision ? definitionOf(agent, revision, entry.version) : null,
    kind: revision?.kind ?? null,
    revision: revision?.id ?? null,
    revisions: entry.revisions,
    source: null,
    skills: Object.entries(revision?.body.skills ?? {}).map(([path, sha]) => ({ path, sha256: sha, size_bytes: entry.sizes.get(sha) ?? null })),
    sign_ins: [],
    runs: entry.runs,
    region: "local",
    home_etag: etagOf(entry),
    archived_at: agent.archivedAt ?? null,
    created_at: agent.createdAt,
    updated_at: revision && revision.createdAt > agent.createdAt ? revision.createdAt : agent.createdAt,
  };
}

/** One revision as `GET .../revisions` lists it. */
export function revisionView(agent: Agent, row: RevisionRow & { version: number }, revision: Revision) {
  return { revision: row.id, version: row.version, parent: row.parent, kind: row.kind, current: row.current, note: row.note ?? null, created_at: row.createdAt, definition: definitionOf(agent, revision, row.version) };
}
