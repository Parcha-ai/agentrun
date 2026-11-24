// The `agentrun.share/1` bundle as serve's run-export.ts writes it (GET /v2/runs/{id}/export), and where the share page
// reads it from. The page renders the bundle alone: what it shows is what a share host would store and show.
import type { RunGraph } from "@/lib/runGraph";
import type { Run, TimelineRow } from "@/lib/v2";

export const SHARE_FORMAT = "agentrun.share/1";

/** A cut's kind (serve's secret-cut.ts CutKind). */
export type CutKind = "format" | "held" | "dump" | "label" | "personal" | "jev";
/** A cut in the bundle: where it is (an RFC 6901 pointer and its span there), its rule, kind and shape. Never its value. */
export type CutRecord = { id: string; at: string; start: number; end: number; rule: string; kind: CutKind; restorable: boolean; shape: string };
/** A cut a restore put back: its value is in place again at `start`-`end` of the string at `at`. */
export type RestoredRecord = { id: string; at: string; start: number; end: number; rule: string; kind: CutKind };
export type ShareFile = { path: string; bytes: number; sha256: string; encoding: "utf8"; content: string };
export type Omitted = { what: "file"; path: string; why: string } | { what: "files"; why: string } | { what: "recordings"; why: string };

/** The run's allowlisted fields (serve's SHARE_RUN_FIELDS), the rest of a served run dropped. */
export type ShareRun = Pick<Run, "kind" | "status" | "state" | "title" | "created_at" | "result" | "error" | "review" | "cost"> & { ended_at?: string | null; imported_from?: { source: string } | null; [field: string]: unknown };

export type ShareBundle = {
  format: typeof SHARE_FORMAT;
  sha256: string;
  source: { agentrun: string; scrubber: { version: number; rules: string } };
  agent: { name: string; kind: string };
  run: ShareRun;
  rows: TimelineRow[];
  graph: Omit<RunGraph, "run"> & { run: Partial<RunGraph["run"]> } | null;
  files: ShareFile[];
  omitted: Omitted[];
  cuts: CutRecord[];
  restored: RestoredRecord[];
};

/** The kinds a preview may put back (the scrubber asks `keep` of these alone). Every other kind is locked. */
export const RESTORABLE_KINDS: ReadonlySet<CutKind> = new Set(["label", "personal", "jev"]);
/** Whether a cut gets a restore switch: the bundle says it is restorable and its kind is one that is. A bundle that says
 *  a format, held or dump cut is restorable is wrong, and the page offers nothing for it. */
export const mayRestore = (cut: { kind: CutKind; restorable?: boolean }, restored = false): boolean => RESTORABLE_KINDS.has(cut.kind) && (restored || cut.restorable === true);

/** Why a locked kind is never published, in one line. */
export const LOCKED_WHY: Readonly<Record<string, string>> = {
  format: "A known key format: never published.",
  held: "A value this server holds: never published.",
  dump: "An environment or file dump: never published.",
};
/** Each kind's name and what it covers, in the panel's order: what may be restored first. */
export const KINDS: readonly { kind: CutKind; name: string; about: string }[] = [
  { kind: "personal", name: "Personal", about: "Emails, home folders, private addresses. Restore one only if you mean to publish it." },
  { kind: "label", name: "Labelled", about: "A value written after a name like PASSWORD= or token:. Restore one only if it is not a secret." },
  { kind: "jev", name: "Judged", about: "A value a model judged to be private." },
  { kind: "format", name: "Key formats", about: LOCKED_WHY.format! },
  { kind: "held", name: "Held values", about: LOCKED_WHY.held! },
  { kind: "dump", name: "Dumps", about: LOCKED_WHY.dump! },
];

/** The share host a publish goes to: agentrun.ai, whose /r/ is the share host (a self-hosted one takes its own address
 *  in --to). */
export const SHARE_HOST = "https://agentrun.ai";

/** The command that publishes this exact bundle to the share host: the restores it holds, and its sha256, which the CLI
 *  checks against a fresh export before it sends anything. */
export function publishCommand(runId: string, bundle: Pick<ShareBundle, "restored" | "sha256">): string {
  const restore = bundle.restored.map((r) => r.id);
  return ["agentrun share", runId, "--to", SHARE_HOST, ...(restore.length ? ["--restore", restore.join(",")] : []), "--expect", bundle.sha256].join(" ");
}

