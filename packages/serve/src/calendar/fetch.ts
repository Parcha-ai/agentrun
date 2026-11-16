// A calendar's file, fetched under the server's one address rule, the one an MCP server is held to (mcp-oauth.ts
// calendarAt, beside mcpServerAt): https only; every address a hop's name resolves to checked, and the connection dialled
// at the address checked (dialAt), so a name that resolves to the owner's network or a redirect that goes there is
// refused; a host on a private network only where the owner allows it in Settings → MCP servers (private hosts), never
// loopback, link-local (cloud metadata) or this machine's own; and loopback, as written, only for a server that is a local
// install, whose fakes listen there (the operator's mcpLoopback, as an MCP server on loopback is). Each redirect hop is
// checked again. A 10 MB body, 20 s for the whole fetch, at most 5 redirects. A read is kept in memory, parsed, for 5
// minutes, and used again with no request; past that the next read asks with its ETag (If-None-Match) and Last-Modified
// (If-Modified-Since), and a 304 keeps the parsed copy. Every failure is a CalendarError in the server's words, naming
// the host at most: never the address, which is a secret.
import type { OAuthNetwork, Reach } from "../mcp-oauth.js";
import { scrubAddress } from "./address.js";
import { BODY_MAX_BYTES, CALENDAR_SETTING, FETCH_TIMEOUT_MS, FRESH_MS, REDIRECTS_MAX } from "./names.js";
import { type ParsedCalendar, parseCalendar } from "./parse.js";

/** A read that failed, in words that never hold the address. */
export class CalendarError extends Error {}

/** Where a read may go beyond public hosts (mcp-oauth.ts Reach): `loopback`, a local install's (its fakes); `allowed`, the
 *  private-network hosts the owner allows (Settings → MCP servers); `own`, this server's own origins, never dialled on
 *  loopback. */
export type CalendarReach = Reach;
/** The network a read resolves and dials through (mcp-oauth.ts OAuthNetwork), for a test. Default the system's. */
export type CalendarNetwork = OAuthNetwork;

/** A calendar read: parsed, with `followed`, every address a redirect took the read to (the saved one's host may send it
 *  to another secret address), each scrubbed from what the calendar says as the saved one is (address.ts scrubAddress). */
export type ReadCalendar = ParsedCalendar & { followed: readonly string[] };

/** A read kept: `from`, the address its body came from (the last hop), the one address its validators are sent to;
 *  `followed`, its calendar's own list, added to in place when a revalidation is redirected somewhere new, so a 304 answers
 *  the very copy kept. */
type Kept = { at: number; from: string; etag?: string; modified?: string; calendar: ReadCalendar; followed: string[] };
/** Each address's last read, by address: at most KEPT_MAX, the oldest read dropped first. */
const kept = new Map<string, Kept>();
const KEPT_MAX = 16;

/** Every kept read made stale, its parsed copy and validators kept: the next read of each revalidates (a test's, standing in
 *  for five minutes passing). */
export function staleCalendarsForTests(): void {
  for (const one of kept.values()) one.at = 0;
}
/** Every kept read forgotten (a test's). */
export function forgetCalendarsForTests(): void {
  kept.clear();
}

/** The calendar at `url`, parsed: the kept copy while it is fresh, else fetched (a 304 keeps the kept copy, the addresses
 *  this read was redirected to added to its own). */
export async function readCalendar(url: string, reach: CalendarReach = {}, network?: CalendarNetwork, signal?: AbortSignal): Promise<ReadCalendar> {
  const held = kept.get(url);
  if (held && Date.now() - held.at < FRESH_MS) return held.calendar;
  const followed: string[] = [];
  try {
    const answer = await fetchCalendar(url, reach, network, held, signal, followed);
    // A 304 only answers a read that sent the kept copy's validators (fetchCalendar), so `held` is there.
    if (answer.status === 304) {
      if (!held) throw new CalendarError(`${hostOf(url)} answered 304.`);
      held.at = Date.now();
      for (const one of followed) if (!held.followed.includes(one)) held.followed.push(one);
      return held.calendar;
    }
    const calendar = { ...parseCalendar(answer.body ?? "", hostOf(url)), followed };
    kept.delete(url);
    kept.set(url, { at: Date.now(), from: answer.from, ...(answer.etag ? { etag: answer.etag } : {}), ...(answer.modified ? { modified: answer.modified } : {}), calendar, followed });
    while (kept.size > KEPT_MAX) kept.delete(kept.keys().next().value!);
    return calendar;
  } catch (error) {
    // Words of the server's own, or the parser's, the address cut from them whatever they say.
    const said = error instanceof CalendarError ? error.message : `${hostOf(url)}'s calendar couldn't be read (${(error as Error)?.message ?? String(error)})`;
    throw new CalendarError(scrubAddress(said, [url, ...followed]));
  }
}

const hostOf = (url: string | URL) => (typeof url === "string" ? (URL.parse(url)?.host ?? "the calendar's host") : url.host);

