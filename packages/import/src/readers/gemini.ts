// Gemini CLI: ~/.gemini/tmp/<project id>/chats/session-<time>-<short id>.jsonl, its subagents' files nested under their
// parent's full session id (chats/<parent id>/<id>.jsonl), and the legacy whole-file session-*.json the CLI wrote before.
// Read from google-gemini/gemini-cli at v0.70.0:
//   packages/core/src/services/chatRecordingTypes.ts   ConversationRecord, MessageRecord, TokensSummary
//   packages/core/src/services/chatRecordingService.ts the files' names and records: a metadata record ({sessionId,
//       projectHash, startTime, kind, ...}), then one record per message, the same id written again each time the message
//       changes (its tool calls, its tokens): the last one is the message. {$patch}, {$rewindTo} and {$set} edit what
//       came before; a legacy .json is one ConversationRecord, which the CLI migrates into a .jsonl on resume (its
//       messages keep their ids, so the same request is in both files).
//   packages/core/src/config/storage.ts + utils/paths.ts   the directory is <home>/.gemini/tmp/<project id>, and the home
//       is GEMINI_CLI_HOME where that is set, else the user's. (Under macOS Seatbelt the CLI writes to
//       ~/.cache/.gemini instead; not read here.)
//   packages/core/src/config/projectRegistry.ts   <home>/.gemini/projects.json ({projects: {<path>: <project id>}}), and the
//       .project_root marker (the path) in each project's directory: where a session's cwd comes from.
//   packages/core/src/telemetry/uiTelemetry.ts   the CLI's own input is `tokens.input - tokens.cached`: promptTokenCount
//       holds the cached tokens, as OpenAI's input does.
// A message with `tokens` is one model request, keyed by its message id; a message id is a random UUID, so the key is
// the same in every file that holds it. The whole file is read each time it changed (a rewrite on resume can be anywhere
// in it), and the cursor holds the keys this file counted, so a pass over a grown file counts nothing twice.
import { open, readFile, type FileHandle } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { type Env, entries, type Locator, type Reader, type ReadOptions, type ReadResult, rememberUser, type SessionRead } from "../reader.js";
import { argsOf, isObject, str, textOf, timeOf } from "../text.js";
import { ACTIVE_GAP_MS, type Answer, type SessionOf, type ToolCall, type Turn } from "../types.js";
import { normalizeUsage } from "../usage.js";

type Session = SessionOf<"gemini">;
type Meta = { sessionId?: string; kind?: string; summary?: string; startTime?: string; lastUpdated?: string };
/** One file read whole: where it stopped being the same file, what it counted, and the session it made. Plain data. */
type Cursor = { source: "gemini"; dev: number; ino: number; size: number; mtimeMs: number; keep: boolean; claimed: string[]; session: Session; requests: Answer[] };

const SESSION_FILE = /^session-.*\.jsonl?$/;
const SUBAGENT_FILE = /\.jsonl?$/;

/** The messages and metadata a file's records leave, in the order the CLI's own loader leaves them. */
function conversation(text: string): { meta: Meta; messages: Record<string, unknown>[] } {
  let meta: Meta = {};
  const messages = new Map<string, Record<string, unknown>>();
  const setMessages = (list: unknown) => {
    messages.clear();
    if (Array.isArray(list)) for (const message of list) if (isObject(message) && str(message.id)) messages.set(message.id as string, message);
  };
  const metadata = (record: Record<string, unknown>) => {
    for (const key of ["sessionId", "kind", "summary", "startTime", "lastUpdated"] as const) if (typeof record[key] === "string") meta[key] = record[key] as string;
  };
  const patch = (one: unknown) => {
    if (!isObject(one) || !str(one.id)) return;
    const held = messages.get(one.id as string);
    if (held && one.content !== undefined) held.content = one.content;
  };
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isObject(record)) continue;
    if (str(record.$rewindTo)) {
      // The message it names and every one after it go; one it does not find empties the list.
      const ids = [...messages.keys()];
      const at = ids.indexOf(record.$rewindTo as string);
      for (const id of at === -1 ? ids : ids.slice(at)) messages.delete(id);
    } else if (isObject(record.$patch)) {
      const edit = record.$patch;
      patch(edit);
      if (Array.isArray(edit.updates)) for (const update of edit.updates) patch(update);
      if (Array.isArray(edit.removeIds)) for (const id of edit.removeIds) if (typeof id === "string") messages.delete(id);
    } else if (str(record.id)) {
      messages.set(record.id as string, record);
    } else if (isObject(record.$set)) {
      metadata(record.$set);
      if (Array.isArray(record.$set.messages)) setMessages(record.$set.messages);
    } else if (str(record.sessionId) && str(record.projectHash)) {
      metadata(record);
      if (Array.isArray(record.messages)) setMessages(record.messages);
    }
  }
  if (!meta.sessionId) {
    // The legacy file: one JSON object, the whole ConversationRecord.
    try {
      const whole: unknown = JSON.parse(text);
      if (isObject(whole) && str(whole.sessionId) && Array.isArray(whole.messages)) {
        meta = {};
        metadata(whole);
        setMessages(whole.messages);
      }
    } catch {
      // No session in it.
    }
  }
  return { meta, messages: [...messages.values()] };
}

