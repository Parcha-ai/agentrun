// Coming home: the page's side of a check-in. While the run is checked out the workspace changes in this browser only; at checkout the page records what the server's
// work/ held (a baseline: path, kind, size and SHA-256 of each file), and at check-in the changes are what the workspace holds now against that baseline, as the inline
// FileChanges the server applies (pipe/server.ts, POST /api/runs/<id>/checkin). The request itself is `postCheckin`. Portable: Web Crypto and fetch.
import { sha256Hex, toBase64, type FileChange } from "../wire.ts";

/** A workspace as the page holds it: a file's bytes or a directory. */
export type Snapshot = ReadonlyMap<string, { kind: "file"; data?: Uint8Array } | { kind: "directory" }>;

/** What the server's work/ held at checkout, one entry per path. */
export type Baseline = Record<string, { kind: "directory" } | { kind: "file"; size: number; sha256: string }>;

export async function baselineOf(snapshot: Snapshot): Promise<Baseline> {
  const out: Baseline = {};
  for (const [path, entry] of snapshot) out[path] = entry.kind === "directory" ? { kind: "directory" } : { kind: "file", size: entry.data?.length ?? 0, sha256: await sha256Hex(entry.data ?? new Uint8Array()) };
  return out;
}

/** The changes that turn the baseline into `now`: new and changed files whole, new directories, and what is gone (a removed directory's children first, so a replay of the list is safe). Parents before children for what is new. */
export async function diffWorkspace(baseline: Baseline, now: Snapshot): Promise<FileChange[]> {
  const changes: FileChange[] = [];
  // a path that is a different kind now (a file made a directory, or the other way) is deleted first and made again: the server's copy of the old kind would refuse the new one
  const replaced = (p: string) => baseline[p] !== undefined && now.has(p) && baseline[p]!.kind !== now.get(p)!.kind;
  const gone = Object.keys(baseline).filter((p) => !now.has(p) || replaced(p)).sort((a, b) => b.split("/").length - a.split("/").length || (a < b ? 1 : -1));
  for (const path of gone) changes.push({ path, op: "delete" });
  const present = [...now.keys()].sort((a, b) => a.split("/").length - b.split("/").length || (a < b ? -1 : 1));
  for (const path of present) {
    const entry = now.get(path)!;
    const before = baseline[path];
    if (entry.kind === "directory") {
      if (before?.kind !== "directory") changes.push({ path, op: "mkdir" });
      continue;
    }
    const data = entry.data ?? new Uint8Array();
    if (before?.kind === "file" && before.size === data.length && before.sha256 === (await sha256Hex(data))) continue;
    changes.push({ path, op: "write", data: toBase64(data) });
  }
  return changes;
}

/** Why the server did not take the check-in; `code` is the server's (CHECKIN_DIVERGED, NOT_CHECKED_OUT, CHECKIN_BUSY, MARKER_UNREADABLE) or `NETWORK` when it was not reached. */
export class CheckinError extends Error {
  readonly code: string;
  readonly status: number | undefined;
  constructor(code: string, message: string, status?: number) {
    super(message);
    this.name = "CheckinError";
    this.code = code;
    this.status = status;
  }
}

export interface CheckinDone {
  head: number;
  files: number;
}

/**
 * Send the browser's store and the workspace changes home. A 409 that is not a refusal of the store (the server is busy, or still has the mark) may be sent again; the caller decides
 * (a CHECKIN_DIVERGED never succeeds by repeating). The reply is the server's: the head it now holds and how many files it wrote.
 */
export async function postCheckin(o: { run: string; secret: string; tab: string; store: Uint8Array; changes: readonly FileChange[]; fetch?: typeof fetch; signal?: AbortSignal }): Promise<CheckinDone> {
  const body = JSON.stringify({ tab: o.tab, store: toBase64(o.store), changes: o.changes });
  let response: Response;
  try {
    response = await (o.fetch ?? fetch)(`/api/runs/${encodeURIComponent(o.run)}/checkin`, { method: "POST", headers: { authorization: `Bearer ${o.secret}`, "content-type": "application/json" }, body, ...(o.signal ? { signal: o.signal } : {}) });
  } catch (error) {
    throw new CheckinError("NETWORK", `the server could not be reached: ${(error as Error).message}`);
  }
  const reply = (await response.json().catch(() => null)) as { head?: number; files?: number; error?: string; code?: string } | null;
  if (!response.ok) throw new CheckinError(reply?.code ?? `HTTP_${response.status}`, reply?.error ?? `the server answered ${response.status}`, response.status);
  if (typeof reply?.head !== "number") throw new CheckinError("BAD_REPLY", "the server's answer to the check-in has no head");
  return { head: reply.head, files: typeof reply.files === "number" ? reply.files : 0 };
}
