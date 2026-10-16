// The one exporter of a run's store for a reader who is not the run: a NEW SQLite file holding only the rows an allowlist
// keeps, in pi-durable's own schema, so the readers and the viewer's SQL work on it unchanged. Nothing is deleted from a
// copy: the source is opened read-only in one read transaction and every kept row is inserted into a fresh file, which is
// then vacuumed and closed as one file (no -wal, -shm or -journal beside it). A raw run store holds saved sign-ins, leases
// and the host's own names; this is the only way one leaves.
//
// What is kept, and how:
//   - a document only when its kind is on `options.exportable.kinds` or on EXPORT_KINDS (the DSL's own kinds the run
//     pages read); every other kind is dropped, and a kind on SECRET_KINDS is never kept, even when a caller lists it;
//   - a kept document's every surviving revision, as the WHOLE value after it (a base row each, never a delta), through
//     the same replay `recordingLines` uses, and through `options.exportable.project` when the caller gives one;
//   - the conversations and their entries (what a run's timeline reads), with each image block moved to a row of `blobs`
//     and left as `{ type: "image", mimeType, blob: <sha256> }`, the shape a recording uses;
//   - no task, submission or other table: a task's own record is the `agentrun.task` document.
// Every kept value is then scanned for a credential's shape and for each exact value in `options.secrets`; a hit refuses
// the export, naming the kind, key and path it was in (never the value), and the half-written file is removed.
import { createHash } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import { credentialIn } from "../credentials.js";
import { revisionValues } from "./recording.js";
import { withDurableFile } from "./readers.js";

type Database = import("node:sqlite").DatabaseSync;
type Json = any;

/** The DSL's own document kinds a run page reads: the journal, its effects, the node attempts, the tasks, the record and
 *  its gate, the receipts and the decisions. A host's own kinds are not here; its caller lists them. */
export const EXPORT_KINDS: readonly string[] = Object.freeze([
  "agentrun.driver", "agentrun.effects", "agentrun.nodes", "agentrun.node", "agentrun.task", "agentrun.record", "agentrun.gate", "agentrun.receipts", "agentrun.decisions",
]);

/** The kinds that never leave a run: saved sign-ins, save leases, and each host's names for the agent and where its tools
 *  run. A copy of `@parcha/pi-durable-agent`'s SECRET_KINDS (that package is private, so this one cannot import it); a test
 *  keeps the two equal. */
export const SECRET_EXPORT_KINDS: readonly string[] = Object.freeze(["browser.profiles", "agent.leases", "agent.bindings", "agent.aliases"]);

/** The tables an export fills; every other table the store has is created empty. */
export const EXPORT_STORE_TABLES: readonly string[] = Object.freeze(["documents", "document_revisions", "conversations", "entries", "blobs", "record_ids", "durable_metadata", "durable_schema"]);

/** The size an export may reach: a caller's `maxBytes` can only lower it. */
export const EXPORT_MAX_BYTES = 10 * 1024 * 1024;

export type ExportStoreOptions = {
  exportable: {
    /** The kinds a caller's host adds to EXPORT_KINDS (`@parcha/pi-durable-agent`'s EXPORTABLE_KINDS, say). */
    kinds: readonly string[];
    /** What to write for one kept document's value of one of `kinds` (`projectForExport`); `undefined` drops that revision. Default: the value as it is. The DSL's own kinds are not passed through it. */
    project?: (kind: string, value: Json) => Json | undefined;
  };
  /** Exact values (a key, a token, a session id) that no kept value or byte of the file may hold. Each must be at least 8 characters. */
  secrets?: readonly string[];
  /** A cap below EXPORT_MAX_BYTES. A larger one is refused. */
  maxBytes?: number;
};

export type ExportStoreReport = {
  out: string;
  bytes: number;
  /** Per kept kind: its documents and the revisions written. */
  kept: Record<string, { documents: number; revisions: number }>;
  /** Per dropped kind: its documents. */
  dropped: Record<string, number>;
  conversations: number;
  entries: number;
  blobs: number;
};