const unescape = (token: string) => token.replace(/~1/g, "/").replace(/~0/g, "~");
/** Where a cut's pointer is, in words: a Timeline step (numbered from 1), the run's title or answer, a file's path. */
export function placeOf(at: string, bundle: Pick<ShareBundle, "files">): string {
  const [part, ...rest] = at.split("/").slice(1).map(unescape);
  if (part === "rows" && rest.length >= 1) return `Timeline step ${Number(rest[0]) + 1}${rest.length > 1 ? ` · ${rest.slice(1).join(".")}` : ""}`;
  if (part === "run") {
    const field = rest.join("/");
    return field === "title" ? "Run title" : field === "result/final_answer" ? "Answer" : field.startsWith("result/output") ? "Output" : `Run ${field.replace(/[/_]/g, " ")}`;
  }
  if (part === "files" && rest.length >= 1) {
    const path = bundle.files[Number(rest[0])]?.path ?? `File ${Number(rest[0]) + 1}`;
    return rest[1] === "path" ? `${path} (its name)` : path;
  }
  if (part === "agent") return "Agent name";
  if (part === "graph") return `Graph · ${rest.join("/")}`;
  return at;
}

/** One read of the bundle: the bundle, or the status that refused it (never the refusal's words: a page that failed
 *  shows its own). A status of 0 is a server that could not be reached. */
export type ShareLoad = { ok: true; bundle: ShareBundle } | { ok: false; status: number };
/** Where the page reads its bundle. The owner's preview reads the export with restores; a share host's page reads the
 *  stored bundle (storedSource), with none. */
export type ShareSource = { load(restore: readonly string[], signal: AbortSignal): Promise<ShareLoad> };

/** Whether `value` is a share bundle the page can draw: the format it knows and the parts it reads. */
function isBundle(value: unknown): value is ShareBundle {
  const b = value as Partial<ShareBundle> | null;
  return !!b && b.format === SHARE_FORMAT && typeof b.sha256 === "string" && !!b.run && typeof b.run === "object" && Array.isArray(b.rows) && Array.isArray(b.files) && Array.isArray(b.cuts) && Array.isArray(b.restored) && Array.isArray(b.omitted);
}

/** The owner's export of `runId` on this server (or under `base`), with the session cookie: the one read the page makes. */
export function exportSource({ runId, base = "" }: { runId: string; base?: string }): ShareSource {
  return {
    async load(restore, signal) {
      const url = `${base}/v2/runs/${encodeURIComponent(runId)}/export${restore.length ? `?restore=${restore.map(encodeURIComponent).join(",")}` : ""}`;
      let res: Response;
      try {
        res = await fetch(url, { method: "GET", credentials: "same-origin", headers: { accept: "application/json" }, signal });
      } catch (error) {
        if ((error as Error)?.name === "AbortError") throw error;
        return { ok: false, status: 0 };
      }
      if (!res.ok) return { ok: false, status: res.status };
      const body: unknown = await res.json().catch(() => undefined);
      return isBundle(body) ? { ok: true, bundle: body } : { ok: false, status: 500 };
    },
  };
}

/** A share host's stored bundle of share `shareId` (GET /r/<id>/bundle.json, the bytes the host scanned), with no
 *  credential: the one read a public share page makes. */
export function storedSource({ shareId, base = "" }: { shareId: string; base?: string }): ShareSource {
  return {
    async load(_restore, signal) {
      let res: Response;
      try {
        res = await fetch(`${base}/r/${encodeURIComponent(shareId)}/bundle.json`, { method: "GET", credentials: "omit", headers: { accept: "application/json" }, signal });
      } catch (error) {
        if ((error as Error)?.name === "AbortError") throw error;
        return { ok: false, status: 0 };
      }
      if (!res.ok) return { ok: false, status: res.status };
      const body: unknown = await res.json().catch(() => undefined);
      return isBundle(body) ? { ok: true, bundle: body } : { ok: false, status: 500 };
    },
  };
}

/** A share's id as a share host's address names it (serve's share-host.ts SHARE_ID): 26 base32 letters. */
const SHARE_ID = /^[a-z2-7]{26}$/;
/** The share `/r/<id>` names, or null for any other address. */
export function shareIdOf(pathname: string): string | null {
  const m = /^\/r\/([^/]+)\/?$/.exec(pathname);
  return m && SHARE_ID.test(m[1]!) ? m[1]! : null;
}

/** A run id as a page address names it: one segment of letters, digits, `_`, `-` and `.`, never a dot segment. */
const SEGMENT = /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/;
/** The run `/share/<run>` names, or null for any other address. */
export function runIdOf(pathname: string): string | null {
  const m = /^\/share\/([^/]+)\/?$/.exec(pathname);
  return m && SEGMENT.test(m[1]!) ? m[1]! : null;
}
