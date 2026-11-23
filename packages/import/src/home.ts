// Every session under a home, as totals: what each used, its subagents' requests with it, and what it cost. A session is
// one per source and id, however many files write it (a Codex thread resumed in a new file, a Claude Code session copied
// into a resumed one's); a subagent's is no session of its own but its parent's.
import { createHash } from "node:crypto";
import { relative, sep } from "node:path";
import { type CalculateCost, type Catalog, builtinCatalog, priceRequests } from "./price.js";
import { childrenOf, inOrder, type Readers, readerOf, sessionLocators } from "./read.js";
import { type Env, type Locator, locatorKey, type SessionRead } from "./reader.js";
import { READERS, SOURCES, type Source } from "./readers/index.js";
import { addTokens, noTokens, type Tokens } from "./usage.js";
import type { Usage } from "./types.js";

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
  /** Each record read (the reader's "u:"/"m:" keys), with the locator (locatorKey) that read it first: the one it counts in. */
  owners: Map<string, string>;
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
  /** Called with each session as it is totalled: its totals, and its requests (its subagents' with them, each once) with
   *  their times and models, text-free as the totals are. `started`: the time (ms) of the first request of the session's
   *  own files (not its subagents'), absent when it has none. For a caller that buckets the same numbers (wrapped.ts). */
  requests?: (totals: SessionTotals, requests: readonly SessionRequest[], started: number | undefined) => void;
};

/** One model request of a session: when (ms), by which model ("provider/model", the session's when the request names none),
 *  and its tokens where the source counted them. */
export type SessionRequest = { at: number; model?: string; usage?: Usage };

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

type Part = { locator: Locator; read: SessionRead };

/** Every session of `sources` under `home`, as totals, sorted by key. */
export async function parseHome(home: string, { sources = SOURCES, readers = READERS, state, catalog, calculateCost, env, failures, requests }: ParseOptions = {}): Promise<SessionTotals[]> {
  let prices: Promise<Catalog | undefined> | undefined;
  const priceWith = () => (catalog === false ? Promise.resolve(undefined) : catalog ? Promise.resolve(catalog) : (prices ??= builtinCatalog()));
  const out: SessionTotals[] = [];
  const failed: ReadFailure[] = [];
  if (state) state.read = 0;
  for (const source of sources) {
    const { tops, children, unread } = await readSource(home, source, readers, env, state);
    out.push(...(await totalsOf(home, source, tops, children, priceWith, calculateCost, requests)));
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
async function readSource(home: string, source: string, readers: Readers, env: Env | undefined, state: HomeState | undefined): Promise<{ tops: Part[]; children: (Part & { of: Locator })[]; unread: { locator: Locator; error: unknown }[] }> {
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
    if (state && !kept) kept = state.sources![source] = { cursors: new Map(), owners: new Map(), copied: new Map() };
    const { owners, copied } = kept ?? { owners: new Map<string, string>(), copied: new Map<string, Set<string>>() };
    let restarted = false;
    const unread: { locator: Locator; error: unknown }[] = [];
    const read = async (locator: Locator): Promise<SessionRead[]> => {
      const key = locatorKey(locator);
      const cursor = kept?.cursors.get(key);
      // The records read so far, as the reader asks for them, each new one this locator's, each found one noted. Both are
      // staged and kept only when the read succeeds: a read that fails partway leaves no record owned that no cursor
      // holds, which a retry would take for a copy.
      const mine = new Map<string, string>();
      const found = new Set<string>();
      const seen = {
        has: (record: string) => {
          const owner = owners.get(record) ?? mine.get(record);
          if (owner === undefined) return false;
          if (owner !== key) found.add(owner);
          return true;
        },
        add(record: string) {
          if (!owners.has(record) && !mine.has(record)) mine.set(record, key);
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
          for (const [record, owner] of owners) if (owner === key) owners.delete(record);
          copied.delete(key);
          if ([...copied.values()].some((owners) => owners.has(key))) restarted = true;
        }
        return [];
      }
      for (const [record, owner] of mine) owners.set(record, owner);
      if (found.size) for (const owner of found) (copied.get(key) ?? copied.set(key, new Set()).get(key)!).add(owner);
      if (cursor !== undefined && !result.resumed) restarted = true;
      if (state) state.read! += result.read;
      kept?.cursors.set(key, result.cursor);
      return result.sessions;
    };
    const tops: Part[] = [];
    for (const { locator } of listed) for (const session of await read(locator)) tops.push({ locator: session.locator, read: session });
    const children: (Part & { of: Locator })[] = [];
    for (const { locator, of } of childList) for (const session of await read(locator)) children.push({ locator: session.locator, read: session, of });
    // A locator its reader could not go on in, or a copy this pass found whose record counts after it: read the source
    // again, from nothing.
    if (pass > 0 || !kept || !(restarted || outOfOrder(kept))) return { tops, children, unread };
    state!.sources![source] = undefined;
  }
}

async function totalsOf(home: string, source: string, tops: Part[], children: (Part & { of: Locator })[], priceWith: () => Promise<Catalog | undefined>, calculateCost: CalculateCost | undefined, sink?: ParseOptions["requests"]): Promise<SessionTotals[]> {
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
    if (parts.every(({ read }) => read.session.copies > 0 && read.session.users === 0 && read.requests.length === 0) && subagents.length === 0) continue;
    const first = parts[0]!;
    const tokens = noTokens();
    let reasoning = 0;
    let calls = 0;
    const requests = [...parts, ...subagents].flatMap(({ read }) =>
      read.requests.map(({ at, model, usage }): SessionRequest => {
        const named = model ?? read.session.model;
        return { at, ...(named ? { model: named } : {}), ...(usage ? { usage } : {}) };
      }),
    );
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
    const totals: SessionTotals = {
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
    };
    out.push(totals);
    if (sink) {
      const times = parts.flatMap(({ read }) => read.requests.map(({ at }) => at)).filter(Number.isFinite);
      sink(totals, requests, times.reduce<number | undefined>((least, at) => (least === undefined || at < least ? at : least), undefined));
    }
  }
  return out;
}
