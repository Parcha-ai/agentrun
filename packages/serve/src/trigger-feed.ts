// The feed trigger: a source on a clock that polls (trigger-adapter.ts `poll`), as the email trigger is. Every every_s
// seconds (15 minutes by default), on a grid from the epoch, it reads each of its feeds (`urls`, 1 to 20: RSS, Atom, JSON
// Feed, or a JSON list such as GitHub's pulls API, read at its `items` and `id` pointers) through feed/fetch.ts, and each
// new or updated item is one firing through the path a pushed event takes (triggers.ts): its accept filter, a run per
// item, max_active_runs, its key kept for its day. Its payload is the item, untrusted.
//
// Its cursor is each feed's seen set, by URL, in the trigger's own settings (public: nothing secret), kept once the poll's
// firings are recorded, so a restart goes on from it. A feed with no seen set (the trigger made, turned on again, or an
// edit that adds its URL) takes its start at its first read: every item already there is seen, starts no run, and that
// is said. A seen set maps each item's key (its id, else its link, else a hash of its title and date) to the last
// `updated` it was read with: an item seen again with a later `updated` (a Statuspage incident's next status post) fires
// again with `update: true`; seen again unchanged, it fires nothing. A set keeps its last SEEN_KEPT keys, or twice its
// feed's length when that is more. An edit keeps the sets of the URLs it keeps and drops the others'.
//
// A poll takes at most POLL_TAKES items across its feeds, oldest first; the rest wait for the next (their feed read again
// in full, its validators dropped). A feed that hasn't changed answers 304 (its ETag and Last-Modified are kept with its
// set). A feed that can't be read is said in the trigger's check and tried at the next time; a 410, or a 404 three
// checks running, stops that feed alone (said in every check after), and the trigger turns off, in words, once every
// feed it reads has stopped. Turning it on again reads them all from the start.
import type { FeedItem, ParsedFeed } from "./feed/parse.js";
import type { FeedReach, Validators } from "./feed/fetch.js";
import { pointed } from "./feed/pointer.js";
import { ACCEPT_SCHEMA, acceptOf, acceptRefusal, type Rule } from "./trigger-accept.js";
import { closedSchema, PAYLOAD_KEPT_BYTES, type PolledEvent, type PollResult, type Source, type TriggerAdapter, unknownSourceFields } from "./trigger-adapter.js";
import { MAX_EVERY_S, MIN_EVERY_S } from "./trigger-schedule.js";
import { createHash } from "node:crypto";

/** The most items one poll takes, across its feeds: the rest wait for the next. */
export const POLL_TAKES = 20;
/** The most feeds one trigger reads. */
export const MAX_FEEDS = 20;
/** How often a feed is read by default, in seconds. */
export const DEFAULT_EVERY_S = 900;
/** The keys a feed's seen set keeps at least (twice its feed's length when that is more). */
export const SEEN_KEPT = 1000;
/** The 404s in a row that stop a feed. */
const MISSING_TO_STOP = 3;
/** The feeds read at once. */
const READ_AT_ONCE = 4;
/** The one event a feed trigger's accept names. */
const EVENT = "item";
/** The trigger's own settings: its cursor and its last check (the engine's), no secret (public). */
const CURSOR = "cursor";
const LAST_CHECK = "last_check";
const URL_CHARS = 2000;
const POINTER = /^(\/([^~]|~[01])*)?$/;
const POINTER_CHARS = 300;
/** The most fields a JSON list's `fields` keeps of each item. */
const MAX_FIELDS = 50;

type FeedSource = { kind: "feed"; urls: string[]; every_s: number; items?: string; id?: string; updated?: string; fields?: string[]; accept?: Rule[] };
/** One feed's state: `seen`, its seen set as [key hash, updated ms (null: none; a real date may be 0 or before)], oldest first, `dates` 2 once the set tells a missing date from a real one (a set without it holds 0 for a missing date) (absent: its start not taken
 *  yet); its last read's validators; its own title; `missing`, the 404s in a row; `stopped`, why it is no longer read. */
type FeedState = { seen?: [string, number | null][]; dates?: 2; etag?: string; modified?: string; title?: string; missing?: number; stopped?: string };
type Cursor = { feeds: Record<string, FeedState> };