export class ExportRefused extends Error {
  readonly code: "source_missing" | "out_exists" | "too_large" | "found_secret" | "bad_options";
  /** Where a secret was found: the document's kind and key, or `pi.entry`, and the path inside its value. Never the value. */
  readonly where?: { kind: string; key?: string; path: string; rule: string };
  constructor(code: ExportRefused["code"], message: string, where?: ExportRefused["where"]) {
    super(message);
    this.name = "ExportRefused";
    this.code = code;
    if (where) this.where = where;
  }
}

const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const SIDE_FILES = ["-wal", "-shm", "-journal"] as const;

function removeExact(file: string): void {
  for (const path of [file, ...SIDE_FILES.map((suffix) => `${file}${suffix}`)]) fs.rmSync(path, { force: true });
}

/** The first rule (by name) a string breaks: a credential shape (`../credentials.js`), or one of the exact secrets. */
function ruleOf(text: string, secrets: readonly string[]): string | undefined {
  return credentialIn(text) ?? (secrets.some((secret) => text.includes(secret)) ? "exact secret value" : undefined);
}

/** The path (JSON-pointer style) of the first string or key in `value` that breaks a rule. */
function findIn(value: Json, secrets: readonly string[], path = ""): { path: string; rule: string } | undefined {
  if (typeof value === "string") { const rule = ruleOf(value, secrets); return rule ? { path: path || "/", rule } : undefined; }
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) { const found = findIn(value[i], secrets, `${path}/${i}`); if (found) return found; }
    return undefined;
  }
  if (isObject(value)) {
    for (const [key, inner] of Object.entries(value)) {
      const at = `${path}/${key.replace(/~/g, "~0").replace(/\//g, "~1")}`;
      const rule = ruleOf(key, secrets);
      if (rule) return { path: at, rule };
      const found = findIn(inner, secrets, at);
      if (found) return found;
    }
  }
  return undefined;
}

/** Moves each image block of an entry to `blobs`, leaving `{ type: "image", mimeType, blob }`. */
function blobImages(value: Json, put: (mimeType: string, bytes: Buffer) => string): Json {
  if (Array.isArray(value)) return value.map((inner) => blobImages(inner, put));
  if (!isObject(value)) return value;
  if (value.type === "image" && typeof value.data === "string") {
    const mimeType = typeof value.mimeType === "string" ? value.mimeType : "application/octet-stream";
    const { data, ...rest } = value;
    return { ...rest, mimeType, blob: put(mimeType, Buffer.from(data as string, "base64")) };
  }
  return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, blobImages(inner, put)]));
}

/**
 * Writes `out`, a new SQLite file holding the rows of the store `source` that the allowlist keeps (see the top of this file).
 * The source is opened read-only and read in one transaction, so the export is one commit's view whatever a writer
 * commits meanwhile; it is never changed. `out` must not exist. The export is built beside `out` and renamed into
 * place only when it passed every check, so a refusal leaves no file at `out`. It is refused when it would pass
 * `options.maxBytes` (at most EXPORT_MAX_BYTES), when any kept value holds a credential's shape or an exact secret,
 * and when `source` is missing. Synchronous.
 */
