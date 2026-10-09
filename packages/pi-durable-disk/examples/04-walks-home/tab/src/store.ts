// The creature's memory: designs it was given and the machines it has run on, in one SQLite file.
// SQLite runs as sql.js (WASM) so the same code works in the tab and under node. The file lives on the agent's disk
// (work/creature/memory.sqlite, carried by the tab's write-through); a `Backend` moves its bytes in and out, so the
// store does not know whether they come from the disk, IndexedDB or a test.
//
// Invariant: every mutation is exported through the backend before its promise resolves, so a closed tab never holds
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

const SCHEMA = `
CREATE TABLE IF NOT EXISTS designs (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, sha256 TEXT NOT NULL UNIQUE, json TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS machines (
  id INTEGER PRIMARY KEY, at TEXT NOT NULL, host TEXT NOT NULL, kind TEXT NOT NULL, note TEXT NOT NULL DEFAULT '');
CREATE INDEX IF NOT EXISTS machines_at ON machines(at);
`;

export class CreatureStore {
  private readonly db: any;
  private readonly backend: Backend;

  private constructor(db: any, backend: Backend) {
    this.db = db;
    this.backend = backend;
  }

  static async open(sql: SqlJs, backend: Backend): Promise<CreatureStore> {
    const bytes = await backend.read();
    const db = bytes ? new sql.Database(bytes) : new sql.Database();
    db.run(SCHEMA);
    return new CreatureStore(db, backend);
  }

  private async persist(): Promise<void> {
    await this.backend.write(this.db.export());
  }

  /** Save a design; the same body (same canonical JSON) is stored once and its id returned again. */
  async saveDesign(design: Design, now = new Date().toISOString()): Promise<SavedDesign> {
    const json = canonicalDesign(design);
    const sha256 = await sha256Hex(json);
    const have = this.db.exec('SELECT id FROM designs WHERE sha256 = ?', [sha256]);
    if (!have[0]) {
      this.db.run('INSERT INTO designs (name, sha256, json, created_at) VALUES (?, ?, ?, ?)', [design.name, sha256, json, now]);
      await this.persist();
    }
    return this.designBySha(sha256)!;
  }

  private rows(sql: string, params: unknown[] = []): Record<string, any>[] {
    const stmt = this.db.prepare(sql, params);
    const out: Record<string, any>[] = [];
    while (stmt.step()) out.push(stmt.getAsObject());
    stmt.free();
    return out;
  }

  private toSaved(r: Record<string, any>): SavedDesign {
    return { id: r.id, name: r.name, sha256: r.sha256, createdAt: r.created_at, design: JSON.parse(r.json) };
  }

  designBySha(sha256: string): SavedDesign | null {
    const r = this.rows('SELECT * FROM designs WHERE sha256 = ?', [sha256])[0];
    return r ? this.toSaved(r) : null;
  }

  designs(): SavedDesign[] {
    return this.rows('SELECT * FROM designs ORDER BY id DESC').map((r) => this.toSaved(r));
  }

  async recordMachine(e: MachineEvent): Promise<void> {
    this.db.run('INSERT INTO machines (at, host, kind, note) VALUES (?, ?, ?, ?)', [e.at, e.host, e.kind, e.note]);
    await this.persist();
  }

  /** Oldest first: the story in the order it happened. */
  timeline(): MachineEvent[] {
    return this.rows('SELECT * FROM machines ORDER BY at, id').map((r) => ({ id: r.id, at: r.at, host: r.host, kind: r.kind, note: r.note }));
  }

  /** Re-read from the backend, for when the agent (another writer, in turn) added rows while this tab was idle. */
  static async reload(sql: SqlJs, backend: Backend): Promise<CreatureStore> {
    return CreatureStore.open(sql, backend);
  }

  close(): void { this.db.close(); }
}

export class MemoryBackend implements Backend {
  bytes: Uint8Array | null = null;
  writes = 0;
  async read() { return this.bytes; }
  async write(b: Uint8Array) { this.bytes = b; this.writes++; }
}
