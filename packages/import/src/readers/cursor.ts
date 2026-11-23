// Cursor's CLI (cursor-agent): each chat a SQLite store of its own, <config>/chats/<md5 of the workspace>/<agent id>/store.db
// (an ACP session's in <config>/acp-sessions/<id>/store.db), with a meta.json beside it (the workspace, when the chat was
// made and last written). The store is content-addressed: blobs(id, data), each id the sha256 of its bytes, and
// meta(key, value), whose key "0" holds the agent's metadata as hex-encoded JSON (its latest root blob, its name, when it
// was made, the agent it ran under when it is a subagent). The messages are AI SDK messages as JSON blobs; their order is
// only in the root, a protobuf (rootOf). Cursor keeps no tokens, cost or error of a request here (its usage is on
// Cursor's server), no model a person can read (each turn's is encrypted, and is never read), nor a message's time: each
// answer is a request of unknown tokens on an unknown model, and every turn is at the chat's start. A store is read once,
// whole, read-only: no cursor to go on from.
import { readFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { entries, type Env, type Reader, type ReadOptions, type ReadResult, rememberUser } from "../reader.js";
import { argsOf, isObject, str, textOf } from "../text.js";
import { ACTIVE_GAP_MS, type Answer, type SessionOf, type ToolCall, type Turn } from "../types.js";

/** A chat's id: its folder's name, the agent id Cursor names it by (an ACP session's id). */
export const cursorSessionId = (file: string): string => basename(dirname(file));

/** Cursor's config directory: CURSOR_CONFIG_DIR, else XDG_CONFIG_HOME's cursor, else ~/.cursor. */
const configDir = (home: string, env: Env): string => env.CURSOR_CONFIG_DIR || (env.XDG_CONFIG_HOME ? join(env.XDG_CONFIG_HOME, "cursor") : join(home, ".cursor"));

/** Each chat's store under `config`: chats/<workspace>/<agent>/store.db and acp-sessions/<id>/store.db. */
async function storesIn(config: string): Promise<string[]> {
  const out: string[] = [];
  const chats = join(config, "chats");
  for (const workspace of await entries(chats)) {
    if (!workspace.isDirectory()) continue;
    for (const agent of await entries(join(chats, workspace.name))) if (agent.isDirectory()) out.push(join(chats, workspace.name, agent.name, "store.db"));
  }
  const acp = join(config, "acp-sessions");
  for (const session of await entries(acp)) if (session.isDirectory()) out.push(join(acp, session.name, "store.db"));
  return out;
}

type Row = Record<string, unknown>;
/** An open store, read-only; `read` the bytes of the blobs the queries have returned so far. */
type Db = { all(sql: string, ...params: (string | number)[]): Row[]; close(): void; read(): number };
// Read through a variable: a Bun build bundles node:sqlite as missing, and Node has no bun:sqlite.
const BUN_SQLITE = "bun:sqlite";
const NODE_SQLITE = "node:sqlite";
/** How long a read waits on Cursor's own write (a lock it holds) before it fails, ms. */
const BUSY_MS = 5000;
const BUSY_PRAGMA = "PRAGMA busy_timeout = 5000";
/** `file` opened read-only, waiting BUSY_MS on a lock: with Node's node:sqlite, or Bun's bun:sqlite under Bun (Bun 1.3
 *  has no node:sqlite, and its opener takes no timeout: the connection's busy_timeout, which writes nothing). */
async function openDb(file: string): Promise<Db> {
  let query: (sql: string, params: (string | number)[]) => Row[];
  let close: () => void;
  if (process.versions.bun) {
    const { Database } = (await import(BUN_SQLITE)) as { Database: new (file: string, options: { readonly: boolean }) => { query(sql: string): { all(...params: unknown[]): Row[] }; close(): void } };
    const db = new Database(file, { readonly: true });
    db.query(BUSY_PRAGMA).all();
    query = (sql, params) => db.query(sql).all(...params);
    close = () => db.close();
  } else {
    const { DatabaseSync } = (await import(NODE_SQLITE)) as typeof import("node:sqlite");
    const db = new DatabaseSync(file, { readOnly: true, timeout: BUSY_MS });
    query = (sql, params) => db.prepare(sql).all(...params) as Row[];
    close = () => db.close();
  }
  let bytes = 0;
  return {
    all(sql, ...params) {
      const rows = query(sql, params);
      for (const row of rows) if (row.data instanceof Uint8Array) bytes += row.data.byteLength;
      return rows;
    },
    close,
    read: () => bytes,
  };
}

/** The ids of a chat's messages, in order: the root's field 1. The root is agent.v1.ConversationStateStructure (as
 *  cursor-agent 2026.07.09-a3815c0 declares it), and field 1, root_prompt_messages_json, its repeated message blob ids,
 *  each stored as the 32 raw bytes of the blob's sha256. Every other field is passed over by its wire type; nothing is
 *  generated from Cursor's schema. A root that is no protobuf throws. */
function rootOf(bytes: Uint8Array): string[] {
  const ids: string[] = [];
  let at = 0;
  const varint = (): number => {
    let value = 0;
    for (let scale = 1; ; scale *= 128) {
      if (at >= bytes.length || scale > 2 ** 63) throw new Error("not a Cursor chat root: a varint runs past its end");
      const byte = bytes[at++]!;
      value += (byte & 0x7f) * scale;
      if (byte < 0x80) return value;
    }
  };
  while (at < bytes.length) {
    const tag = varint();
    const field = Math.floor(tag / 8);
    const wire = tag % 8;
    if (wire === 0) varint();
    else if (wire === 2) {
      const length = varint();
      if (at + length > bytes.length) throw new Error("not a Cursor chat root: a field runs past its end");
      if (field === 1 && length === 32) ids.push(Buffer.from(bytes.subarray(at, at + length)).toString("hex"));
      at += length;
    } else if (wire === 1) at += 8;
    else if (wire === 5) at += 4;
    else throw new Error(`not a Cursor chat root: wire type ${wire}`);
  }
  if (at > bytes.length) throw new Error("not a Cursor chat root: a field runs past its end");
  return ids;
}

/** The agent's metadata (meta key "0"): hex-encoded JSON, as cursor-agent writes it. */
function agentOf(db: Db): Row {
  const value = db.all("SELECT value FROM meta WHERE key = ?", "0")[0]?.value;
  if (typeof value !== "string") throw new Error("not a Cursor chat: no agent metadata");
  const parsed = JSON.parse(/^(?:[0-9a-f]{2})+$/i.test(value) ? Buffer.from(value, "hex").toString("utf8") : value) as unknown;
  if (!isObject(parsed)) throw new Error("not a Cursor chat: its agent metadata is no object");
  return parsed;
}

/** meta.json beside the store: the workspace, and when the chat was made and last written. None when it is not there. */
async function chatOf(file: string): Promise<Row> {
  try {
    const parsed = JSON.parse(await readFile(join(dirname(file), "meta.json"), "utf8")) as unknown;
    return isObject(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

const num = (value: unknown): number | undefined => (typeof value === "number" && Number.isFinite(value) ? value : undefined);
const parts = (content: unknown): Row[] => (Array.isArray(content) ? content.filter(isObject) : []);
const cursorOptions = (value: Row): Row | undefined => (isObject(value.providerOptions) && isObject(value.providerOptions.cursor) ? value.providerOptions.cursor : undefined);

/** One chat's store, read whole. */
async function readChat(file: string, { turns: keep = true }: ReadOptions): Promise<ReadResult<"cursor", null>> {
  const [db, chat] = [await openDb(file), await chatOf(file)];
  try {
    const agent = agentOf(db);
    const blob = (id: string): Uint8Array | undefined => {
      const data = db.all("SELECT data FROM blobs WHERE id = ?", id)[0]?.data;
      return data instanceof Uint8Array ? data : undefined;
    };
    const rootId = str(agent.latestRootBlobId);
    const root = rootId ? blob(rootId) : undefined;
    const ids = root ? rootOf(root) : [];
    const first = num(agent.createdAt) ?? num(chat.createdAtMs);
    const last = Math.max(num(chat.updatedAtMs) ?? first ?? 0, first ?? 0);
    const at = first ?? last;
    const subagent = isObject(agent.subagentInfo) ? agent.subagentInfo : undefined;
    const name = str(agent.name);
    const session: SessionOf<"cursor"> = {
      source: "cursor",
      id: cursorSessionId(file),
      file,
      ...(str(chat.cwd) ? { cwd: chat.cwd as string } : {}),
      ...(first !== undefined ? { startedAt: new Date(first).toISOString(), endedAt: new Date(last).toISOString() } : {}),
      state: "completed",
      ...(name && name !== "New Agent" ? { sourceTitle: name } : {}),
      child: subagent !== undefined,
      ...(subagent && str(subagent.parentAgentId) ? { parent: subagent.parentAgentId as string } : {}),
      turns: [],
      users: 0,
      activeMs: first !== undefined && last - first <= ACTIVE_GAP_MS ? last - first : 0,
      copies: 0,
    };
    const requests: Answer[] = [];
    /** Each request by its key: Cursor's requestId where the message names one, else the message's id. */
    const byKey = new Map<string, Answer>();
    const add = (turn: Turn) => {
      rememberUser(session, turn);
      if (keep) session.turns.push(turn);
      if (turn.role === "assistant") requests.push(turn);
    };
    for (const id of ids) {
      const data = blob(id);
      if (!data) continue;
      let message: unknown;
      try {
        message = JSON.parse(Buffer.from(data).toString("utf8"));
      } catch {
        continue;
      }
      if (!isObject(message)) continue;
      if (message.role === "user") add({ role: "user", text: textOf(message.content), at });
      else if (message.role === "assistant") {
        const content = parts(message.content);
        const calls: ToolCall[] = content
          .filter((part) => part.type === "tool-call")
          .map((part) => ({ type: "toolCall", id: String(part.toolCallId ?? ""), name: String(part.toolName ?? ""), arguments: keep ? argsOf(part.args) : {} }));
        const text = typeof message.content === "string" ? message.content : content.filter((part) => part.type === "text" && typeof part.text === "string").map((part) => part.text as string).join("\n");
        const key = str(cursorOptions(message)?.requestId) ?? str(message.id);
        const held = key === undefined ? undefined : byKey.get(key);
        // A later message of a request read already is more of it: its text and calls join the first, which counts once.
        if (held) {
          if (keep && text) held.text = held.text ? `${held.text}\n${text}` : text;
          held.calls.push(...calls);
          continue;
        }
        const answer: Answer = { role: "assistant", text: keep ? text : "", calls, at, ...(key !== undefined ? { key } : {}) };
        if (key !== undefined) byKey.set(key, answer);
        add(answer);
      } else if (message.role === "tool") {
        const outcome = cursorOptions(message)?.highLevelToolCallResult;
        for (const part of parts(message.content)) {
          if (part.type !== "tool-result") continue;
          add({
            role: "toolResult",
            callId: String(part.toolCallId ?? ""),
            name: String(part.toolName ?? ""),
            text: typeof part.result === "string" ? part.result : textOf(part.experimental_content),
            isError: isObject(outcome) && outcome.isError === true,
            at,
          });
        }
      }
    }
    return { sessions: [{ locator: { file }, session, requests }], cursor: null, read: db.read(), resumed: false };
  } finally {
    db.close();
  }
}

export const cursor: Reader<"cursor", null> = {
  source: "cursor",
  name: "Cursor",
  harness: "cursor",
  discover: async (home, env = {}) => (await storesIn(configDir(home, env))).map((file) => ({ file })),
  read: (locator, _cursor, options = {}) => readChat(locator.file, options),
};