export function exportStore(source: string, out: string, options: ExportStoreOptions): ExportStoreReport {
  const secrets = options.secrets ?? [];
  const maxBytes = options.maxBytes ?? EXPORT_MAX_BYTES;
  if (!Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > EXPORT_MAX_BYTES) throw new ExportRefused("bad_options", `maxBytes is a whole number from 1 to ${EXPORT_MAX_BYTES}`);
  for (const secret of secrets) if (typeof secret !== "string" || secret.length < 8) throw new ExportRefused("bad_options", "each exact secret is a string of at least 8 characters");
  const kinds = new Set<string>([...EXPORT_KINDS, ...options.exportable.kinds].filter((kind) => !SECRET_EXPORT_KINDS.includes(kind)));
  const callers = new Set(options.exportable.kinds.filter((kind) => kinds.has(kind)));
  const project = options.exportable.project ?? ((_kind: string, value: Json) => value);
  if ([out, ...SIDE_FILES.map((suffix) => `${out}${suffix}`)].some((path) => fs.existsSync(path))) throw new ExportRefused("out_exists", `${out} (or a -wal, -shm or -journal of it) already exists: an export writes a new file`);
  const building = `${out}.exporting`;
  removeExact(building);
  const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
  let target: Database | undefined;
  try {
    const report = withDurableFile(source, (db) => {
      const target_ = new DatabaseSync(building);
      target = target_;
      return writeExport(db, target_, { kinds, callers, project, secrets, maxBytes });
    });
    if (!report) throw new ExportRefused("source_missing", `${source} does not exist`);
    target!.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    target!.exec("VACUUM");
    target!.close();
    target = undefined;
    for (const suffix of SIDE_FILES) fs.rmSync(`${building}${suffix}`, { force: true });
    const bytes = fs.statSync(building).size;
    if (bytes > maxBytes) throw new ExportRefused("too_large", `the export is ${bytes} bytes, over the ${maxBytes} allowed`);
    const file = fs.readFileSync(building);
    for (const secret of secrets) {
      for (const needle of [Buffer.from(secret, "utf8"), Buffer.from(secret, "utf16le")]) {
        if (file.includes(needle)) throw new ExportRefused("found_secret", "an exact secret value is in the bytes of the export (a row, or a page SQLite left)", { kind: "(file)", path: "/", rule: "exact secret value" });
      }
    }
    fs.renameSync(building, out);
    return { ...report, out, bytes };
  } catch (error) {
    try { target?.close(); } catch { /* already closed */ }
    removeExact(building);
    throw error;
  }
}

