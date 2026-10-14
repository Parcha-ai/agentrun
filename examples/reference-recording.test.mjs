// The reference job's store, killed ten times by the ten-kill ledger, read as durable recording lines
// (agentrun.recording/1, section 3.1) after the run: the validator's invariants hold, the last line of each document is
// what the store reads, every counter of section 6 the export can give folds from the lines to the number the store and
// the ledger give, a reader never writes, and polling with after = last returns nothing.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { test } from 'node:test';
import { BACKGROUND_CONTEXT as ctx } from '@earendil-works/chord/context';
import { apply } from '@earendil-works/chord/delta';
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';
import { durableDoc, readJournal, recordingLines, snapshotLines } from '@parcha/agentrun-pi/durable';
import { placeAt, RUN_KEY } from './reference/assemble.ts';
import { killAnywhere } from './reference/kill-anywhere.ts';

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');
const bytesOf = (file) => [file, `${file}-wal`].filter((at) => existsSync(at) && readFileSync(at).length > 0).map((at) => createHash('sha256').update(readFileSync(at)).digest('hex')).join(' ');
const isTask = (line) => line.data?.doc === undefined && line.data?.state !== undefined;
/** A document's identity in the lines: its kind, its family key and its conversation (a conversation's singleton, such as
 *  `pi.live`, exists once in each conversation). */
const docId = (doc, key, conv) => JSON.stringify([doc, key ?? null, conv ?? null]);

/** Section 3's durable invariants: commit never decreases, (commit, order) strictly increases. */
const ordered = (lines) => lines.every((line, i) => i === 0 || line.commit > lines[i - 1].commit || (line.commit === lines[i - 1].commit && line.order > lines[i - 1].order));

/** Every document the store holds, materialized the way the frozen reader does (the latest base, then each later
 *  delta), whatever its scope: `durableDoc` reads only Session documents. */
function storedDocuments(file) {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const out = new Map();
    const taskConversation = new Map(db.prepare('SELECT id, conversation_id FROM tasks').all().map((task) => [task.id, task.conversation_id]));
    for (const doc of db.prepare('SELECT id, kind, family, key_value, scope_kind, owner_id FROM documents WHERE retired_at IS NULL').all()) {
      const base = db.prepare("SELECT seq, content FROM document_revisions WHERE document_id = ? AND kind = 'base' ORDER BY seq DESC LIMIT 1").get(doc.id);
      if (!base) continue;
      let value = JSON.parse(base.content);
      for (const delta of db.prepare('SELECT content FROM document_revisions WHERE document_id = ? AND seq > ? ORDER BY seq').all(doc.id, base.seq)) value = apply(value, JSON.parse(delta.content));
      const conv = doc.scope_kind === 'conversation' ? doc.owner_id : doc.scope_kind === 'task' ? taskConversation.get(doc.owner_id) : undefined;
      assert.ok(!out.has(docId(JSON.parse(doc.kind), doc.family ? JSON.parse(doc.key_value) : undefined, conv)), 'one document per identity');
      out.set(docId(JSON.parse(doc.kind), doc.family ? JSON.parse(doc.key_value) : undefined, conv), value);
    }
    return out;
  } finally { db.close(); }
}

/** The tool calls the agent executed, from its conversation entries: each result joined to the call that asked it,
 *  identified by (tool, arguments); `reused` and `refused` results are not executions (section 6, "repeated"). */
function executedCalls(entries) {
  const asked = new Map();
  for (const entry of entries.filter((e) => e.data.kind === 'pi.assistant')) for (const block of entry.data.model?.[0]?.content ?? []) if (block.type === 'toolCall') asked.set(block.id, block);
  return entries.filter((e) => e.data.kind === 'pi.tool-result').flatMap((e) => {
    const result = e.data.model?.[0];
    if (!result || result.details?.reused || result.details?.refused) return [];
    const call = asked.get(result.toolCallId);
    return [{ identity: JSON.stringify([result.toolName, call?.arguments ?? null]), gen: e.gen, commit: e.commit }];
  });
}

