// Read-only views of a run's durable file, synchronously and without the Harness: a document by its address, a
// journal as `documentStore` wrote it, and the route decisions a frozen snapshot holds. A reader that only looks at
// what ran (the run card, a tail that inherits what a run decided) uses them; the Harness stays the only writer. The
// readers take the store file itself (pi-durable's SQLite file, wherever the host keeps it), never a directory.
import fs from "node:fs";
import { createRequire } from "node:module";
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

/** The run's store `file`, opened read-only for `read`; null when there is no such file. Every query of one `read` runs
 *  in one read transaction, so what it returns is one commit's view, whatever a writer commits meanwhile. */
export function withDurableFile<T>(file: string, read: (db: Database) => T): T | null {
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

/** The row of a Session document. `key` names a family member; a singleton has none. */
function sessionDocId(db: Database, kind: string, key?: string): number | undefined {
  const row = db.prepare("SELECT id FROM documents WHERE kind = ? AND scope_kind = 'session' AND owner_id = 0 AND family = ? AND key_value = ? AND retired_at IS NULL ORDER BY created_at DESC LIMIT 1")
    .get(JSON.stringify(kind), key === undefined ? 0 : 1, JSON.stringify(key ?? "")) as { id?: number } | undefined;
  return row?.id;
}

/** A Session document's current value. `key` names a family member; a singleton has none. */
function sessionDoc(db: Database, kind: string, key?: string): Record<string, unknown> | undefined {
  const id = sessionDocId(db, kind, key);
  return id === undefined ? undefined : revisionsOf(db, id);
}

/** The ids of the effects the map items of `table` own (the keyed layout's `maps`: `{ <map path>: { items, ... } }`), each
 *  item's own nested maps included, read as the driver reads them back: item `i` of a map is its record at
 *  `<map path>/items/<i>`, for every item the map started. */
function itemEffects(db: Database, key: string, table: unknown, into: string[]): void {
  if (!table || typeof table !== "object" || Array.isArray(table)) return;
  for (const [mapPath, entry] of Object.entries(table as Record<string, { items?: unknown } | null>)) {
    const started = entry?.items;
    if (typeof started !== "number" || !Number.isSafeInteger(started)) continue;
    for (let index = 0; index < started; index += 1) {
      const item = sessionDoc(db, "agentrun.items", effectKey(key, `${mapPath}/items/${index}`)) as { effects?: unknown; maps?: unknown } | undefined;
      if (!item) continue;
      if (Array.isArray(item.effects)) for (const id of item.effects) if (typeof id === "string") into.push(id);
      itemEffects(db, key, item.maps, into);
    }
  }
}

/** A Session document of the run's store `file`, read-only; undefined when the file or the document is absent. */
export function durableDoc<T = Record<string, unknown>>(file: string, kind: string, key?: string): T | undefined {
  return (withDurableFile(file, (db) => sessionDoc(db, kind, key)) ?? undefined) as T | undefined;
}

/** The journal `key` holds in the run's store `file`, as the last commit left it; undefined when the file holds no
 *  such journal or none has bound it. `effects` are every effect the journal admitted, once each, in the order they were
 *  admitted, in either layout: in the keyed one (`agentrun.frozen_run.v4`) the effects a map item owns, nested maps
 *  included, are listed by that item's record, not the driver's, and are read from there. `state` is the driver's own
 *  record: in the keyed layout what lies in each map item stays in the item's record. */
export function readJournal(file: string, key: string): JournalView | undefined {
  return withDurableFile(file, (db): JournalView | undefined => {
    const doc = sessionDoc(db, "agentrun.driver", key) as DriverRecord | undefined;
    if (!doc || doc.binding === null) return undefined;
    // The driver's record lists the effects no map item owns; in the keyed layout each item's record lists its own. All of
    // them, once each, in the order they were admitted: an effect's document is created by its admission, and a document's
    // row is numbered when it is created (a later checkpoint folds its revisions, never its row).
    const ids = [...doc.effects];
    itemEffects(db, key, (doc.state as { maps?: unknown } | null)?.maps, ids);
    const admitted = new Map<string, number>();
    for (const id of new Set(ids)) admitted.set(id, sessionDocId(db, "agentrun.effects", effectKey(key, id)) ?? Number.MAX_SAFE_INTEGER);
    // A stable sort: an id whose document is missing keeps its place in the listing, after every admitted one.
    const effects = [...admitted.keys()].sort((a, b) => admitted.get(a)! - admitted.get(b)!).map((id) => {
      const e = sessionDoc(db, "agentrun.effects", effectKey(key, id)) as (Omit<RecoveryEffect, "id"> & { intent?: { tool: string; argsHash: string } }) | undefined;
      return { id, name: e?.name ?? "", argsHash: e?.argsHash ?? "", status: e?.status ?? "unknown", session: e?.session ?? null, result: e?.result ?? null, ...(e?.intent ? { intent: e.intent } : {}), ...(e?.args !== undefined ? { args: e.args } : {}), ...(Array.isArray((e as { calls?: unknown })?.calls) ? { calls: (e as { calls: unknown[] }).calls } : {}) } as RecoveryEffect;
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
