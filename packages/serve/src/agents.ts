// The agents this server holds: one agent store of @parcha/pi-durable-agent in the data directory (`store.sqlite`), many
// agents in it, each with revisions written once. A definition is one revision; an edit commits the next, its parent
// the current one, and makes it current.
import { createHash } from "node:crypto";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { type Agent, AgentHomeError, type AgentStore, type NewRevision, openStore, type Revision, type RevisionRow, type RunRow, STORE_FILE } from "@parcha/pi-durable-agent";
import { ApiError, invalid } from "./errors.js";
import { DEFAULT_HARNESS, harnessOfBody } from "./harness.js";
import { type DefinitionBody, isObject, type Json, skillIssues, skillNames, stable } from "./validate.js";

/** One agent as the routes show it: its row, its current revision and that revision's number (the oldest is 1). */
export type AgentEntry = { agent: Agent; revision: Revision | null; version: number; revisions: number; runs: { count: number; live: number }; sizes: Map<string, number> };

/** SQLITE_BUSY or SQLITE_LOCKED: another connection holds the database. */
export const sqliteBusy = (error: unknown) => isObject(error) && error.code === "ERR_SQLITE_ERROR" && typeof error.errcode === "number" && [5, 6].includes(error.errcode & 0xff);

/** How long a request waits for a busy agent store, step by step: short first, so a reader's overlap costs
 *  milliseconds; about 2 s in all, then the request answers home_busy. */
export const REQUEST_BUSY_MS: readonly number[] = [10, 20, 50, 100, 200, 400, 600, 600];

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** `act` again while another connection holds the store: after busy `attempt`, `onBusy` hears of it and the next of
 *  `delaysMs` is waited out without blocking the event loop. Past the last, the busy error is thrown. */
export async function whenFree<T>(act: () => T | Promise<T>, delaysMs: readonly number[], onBusy?: (attempt: number, delayMs: number | undefined) => void): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await act();
    } catch (error) {
      if (!sqliteBusy(error)) throw error;
      const delay = delaysMs[attempt];
      onBusy?.(attempt, delay);
      if (delay === undefined) throw error;
      await sleep(delay);
    }
  }
}

/** A store another writer holds: SQLite's busy or locked, or the agent home's own `busy` (a home held past its deadline, or a
 *  store a stopped writer left mid-write). Every answer of the server maps it the same way: home_busy. */
export const storeBusy = (error: unknown) => sqliteBusy(error) || (error instanceof AgentHomeError && error.code === "busy");

/** The answer to a request the agent store stayed busy for. */
export const homeBusy = () => new ApiError("home_busy", "the agent store is busy with another write; try again", { retry_after_ms: 500 });

/** A store error as the request's answer: a busy store is retryable, a refusal names the field it refused. */
export function storeError(error: unknown, field = "definition"): never {
  if (storeBusy(error)) throw homeBusy();
  if (error instanceof AgentHomeError && error.code === "invalid") throw invalid([{ field, reason: "invalid", message: error.message }]);
  if (error instanceof AgentHomeError && error.code === "missing") throw new ApiError("not_found", error.message);
  if (error instanceof AgentHomeError && error.code === "stale") throw new ApiError("precondition_failed", "the agent's current revision moved since the If-Match it was read at: read the agent again");
  throw error;
}

export class Agents {
  /** Never waits for another connection synchronously: what touches it goes through `request` or `whenFree`. */
  readonly store: AgentStore;
  /** Read-only, for the store's skill texts, which its reads do not return. */
  private readonly skills: DatabaseSync;
  constructor(readonly dir: string) {
    this.store = openStore(dir, { busyTimeoutMs: 0 });
    this.skills = new DatabaseSync(join(dir, STORE_FILE), { readOnly: true, timeout: 0 });
  }

