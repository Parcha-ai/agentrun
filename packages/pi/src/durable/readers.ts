// Read-only views of a run's durable file, synchronously and without the Harness: a document by its address, a
// journal as `documentStore` wrote it, and the route decisions a frozen snapshot holds. A reader that only looks at
// what ran (the run card, a tail that inherits what a run decided) uses them; the Harness stays the only writer.
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { apply } from "@earendil-works/chord/delta";
import type { RecoveryEffect, RecoveryNote } from "@parcha/agentrun-dsl/recovery";
import { effectKey } from "./store.js";

type Database = import("node:sqlite").DatabaseSync;
type Json = any;

/** A journal read back from the file: what `documentStore` keeps under one key. */
export type JournalView = {
  binding: string; inputs: Record<string, string> | null; generation: number; revision: number; state: Json;
  notes: RecoveryNote[]; effects: RecoveryEffect[];
};
type DriverRecord = { binding: string | null; inputs: Record<string, string> | null; generation: number; revision: number; state: Json; notes: RecoveryNote[]; effects: string[] };

/** The run's durable file, opened read-only for `read`; null when the run has none. Every query of one `read` runs in
 *  one read transaction, so what it returns is one commit's view, whatever a writer commits meanwhile. */
function withDurableFile<T>(directory: string, read: (db: Database) => T): T | null {
  const file = path.join(directory, "durable", "run.sqlite");
  if (!fs.existsSync(file)) return null;
  const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
  const db = new DatabaseSync(file, { readOnly: true, timeout: 5000 });
  try { db.exec("BEGIN"); return read(db); } finally { db.close(); }
}

/** A document's value: its latest base with every later delta applied, as the storage materializes it. */
function revisionsOf(db: Database, id: number): Record<string, unknown> | undefined {
  const base = db.prepare("SELECT seq, content FROM document_revisions WHERE document_id = ? AND kind = 'base' ORDER BY seq DESC LIMIT 1").get(id) as { seq: number; content: string } | undefined;
  if (!base) return undefined;
  let value = JSON.parse(base.content);
  for (const delta of db.prepare("SELECT content FROM document_revisions WHERE document_id = ? AND seq > ? ORDER BY seq").all(id, base.seq) as Array<{ content: string }>) {
    value = apply(value, JSON.parse(delta.content));
  }
  return value;
}

/** A Session document's current value. `key` names a family member; a singleton has none. */
function sessionDoc(db: Database, kind: string, key?: string): Record<string, unknown> | undefined {
  const row = db.prepare("SELECT id FROM documents WHERE kind = ? AND scope_kind = 'session' AND owner_id = 0 AND family = ? AND key_value = ? AND retired_at IS NULL ORDER BY created_at DESC LIMIT 1")
    .get(JSON.stringify(kind), key === undefined ? 0 : 1, JSON.stringify(key ?? "")) as { id?: number } | undefined;
  return row?.id === undefined ? undefined : revisionsOf(db, row.id);
}

/** A Session document of the run's durable file, read-only; undefined when the file or the document is absent. */
export function durableDoc<T = Record<string, unknown>>(directory: string, kind: string, key?: string): T | undefined {
  return (withDurableFile(directory, (db) => sessionDoc(db, kind, key)) ?? undefined) as T | undefined;
}

/** The journal `key` holds in the run's durable file, as the last commit left it; undefined when the file holds no
 *  such journal or none has bound it. */
export function readJournal(directory: string, key: string): JournalView | undefined {
  return withDurableFile(directory, (db): JournalView | undefined => {
    const doc = sessionDoc(db, "agentrun.driver", key) as DriverRecord | undefined;
    if (!doc || doc.binding === null) return undefined;
    const effects = doc.effects.map((id) => {
      const e = sessionDoc(db, "agentrun.effects", effectKey(key, id)) as (Omit<RecoveryEffect, "id"> & { intent?: { tool: string; argsHash: string } }) | undefined;
      return { id, name: e?.name ?? "", argsHash: e?.argsHash ?? "", status: e?.status ?? "unknown", session: e?.session ?? null, result: e?.result ?? null, ...(e?.intent ? { intent: e.intent } : {}) } as RecoveryEffect;
    });
    return { binding: doc.binding, inputs: doc.inputs, generation: doc.generation, revision: doc.revision, state: doc.state, notes: doc.notes, effects };
  }) ?? undefined;
}

/** Every committed route decision a frozen snapshot holds (each judge's answer, whole), by execution path. Empty for a
 *  state that is no snapshot. */
export function committedRoutes(state: unknown): Record<string, Json> {
  const routes = (state as { pin?: { routes?: Record<string, Json> } } | null)?.pin?.routes;
  return routes && typeof routes === "object" && !Array.isArray(routes) ? { ...routes } : {};
}