/** The counters of section 6 the export can give, folded from durable lines alone. */
function fold(lines) {
  const latest = new Map();
  for (const line of lines) if (line.data?.doc !== undefined) latest.set(docId(line.data.doc, line.data.key, line.conv), line);
  const values = (kind) => [...latest.values()].filter((line) => line.kind === kind).map((line) => line.data.value);
  const effects = values('agentrun.effects');
  const rows = values('agentrun.decisions').flatMap((value) => value.receipts ?? []);
  const answered = rows.filter((row) => row.rule !== null && row.error === undefined);
  const perDecision = new Map();
  for (const row of answered) perDecision.set(JSON.stringify([row.decision_id ?? null, row.run_key ?? null]), (perDecision.get(JSON.stringify([row.decision_id ?? null, row.run_key ?? null])) ?? 0) + 1);
  // Dispatches by identity: an effect at its admission (its first line), an agent's executed tool call at its result.
  const admitted = new Map();
  for (const line of lines) if (line.kind === 'agentrun.effects' && !admitted.has(line.data.key)) admitted.set(line.data.key, line);
  const dispatches = [
    ...[...admitted.values()].map((line) => ({ identity: JSON.stringify(line.data.value.intent ? [line.data.value.intent.tool, line.data.value.intent.argsHash] : [line.data.value.name, line.data.value.argsHash]), gen: line.gen, commit: line.commit })),
    ...executedCalls(lines.filter((line) => line.source === 'pi' && line.data?.doc === undefined && !isTask(line))),
  ];
  const byIdentity = new Map();
  for (const d of dispatches) byIdentity.set(d.identity, [...(byIdentity.get(d.identity) ?? []), d]);
  const again = [...byIdentity.values()].filter((list) => list.length > 1);
  return {
    made: { workflow: effects.filter((e) => e.status === 'completed').length, receipts: values('agentrun.receipts').length, browser: values('browser.sessions').reduce((n, v) => n + (v.sessions?.length ?? 0), 0) },
    unknown: effects.filter((e) => e.status === 'unknown').length,
    judge: { answered: answered.length, failed: rows.filter((row) => row.error !== undefined).length, reasked: [...perDecision.values()].filter((n) => n > 1).length },
    turns: lines.filter((line) => line.kind === 'pi.assistant' && line.data?.doc === undefined).length,
    // With every identity dispatched once, neither "repeated" nor "asked twice" needs a generation to fold.
    dispatchedTwice: again.length,
  };
}

