// Every session under a home, as totals: what each used, its subagents' requests with it, and what it cost. A session is
// one per source and id, however many files write it (a Codex thread resumed in a new file, a Claude Code session copied
// into a resumed one's); a subagent's is no session of its own but its parent's.
import { createHash } from "node:crypto";
import { relative, sep } from "node:path";
import { type CalculateCost, type Catalog, builtinCatalog, type Priced, priceRequests } from "./price.js";
import { childrenOf, inOrder, type Readers, readerOf, sessionLocators } from "./read.js";
import { type Env, type Locator, locatorKey, type SessionRead } from "./reader.js";
import { READERS, SOURCES, type Source } from "./readers/index.js";
import { addAll, addRecord, dropOwner, locatorNumber, ownerOf, type RecordIndex, recordIndex } from "./record-index.js";
import { packed, packInto } from "./record-key.js";
import type { Usage } from "./types.js";
import { addTokens, noTokens, type Tokens } from "./usage.js";

export type SessionTotals = {
  /** The sha256 (hex) of the session's first file's path relative to the home, with "/" between its parts, and
   *  `#<session id>` after it for a file that holds many sessions (its locator names the id). */
  key: string;
  /** That path. */
  file: string;
  source: string;
  /** The source's own id for the session. */
  id: string;
  /** Its requests' tokens, its subagents' with them. */
  tokens: Tokens;
  /** Of `tokens.output`, the part spent reasoning, where the source says (0 where it does not). */
  reasoning: number;
  /** USD: the source's own cost when it wrote one, else its requests' (its subagents' with them) at the catalog's list
   *  prices; null when neither is known. */
  cost: number | null;
  /** The person's turns: the session's user messages (a subagent's prompts are its parent agent's, not counted). */
  turns: number;
  /** Model requests, its subagents' with them, each once. */
  calls: number;
  /** The subagents' sessions counted in it. */
  subagents: number;
};

/** What parseHome keeps between passes, when handed one: each locator's cursor (its reader's own), the records each
 *  source has read with the locator that read each first, and which locators found a record another read first, so a
 *  second pass reads only what was written since. It holds no session text (its reads are turns: false: counts, ids and
 *  paths alone), so it can be kept with v8.serialize. Its contents are the package's; `read` is the last pass's bytes. */
export type HomeState = { read?: number; sources?: Partial<Record<string, SourceState>> };

/** One source's part of a HomeState. */
type SourceState = {
  cursors: Map<string, unknown>;
  /** Each record read (the reader's "u:"/"m:" keys, packed: packInto), with the locator (locatorKey) that read it first: the one it counts in. */
  owners: RecordIndex;
  /** For each locator, the locators whose records it found already read (its copies' owners). */
  copied: Map<string, Set<string>>;
};

export type ParseOptions = {
  /** The sources to read (default: every registered one). */
  sources?: readonly (Source | (string & {}))[];
  /** The readers to read them with (default: the registry's). */
  readers?: Readers;
  /** Kept across calls: a pass goes on from where the last one stopped (see HomeState). */
  state?: HomeState;
  /** The catalog to price requests with; false prices none (cost is then the source's own or null). Default: pi-ai's. */
  catalog?: Catalog | false;
  /** pi-ai's calculateCost, when the caller imported pi-ai itself (the CLI); else priceRequests loads it. */
  calculateCost?: CalculateCost;
  /** Where the readers look for a source's own directory (CLAUDE_CONFIG_DIR, CODEX_HOME). Default: none, the home's. */
  env?: Env;
  /** Where each locator its reader could not read goes (unopenable, an I/O error midway); the rest are totalled. Without
   *  it, parseHome throws ReadFailures instead: an unreadable file is never taken for an empty one. */
  failures?: ReadFailure[];
};

/** A locator its reader could not read: its key (as SessionTotals'), its file, and the reader's error. */
export type ReadFailure = { key: string; file: string; source: string; error: unknown };

/** What parseHome throws when a locator could not be read and the caller took no failures list. Its message names no
 *  path; `failures` holds them. */
export class ReadFailures extends Error {
  constructor(readonly failures: ReadFailure[]) {
    super(`${failures.length} session ${failures.length === 1 ? "file" : "files"} could not be read`);
    this.name = "ReadFailures";
  }
}

/** A session's key: the sha256 of its file's path relative to the home, "/" between its parts, `#<id>` after it when its
 *  locator names one. */
const keyOf = (home: string, { file, id }: Locator): { key: string; file: string } => {
  const path = relative(home, file).split(sep).join("/");
  return { key: createHash("sha256").update(id === undefined ? path : `${path}#${id}`).digest("hex"), file: path };
};

