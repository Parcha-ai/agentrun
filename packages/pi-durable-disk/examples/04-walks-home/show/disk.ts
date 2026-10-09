// The agent's disk, as the tab's storage-read / storage-write see it. Two backends behind one interface:
//   modelDisk  in memory, for a scripted feed with no run (a rehearsal's disk; emptied by a reset)
//   runDisk    the real run's work/ over the 03 server's HTTP route, with the run secret the stage's SERVER holds
// The run secret never reaches the page: the page asks the stage, the stage asks the run.
import { createHash } from "node:crypto";

export type DiskRead = { status: 200; bytes: Buffer; etag: string } | { status: 304; etag: string } | { status: 204 } | { status: number; error: string };
export type DiskWrite = { status: 200; bytes: number } | { status: number; error: string };

/** The file itself (a 200), as opposed to "unchanged" (304), "missing" (204) or an error: the error variant's number includes 200 for the compiler. */
export const isFile = (r: DiskRead): r is Extract<DiskRead, { bytes: Buffer }> => r.status === 200 && "bytes" in r;

export interface DiskBackend {
  read(path: string, ifNoneMatch?: string): Promise<DiskRead>;
  write(path: string, bytes: Buffer): Promise<DiskWrite>;
  /** Forget everything (a new take starts with a fresh disk). The real disk has no such thing. */
  reset?(): void;
}

/** A content hash as a strong entity tag: the same bytes always have the same tag, so a poller can ask "changed since?". */
export function etagOf(bytes: Uint8Array): string {
  return `"${createHash("sha256").update(bytes).digest("hex").slice(0, 32)}"`;
}

/** Does an `If-None-Match` header (one tag, a list, weak tags, or *) name this tag? */
export function matches(ifNoneMatch: string | undefined, etag: string): boolean {
  if (!ifNoneMatch) return false;
  if (ifNoneMatch.trim() === "*") return true;
  return ifNoneMatch.split(",").some((t) => t.trim().replace(/^W\//, "") === etag);
}

function answer(bytes: Buffer, ifNoneMatch: string | undefined): DiskRead {
  const etag = etagOf(bytes);
  return matches(ifNoneMatch, etag) ? { status: 304, etag } : { status: 200, bytes, etag };
}

export function modelDisk(): DiskBackend {
  const files = new Map<string, Buffer>();
  return {
    async read(path, ifNoneMatch) {
      const hit = files.get(path);
      // A file that does not exist yet is normal on a first read: 204, never an error.
      return hit ? answer(hit, ifNoneMatch) : { status: 204 };
    },
    async write(path, bytes) {
      files.set(path, Buffer.from(bytes));
      return { status: 200, bytes: bytes.length };
    },
    reset: () => files.clear(),
  };
}

export type RunTarget = { origin: string; run: string; secret: string };

/**
 * The real run's work/ (the 03 server's `GET|PUT /api/runs/<id>/work/<path>`, both with the run's secret as a bearer token). A
 * write names the tab that holds the run in `x-pda-tab` and only lands at the paths the server was started with `--tab-writable`:
 * anything else is its 403, a tab that does not hold the run is its 409. Both are passed back as they came, with the server's words.
 */
export function runDisk(target: RunTarget | (() => RunTarget | undefined), writerTab: () => string | undefined, fetchFn: typeof fetch = fetch): DiskBackend {
  // The target may be followed live (a retake writes a new link): it is asked for at every call, never kept.
  const now = () => (typeof target === "function" ? target() : target);
  const url = (t: RunTarget, path: string) => `${t.origin}/api/runs/${encodeURIComponent(t.run)}/work/${path.split("/").map(encodeURIComponent).join("/")}`;
  const auth = (t: RunTarget) => ({ authorization: `Bearer ${t.secret}` });
  const reason = async (res: Response) => {
    const body = (await res.json().catch(() => undefined)) as { error?: string } | undefined;
    return body?.error ?? `HTTP ${res.status}`;
  };
  return {
    async read(path, ifNoneMatch) {
      const t = now();
      // No run yet (the link file is not there): nothing is on any disk.
      if (!t) return { status: 204 };
      const res = await fetchFn(url(t, path), { headers: auth(t), signal: AbortSignal.timeout(8000) }).catch((e: Error) => e);
      if (res instanceof Error) return { status: 502, error: `the run's server did not answer (${res.message})` };
      if (res.status === 404) return { status: 204 };
      // While the run moves no pipe holds it and the server cannot read its files (503). That is "unknown right now", not a failure:
      // a poller that passed the etag it last saw is told nothing changed, one that did not is told there is nothing yet. Either
      // way the page logs no error for a move, which is routine.
      if (res.status === 503) return ifNoneMatch ? { status: 304, etag: ifNoneMatch } : { status: 204 };
      if (!res.ok) return { status: res.status, error: await reason(res) };
      return answer(Buffer.from(await res.arrayBuffer()), ifNoneMatch);
    },
    async write(path, bytes) {
      const t = now();
      if (!t) return { status: 409, error: "there is no run yet" };
      const tab = writerTab();
      if (!tab) return { status: 409, error: "no tab holds the run" };
      const res = await fetchFn(url(t, path), { method: "PUT", headers: { ...auth(t), "x-pda-tab": tab }, body: new Uint8Array(bytes), signal: AbortSignal.timeout(15000) }).catch((e: Error) => e);
      if (res instanceof Error) return { status: 502, error: `the run's server did not answer (${res.message})` };
      return res.ok ? { status: 200, bytes: bytes.length } : { status: res.status, error: await reason(res) };
    },
  };
}
