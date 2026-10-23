import { DatabaseSync } from "node:sqlite";
import { SECRET_KINDS } from "./export.js";
import { AGENT_STORE_FILE, ID_PATTERN } from "./home.js";
import { canonical, FORMAT_VERSION, type AgentDefinition } from "./kinds.js";
import { AgentHomeError } from "./store.js";

// What a packer and a reader agree on. A rule that one of them applies is here, so a pack the packer writes is a pack
// the reader reads.

export const PACK_FORMAT = `agentrun.home/${FORMAT_VERSION}`;

/** What a pack holds, without its bytes: the first member of every pack. */
export type HomeManifest = {
  format: string;
  agent_id: string;
  definition: AgentDefinition;
  /** The home's `agent.source`, in the contract's names; `null` for a home not tied to a repo. */
  source: { sha: string; refreshed_at: string } | null;
  skills: { path: string; sha256: string; size_bytes: number }[];
  /** What the source had. No sign-in travels: the target signs in again. */
  sign_ins: { key: string; provider: string }[];
  vault: { name: string }[];
  runs: { count: number; live: number };
  /** The size of the pack, in bytes. */
  size_bytes: number;
  created_at: string;
};

export const invalid = (message: string) => new AgentHomeError("invalid", message);
export const refused = (message: string) => new AgentHomeError("check", message);
export const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
export const iso = (ms: number) => new Date(ms).toISOString();
export const isRunId = (value: unknown): value is string => typeof value === "string" && ID_PATTERN.test(value);

export const SQLITE_MAGIC = Buffer.from("SQLite format 3\0", "ascii");
export const MANIFEST_LIMIT = 4 * 1024 * 1024;
/** The most members a pack holds; a packer refuses to write more and a reader to read more. */
export const MAX_MEMBERS = 200_000;
export const SIDE_FILES = ["-wal", "-shm", "-journal"];
/** The most directories a work file may be nested in; a member deeper than this is refused. */
export const MAX_DEPTH = 64;

export { canonical };

export const byName = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

export const safeSegment = (segment: string): boolean =>
  segment !== "" && !segment.startsWith(".") && !/[\\\0\x01-\x1f\x7f]/.test(segment) && Buffer.byteLength(segment) <= 255;

/** Why `name` is not a member a pack may hold, or undefined. The allowlist: the manifest, the agent store, a run's
 *  store, and a run's work directory with the regular files and directories under it whose names do not start with ".". */
export function memberProblem(name: string, kind: "file" | "dir"): string | undefined {
  if (Buffer.byteLength(name) > 4096) return "its name is too long";
  if (SIDE_FILES.some((suffix) => name.endsWith(`.sqlite${suffix}`))) return "a SQLite side file is never part of a pack";
  if (kind === "file" && (name === "manifest.json" || name === AGENT_STORE_FILE)) return undefined;
  const parts = name.split("/");
  if (parts[0] !== "runs" || parts.length < 3 || !isRunId(parts[1])) return "it is not a member a home pack holds";
  if (kind === "file" && parts.length === 4 && parts[2] === "store" && parts[3] === "run.sqlite") return undefined;
  if (parts[2] === "work" && parts.length - 3 > MAX_DEPTH) return `it is nested more than ${MAX_DEPTH} levels deep`;
  if (parts[2] === "work" && parts.slice(3).every(safeSegment) && (kind === "dir" || parts.length > 3)) return undefined;
  return "it is not a member a home pack holds";
}

/** The store keeps a kind as JSON text (`"agent.runs"`, with its quotes); a file that keeps it bare is read the same. */
function kindName(stored: string): string {
  try {
    const parsed: unknown = JSON.parse(stored);
    return typeof parsed === "string" ? parsed : stored;
  } catch {
    return stored;
  }
}

/** The document kinds a pi-durable store holds, or undefined when the file has no `documents` table. Reads only. */
export function documentKinds(file: string): string[] | undefined {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'documents'").get()) return undefined;
    return (db.prepare("SELECT kind FROM documents GROUP BY kind ORDER BY kind").all() as { kind: string }[]).map((row) => kindName(row.kind));
  } finally {
    db.close();
  }
}

export const secretIn = (kinds: string[] | undefined) => kinds?.find((kind) => SECRET_KINDS.includes(kind));