/** A session's id: the one its metadata record names, else its file's name without the extension. */
export const sessionIdOf = (file: string, recorded?: string): string => recorded ?? basename(file).replace(/\.jsonl?$/, "");

/** One file read into its session, each message not counted elsewhere kept (and claimed). */
function sessionOf(file: string, text: string, claimed: Set<string>, seen: Set<string>, keep: boolean): { session: Session; requests: Answer[] } {
  const { meta, messages } = conversation(text);
  const session: Session = { source: "gemini", id: sessionIdOf(file, meta.sessionId), file, state: "completed", child: meta.kind === "subagent", turns: [], users: 0, activeMs: 0, copies: 0 };
  if (keep && meta.summary) session.sourceTitle = meta.summary;
  const turns: Turn[] = [];
  const requests: Answer[] = [];
  let first: number | undefined;
  let last: number | undefined;
  let activeMs = 0;
  for (const message of messages) {
    const id = message.id as string;
    const kind = message.type;
    if (kind !== "user" && kind !== "gemini") continue;
    const at = timeOf(message.timestamp);
    const text = textOf(message.content);
    const calls: ToolCall[] = kind === "gemini" && Array.isArray(message.toolCalls) ? message.toolCalls.filter(isObject).map((c) => ({ type: "toolCall", id: String(c.id ?? ""), name: String(c.name ?? ""), arguments: keep ? argsOf(c.args) : {} })) : [];
    const usage = kind === "gemini" ? normalizeUsage("gemini", message.tokens) : undefined;
    // What is not a turn: the CLI's own empty user records, a reply of only thoughts.
    if (kind === "user" ? !text.trim() : !usage && !text && calls.length === 0) continue;
    const key = `${kind === "user" ? "u" : "m"}:${id}`;
    // A message a file of the import counted already (a legacy file's copy in its migrated .jsonl) counts there.
    if (!claimed.has(key)) {
      if (seen.has(key)) {
        session.copies += 1;
        continue;
      }
      seen.add(key);
      claimed.add(key);
    }
    if (at !== undefined) {
      first ??= at;
      if (last !== undefined && at >= last && at - last <= ACTIVE_GAP_MS) activeMs += at - last;
      if (last === undefined || at >= last) last = at;
    }
    const when = at ?? last ?? 0;
    const turn: Turn =
      kind === "user"
        ? { role: "user", text: keep ? text : "", at: when, uuids: [id] }
        : { role: "assistant", text: keep ? text : "", calls, at: when, key: id, ...(str(message.model) ? { model: `google/${message.model}` } : {}), ...(usage ? { usage } : {}), uuids: [id] };
    if (turn.role === "user") rememberUser(session, { ...turn, text });
    else {
      requests.push(turn);
      if (turn.model) session.model = turn.model;
    }
    if (keep) turns.push(turn);
  }
  const started = first ?? timeOf(meta.startTime);
  const ended = last ?? timeOf(meta.lastUpdated);
  if (started !== undefined) session.startedAt = new Date(started).toISOString();
  if (ended !== undefined) session.endedAt = new Date(ended).toISOString();
  session.activeMs = Math.round(activeMs);
  session.turns = turns;
  if (!keep) {
    // A listing's session holds none of its words: not the first prompt, a title or a user turn's text.
    delete session.firstPrompt;
    delete session.titleText;
  }
  return { session, requests };
}

const withoutCwd = (session: Session): Session => {
  const { cwd: _cwd, ...rest } = session;
  return rest;
};