/** The source's own fields, checked: each issue through `bad`. Undefined when one does not read. */
function fieldsOf(value: Record<string, unknown>, bad: (field: string, reason: string, message: string) => void): FeedSource | undefined {
  let failed = false;
  const fail = (field: string, reason: string, message: string) => ((failed = true), bad(field, reason, message));
  const urls = value.urls;
  const rule = `urls is a list of 1 to ${MAX_FEEDS} feed URLs, each http or https, none twice`;
  if (!Array.isArray(urls)) fail("urls", urls === undefined ? "missing" : "wrong_type", rule);
  else if (urls.length < 1 || urls.length > MAX_FEEDS) fail("urls", "invalid", rule);
  else {
    const seen = new Set<string>();
    urls.forEach((url, i) => {
      const why = urlProblem(url);
      if (why) fail(`urls[${i}]`, "invalid", why);
      else if (seen.has(url as string)) fail(`urls[${i}]`, "duplicate", `urls[${i}] is ${url as string} again: each feed is read once`);
      else seen.add(url as string);
    });
  }
  const every = value.every_s ?? DEFAULT_EVERY_S;
  if (!Number.isSafeInteger(every) || (every as number) < MIN_EVERY_S || (every as number) > MAX_EVERY_S) fail("every_s", "invalid", `every_s is a whole number of seconds, ${MIN_EVERY_S} to ${MAX_EVERY_S}`);
  for (const name of ["items", "id", "updated"] as const) {
    const pointer = value[name];
    if (pointer === undefined) continue;
    const whole = name === "items";
    if (typeof pointer !== "string" || pointer.length > POINTER_CHARS || !POINTER.test(pointer) || (!whole && !pointer)) {
      if (name === "updated") fail(name, "invalid", "updated is a JSON Pointer into a JSON list's item to the date it last changed (/updated_at): for a feed that is a JSON list");
      else fail(name, "invalid", whole ? `items is a JSON Pointer to a JSON list's array of items ("" for the whole document, /data/items): for a feed that is a JSON list` : `id is a JSON Pointer into a JSON list's item to its id (/id, /number): for a feed that is a JSON list`);
    }
  }
  const fields = value.fields;
  if (fields !== undefined && (!Array.isArray(fields) || fields.length < 1 || fields.length > MAX_FIELDS || fields.some((one) => typeof one !== "string" || !one || one.length > POINTER_CHARS || !POINTER.test(one)))) {
    fail("fields", "invalid", `fields is a list of 1 to ${MAX_FIELDS} JSON Pointers into a JSON list's item (/number, /user/login): the payload's item keeps only these, for a feed that is a JSON list`);
  }
  const accept = value.accept === undefined ? undefined : acceptOf(value.accept, fail);
  accept?.forEach((rule, i) => {
    if (rule.event !== EVENT) fail(`accept[${i}].event`, "not_an_option", `A feed trigger's one event is "${EVENT}"`);
    if (rule.actions !== undefined) fail(`accept[${i}].actions`, "not_allowed", "A feed item has no action: take it by its fields with where");
  });
  if (failed) return undefined;
  return { kind: "feed", urls: urls as string[], every_s: every as number, ...(value.items !== undefined ? { items: value.items as string } : {}), ...(value.id !== undefined ? { id: value.id as string } : {}), ...(value.updated !== undefined ? { updated: value.updated as string } : {}), ...(value.fields !== undefined ? { fields: value.fields as string[] } : {}), ...(accept ? { accept } : {}) };
}

/** Why `url` is no feed URL a trigger reads, or undefined: an http(s) URL, with no user or password in it. */
export function urlProblem(url: unknown): string | undefined {
  const words = "a feed URL is http or https, with no user or password in it";
  if (typeof url !== "string" || !url || url.length > URL_CHARS) return `${words}, at most ${URL_CHARS} characters`;
  const at = URL.parse(url);
  if (!at || (at.protocol !== "http:" && at.protocol !== "https:") || !at.hostname) return `${words}: ${url.slice(0, 200)} is not`;
  if (at.username || at.password) return `${words}: ${at.host}'s holds one`;
  return undefined;
}