/** What a total takes of one session a read found, and no more: its session's counts and ids, and each request's model
 *  and tokens, packed. A whole SessionRead holds every request as objects (its calls, uuids, key, effort); a source of
 *  millions of requests held so until its totals are taken outgrows the heap. */
type Compact = {
  session: Pick<SessionRead["session"], "id" | "child" | "parent" | "users" | "copies" | "costUsd" | "model">;
  /** Each request's model (its own, else the session's), as its index in the pass's Models; -1 for none. */
  models: Int32Array;
  /** Each request's tokens, USAGE_FIELDS numbers a request, in order; HAS_* says which it has. */
  usage: Float64Array;
  /** Each request's HAS_* bits. */
  has: Uint8Array;
};

const USAGE_FIELDS = 6;
const HAS_USAGE = 1;
const HAS_LONG = 2;
const HAS_REASONING = 4;

/** Each model string once, by index: a request names its model as an index into it. */
type Models = { names: string[]; index: Map<string, number> };

/** `read` as a total takes it (Compact), each request's model the one totalsOf prices it at. */
function compact(read: SessionRead, models: Models): Compact {
  const { id, child, parent, users, copies, costUsd, model } = read.session;
  const n = read.requests.length;
  const out: Compact = { session: { id, child, users, copies, ...(parent !== undefined ? { parent } : {}), ...(costUsd !== undefined ? { costUsd } : {}), ...(model !== undefined ? { model } : {}) }, models: new Int32Array(n), usage: new Float64Array(n * USAGE_FIELDS), has: new Uint8Array(n) };
  for (let i = 0; i < n; i += 1) {
    const request = read.requests[i]!;
    const name = request.model ?? model;
    let at = -1;
    if (name !== undefined) {
      at = models.index.get(name) ?? -1;
      if (at === -1) models.index.set(name, (at = models.names.push(name) - 1));
    }
    out.models[i] = at;
    const { usage } = request;
    if (!usage) continue;
    const o = i * USAGE_FIELDS;
    out.usage[o] = usage.input;
    out.usage[o + 1] = usage.output;
    out.usage[o + 2] = usage.cacheRead;
    out.usage[o + 3] = usage.cacheWrite;
    let has = HAS_USAGE;
    if (usage.cacheWrite1h !== undefined) {
      out.usage[o + 4] = usage.cacheWrite1h;
      has |= HAS_LONG;
    }
    if (usage.reasoning !== undefined) {
      out.usage[o + 5] = usage.reasoning;
      has |= HAS_REASONING;
    }
    out.has[i] = has;
  }
  return out;
}

/** The i-th request of `read` as priceRequests takes it. */
function requestAt(read: Compact, i: number, models: Models): Priced {
  const at = read.models[i]!;
  const model = at === -1 ? undefined : models.names[at];
  const has = read.has[i]!;
  if (!(has & HAS_USAGE)) return { model, usage: undefined };
  const o = i * USAGE_FIELDS;
  const usage: Usage = { input: read.usage[o]!, output: read.usage[o + 1]!, cacheRead: read.usage[o + 2]!, cacheWrite: read.usage[o + 3]! };
  if (has & HAS_LONG) usage.cacheWrite1h = read.usage[o + 4]!;
  if (has & HAS_REASONING) usage.reasoning = read.usage[o + 5]!;
  return { model, usage };
}

type Part = { locator: Locator; read: Compact };