/** `refused` (mcp-oauth.ts checked's words, which name the host alone) as a sentence. */
const refusal = (at: { refused: string; unresolved?: true }): string => {
  const said = `${at.refused.charAt(0).toUpperCase()}${at.refused.slice(1)}`;
  return at.unresolved ? `${said}: check the address saved with ${CALENDAR_SETTING}.` : `${said}.`;
};

/** An error's code (ECONNREFUSED, ENOTFOUND, CERT_HAS_EXPIRED), from it or its cause: never its message, which may name
 *  what was asked for. */
function codeOf(error: unknown): string | undefined {
  for (let at: unknown = error, depth = 0; at && depth < 4; at = (at as { cause?: unknown }).cause, depth += 1) {
    const code = (at as { code?: unknown }).code;
    if (typeof code === "string" && /^[A-Z][A-Z0-9_]{1,40}$/.test(code)) return code;
  }
  return undefined;
}

type Answer = { status: 200; body: string; from: string; etag?: string; modified?: string } | { status: 304; body?: undefined; etag?: string; modified?: string };

/** One fetch of `url`, following at most REDIRECTS_MAX redirects, each hop checked and its address added to `followed`;
 *  conditional on `held`'s validators at the address its body came from alone, so a redirect that now goes elsewhere is
 *  read in full there (another server's ETag may match by chance), and a 304 counts only from that address. */
async function fetchCalendar(url: string, reach: CalendarReach, given: CalendarNetwork | undefined, held: Kept | undefined, stop: AbortSignal | undefined, followed: string[]): Promise<Answer> {
  const signal = AbortSignal.any([AbortSignal.timeout(FETCH_TIMEOUT_MS), ...(stop ? [stop] : [])]);
  const { calendarAt, dialAt, systemNetwork } = await import("../mcp-oauth.js");
  const network = given ?? systemNetwork;
  let target = new URL(url);
  try {
    for (let hop = 0; ; hop += 1) {
      // Each hop under the one rule, dialled at the address it checked (undefined: loopback as written, a local install's).
      const at = await calendarAt(target, signal, network, reach);
      if ("refused" in at) throw new CalendarError(refusal(at));
      let res: Response | undefined;
      try {
        const headers: Record<string, string> = { accept: "text/calendar, text/plain;q=0.5, */*;q=0.1", "user-agent": "AgentRun-calendar/1" };
        const asking = held !== undefined && target.href === held.from;
        if (asking && held.etag) headers["if-none-match"] = held.etag;
        if (asking && held.modified) headers["if-modified-since"] = held.modified;
        res = await dialAt(network, at.address)(target.href, { redirect: "manual", signal, headers });
        const location = res.headers.get("location");
        if (res.status >= 300 && res.status < 400 && res.status !== 304 && location) {
          if (hop >= REDIRECTS_MAX) throw new CalendarError(`${hostOf(url)}'s calendar redirected more than ${REDIRECTS_MAX} times: check the address saved with ${CALENDAR_SETTING}.`);
          const next = URL.parse(location, target);
          if (!next) throw new CalendarError(`${target.host} redirected the calendar to an address that isn't one.`);
          target = next;
          if (target.href !== url && !followed.includes(target.href)) followed.push(target.href);
          continue;
        }
        const validators = { ...(res.headers.get("etag") ? { etag: res.headers.get("etag")! } : {}), ...(res.headers.get("last-modified") ? { modified: res.headers.get("last-modified")! } : {}) };
        if (res.status === 304 && asking) return { status: 304, etag: validators.etag ?? held.etag, modified: validators.modified ?? held.modified };
        if (res.status === 401 || res.status === 403 || res.status === 404 || res.status === 410) throw new CalendarError(`${target.host} answered ${res.status}: the address may be old or wrong; copy it again and save it with ${CALENDAR_SETTING}.`);
        if (res.status < 200 || res.status >= 300) throw new CalendarError(`${target.host} answered ${res.status}.`);
        return { status: 200, body: await bodyOf(res, target), from: target.href, ...validators };
      } finally {
        await res?.body?.cancel().catch(() => undefined);
      }
    }
  } catch (error) {
    if (error instanceof CalendarError) throw error;
    if (signal.aborted && !stop?.aborted) throw new CalendarError(`${target.host} didn't answer within ${FETCH_TIMEOUT_MS / 1000} s.`);
    if (stop?.aborted) throw new CalendarError("The read was stopped.");
    throw new CalendarError(`${target.host} couldn't be reached (${codeOf(error) ?? "the connection failed"}).`);
  }
}

/** A 2xx answer's body, as text, at most BODY_MAX_BYTES. */
async function bodyOf(res: Response, target: URL): Promise<string> {
  const stream = res.body;
  if (!stream) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (const reader = stream.getReader(); ; ) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > BODY_MAX_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new CalendarError(`${target.host}'s calendar is over ${BODY_MAX_BYTES / 1024 / 1024} MB: too big to read.`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}