/** The cursor kept, when it reads; else none (every feed starts). */
function cursorOf(text: string | undefined): Cursor {
  if (!text) return { feeds: {} };
  try {
    const value = JSON.parse(text) as Cursor;
    return value && typeof value.feeds === "object" && value.feeds !== null && !Array.isArray(value.feeds) ? value : { feeds: {} };
  } catch {
    return { feeds: {} };
  }
}

const hashed = (key: string) => createHash("sha256").update(key).digest("hex").slice(0, 16);
const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());
const itemsWord = (n: number) => `${n} item${n === 1 ? "" : "s"}`;

/** What one feed's read came to. */
type Read =
  | { url: string; ok: true; changed: false }
  | { url: string; ok: true; changed: true; feed: ParsedFeed; validators: Validators }
  | { url: string; ok: false; problem: string; status?: number };

/** `url` read on `reach` from its state's validators: its items, a 304, or what went wrong, in words. */
async function readOne(url: string, state: FeedState | undefined, source: FeedSource, reach: FeedReach): Promise<Read> {
  const [{ readFeed, FeedRefused, FeedUnreachable }, { parseFeed, FeedUnreadable }] = await Promise.all([import("./feed/fetch.js"), import("./feed/parse.js")]);
  // A feed with no seen set yet is read whole: its start is every item there now.
  const last = state?.seen ? { ...(state.etag ? { etag: state.etag } : {}), ...(state.modified ? { modified: state.modified } : {}) } : {};
  try {
    const read = await readFeed(url, last, reach);
    if (read.status === 304) return { url, ok: true, changed: false };
    if (!("body" in read)) return { url, ok: false, status: read.status, problem: `Couldn't read ${url}: HTTP ${read.status}.` };
    try {
      const feed = parseFeed(read.body, { ...(source.items !== undefined ? { items: source.items } : {}), ...(source.id !== undefined ? { id: source.id } : {}), ...(source.updated !== undefined ? { updated: source.updated } : {}) });
      return { url, ok: true, changed: true, feed, validators: { ...(read.etag ? { etag: read.etag } : {}), ...(read.modified ? { modified: read.modified } : {}) } };
    } catch (error) {
      if (!(error instanceof FeedUnreadable)) throw error;
      return { url, ok: false, status: 200, problem: `Couldn't read ${url}: ${error.message}.` };
    }
  } catch (error) {
    if (error instanceof FeedUnreachable) return { url, ok: false, problem: `Couldn't reach ${url}: ${error.message}.` };
    if (error instanceof FeedRefused) return { url, ok: false, problem: `Couldn't read ${url}: ${error.message}.` };
    return { url, ok: false, problem: `Couldn't read ${url}: ${String((error as Error)?.message ?? error).slice(0, 300)}.` };
  }
}

/** `work` over `items`, at most `n` at once, in their order. */
async function pooled<T, R>(items: readonly T[], n: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    for (let i = next++; i < items.length; i = next++) out[i] = await work(items[i]!);
  }));
  return out;
}

/** `state`'s seen set as a map, a missing date null. A set saved before dates were told apart (no \`dates\`) holds 0 for one:
 *  read as missing for a JSON list, whose items had no dates then; an RSS, Atom or JSON Feed item's 0 stays a number. */
const seenOf = (state: FeedState, list: boolean): Map<string, number | null> => new Map((state.seen ?? []).map(([key, at]) => [key, at === 0 && list && state.dates !== 2 ? null : at] as const));

/** An item that may fire: its feed, the item, whether it updates one seen before, and its date for the order. */
type Candidate = { url: string; item: FeedItem; update: boolean; at: number | null; n: number };

/** One feed's items, oldest first: as it serves them reversed (a feed lists newest first), then by date when every one
 *  has one. Each key once (its first, the newest). */
function oldestFirst(items: readonly FeedItem[]): FeedItem[] {
  const once = new Map<string, FeedItem>();
  for (const item of items) if (!once.has(item.key)) once.set(item.key, item);
  const reversed = [...once.values()].reverse();
  const dated = (item: FeedItem) => item.updated ?? item.published;
  return reversed.every((item) => dated(item) !== null) ? reversed.sort((a, b) => dated(a)! - dated(b)!) : reversed;
}