/** Every session of `sources` under `home`, as totals, sorted by key. */
export async function parseHome(home: string, { sources = SOURCES, readers = READERS, state, catalog, calculateCost, env, failures }: ParseOptions = {}): Promise<SessionTotals[]> {
  let prices: Promise<Catalog | undefined> | undefined;
  const priceWith = () => (catalog === false ? Promise.resolve(undefined) : catalog ? Promise.resolve(catalog) : (prices ??= builtinCatalog()));
  const out: SessionTotals[] = [];
  const failed: ReadFailure[] = [];
  if (state) state.read = 0;
  for (const source of sources) {
    const models: Models = { names: [], index: new Map() };
    const { tops, children, unread } = await readSource(home, source, readers, env, state, models);
    out.push(...(await totalsOf(home, source, tops, children, models, priceWith, calculateCost)));
    failed.push(...unread.map(({ locator, error }) => ({ key: keyOf(home, locator).key, file: locator.file, source, error })));
  }
  if (failed.length && !failures) throw new ReadFailures(failed);
  failures?.push(...failed);
  return out.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

/** `source`'s locators read in the import's order, sessions first, then the subagents beside them, through one `seen`.
 *  A pass handed a state goes on from its cursors, and comes out as a fresh pass would: a record copied into many files
 *  counts in the first of them in the order as it is now. The whole source is read again when a locator it read before is
 *  gone, when its reader could not go on from its cursor (a new inode, truncated, rewritten), or when a locator holding a
 *  copy now comes before the one its record counts in (an append moved an older file after its resumed copy, a new file
 *  sorts before one it shares records with). A change of order among locators that share no record reads nothing again. */
async function readSource(home: string, source: string, readers: Readers, env: Env | undefined, state: HomeState | undefined, models: Models): Promise<{ tops: Part[]; children: (Part & { of: Locator })[]; unread: { locator: Locator; error: unknown }[] }> {
  const reader = readerOf(source, readers);
  const listed = await inOrder(await sessionLocators(home, source, { ...(env ? { env } : {}), readers }), source, readers);
  const childList = await childrenOf(home, source, { ...(env ? { env } : {}), readers });
  // Each locator's place in this pass's order of reading.
  const place = new Map([...listed.map(({ locator }) => locatorKey(locator)), ...childList.map(({ locator }) => locatorKey(locator))].map((key, at) => [key, at]));
  // Whether a locator holds a copy of a record that now counts after it: the fresh pass would count it in that locator.
  const outOfOrder = (kept: SourceState) => [...kept.copied].some(([key, owners]) => [...owners].some((owner) => place.get(owner)! > place.get(key)!));
  for (let pass = 0; ; pass += 1) {
    let kept = state ? (state.sources ??= {})[source] : undefined;
    if (kept && ([...kept.cursors.keys()].some((key) => !place.has(key)) || outOfOrder(kept))) kept = undefined;
    if (state && !kept) kept = state.sources![source] = { cursors: new Map(), owners: recordIndex(), copied: new Map() };
    const { owners, copied } = kept ?? { owners: recordIndex(), copied: new Map<string, Set<string>>() };
    let restarted = false;
    const unread: { locator: Locator; error: unknown }[] = [];
    const read = async (locator: Locator): Promise<SessionRead[]> => {
      const key = locatorKey(locator);
      const cursor = kept?.cursors.get(key);
      // The records read so far, as the reader asks for them, each new one this locator's, each found one noted. Both are
      // staged and kept only when the read succeeds: a read that fails partway leaves no record owned that no cursor
      // holds, which a retry would take for a copy.
      // Records are held by their packed keys (packInto): a reader asks has, then add, of one record, packed once.
      const me = locatorNumber(owners, key);
      const mine = recordIndex(64);
      const found = new Set<string>();
      let asked: string | undefined;
      const at = packed();
      const pack = (record: string) => (record === asked ? at : ((asked = record), packInto(record, at)));
      const seen = {
        has: (record: string) => {
          pack(record);
          let owner = ownerOf(owners, at);
          if (owner === -1) owner = ownerOf(mine, at);
          if (owner === -1) return false;
          if (owner !== me) found.add(owners.locators[owner]!);
          return true;
        },
        add(record: string) {
          pack(record);
          if (ownerOf(owners, at) === -1) addRecord(mine, at, me);
          return this;
        },
      } as Set<string>;
      const result = await reader.read(locator, cursor, { turns: false, seen }).catch((error: unknown) => void unread.push({ locator, error }));
      if (!result) {
        // A locator read before that cannot be read now gives up its cursor and the records it held, as a fresh pass
        // would hold none of them: the next pass reads it from its start. A locator that found them already read (a
        // copy) skipped them, though the fresh pass counts them there: the source is read again.
        if (kept && cursor !== undefined) {
          kept.cursors.delete(key);
          dropOwner(owners, me);
          copied.delete(key);
          if ([...copied.values()].some((owners) => owners.has(key))) restarted = true;
        }
        return [];
      }
      addAll(owners, mine);
      if (found.size) for (const owner of found) (copied.get(key) ?? copied.set(key, new Set()).get(key)!).add(owner);
      if (cursor !== undefined && !result.resumed) restarted = true;
      if (state) state.read! += result.read;
      kept?.cursors.set(key, result.cursor);
      return result.sessions;
    };
    const tops: Part[] = [];
    // Each locator's sessions packed as soon as they are read: only one locator's requests are ever held whole.
    for (const { locator } of listed) for (const session of await read(locator)) tops.push({ locator: session.locator, read: compact(session, models) });
    const children: (Part & { of: Locator })[] = [];
    for (const { locator, of } of childList) for (const session of await read(locator)) children.push({ locator: session.locator, read: compact(session, models), of });
    // A locator its reader could not go on in, or a copy this pass found whose record counts after it: read the source
    // again, from nothing.
    if (pass > 0 || !kept || !(restarted || outOfOrder(kept))) return { tops, children, unread };
    state!.sources![source] = undefined;
  }
}

async function totalsOf(home: string, source: string, tops: Part[], children: (Part & { of: Locator })[], models: Models, priceWith: () => Promise<Catalog | undefined>, calculateCost: CalculateCost | undefined): Promise<SessionTotals[]> {
  // Sessions by id, their locators in the import's order; one naming its parent (a Codex subagent's thread) is the
  // parent's, as is each one beside a session's (Claude Code's subagents).
  const sessions = new Map<string, { parts: Part[]; children: Part[]; untied?: true }>();
  const named: { part: Part; parent: string }[] = [];
  for (const part of tops) {
    const { session } = part.read;
    if (session.child && session.parent) {
      named.push({ part, parent: session.parent });
      continue;
    }
    const held = sessions.get(session.id) ?? sessions.set(session.id, { parts: [], children: [] }).get(session.id)!;
    held.parts.push(part);
  }
  const byLocator = new Map(tops.map((part) => [locatorKey(part.locator), part.read.session.id]));
  const untied: Part[] = [];
  for (const child of children) {
    const id = byLocator.get(locatorKey(child.of));
    const held = id !== undefined ? sessions.get(id) : undefined;
    if (held) held.children.push(child);
    else untied.push(child);
  }
  // A thread's parent is a session, or another thread that names its own parent: up the chain to the session.
  const parentOf = new Map(named.map(({ part, parent }) => [part.read.session.id, parent]));
  for (const { part, parent } of named) {
    let at: string | undefined = parent;
    const visited = new Set<string>();
    while (at !== undefined && !sessions.has(at) && !visited.has(at)) {
      visited.add(at);
      at = parentOf.get(at);
    }
    const held = at !== undefined ? sessions.get(at) : undefined;
    if (held) held.children.push(part);
    else untied.push(part);
  }
  // A subagent whose session is not under the home: a line of its own, but its prompts are its parent agent's.
  for (const part of untied) sessions.set(`\0${locatorKey(part.locator)}`, { parts: [part], children: [], untied: true });
  const out: SessionTotals[] = [];
  for (const { parts, children: subagents, untied } of sessions.values()) {
    // A session whose every file holds only records an earlier file holds (copies) is no session: its records count where
    // they were first read. serve's import leaves such a file out the same way.
    if (parts.every(({ read }) => read.session.copies > 0 && read.session.users === 0 && read.models.length === 0) && subagents.length === 0) continue;
    const first = parts[0]!;
    const tokens = noTokens();
    let reasoning = 0;
    let calls = 0;
    const requests: Priced[] = [];
    for (const { read } of [...parts, ...subagents]) for (let i = 0; i < read.models.length; i += 1) requests.push(requestAt(read, i, models));
    for (const { usage } of requests) {
      calls += 1;
      if (!usage) continue;
      addTokens(tokens, usage);
      reasoning += usage.reasoning ?? 0;
    }
    // The source's own cost, when each of its files wrote one: Claude Code writes the session's running total (a moved
    // session's copy goes on from the original's), so the highest; another source prices each request, so their sum.
    const written = parts.flatMap(({ read }) => (read.session.costUsd !== undefined ? [read.session.costUsd] : []));
    let cost: number | undefined = written.length === parts.length ? (source === "claude-code" ? Math.max(...written) : written.reduce((n, usd) => n + usd, 0)) : undefined;
    if (cost === undefined) {
      const catalog = await priceWith();
      cost = catalog ? await priceRequests(requests, catalog, calculateCost) : undefined;
    }
    const { key, file } = keyOf(home, first.locator);
    out.push({
      key,
      file,
      source,
      id: first.read.session.id,
      tokens,
      reasoning,
      cost: cost ?? null,
      // A subagent's session counted on its own line (its parent not under the home, or named nowhere: Codex's
      // source.subagent alone, a Claude Code sidechain file): its prompts are its parent agent's, as serve takes it.
      turns: untied || parts.every(({ read }) => read.session.child) ? 0 : parts.reduce((n, { read }) => n + read.session.users, 0),
      calls,
      subagents: subagents.length,
    });
  }
  return out;
}