async function read(locator: Locator, cursor?: Cursor, { turns: keep = true, seen }: ReadOptions = {}): Promise<ReadResult<"gemini", Cursor>> {
  const handle: FileHandle = await open(locator.file, "r");
  try {
    const stats = await handle.stat();
    const same = cursor !== undefined && cursor.source === "gemini" && cursor.keep === keep && cursor.dev === stats.dev && cursor.ino === stats.ino;
    const out = (session: Session, requests: Answer[]): SessionRead<"gemini">[] => [{ locator: { file: locator.file }, session, requests }];
    if (same && cursor.size === stats.size && cursor.mtimeMs === stats.mtimeMs) return { sessions: out(cursor.session, cursor.requests), cursor, read: 0, resumed: true };
    const text = await handle.readFile("utf8");
    // The keys this file counted before stay its own; a key another file holds is a copy there.
    const claimed = new Set(same ? cursor.claimed : []);
    const { session, requests } = sessionOf(locator.file, text, claimed, seen ?? new Set(), keep);
    // Where it ran, as every source's listing has it (an import needs the project); the cursor holds none of it.
    const cwd = await cwdOf(locator.file);
    if (cwd) session.cwd = cwd;
    return { sessions: out(session, requests), cursor: { source: "gemini", dev: stats.dev, ino: stats.ino, size: stats.size, mtimeMs: stats.mtimeMs, keep, claimed: [...claimed], session: keep ? session : withoutCwd(session), requests }, read: Buffer.byteLength(text), resumed: same };
  } finally {
    await handle.close();
  }
}

/** The directory a session ran in, from its project's id: the .project_root marker in the project's directory, else the
 *  registry's path for the id, else the id itself. */
async function cwdOf(file: string): Promise<string | undefined> {
  let dir = dirname(file);
  while (basename(dir) !== "chats") {
    if (dirname(dir) === dir) return undefined;
    dir = dirname(dir);
  }
  const project = dirname(dir);
  const id = basename(project);
  const marker = (await readFile(join(project, ".project_root"), "utf8").catch(() => "")).trim();
  if (marker) return marker;
  try {
    const registry: unknown = JSON.parse(await readFile(join(dirname(dirname(project)), "projects.json"), "utf8"));
    const projects = isObject(registry) && isObject(registry.projects) ? registry.projects : {};
    for (const [path, shortId] of Object.entries(projects)) if (shortId === id) return path;
  } catch {
    // No registry, or not one: none.
  }
  return undefined;
}

/** Gemini CLI's own directory: GEMINI_CLI_HOME where the environment names it (the CLI's home), else the given home's. */
const tmpDir = (home: string, env?: Env): string => join(env?.GEMINI_CLI_HOME || home, ".gemini", "tmp");

/** Each project's chats directory. */
async function chats(home: string, env?: Env): Promise<string[]> {
  const root = tmpDir(home, env);
  return (await entries(root)).filter((entry) => entry.isDirectory()).map((entry) => join(root, entry.name, "chats"));
}

/** The first record's session id: how a subagent's directory finds its parent when file names do not say. */
async function headId(file: string): Promise<string | undefined> {
  const handle = await open(file, "r").catch(() => undefined);
  if (!handle) return undefined;
  try {
    const { buffer, bytesRead } = await handle.read(Buffer.alloc(16384), 0, 16384, 0);
    const line = buffer.subarray(0, bytesRead).toString("utf8").split("\n")[0]!;
    const record: unknown = JSON.parse(line);
    return isObject(record) ? str(record.sessionId) : undefined;
  } catch {
    return undefined;
  } finally {
    await handle.close();
  }
}

export const gemini: Reader<"gemini", Cursor> = {
  source: "gemini",
  name: "Gemini CLI",
  // serve has no Gemini harness: what is imported from here runs as pi does.
  harness: "pi",
  discover: async (home, env) => {
    const out: Locator[] = [];
    for (const dir of await chats(home, env)) for (const entry of await entries(dir)) if (entry.isFile() && SESSION_FILE.test(entry.name)) out.push({ file: join(dir, entry.name) });
    return out;
  },
  read,
  children: async (home, env) => {
    const out: { locator: Locator; of: Locator }[] = [];
    for (const dir of await chats(home, env)) {
      const tops = (await entries(dir)).filter((entry) => entry.isFile() && SESSION_FILE.test(entry.name)).map((entry) => join(dir, entry.name));
      for (const folder of (await entries(dir)).filter((entry) => entry.isDirectory())) {
        // The folder is the parent's full id, its session file's name ends in the first 8 characters of it.
        const named = tops.filter((file) => file.replace(/\.jsonl?$/, "").endsWith(`-${folder.name.slice(0, 8)}`));
        let parent = named.length === 1 ? named[0] : undefined;
        if (named.length > 1) for (const file of named) if ((await headId(file))?.replace(/[^a-zA-Z0-9_-]/g, "_") === folder.name) parent = file;
        for (const entry of await entries(join(dir, folder.name))) {
          if (!entry.isFile() || !SUBAGENT_FILE.test(entry.name)) continue;
          const file = join(dir, folder.name, entry.name);
          out.push({ locator: { file }, of: { file: parent ?? file } });
        }
      }
    }
    return out;
  },
};
