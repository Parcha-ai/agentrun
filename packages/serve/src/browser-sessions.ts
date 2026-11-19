// A run's browser sessions, one record each, for an operator who reconciles the run's browser time with its provider's
// bill (GET /runs/{run_id}/usage `browser_sessions`). Two records on the run's root say a session: its open
// (BROWSER_SESSION_OPEN, written before the provider is asked to create it, browser-cost.ts) and its end
// (BROWSER_SESSION_ENDED, below, written once pi-browser lets it go). The end carries the provider's session id, when
// this server saw the session start and end, why it ended, and the provider's own record of it where the provider keeps
// one (BrowserComputerProvider.sessionUsage: its start, its end, its proxy bytes), read once at that release. The
// seconds this server charged for it are its BROWSER_CHARGED records'. Nothing is priced here and nothing is rounded:
// a provider's minimum belongs to whoever bills.
//
// Unknown is never 0. A session with no end record yet (its run's process lost before the release was told) says
// `ended_at` null; a provider that keeps no record, or one whose read failed, says so (`provider_record_status`) with
// `provider_record` null; a field the provider's record does not hold is null in it.
import { ROOT_CONVERSATION_ID, type Tx } from "@earendil-works/pi-durable";
import type { BrowserSessionUsage } from "@parcha/agentrun-computer";
import { BROWSER_CHARGED, BROWSER_SESSION_OPEN } from "./browser-cost.js";
import type { EntryLike } from "./timeline/index.js";

/** The run journal's record of a browser session let go (on the root): see the file's head. */
export const BROWSER_SESSION_ENDED = "agentrun.browser_session_ended";

/** How long the provider's record is waited for at a release before the session's end is written without it. */
export const PROVIDER_RECORD_TIMEOUT_MS = 5_000;

/** What came of reading the provider's own record: `read`, it answered; `not_offered`, the provider keeps none this
 *  server reads; `not_found`, it does not know the session; `failed`, the read failed or timed out; `no_session`, no
 *  session was made (its create failed), so there was nothing to read. */
export type ProviderRecordStatus = "read" | "not_offered" | "not_found" | "failed" | "no_session";

/** The provider's record as this server keeps it: each field null where the provider does not say it. */
export type ProviderRecord = { started_at: string | null; ended_at: string | null; proxy_bytes: number | null };

/** A browser session as the usage read gives it. */
export type BrowserSessionLine = {
  provider: string;
  /** pi-browser's tag for the session: the run's own name for it, which its charges name too. */
  tag: string;
  /** The provider's id for the session; null when none was made, or its end is not recorded. */
  provider_session_id: string | null;
  /** When this server began opening the session, and when it let it go (null: no end recorded). */
  started_at: string | null;
  ended_at: string | null;
  release_reason: string | null;
  /** The seconds this server charged for the session's time (its BROWSER_CHARGED records), unrounded; null when none
   *  was charged (a free provider's, or a session with no charge yet). */
  charged_seconds: number | null;
  provider_record: ProviderRecord | null;
  provider_record_status: ProviderRecordStatus | null;
};

/** A session as pi-browser's release tells it (its SessionRecord), only what is recorded. */
type Released = { tag: string; resourceId: string | null; createdAt: string; endedAt: string | null; releaseReason: string | null; provider: string };

/** The writer of each session's end, once per session in this process (pi-browser tells a release at least once):
 *  the provider's record read first (`usage`, bounded), then the end written on the root (`commit`). It never throws: a
 *  session whose end cannot be written is said in `log`, and reads as not ended. */
