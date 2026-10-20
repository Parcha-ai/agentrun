// What a recording (record.ts) and a replay (../replay.mjs) take out of a run's lines and rows, one set of rules for
// both: the browser profile's id (a context id, or a Chrome profile's path) becomes `[redacted]`; a browser session's
// id a label of its hash, so a session's lines, frames and rows still go together; any `token=` value `[redacted]`; any
// email address `[email]` (a page the agent read names people, and the recording is not where their addresses go); and
// every `liveView` null (a live view is a token for the browser). The ids are the ones a run's browser documents hold.
// It loads node's own modules only: a replay is written where pi's packages are not installed.
import { createHash } from "node:crypto";

export const REDACTED = "[redacted]";
/** Any `token=` value, a live view's or a debugger's, whatever site wrote it. */
const TOKEN = /([?&;]token=)[^&#\s"'\\]+/gi;
/** An email address, as a page or a filing prints one. */
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
export const EMAIL_REDACTED = "[email]";

/** How a recording or a replay shows a browser session's id: a label of its hash. */
export const sessionLabel = (id: string): string => `session-${createHash("sha256").update(id).digest("hex").slice(0, 12)}`;

/** The browser ids of a run. Both sets grow while a run learns them; a redaction reads them at each call. */
export type BrowserIds = { profiles: Set<string>; sessions: Set<string> };
export const browserIds = (): BrowserIds => ({ profiles: new Set(), sessions: new Set() });

/** A value with every `liveView` in it null, at any depth. */
export const withoutLiveViews = (value: unknown): unknown =>
  Array.isArray(value) ? value.map(withoutLiveViews)
    : value !== null && typeof value === "object" ? Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, key === "liveView" ? null : withoutLiveViews(inner)]))
    : value;

/** Each profile id as `[redacted]` and each session id as its label (the longest first, raw and as a JSON string writes
 *  it), then any token. */
export function idsRedaction(ids: BrowserIds): (text: string) => string {
  let size = -1;
  let pairs: [string, string][] = [];
  return (text) => {
    if (size !== ids.profiles.size + ids.sessions.size) {
      size = ids.profiles.size + ids.sessions.size;
      const to = [...[...ids.profiles].map((id) => [id, REDACTED]), ...[...ids.sessions].map((id) => [id, sessionLabel(id)])].sort(([a], [b]) => b.length - a.length);
      pairs = [...new Map(to.flatMap(([id, label]) => [[id, label], [JSON.stringify(id).slice(1, -1), label]] as [string, string][]))];
    }
    let out = text;
    for (const [id, label] of pairs) if (out.includes(id)) out = out.split(id).join(label);
    return out.replace(TOKEN, `$1${REDACTED}`).replace(EMAIL, EMAIL_REDACTED);
  };
}

/** The ids a run's store holds in its browser documents, from every revision of each (a delta names its path, whose last
 *  part is the key): profile and context ids (`ref`, `contextId`) and session ids (`resourceId`). Read-only. */
export async function readBrowserIds(storePath: string, ids: BrowserIds = browserIds()): Promise<BrowserIds> {
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(storePath, { readOnly: true });
  const take = (key: unknown, value: unknown) => {
    if (typeof value !== "string" || !value) return;
    if (key === "ref" || key === "contextId") ids.profiles.add(value);
    else if (key === "resourceId") ids.sessions.add(value);
  };
  const walk = (value: unknown, key?: unknown): void => {
    if (Array.isArray(value)) value.forEach((inner) => walk(inner, key));
    else if (value !== null && typeof value === "object") for (const [name, inner] of Object.entries(value)) walk(inner, name);
    else take(key, value);
  };
  try {
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'document_revisions'").get()) return ids;
    const rows = db.prepare("SELECT r.kind AS revision, r.content AS content FROM document_revisions r JOIN documents d ON d.id = r.document_id WHERE d.kind LIKE '%browser.%'").all() as { revision: string; content: string }[];
    for (const { revision, content } of rows) {
      const value = JSON.parse(content) as unknown;
      if (revision === "base") walk(value);
      else for (const [, path, ...rest] of value as [string, (string | number)[], ...unknown[]][]) for (const inner of rest) walk(inner, path.at(-1));
    }
  } finally {
    db.close();
  }
  return ids;
}