function writeExport(db: Database, target: Database, rules: { kinds: Set<string>; callers: Set<string>; project: (kind: string, value: Json) => Json | undefined; secrets: readonly string[]; maxBytes: number }): Omit<ExportStoreReport, "out" | "bytes"> {
  const { kinds, callers, project, secrets, maxBytes } = rules;
  target.exec("PRAGMA journal_mode = DELETE");
  // pi-durable's own schema, as the source has it, so every reader of a run store reads an export.
  for (const { sql } of db.prepare("SELECT sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY rowid").all() as Array<{ sql: string }>) target.exec(sql);
  target.exec("CREATE TABLE blobs (sha256 TEXT PRIMARY KEY, mime_type TEXT NOT NULL, bytes BLOB NOT NULL) STRICT");
  const kept: ExportStoreReport["kept"] = {};
  const dropped: ExportStoreReport["dropped"] = {};
  let budget = 0;
  const spend = (bytes: number, what: string) => {
    budget += bytes;
    if (budget > maxBytes) throw new ExportRefused("too_large", `the kept rows pass ${maxBytes} bytes at ${what}`);
  };
  const refuse = (kind: string, key: string | undefined, found: { path: string; rule: string }): never => {
    throw new ExportRefused("found_secret", `${found.rule} in ${kind}${key !== undefined ? ` (key ${JSON.stringify(key)})` : ""} at ${found.path}: not exported`, { kind, ...(key !== undefined ? { key } : {}), ...found });
  };
  const ids = new Map<number, string>();
  const insertDocument = target.prepare("INSERT INTO documents (id, kind, family, key_value, scope_kind, owner_id, created_at, retired_at, record) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)");
  const insertRevision = target.prepare("INSERT INTO document_revisions (document_id, seq, kind, version, content) VALUES (?, ?, 'base', ?, ?)");
  type DocRow = { id: number; kind: string; family: number; key_value: string; scope_kind: string; owner_id: number; created_at: number; retired_at: number | null; record: string };
  for (const doc of db.prepare("SELECT id, kind, family, key_value, scope_kind, owner_id, created_at, retired_at, record FROM documents ORDER BY id").all() as DocRow[]) {
    const kind = JSON.parse(doc.kind) as string;
    const key = doc.family === 1 ? JSON.parse(doc.key_value) as string : undefined;
    if (!kinds.has(kind)) { dropped[kind] = (dropped[kind] ?? 0) + 1; continue; }
    const revisions: Array<{ seq: number; version: number; text: string }> = [];
    for (const rev of revisionValues(db, doc.id)) {
      // `project` is the caller's, for the caller's kinds; the DSL's own kinds are kept as they are.
      const value = callers.has(kind) ? project(kind, rev.value) : rev.value;
      if (value === undefined) continue;
      const found = findIn(value, secrets);
      if (found) refuse(kind, key, found);
      const text = JSON.stringify(value);
      spend(text.length, `${kind}${key !== undefined ? ` ${key}` : ""}`);
      revisions.push({ seq: rev.seq, version: rev.version, text });
    }
    if (revisions.length === 0) { dropped[kind] = (dropped[kind] ?? 0) + 1; continue; }
    const meta = findIn({ kind, key, record: JSON.parse(doc.record) }, secrets);
    if (meta) refuse(kind, key, meta);
    spend(doc.record.length + doc.key_value.length, `${kind} record`);
    insertDocument.run(doc.id, doc.kind, doc.family, doc.key_value, doc.scope_kind, doc.owner_id, doc.created_at, doc.retired_at, doc.record);
    for (const rev of revisions) insertRevision.run(doc.id, rev.seq, rev.version, rev.text);
    ids.set(doc.id, "document");
    kept[kind] ??= { documents: 0, revisions: 0 };
    kept[kind]!.documents += 1;
    kept[kind]!.revisions += revisions.length;
  }
  // The conversations and their entries: what a run's timeline reads. Images leave the entry for `blobs`.
  const blobs = new Map<string, number>();
  const insertBlob = target.prepare("INSERT OR IGNORE INTO blobs (sha256, mime_type, bytes) VALUES (?, ?, ?)");
  const put = (mimeType: string, bytes: Buffer) => {
    const sha = createHash("sha256").update(bytes).digest("hex");
    if (!blobs.has(sha)) {
      for (const secret of secrets) if (bytes.includes(Buffer.from(secret, "utf8"))) refuse("pi.entry", undefined, { path: `/blob/${sha}`, rule: "exact secret value" });
      spend(bytes.length, "an image");
      insertBlob.run(sha, mimeType, bytes);
      blobs.set(sha, bytes.length);
    }
    return sha;
  };
  let conversations = 0;
  const insertConversation = target.prepare("INSERT INTO conversations (id, owner_conversation_id, owner_task_id, record) VALUES (?, ?, ?, ?)");
  for (const row of db.prepare("SELECT id, owner_conversation_id, owner_task_id, record FROM conversations ORDER BY id").all() as Array<{ id: number; owner_conversation_id: number | null; owner_task_id: number | null; record: string }>) {
    const found = findIn(JSON.parse(row.record), secrets);
    if (found) refuse("pi.conversation", String(row.id), found);
    spend(row.record.length, "a conversation");
    insertConversation.run(row.id, row.owner_conversation_id, row.owner_task_id, row.record);
    ids.set(row.id, "conversation");
    conversations += 1;
  }
  let entries = 0;
  const insertEntry = target.prepare("INSERT INTO entries (id, conversation_id, head, commit_seq, record) VALUES (?, ?, ?, ?, ?)");
  for (const row of db.prepare("SELECT id, conversation_id, head, commit_seq, record FROM entries ORDER BY id").all() as Array<{ id: number; conversation_id: number; head: number | null; commit_seq: number; record: string }>) {
    const record = blobImages(JSON.parse(row.record), put);
    const found = findIn(record, secrets);
    if (found) refuse("pi.entry", String(row.id), found);
    const text = JSON.stringify(record);
    spend(text.length, "an entry");
    insertEntry.run(row.id, row.conversation_id, row.head, row.commit_seq, text);
    ids.set(row.id, "entry");
    entries += 1;
  }
  const insertId = target.prepare("INSERT INTO record_ids (id, record_type) VALUES (?, ?)");
  for (const [id, type] of ids) insertId.run(id, type);
  // The source's counters and schema version (the tables came with the schema, their one row each did not).
  const counters = db.prepare("SELECT next_id, next_seq FROM durable_metadata WHERE singleton = 1").get() as { next_id: string; next_seq: number } | undefined;
  if (counters) target.prepare("INSERT OR REPLACE INTO durable_metadata (singleton, next_id, next_seq) VALUES (1, ?, ?)").run(counters.next_id, counters.next_seq);
  const schema = db.prepare("SELECT version FROM durable_schema WHERE singleton = 1").get() as { version: number } | undefined;
  if (schema) target.prepare("INSERT OR REPLACE INTO durable_schema (singleton, version) VALUES (1, ?)").run(schema.version);
  return { kept, dropped, conversations, entries, blobs: blobs.size };
}
