// The agents this server holds: one agent home of @parcha/pi-durable-agent per agent, at `<data>/<agent_id>/`, with a
// host file `serve.json` ({created_at}) beside its `agent.sqlite`.
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { AGENT_STORE_FILE, AgentHomeError, createAgentHome, readAgentHome, type AgentHome, type AgentHomeState, type AgentDefinitionInput } from "@parcha/pi-durable-agent";
import { ApiError } from "./errors.js";
import { readJson, writeWhole } from "./files.js";
import { ID, type Json } from "./validate.js";

export const HOST_FILE = "serve.json";

export type AgentEntry = { home: AgentHome; state: AgentHomeState; revision: number; createdAt: string; updatedAt: string };

/** A UUIDv7: 48 bits of Unix milliseconds, then random bits, so ids sort by creation time. */
export function uuidv7(now = Date.now()): string {
  const bytes = randomBytes(16);
  bytes.writeUIntBE(now, 0, 6);
  bytes[6] = (bytes[6]! & 0x0f) | 0x70;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}


/** A home error as the request's answer: a busy writer lock is retryable. */
export function homeError(error: unknown): never {
  if (error instanceof AgentHomeError && error.code === "busy") throw new ApiError("home_busy", "the agent home is busy with another write; try again", { retry_after_ms: 500 });
  throw error;
}

export class Agents {
  private readonly cache = new Map<string, { sig: string; entry: AgentEntry }>();
  constructor(readonly dir: string) {}

  /** Create the home from a checked definition and skill files. A definition id already here is `409 agent_exists`. */
  async create(definition: Json, skills: Record<string, string>): Promise<AgentEntry> {
    const given = typeof definition.id === "string" ? definition.id : undefined;
    if (given !== undefined && existsSync(join(this.dir, given))) throw new ApiError("agent_exists", `an agent ${given} exists here`);
    const id = given ?? uuidv7();
    const dir = join(this.dir, id);
    await mkdir(dir, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
      throw error.code === "EEXIST" ? new ApiError("agent_exists", `an agent ${id} exists here`) : error;
    });
    try {
      const home = await createAgentHome(dir, { definition: { ...definition, id } as AgentDefinitionInput, skills }).catch(homeError);
      await writeWhole(join(dir, HOST_FILE), `${JSON.stringify({ created_at: new Date().toISOString() })}\n`);
      return (await this.get(home.identity.id))!;
    } catch (error) {
      await rm(dir, { recursive: true, force: true });
      throw error;
    }
  }

  /** The agent `id`, read again only when its store changed: every write closes the store, so the file shows it. */
  async get(id: string): Promise<AgentEntry | null> {
    if (!ID.test(id)) return null;
    const dir = join(this.dir, id);
    const st = await stat(join(dir, AGENT_STORE_FILE)).catch(() => null);
    if (!st?.isFile()) return null;
    const sig = `${st.mtimeMs}:${st.size}`;
    const hit = this.cache.get(id);
    if (hit?.sig === sig) return hit.entry;
    const home: AgentHome = { dir, identity: { id, name: "", formatVersion: 1 } };
    // The revision is read first: an ETag never names a revision newer than the state it is sent with.
    const revision = await homeRevision(home);
    const state = await readAgentHome(home).catch(homeError);
    const meta = await readJson(join(dir, HOST_FILE));
    const createdAt = typeof meta?.created_at === "string" ? meta.created_at : new Date(st.birthtimeMs || st.ctimeMs).toISOString();
    const updatedAt = new Date(st.mtimeMs).toISOString();
    const entry = { home: { dir, identity: state.identity }, state, revision, createdAt, updatedAt: updatedAt > createdAt ? updatedAt : createdAt };
    this.cache.set(id, { sig, entry });
    return entry;
  }

  /** Every agent here, newest first. */
  async list(): Promise<AgentEntry[]> {
    const names = await readdir(this.dir).catch(() => [] as string[]);
    const all = await Promise.all(names.filter((name) => ID.test(name)).map((name) => this.get(name).catch(() => null)));
    return all.filter((entry): entry is AgentEntry => entry !== null).sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.home.identity.id.localeCompare(b.home.identity.id));
  }

  /** The agent whose runs index holds `runId`. */
  async ownerOf(runId: string): Promise<AgentEntry | null> {
    if (!ID.test(runId)) return null;
    for (const entry of await this.list()) if (Object.hasOwn(entry.state.runs, runId)) return entry;
    return null;
  }

  forget(id: string): void {
    this.cache.delete(id);
  }
}

/**
 * The agent store's head commit number: every write that changes the home moves it, and no read does. One read-only
 * query, under no lock. The same reading as `homeRevision` of @parcha/pi-durable-agent, with the same signature.
 */
export async function homeRevision(home: Pick<AgentHome, "dir">): Promise<number> {
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(join(home.dir, AGENT_STORE_FILE), { readOnly: true, timeout: 5_000 });
  let row: { next_seq?: unknown } | undefined;
  try {
    row = db.prepare("SELECT next_seq FROM durable_metadata WHERE singleton = 1").get() as { next_seq?: unknown } | undefined;
  } finally {
    db.close();
  }
  const next = typeof row?.next_seq === "bigint" ? Number(row.next_seq) : row?.next_seq;
  if (typeof next !== "number" || !Number.isSafeInteger(next) || next < 1) throw new AgentHomeError("format", "the agent store has no usable head commit");
  return next - 1;
}

/** The home's ETag: its revision, which changes with every write to `agent.sqlite`. */
export const etagOf = (entry: AgentEntry) => `"${entry.revision}"`;

/** `Agent` as the contract shows it. A sign-in's `ref` never leaves the home. */
export function agentView(entry: AgentEntry, now = Date.now()) {
  const { state } = entry;
  const runs = Object.values(state.runs);
  const leaseOf = (key: string) => {
    const lease = Object.hasOwn(state.leases, key) ? state.leases[key] : undefined;
    if (!lease || Date.parse(lease.expiresAt) <= now) return null;
    const run = Object.hasOwn(state.runs, lease.runId) ? state.runs[lease.runId] : undefined;
    return run && run.endedAt === undefined ? lease.runId : null;
  };
  return {
    agent_id: state.identity.id,
    definition: state.definition,
    source: state.source ? { sha: state.source.sha, refreshed_at: state.source.refreshedAt } : null,
    skills: Object.entries(state.skills).map(([path, file]) => ({ path, sha256: file.sha256, size_bytes: Buffer.byteLength(file.content, "utf8") })),
    sign_ins: Object.entries(state.profiles)
      .filter(([, profile]) => typeof profile.ref === "string" && profile.ref !== "")
      .map(([key, profile]) => {
        const held = leaseOf(key);
        return { key, provider: profile.provider, state: held ? "held" : "ready", held_by: held, verified_at: profile.verifiedAt ?? null };
      }),
    runs: { count: runs.length, live: runs.filter((run) => run.endedAt === undefined).length },
    region: "local",
    home_etag: etagOf(entry),
    created_at: entry.createdAt,
    updated_at: entry.updatedAt,
  };
}