test('the ten-kill ledger\'s store as recording lines: invariants, values, every counter the export gives, read-only, nothing after last', { timeout: 300_000 }, async (t) => {
  const ledger = await killAnywhere({ seed: 21, kills: 10, keep: true });
  t.after(() => rmSync(ledger.scratch, { recursive: true, force: true }));
  assert.deepEqual(ledger.checks.filter((check) => !check.ok).map((check) => check.name), []);
  const file = join((await placeAt(join(ledger.scratch, 'cut'))).store, 'run.sqlite');

  const before = bytesOf(file);
  const { lines, last } = recordingLines(file);
  assert.equal(bytesOf(file), before, 'a reader never writes');
  assert.deepEqual(recordingLines(file, { after: last }), { lines: [], last });
  // Polled from inside the history: from the commit of an entry on, nothing at or before it comes back, and the
  // document and entry lines after it are the whole read's.
  const cut = lines.find((line) => line.kind === 'pi.assistant').commit;
  const later = recordingLines(file, { after: cut }).lines;
  assert.ok(later.every((line) => line.commit > cut));
  assert.deepEqual(later.filter((line) => !isTask(line)), lines.filter((line) => line.commit > cut && !isTask(line)));
  assert.ok(ordered(lines), 'commit never decreases; (commit, order) strictly increases');
  assert.ok(lines.every((line, i) => line.order === (i > 0 && lines[i - 1].commit === line.commit ? lines[i - 1].order + 1 : 0)), 'order counts from 0 in each commit');
  // A conversation entry belongs to its conversation; so does a conversation's document.
  const entryLines = lines.filter((line) => line.data?.doc === undefined && !isTask(line));
  assert.ok(entryLines.length > 0 && entryLines.every((line) => line.source === 'pi' && line.conv === line.data.conversationId));
  assert.ok(lines.filter((line) => line.kind.startsWith('pi.') && line.data?.doc !== undefined).every((line) => typeof line.conv === 'number'));
  // The node attempt's conversation: its entries, documents and tasks carry the node's path, so a branch's view holds
  // its agent's turns.
  const node = lines.find((line) => line.kind === 'agentrun.nodes');
  const inNode = lines.filter((line) => line.conv === node.data.value.conversation);
  assert.equal(node.path, '/root/steps/1');
  assert.ok(inNode.some((line) => line.kind === 'pi.assistant') && inNode.every((line) => line.path === node.path));

  // Kinds and sources (section 3.1): by prefix, a kind with none is the host's; every task once, at the last commit.
  const sources = new Map(lines.map((line) => [line.kind, line.source]));
  for (const [kind, source] of sources) assert.equal(source, kind.startsWith('agentrun.') ? 'workflow' : kind.startsWith('browser.') ? 'browser' : kind.startsWith('pi.') ? 'pi' : 'host', kind);
  assert.equal(sources.get('reference.label'), 'host');
  const tasks = lines.filter(isTask);
  assert.ok(tasks.length > 0 && tasks.every((line) => line.commit === last) && lines.slice(-tasks.length).every(isTask));
  assert.deepEqual(new Set(tasks.map((line) => line.kind)), new Set(['agentrun.workflow', 'pi.generation', 'pi.tool', 'browser.release']));

  // gen: the driver's generation from its earliest surviving revision on (it checkpoints every 32 deltas); none before.
  const firstDriver = lines.find((line) => line.kind === 'agentrun.driver');
  assert.ok(lines.filter((line) => line.commit < firstDriver.commit).every((line) => line.gen === undefined));
  assert.ok(lines.filter((line) => line.commit >= firstDriver.commit).every((line) => typeof line.gen === 'number'));
  // It counts journal opens, not processes (section 6, "processes"): this host opens the journal twice in each one.
  assert.equal(Math.max(...lines.map((line) => line.gen ?? 0)), durableDoc(file, 'agentrun.driver', RUN_KEY).generation);
  assert.ok(ledger.processes < durableDoc(file, 'agentrun.driver', RUN_KEY).generation);

  // The last line of every document is the store's value: Session documents as durableDoc reads them, every document as
  // the frozen reader materializes it.
  const stored = storedDocuments(file);
  const lastValue = new Map();
  for (const line of lines) if (line.data?.doc !== undefined) lastValue.set(docId(line.data.doc, line.data.key, line.conv), line);
  assert.deepEqual(new Set(lastValue.keys()), new Set(stored.keys()));
  for (const [id, line] of lastValue) {
    assert.deepEqual(line.data.value, stored.get(id), id);
    if (line.conv === undefined) assert.deepEqual(durableDoc(file, line.data.doc, line.data.key), line.data.value, id);
  }

  // Section 6, folded from the lines, against the store read directly and against the ledger's own count.
  const folded = fold(lines);
  const journal = readJournal(file, RUN_KEY);
  const db = new DatabaseSync(file, { readOnly: true });
  const entries = db.prepare('SELECT record FROM entries ORDER BY id').all().map((row) => JSON.parse(row.record));
  db.close();
  const decisions = durableDoc(file, 'agentrun.decisions').receipts;
  const answeredRows = decisions.filter((row) => row.rule !== null && !row.error);
  const perDecision = answeredRows.reduce((m, row) => m.set(JSON.stringify([row.decision_id ?? null, row.run_key ?? null]), (m.get(JSON.stringify([row.decision_id ?? null, row.run_key ?? null])) ?? 0) + 1), new Map());
  const identities = [
    ...journal.effects.map((e) => JSON.stringify(e.intent ? [e.intent.tool, e.intent.argsHash] : [e.name, e.argsHash])),
    ...executedCalls(entries.map((record) => ({ data: record }))).map((call) => call.identity),
  ];
  const fromStore = {
    made: {
      workflow: journal.effects.filter((e) => e.status === 'completed').length,
      receipts: [...stored.keys()].filter((id) => JSON.parse(id)[0] === 'agentrun.receipts').length,
      browser: [...stored.entries()].filter(([id]) => JSON.parse(id)[0] === 'browser.sessions').reduce((n, [, v]) => n + v.sessions.length, 0),
    },
    unknown: journal.effects.filter((e) => e.status === 'unknown').length,
    judge: { answered: answeredRows.length, failed: decisions.filter((row) => row.error).length, reasked: [...perDecision.values()].filter((n) => n > 1).length },
    turns: entries.filter((record) => record.kind === 'pi.assistant').length,
    dispatchedTwice: [...identities.reduce((m, id) => m.set(id, (m.get(id) ?? 0) + 1), new Map()).values()].filter((n) => n > 1).length,
  };
  assert.deepEqual(folded, fromStore);
  assert.deepEqual(folded.made, { workflow: 1, receipts: 0, browser: 1 });
  assert.equal(folded.made.workflow, Object.values(ledger.counted.effects).reduce((n, k) => n + k, 0), 'paid effects, as the ledger counts them');
  assert.equal(folded.made.browser, ledger.counted.browser.create, 'browser sessions, as the backend counts them');
  assert.equal(folded.judge.answered, Object.values(ledger.counted.judge).reduce((n, k) => n + k, 0), 'judge asks, as the ledger counts them');
  assert.equal(folded.turns, ledger.counted.committedTurns.length, 'committed turns, as the ledger counts them from the store');
  assert.equal(folded.unknown, 0);
  assert.equal(ledger.final.status, 'complete');

  // snapshotLines over the same store, opened as a process would open it: every document's value as the export's last
  // line, the node's conversation with the node's path, every line a snapshot at the given commit.
  const storage = await openNodeSqliteStorage(file);
  try {
    const snapshot = await snapshotLines(storage, { at: last, context: ctx });
    assert.ok(snapshot.every((line, i) => line.snapshot === true && line.commit === last && line.order === i));
    assert.deepEqual(new Map(snapshot.map((line) => [docId(line.data.doc, line.data.key, line.conv), line.data.value])), new Map([...lastValue].map(([id, line]) => [id, line.data.value])));
    for (const line of snapshot) {
      const exported = lastValue.get(docId(line.data.doc, line.data.key, line.conv));
      assert.equal(line.path, exported.path, docId(line.data.doc, line.data.key, line.conv));
    }
    assert.ok(snapshot.some((line) => line.conv === node.data.value.conversation && line.path === node.path));
  } finally { await storage.close(ctx); }
});
