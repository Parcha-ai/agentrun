// The creature's memory, in two SQLite files with one writer each, so neither writer can overwrite the other's rows:
//   designs.sqlite  the bodies the creature was given. Written by the tab.
//   memory.sqlite   the machines it has run on, oldest first. Written by the agent as it moves; the tab only reads it
//                   (it re-reads on every open of the memory view). `memoryWritable` is true only when the tab owns the
//                   file (standalone, no disk) or a test does.
// SQLite runs as sql.js (WASM) so the same code works in the tab and under node. Both files live on the agent's disk
// (work/creature/, carried by the tab's write-through); a `Backend` moves a file's bytes in and out, so the store does
// not know whether they come from the disk, IndexedDB or a test.
//
// Invariant: every mutation is exported through its backend before its promise resolves, so a closed tab never holds
// rows the disk lacks.

import { canonicalDesign, type Design } from './design.ts';
import { sha256Hex } from './policy.ts';

export interface Backend {
  read(): Promise<Uint8Array | null>;
  write(bytes: Uint8Array): Promise<void>;
}

export interface SavedDesign { id: number; name: string; sha256: string; createdAt: string; design: Design }
export interface MachineEvent { id?: number; at: string; host: string; kind: string; note: string }

/* eslint-disable @typescript-eslint/no-explicit-any */
type SqlJs = { Database: new (data?: Uint8Array) => any };

export const DESIGNS_SCHEMA = `
CREATE TABLE IF NOT EXISTS designs (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, sha256 TEXT NOT NULL UNIQUE, json TEXT NOT NULL, created_at TEXT NOT NULL);
`;
// The agent-side writer uses exactly this (see memory-schema.sql); `at` is an ISO-8601 UTC string.
export const MEMORY_SCHEMA = `
CREATE TABLE IF NOT EXISTS machines (
  id INTEGER PRIMARY KEY, at TEXT NOT NULL, host TEXT NOT NULL, kind TEXT NOT NULL, note TEXT NOT NULL DEFAULT '');
CREATE INDEX IF NOT EXISTS machines_at ON machines(at);
`;

export interface Backends { designs: Backend; memory: Backend }

export class CreatureStore {
  private readonly designsDb: any;
  private readonly memoryDb: any;
  private readonly backends: Backends;
  readonly memoryWritable: boolean;

  private constructor(designsDb: any, memoryDb: any, backends: Backends, memoryWritable: boolean) {
    this.designsDb = designsDb;
    this.memoryDb = memoryDb;
    this.backends = backends;
    this.memoryWritable = memoryWritable;
  }

  static async open(sql: SqlJs, backends: Backends, opts: { memoryWritable?: boolean } = {}): Promise<CreatureStore> {
    const [d, m] = await Promise.all([backends.designs.read(), backends.memory.read()]);
    const designsDb = d ? new sql.Database(d) : new sql.Database();
    const memoryDb = m ? new sql.Database(m) : new sql.Database();
    designsDb.run(DESIGNS_SCHEMA);
    // A tab that does not own memory.sqlite never creates it: the table is only declared in its in-memory copy.
    memoryDb.run(MEMORY_SCHEMA);
    return new CreatureStore(designsDb, memoryDb, backends, opts.memoryWritable ?? true);
  }

  /** Save a design; the same body (same canonical JSON) is stored once and its id returned again. */
  async saveDesign(design: Design, now = new Date().toISOString()): Promise<SavedDesign> {
    const json = canonicalDesign(design);
    const sha256 = await sha256Hex(json);
    const have = this.designsDb.exec('SELECT id FROM designs WHERE sha256 = ?', [sha256]);
    if (!have[0]) {
      this.designsDb.run('INSERT INTO designs (name, sha256, json, created_at) VALUES (?, ?, ?, ?)', [design.name, sha256, json, now]);
      await this.persisted(this.designsDb, this.backends.designs, 'DELETE FROM designs WHERE sha256 = ?', [sha256]);
    }
    return this.designBySha(sha256)!;
  }

  /** Export `db` through `backend`; if the backend refuses or times out, undo the insert so the open store never holds a row the disk lacks. */
  private async persisted(db: any, backend: Backend, undoSql: string, undoParams: unknown[]): Promise<void> {
    try {
      await backend.write(db.export());
    } catch (e) {
      db.run(undoSql, undoParams);
      throw e;
    }
  }

  private rows(db: any, sql: string, params: unknown[] = []): Record<string, any>[] {
    const stmt = db.prepare(sql, params);
    const out: Record<string, any>[] = [];
    while (stmt.step()) out.push(stmt.getAsObject());
    stmt.free();
    return out;
  }

  private toSaved(r: Record<string, any>): SavedDesign {
    return { id: r.id, name: r.name, sha256: r.sha256, createdAt: r.created_at, design: JSON.parse(r.json) };
  }

  designBySha(sha256: string): SavedDesign | null {
    const r = this.rows(this.designsDb, 'SELECT * FROM designs WHERE sha256 = ?', [sha256])[0];
    return r ? this.toSaved(r) : null;
  }

  designs(): SavedDesign[] {
    return this.rows(this.designsDb, 'SELECT * FROM designs ORDER BY id DESC').map((r) => this.toSaved(r));
  }

  /** Append a machine row. Refused when the agent owns the file: a stale copy exported from here would erase its rows. */
  async recordMachine(e: MachineEvent): Promise<void> {
    if (!this.memoryWritable) throw new Error('memory.sqlite belongs to the agent; the tab only reads it');
    this.memoryDb.run('INSERT INTO machines (at, host, kind, note) VALUES (?, ?, ?, ?)', [e.at, e.host, e.kind, e.note]);
    await this.persisted(this.memoryDb, this.backends.memory, 'DELETE FROM machines WHERE id = last_insert_rowid()', []);
  }

  /** Oldest first: the story in the order it happened. */
  timeline(): MachineEvent[] {
    return this.rows(this.memoryDb, 'SELECT * FROM machines ORDER BY at, id').map((r) => ({ id: r.id, at: r.at, host: r.host, kind: r.kind, note: r.note }));
  }

  /** A fresh store over the same backends: picks up rows the agent added while this tab was idle. */
  async reload(sql: SqlJs): Promise<CreatureStore> {
    return CreatureStore.open(sql, this.backends, { memoryWritable: this.memoryWritable });
  }

  close(): void { this.designsDb.close(); this.memoryDb.close(); }
}

export class MemoryBackend implements Backend {
  bytes: Uint8Array | null = null;
  writes = 0;
  async read() { return this.bytes; }
  async write(b: Uint8Array) { this.bytes = b; this.writes++; }
}