export function sessionEnds(options: {
  usage: ((id: string, signal?: AbortSignal) => Promise<BrowserSessionUsage | undefined>) | undefined;
  commit: ((change: (tx: Tx) => Promise<void>) => Promise<unknown>) | undefined;
  log?: (line: string) => void;
  timeoutMs?: number;
}): (session: Released, conversation: number) => Promise<void> {
  const written = new Set<string>();
  const log = options.log ?? ((line: string) => void process.stderr.write(`agentrun-serve: ${line}\n`));
  return async (session, conversation) => {
    if (written.has(session.tag) || !options.commit) return;
    written.add(session.tag);
    const { record, status } = await providerRecord(session.resourceId, options.usage, options.timeoutMs ?? PROVIDER_RECORD_TIMEOUT_MS);
    const data = {
      tag: session.tag,
      conversation,
      provider: session.provider,
      provider_session_id: session.resourceId,
      started_at: session.createdAt,
      ended_at: session.endedAt ?? new Date().toISOString(),
      release_reason: session.releaseReason,
      provider_record: record,
      provider_record_status: status,
    };
    try {
      await options.commit(async (tx) => void (await tx.appendEntry(ROOT_CONVERSATION_ID, { kind: BROWSER_SESSION_ENDED, data })));
    } catch (error) {
      written.delete(session.tag);
      log(`the end of browser session ${session.tag} was not recorded (${String((error as Error)?.message ?? error).slice(0, 200)}): its usage reads it as not ended`);
    }
  };
}

async function providerRecord(id: string | null, usage: ((id: string, signal?: AbortSignal) => Promise<BrowserSessionUsage | undefined>) | undefined, timeoutMs: number): Promise<{ record: ProviderRecord | null; status: ProviderRecordStatus }> {
  if (id === null) return { record: null, status: "no_session" };
  if (!usage) return { record: null, status: "not_offered" };
  let timer: NodeJS.Timeout | undefined;
  try {
    const signal = AbortSignal.timeout(timeoutMs);
    const read = await Promise.race([usage(id, signal), new Promise<"late">((resolve) => { timer = setTimeout(() => resolve("late"), timeoutMs); })]);
    if (read === "late") return { record: null, status: "failed" };
    if (read === undefined) return { record: null, status: "not_found" };
    return { record: { started_at: read.startedAt, ended_at: read.endedAt, proxy_bytes: read.proxyBytes }, status: "read" };
  } catch {
    return { record: null, status: "failed" };
  } finally {
    clearTimeout(timer);
  }
}

const text = (value: unknown) => (typeof value === "string" ? value : null);
const count = (value: unknown) => (typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null);
const STATUSES: readonly ProviderRecordStatus[] = ["read", "not_offered", "not_found", "failed", "no_session"];

/** A run's browser sessions from its journal `entries`, in the order they were opened: one per tag its root names in an
 *  open, an end or a charge. The first end recorded for a tag is its end. */
export function browserSessionsOf(entries: readonly EntryLike[]): BrowserSessionLine[] {
  const sessions = new Map<string, BrowserSessionLine>();
  const of = (tag: string, provider: string) => {
    let line = sessions.get(tag);
    if (!line) {
      line = { provider, tag, provider_session_id: null, started_at: null, ended_at: null, release_reason: null, charged_seconds: null, provider_record: null, provider_record_status: null };
      sessions.set(tag, line);
    }
    return line;
  };
  const ended = new Set<string>();
  for (const e of entries) {
    const d = (e.data ?? {}) as Record<string, unknown>;
    const tag = text(d.tag);
    if (tag === null) continue;
    if (e.kind === BROWSER_SESSION_OPEN) of(tag, text(d.provider) ?? "");
    else if (e.kind === BROWSER_CHARGED && d.tool === "browser" && typeof d.seconds === "number" && Number.isFinite(d.seconds)) {
      const line = of(tag, text(d.charged_by) ?? "");
      line.charged_seconds = Math.round(((line.charged_seconds ?? 0) + d.seconds) * 1e6) / 1e6;
    } else if (e.kind === BROWSER_SESSION_ENDED && !ended.has(tag)) {
      ended.add(tag);
      const line = of(tag, text(d.provider) ?? "");
      if (line.provider === "") line.provider = text(d.provider) ?? "";
      const record = d.provider_record as Record<string, unknown> | null | undefined;
      const status = STATUSES.find((one) => one === d.provider_record_status) ?? null;
      Object.assign(line, {
        provider_session_id: text(d.provider_session_id),
        started_at: text(d.started_at),
        ended_at: text(d.ended_at),
        release_reason: text(d.release_reason),
        provider_record: record && typeof record === "object" ? { started_at: text(record.started_at), ended_at: text(record.ended_at), proxy_bytes: count(record.proxy_bytes) } : null,
        provider_record_status: status,
      });
    }
  }
  return [...sessions.values()];
}