/** The payload an item fires with, within PAYLOAD_KEPT_BYTES: a JSON list's {id, link, title, item, update}, its raw item
 *  cut shallower until it fits; any other's {id, link, title, published, updated, author, summary, categories, feed,
 *  update}, its summary cut until it fits. */
function payloadOf(c: Candidate, list: boolean, title: string | null, fields?: readonly string[]): Record<string, unknown> {
  const { item, update } = c;
  if (list) {
    // `fields`, when the source names some, keep only those of the item, before the cap.
    const raw = fields ? keeping(item.raw, fields) : item.raw;
    const whole = { id: item.id, link: item.link, title: item.title, item: raw, update };
    if (fits(whole)) return whole;
    for (const [depth, chars] of [[3, 2000], [3, 300], [2, 2000], [2, 300], [1, 300], [1, 100]] as const) {
      const cut = { ...whole, item: shallow(raw, depth, chars), item_truncated: true };
      if (fits(cut)) return cut;
    }
    return { id: item.id, link: item.link, title: item.title?.slice(0, 300) ?? null, item: null, item_truncated: true, update };
  }
  const whole = { id: item.id, link: item.link, title: item.title, published: iso(item.published), updated: iso(item.updated), author: item.author, summary: item.summary, categories: item.categories, feed: { title, url: c.url }, update };
  if (fits(whole)) return whole;
  for (const chars of [1000, 300]) {
    const cut = { ...whole, id: clipped(item.id, chars), link: clipped(item.link, chars), title: clipped(item.title, chars), author: clipped(item.author, chars), summary: clipped(item.summary, chars), categories: item.categories.slice(0, 10).map((one) => clipped(one, 100)), feed: { title: clipped(title, 200), url: c.url } };
    if (fits(cut)) return cut;
  }
  return { id: clipped(item.id, 200), link: clipped(item.link, 200), title: clipped(item.title, 200), published: iso(item.published), updated: iso(item.updated), author: null, summary: null, categories: [], feed: { title: null, url: c.url }, update };
}
/** `raw` with only the values at `pointers` kept, each at its own place (a list's kept entries compacted). Every
 *  container is built bare and every key set as an own property, so no name (\`__proto__\` too) reaches a prototype; only
 *  own keys of the item are read. */
function keeping(raw: unknown, pointers: readonly string[]): unknown {
  const bare = (like: unknown): Record<string, unknown> | unknown[] => (Array.isArray(like) ? [] : Object.create(null));
  const own = (from: unknown, key: string): unknown => (from !== null && typeof from === "object" && Object.hasOwn(from, key) ? (from as Record<string, unknown>)[key] : undefined);
  const out = bare(raw);
  for (const pointer of pointers) {
    const value = pointed(raw, pointer);
    if (value === undefined) continue;
    const keys = pointer.split("/").slice(1).map((part) => part.replace(/~1/g, "/").replace(/~0/g, "~"));
    let from: unknown = raw;
    let into: Record<string, unknown> | unknown[] = out;
    keys.forEach((key, i) => {
      const source = own(from, key);
      if (i === keys.length - 1) Object.defineProperty(into, key, { value, enumerable: true, writable: true, configurable: true });
      else {
        if (!Object.hasOwn(into, key)) Object.defineProperty(into, key, { value: bare(source), enumerable: true, writable: true, configurable: true });
        into = (into as Record<string, unknown>)[key] as Record<string, unknown> | unknown[];
      }
      from = source;
    });
  }
  const dense = (value: unknown): unknown => (Array.isArray(value) ? value.filter(() => true).map(dense) : value !== null && typeof value === "object" ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, dense(v)])) : value);
  return dense(out);
}
const fits = (value: unknown) => Buffer.byteLength(JSON.stringify(value), "utf8") <= PAYLOAD_KEPT_BYTES;
const clipped = (text: string | null, n: number) => (text !== null && text.length > n ? `${text.slice(0, n - 1)}…` : text);
/** `value` with its objects and lists `depth` deep (deeper ones dropped), a list's first 20, its strings `chars` long. */
function shallow(value: unknown, depth: number, chars: number): unknown {
  if (typeof value === "string") return clipped(value, chars);
  if (value === null || typeof value !== "object") return value;
  if (depth <= 0) return undefined;
  if (Array.isArray(value)) return value.slice(0, 20).map((one) => shallow(one, depth - 1, chars)).filter((one) => one !== undefined);
  return Object.fromEntries(Object.entries(value).map(([key, one]) => [key, shallow(one, depth - 1, chars)] as const).filter(([, one]) => one !== undefined));
}