  /** A read or write of the store for a request: a busy store is waited for about 2 s (REQUEST_BUSY_MS). */
  request<T>(act: () => T | Promise<T>): Promise<T> {
    return whenFree(act, REQUEST_BUSY_MS);
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
    // The default harness is never stored: naming pi and naming none are one revision.
    const harness = typeof definition.harness === "string" && definition.harness !== DEFAULT_HARNESS ? { harness: definition.harness } : {};
    const common = { skills: files, tools: (definition.tools as string[] | undefined) ?? [], ...harness, ...(note !== undefined ? { note } : {}) };
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

  /** A new agent and its first revision, current. A definition id already here is `409 agent_exists`. `check` sees the
   *  revision before anything is written, and may refuse it. */
  async create({ definition, skills = {}, note }: DefinitionBody, check?: (revision: NewRevision) => Promise<void>): Promise<AgentEntry> {
    const given = typeof definition.id === "string" ? definition.id : undefined;
    if (given !== undefined && (await this.request(() => this.store.readAgent(given)))) throw new ApiError("agent_exists", `an agent ${given} exists here`);
    const revision = this.revisionOf(definition, skills, note);
    this.checkVersion(definition, 1);
    await this.checked(revision);
    await check?.(revision);
    let agent: Agent;
    try {
      agent = await this.request(() => this.store.createAgent({ name: definition.name as string, ...(typeof definition.description === "string" ? { description: definition.description } : {}), ...(given !== undefined ? { id: given } : {}) }));
    } catch (error) {
      if (error instanceof AgentHomeError && error.code === "exists") throw new ApiError("agent_exists", `an agent ${given} exists here`);
      storeError(error);
    }
    await this.request(() => this.store.commitRevision(agent.id, revision, { setCurrent: true })).catch((error) => storeError(error));
    return (await this.get(agent.id))!;
  }

  /** An edit: a new revision of the agent, its parent the current one, made current. Without `skills` the current
   *  revision's skill files carry over. An edit that is the current revision writes nothing, so a PUT sent twice makes
   *  one revision. The store keeps an agent's id, name and description from its creation. `ifCurrent` (from If-Match)
   *  is the current revision the caller read, null for none: the store compares it in the commit's own transaction.
   *  `check` sees the revision, the current one's included, before anything is written, and may refuse it. */
  async commit(read: AgentEntry, { definition, skills, note }: DefinitionBody, { ifCurrent, check }: { ifCurrent?: string | null; check?: (revision: NewRevision) => Promise<void> } = {}): Promise<AgentEntry> {
    const held = (now: AgentEntry) => {
      if (ifCurrent !== undefined && (now.revision?.id ?? null) !== ifCurrent) storeError(new AgentHomeError("stale", "the agent's current revision is not the one the commit expects"));
      return now;
    };
    const entry = held((await this.get(read.agent.id)) ?? read);
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
      const texts = await this.request(() => this.texts(held.map(([, sha]) => sha)));
      files = Object.fromEntries(held.map(([path, sha]) => [path, texts.get(sha) ?? ""]));
    }
    // An edit that names no harness keeps the agent's, as it keeps its skill files: absent here is unchanged, not pi.
    const current = entry.revision?.body.harness;
    const revision = this.revisionOf(definition.harness === undefined && current ? { ...definition, harness: current } : definition, files, note);
    await this.checked(revision);
    await check?.(revision);
    // Each try reads the current revision, checks against it and commits on it in one go: a try a busy store sent back
    // checks again, and the store refuses the commit if another writer moved the current revision after this read.
    const attempt = async (): Promise<AgentEntry | undefined> => {
      const now = held(this.entry(agent.id) ?? entry);
      if (now.revision && sameRevision(now.revision, revision)) {
        this.checkVersion(definition, now.version);
        return now;
      }
      this.checkVersion(definition, now.revisions + 1);
      await this.store.commitRevision(agent.id, revision, { setCurrent: true, ifCurrent: now.revision?.id ?? null });
      return undefined;
    };
    for (let tries = 1; ; tries++) {
      try {
        return (await this.request(attempt)) ?? (await this.get(agent.id))!;
      } catch (error) {
        // Without If-Match an edit goes on the revision current when it commits: one moved under it is read again.
        if (ifCurrent === undefined && tries < 5 && error instanceof AgentHomeError && error.code === "stale") continue;
        storeError(error);
      }
    }
  }

  /** Makes `revision`, one of the agent's own, its current one. */
  async setCurrent(entry: AgentEntry, revision: string): Promise<AgentEntry> {
    await this.request(() => this.store.setCurrent(entry.agent.id, revision)).catch((error) => storeError(error, "revision"));
    return (await this.get(entry.agent.id))!;
  }

  /** Archives or unarchives an agent or a run. */
  async setArchived(kind: "agent" | "run", id: string, archived: boolean): Promise<void> {
    await this.request(() => this.store.setArchived(kind, id, archived)).catch((error) => storeError(error));
  }

  /** The agent's revisions, newest first, each with its number. */
  revisions(id: string): Promise<Array<RevisionRow & { version: number }>> {
    return this.request(() => {
      const rows = this.store.listRevisions(id);
      return rows.map((row, index) => ({ ...row, version: rows.length - index }));
    });
  }

  /** Revision `id` and its number, or null when it is not one of `agent`'s. */
  async revision(agent: string, id: string): Promise<{ revision: Revision; version: number } | null> {
    const row = (await this.revisions(agent)).find((r) => r.id === id);
    return row ? { revision: await this.request(() => this.store.readRevision(id)), version: row.version } : null;
  }

  /** The agent `id`, or null. `runs` saves a read when the caller holds every run already. */
  get(id: string): Promise<AgentEntry | null> {
    return this.request(() => this.entry(id));
  }

  private entry(id: string, runs?: readonly RunRow[]): AgentEntry | null {
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
  list(): Promise<AgentEntry[]> {
    return this.request(() => {
      const runs = this.store.listRuns();
      return this.store
        .listAgents()
        .map((row) => this.entry(row.id, runs)!)
        .sort((a, b) => b.agent.createdAt.localeCompare(a.agent.createdAt) || a.agent.id.localeCompare(b.agent.id));
    });
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
  return { id: agent.id, version, name: agent.name, ...(agent.description !== undefined ? { description: agent.description } : {}), ...body, harness: harnessOfBody(revision.body), skills: skillNames(Object.keys(revision.body.skills)), tools: revision.body.tools };
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
