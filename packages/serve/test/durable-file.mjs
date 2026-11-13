// A read of a run's durable file for the tests that hold documentStore to what it writes: a Session document by its
// address, and a journal as documentStore kept it under one key. Read-only, plain open; the Harness is the only writer.
import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import { apply } from '@earendil-works/chord/delta';
import { effectKey } from '../dist/workflow/store.js';

/** The store `file` opened read-only for `read`, in one read transaction; null when there is no such file. */
function withFile(file, read) {
  if (!existsSync(file)) return null;
  const db = new DatabaseSync(file, { readOnly: true, timeout: 5000 });
  try {
    db.exec('BEGIN');
    return read(db);
  } finally { db.close(); }
}

/** A document's value: its latest base with every later delta applied. */
function revisionsOf(db, id) {
  const base = db.prepare("SELECT seq, content FROM document_revisions WHERE document_id = ? AND kind = 'base' ORDER BY seq DESC LIMIT 1").get(id);
  if (!base) return undefined;
  let value = JSON.parse(base.content);
  for (const delta of db.prepare('SELECT content FROM document_revisions WHERE document_id = ? AND seq > ? ORDER BY seq').all(id, base.seq)) value = apply(value, JSON.parse(delta.content));
  return value;
}

function sessionDocId(db, kind, key) {
  const row = db.prepare("SELECT id FROM documents WHERE kind = ? AND scope_kind = 'session' AND owner_id = 0 AND family = ? AND key_value = ? AND retired_at IS NULL ORDER BY created_at DESC LIMIT 1")
    .get(JSON.stringify(kind), key === undefined ? 0 : 1, JSON.stringify(key ?? ''));
  return row?.id;
}

function sessionDoc(db, kind, key) {
  const id = sessionDocId(db, kind, key);
  return id === undefined ? undefined : revisionsOf(db, id);
}

/** The ids of the effects the map items of `table` own (the keyed layout's `maps`), nested maps included. */
function itemEffects(db, key, table, into) {
  if (!table || typeof table !== 'object' || Array.isArray(table)) return;
  for (const [mapPath, entry] of Object.entries(table)) {
    const started = entry?.items;
    if (typeof started !== 'number' || !Number.isSafeInteger(started)) continue;
    for (let index = 0; index < started; index += 1) {
      const item = sessionDoc(db, 'agentrun.items', effectKey(key, `${mapPath}/items/${index}`));
      if (!item) continue;
      if (Array.isArray(item.effects)) for (const id of item.effects) if (typeof id === 'string') into.push(id);
      itemEffects(db, key, item.maps, into);
    }
  }
}

/** A Session document of the store `file`; undefined when the file or the document is absent. */
export function durableDoc(file, kind, key) {
  return withFile(file, (db) => sessionDoc(db, kind, key)) ?? undefined;
}

/** The journal `key` holds in `file`, as the last commit left it; undefined when none is bound. `effects` are every
 *  effect admitted, once each, in admission order, in either layout (a keyed layout's map items own theirs). */
export function readJournal(file, key) {
  return withFile(file, (db) => {
    const doc = sessionDoc(db, 'agentrun.driver', key);
    if (!doc || doc.binding === null) return undefined;
    const ids = [...doc.effects];
    itemEffects(db, key, doc.state?.maps, ids);
    const admitted = new Map();
    for (const id of new Set(ids)) admitted.set(id, sessionDocId(db, 'agentrun.effects', effectKey(key, id)) ?? Number.MAX_SAFE_INTEGER);
    const effects = [...admitted.keys()].sort((a, b) => admitted.get(a) - admitted.get(b)).map((id) => {
      const e = sessionDoc(db, 'agentrun.effects', effectKey(key, id));
      return { id, name: e?.name ?? '', argsHash: e?.argsHash ?? '', status: e?.status ?? 'unknown', session: e?.session ?? null, result: e?.result ?? null, ...(e?.intent ? { intent: e.intent } : {}), ...(e?.args !== undefined ? { args: e.args } : {}), ...(Array.isArray(e?.calls) ? { calls: e.calls } : {}) };
    });
    return { binding: doc.binding, inputs: doc.inputs, generation: doc.generation, revision: doc.revision, state: doc.state, notes: doc.notes, effects };
  }) ?? undefined;
}