/** One poll of `source`'s feeds from `cursor`. */
async function poll(source: FeedSource, reach: FeedReach, cursor: Cursor): Promise<PollResult> {
  // Each feed the source reads now, with the state it had (none for one an edit added); a removed one's goes.
  const states: Record<string, FeedState> = Object.fromEntries(source.urls.flatMap((url) => (cursor.feeds[url] ? [[url, { ...cursor.feeds[url] }]] : [])));
  const live = source.urls.filter((url) => !states[url]?.stopped);
  const reads = await pooled(live, READ_AT_ONCE, (url) => readOne(url, states[url], source, reach));
  const problems: string[] = [];
  const started: { url: string; count: number }[] = [];
  const candidates: Candidate[][] = [];
  /** Each feed read and parsed: its items oldest first, for its seen set. */
  const present = new Map<string, FeedItem[]>();
  const lists = new Map<string, boolean>();
  for (const read of reads) {
    const state = (states[read.url] ??= {});
    if (!read.ok) {
      state.missing = read.status === 404 ? (state.missing ?? 0) + 1 : 0;
      if (read.status === 410) state.stopped = "is gone (HTTP 410)";
      else if (read.status === 404 && state.missing >= MISSING_TO_STOP) state.stopped = `answered HTTP 404 ${MISSING_TO_STOP} checks running`;
      if (!state.stopped) problems.push(read.problem);
      continue;
    }
    state.missing = 0;
    if (!read.changed) continue;
    const { feed, validators } = read;
    if (feed.title) state.title = feed.title;
    delete state.etag;
    delete state.modified;
    Object.assign(state, validators);
    const items = oldestFirst(feed.items);
    lists.set(read.url, feed.list);
    if (!state.seen) {
      // Its start: every item there now is seen, and starts nothing.
      state.seen = items.map((item) => [hashed(item.key), item.updated]);
      state.dates = 2;
      started.push({ url: read.url, count: items.length });
      continue;
    }
    present.set(read.url, items);
    const seen = seenOf(state, feed.list);
    const fresh: Candidate[] = [];
    for (const item of items) {
      const was = seen.get(hashed(item.key));
      if (was === undefined) fresh.push({ url: read.url, item, update: false, at: item.updated ?? item.published, n: 0 });
      else if (item.updated !== null && (was === null ? !feed.list : item.updated > was)) fresh.push({ url: read.url, item, update: true, at: item.updated, n: 0 });
    }
    candidates.push(fresh);
  }
  // The oldest POLL_TAKES across the feeds: each feed's in its order, the oldest head first (one with no date at once).
  const taken: Candidate[] = [];
  const heads = candidates.map(() => 0);
  while (taken.length < POLL_TAKES) {
    let pick = -1;
    for (let i = 0; i < candidates.length; i++) {
      const head = candidates[i]![heads[i]!];
      if (!head) continue;
      const best = pick < 0 ? undefined : candidates[pick]![heads[pick]!]!;
      if (!best || (head.at ?? -Infinity) < (best.at ?? -Infinity)) pick = i;
    }
    if (pick < 0) break;
    taken.push({ ...candidates[pick]![heads[pick]!]!, n: taken.length });
    heads[pick]!++;
  }
  const waiting = candidates.flat().length - taken.length;
  // The feeds with an item not taken this poll: read whole at the next.
  const left = new Set(candidates.flatMap((list, i) => list.slice(heads[i]).map((c) => c.url)));
  const marks = new Map(taken.map((c) => [`${c.url}\n${c.item.key}`, c]));

  /** The cursor once the first `upTo` items taken are recorded: each feed's seen set with them marked, the items it
   *  serves now moved to its end, trimmed; a feed with an item not marked yet keeps no validators, so its next read is
   *  whole. An item new to its feed and not marked is not in its set; one updated and not marked keeps its last time. */
  const cursorAfter = (upTo: number): Record<string, string> => {
    const feeds: Record<string, FeedState> = {};
    for (const url of source.urls) {
      const state = states[url];
      if (!state) continue;
      const items = present.get(url);
      if (!items || !state.seen) {
        feeds[url] = state;
        continue;
      }
      const list = lists.get(url) ?? false;
      const seen = seenOf(state, list);
      for (const item of items) {
        const key = hashed(item.key);
        const was = seen.get(key);
        const mark = marks.get(`${url}\n${item.key}`);
        seen.delete(key);
        if (mark && mark.n < upTo) seen.set(key, item.updated);
        // A JSON list's item first seen with no date takes the one it gains, fired on never.
        else if (was !== undefined) seen.set(key, was === null && list ? item.updated : was);
      }
      const whole = !left.has(url) && !taken.slice(upTo).some((c) => c.url === url);
      const { etag, modified, ...rest } = state;
      feeds[url] = { ...rest, dates: 2, ...(whole && etag ? { etag } : {}), ...(whole && modified ? { modified } : {}), seen: [...seen.entries()].slice(-Math.max(SEEN_KEPT, 2 * items.length)) };
    }
    return { [CURSOR]: JSON.stringify({ feeds }) };
  };

  const name = (url: string) => states[url]?.title ?? url;
  const named = (urls: readonly string[]) => (urls.length === 1 ? name(urls[0]!) : `${urls.length} feeds`);
  const events: PolledEvent[] = taken.map((c) => {
    const body = payloadOf(c, lists.get(c.url) ?? false, states[c.url]?.title ?? null, source.fields);
    const key = `${c.url}\n${c.item.key}${c.item.updated !== null ? `\n${iso(c.item.updated)}` : ""}`;
    // Its cursor made only when the engine asks for it (the last event it records, when the poll is cut short): never one
    // whole cursor per item taken.
    return { key, text: JSON.stringify(body), attrs: { title: (c.item.title ?? c.item.link ?? c.item.key).slice(0, 200), feed: c.url }, event: EVENT, body, get cursor() { return cursorAfter(c.n + 1); } };
  });
  const stopped = source.urls.filter((url) => states[url]?.stopped);
  const said = stopped.map((url) => `${url} ${states[url]!.stopped}: it is no longer read; edit the trigger's urls to drop or fix it.`);
  const parts: string[] = [];
  if (started.length) parts.push(`Watching ${named(started.map((s) => s.url))}.`);
  const okUrls = reads.filter((r) => r.ok && !started.some((s) => s.url === r.url)).map((r) => r.url);
  if (okUrls.length) parts.push(`Read ${named(okUrls)}: ${taken.length} new${waiting > 0 ? `, ${waiting} more at the next check` : ""}.`);
  const note = started.length ? (() => {
    const count = started.reduce((sum, s) => sum + s.count, 0);
    const which = named(started.map((s) => s.url));
    return count ? `Watching ${which} from now: the ${itemsWord(count)} already there won't start runs.` : `Watching ${which} from now: ${started.length === 1 ? "it holds" : "they hold"} no items yet.`;
  })() : undefined;
  const result: PollResult = {
    check: { ok: !problems.length && !stopped.length, message: [...parts, ...problems, ...said].join(" ") || "Read nothing." },
    ...(note ? { note } : {}),
    ...(events.length ? { events } : {}),
    cursor: cursorAfter(taken.length),
  };
  if (stopped.length === source.urls.length) {
    result.stop = { detail: `Every feed it reads has stopped: ${stopped.map((url) => `${url} ${states[url]!.stopped}`).join("; ")}. Edit its urls, then turn it on again.` };
  }
  return result;
}

export const feed: TriggerAdapter = {
  id: "feed",
  label: "feed trigger",
  delivery: "clock",
  owner: false,
  settings: { scope: "trigger", fields: { [CURSOR]: { public: true }, [LAST_CHECK]: { public: true } } },
  describe: `{kind: "feed", urls: ["https://..."], every_s?: ${DEFAULT_EVERY_S}, items?: "/data/items", id?: "/id", updated?: "/updated_at", fields?: ["/number", "/title"], accept?: [{event: "${EVENT}", where?}]}`,
  fires: "each new or updated item in its feeds (`feed`: RSS, Atom, JSON Feed or a JSON list), read every every_s seconds, that its `accept` takes",
  firedBy: "`feed`: an item new to one of its feeds, or one seen before with a later updated time, its key from the trigger, the feed's URL, the item's key and its updated time.",
  schemas: [
    closedSchema(
      { kind: { const: "feed" }, urls: { type: "array", minItems: 1, maxItems: MAX_FEEDS, uniqueItems: true, items: { type: "string", minLength: 1, maxLength: URL_CHARS, pattern: "^[Hh][Tt][Tt][Pp][Ss]?://" }, description: `The feeds it reads, 1 to ${MAX_FEEDS}, each an http or https URL: RSS, Atom, JSON Feed, or a JSON list (an API's array of objects). Plain http is read on a public address alone.` } },
      {
        every_s: { type: "integer", minimum: MIN_EVERY_S, maximum: MAX_EVERY_S, default: DEFAULT_EVERY_S, description: "How often it reads its feeds, in seconds, on a grid from the epoch." },
        items: { type: "string", maxLength: POINTER_CHARS, pattern: "^(/([^~]|~[01])*)?$", description: "For a JSON list: a JSON Pointer to its array of items. Absent: the whole document." },
        id: { type: "string", minLength: 1, maxLength: POINTER_CHARS, pattern: "^/([^~]|~[01])*$", description: "For a JSON list: a JSON Pointer into each item to its id. Absent: /id." },
        updated: { type: "string", minLength: 1, maxLength: POINTER_CHARS, pattern: "^/([^~]|~[01])*$", description: "For a JSON list: a JSON Pointer into each item to the date it last changed (/updated_at). An item whose date moves on fires again with update: true. Absent: a JSON list's item fires once." },
        fields: { type: "array", minItems: 1, maxItems: MAX_FIELDS, items: { type: "string", minLength: 1, maxLength: POINTER_CHARS, pattern: "^/([^~]|~[01])*$" }, description: "For a JSON list: JSON Pointers into each item; the payload's item keeps only these, each at its own place, before the payload's size cap (a pull request that is large whole fits). Absent: the whole item, cut shallower when it is over the cap." },
        accept: { ...ACCEPT_SCHEMA, description: `The items that start a run: each rule's event is "${EVENT}", its where reads the payload (/title, /link, /feed/url; a JSON list's /item/...). None: every item.` },
      },
    ),
  ],
  sent: [
    closedSchema(
      { kind: { const: "feed" }, urls: { type: "array", minItems: 1, maxItems: MAX_FEEDS, items: { type: "string" } }, every_s: { type: "integer", minimum: MIN_EVERY_S, maximum: MAX_EVERY_S } },
      { items: { type: "string" }, id: { type: "string" }, updated: { type: "string" }, fields: { type: "array", items: { type: "string" } }, accept: ACCEPT_SCHEMA },
    ),
  ],
  parse(value, _now, bad, issues) {
    issues.push(...unknownSourceFields(value, ["kind", "urls", "every_s", "items", "id", "updated", "fields", "accept"]));
    return fieldsOf(value, bad);
  },
  wellFormed: (source) => fieldsOf(source, () => {}) !== undefined,
  clock(source: Source) {
    const step = (source.every_s as number) * 1000;
    return { next: (after) => (Math.floor(after / step) + 1) * step, latest: (first, now) => first + Math.floor((now - first) / step) * step, step };
  },
  problem: (source) => (typeof source.every_s === "number" && (source.every_s < MIN_EVERY_S || source.every_s > MAX_EVERY_S) ? `every_s ${source.every_s} is not ${MIN_EVERY_S} to ${MAX_EVERY_S} seconds` : undefined),
  // Each item is its own work: a run per item, max_active_runs bounding how many at once.
  concurrent: () => true,
  takes: (source, event) => {
    const rules = source.accept as Rule[] | undefined;
    return rules ? acceptRefusal(rules, event.event, event.body) : undefined;
  },
  async poll(source, ctx) {
    const reach = (await ctx.credentials()) as FeedReach | undefined;
    if (!reach) return { check: { ok: false, message: "This server reads no feeds." } };
    return poll(source as FeedSource, reach, cursorOf(ctx.setting(CURSOR)));
  },
  title: (attrs) => attrs.title,
};
