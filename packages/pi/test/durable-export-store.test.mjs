// exportStore: the one exporter of a run's store for a reader who is not the run. A new file with only the rows the
// allowlist keeps, whole values, no secret, one closed file. The sources are real stores: a signed-in agent home, and a
// workflow run (the v3 recovery layout) with a model's conversation in it.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { BACKGROUND_CONTEXT as ctx } from '@earendil-works/chord/context';
import { createModels } from '@earendil-works/pi-ai/models';
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
import { createRegistry, defineDocFamily, Harness } from '@earendil-works/pi-durable';
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';
import { runWorkflow } from '@parcha/agentrun-dsl';
import { openRecovery, withRecovery } from '@parcha/agentrun-dsl/recovery';
import { credentialIn } from '../dist/credentials.js';
import { documentStore, EXPORT_KINDS, EXPORT_MAX_BYTES, ExportRefused, exportStore, hostScope, nodeRunner, readJournal, recordingLines, SECRET_EXPORT_KINDS } from '../dist/durable/index.js';
import { buildSignedInHome, checkExportClean, SIGN_IN_MARKER, signedInHomeSkip } from '../../pi-durable-agent/test/fixtures/signed-in-home.mjs';
import { EXPORTABLE_KINDS, projectForExport, SECRET_KINDS } from '../../pi-durable-agent/dist/index.js';
import { timelineOf } from '../../pi-durable-agent/dist/timeline/index.js';

const root = mkdtempSync(join(tmpdir(), 'agentrun-export-'));
after(() => rmSync(root, { recursive: true, force: true }));
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');
const exportable = { kinds: EXPORTABLE_KINDS, project: projectForExport };
const dirOf = () => mkdtempSync(join(root, 'case-'));
const sha = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');
const rows = (file, sql) => { const db = new DatabaseSync(file, { readOnly: true }); try { return db.prepare(sql).all().map((row) => ({ ...row })); } finally { db.close(); } };

const VERDICT = { type: 'object', additionalProperties: false, required: ['verdict'], properties: { verdict: { type: 'string' } } };
const WORKFLOW = { v: 2, name: 'one-node', schemas: { Verdict: VERDICT, Out: { type: 'object', required: ['verdict'], properties: { verdict: { type: 'string' } } } },
  output: { schemaId: 'Out', path: 'decision' }, root: { node: 'chain', steps: [{ node: 'decide', label: 'Verdict', instructions: 'Decide buy or pass.', out: 'Verdict', as: 'decision' }] } };
const Other = defineDocFamily({ kind: 'host.unknown', version: 1, scope: 'session', family: true, initial: () => ({ note: '' }) });

/** A workflow run on a sqlite store: the journal in `agentrun.driver` (whole in the v3 layout, with its map items and states
 *  in `agentrun.items` and `agentrun.states` in the v4 one), its effects, each node's conversation with a scripted model.
 *  `extra` writes more into the same store before it closes. */
async function build(file, extra = async () => undefined, { workflow = WORKFLOW, input = { claim: 'x' }, layout, verdicts = 1 } = {}) {
  const faux = fauxProvider();
  faux.setResponses(Array.from({ length: verdicts }, () => fauxAssistantMessage([fauxToolCall('submit', { verdict: 'buy' })], { stopReason: 'toolUse' })));
  const models = createModels();
  models.setProvider(faux.provider);
  const nodes = nodeRunner({ agent: () => ({ model: { provider: 'faux', modelId: 'faux-1' } }) });
  const registry = createRegistry();
  registry.install(nodes.extension);
  const harness = await Harness.open(await openNodeSqliteStorage(file), { models, registry }, ctx);
  try {
    const { runNode } = nodes.on(hostScope(harness), ctx);
    const driver = await openRecovery(documentStore(harness, 'run-1'), workflow, { key: 'run-1', ...(layout ? { layout } : {}) });
    try {
      await runWorkflow(workflow, input, withRecovery(driver, { runNode }, { durableNodes: true }));
    } finally { await driver.close(); }
    await extra(harness);
  } finally { await harness.close(ctx); }
  return file;
}
const entriesOf = (file, conversation) => rows(file, `SELECT record FROM entries WHERE conversation_id = ${conversation === undefined ? '(SELECT MIN(conversation_id) FROM entries)' : Number(conversation)} ORDER BY id`).map((row) => JSON.parse(row.record));
const conversationsOf = (file) => rows(file, 'SELECT DISTINCT conversation_id AS id FROM entries ORDER BY id').map((row) => row.id);

test('a signed-in home, exported: no sign-in in any byte, the host stripped, and the secret kinds never listed in', { skip: signedInHomeSkip, timeout: 120_000 }, async () => {
  const home = await buildSignedInHome(dirOf());
  for (const [name, source] of [['agent', home.agentStore], ['run', home.runStore]]) {
    const before = sha(source);
    const out = join(dirOf(), `${name}.sqlite`);
    const report = exportStore(source, out, { exportable, secrets: [SIGN_IN_MARKER] });
    assert.equal(sha(source), before, 'the source is never changed');
    checkExportClean(out);
    // Read straight from the files' documents tables. `documents.kind` holds the kind as JSON text, quotes included, so the
    // decoded kind is what is compared; the source must hold secret rows (or this proves nothing), the export none.
    const decoded = (file) => rows(file, "SELECT json_extract(kind, '$') AS kind, kind AS raw FROM documents");
    assert.ok(decoded(source).some((row) => SECRET_KINDS.includes(row.kind) && row.raw === JSON.stringify(row.kind)), `${name}: the source holds a secret kind, quoted as stored`);
    const exported = decoded(out);
    assert.deepEqual(exported.filter((row) => SECRET_KINDS.includes(row.kind) || SECRET_KINDS.map((kind) => JSON.stringify(kind)).includes(row.raw)), [], `${name}: no exported row is of a secret kind`);
    assert.ok((name === 'run' || exported.length > 0) && exported.every((row) => row.raw === JSON.stringify(row.kind)), `${name}: the export keeps pi-durable's quoted column`);
    assert.ok(report.bytes === statSync(out).size && report.bytes <= EXPORT_MAX_BYTES);
    assert.equal(report.kept['browser.profiles'], undefined);
    assert.ok(report.dropped['browser.profiles'] >= 1, `${name}: the saved sign-in is dropped by kind`);
    assert.deepEqual(readdirSync(join(out, '..')), [`${name}.sqlite`], 'one closed file, no -wal, -shm or -journal');
  }
  const agentOut = join(dirOf(), 'agent-again.sqlite');
  exportStore(home.agentStore, agentOut, { exportable, secrets: [SIGN_IN_MARKER] });
  const runs = recordingLines(agentOut).lines.filter((line) => line.kind === 'agent.runs');
  assert.ok(runs.length >= 1 && runs.every((line) => !('host' in line.data.value)), 'projectForExport dropped the run\'s host');
  assert.ok(recordingLines(agentOut).lines.some((line) => line.kind === 'agent.definition'));
  // A caller that lists a secret kind keeps nothing of it: this package refuses the known ones itself.
  const greedy = join(dirOf(), 'greedy.sqlite');
  const report = exportStore(home.agentStore, greedy, { exportable: { kinds: [...EXPORTABLE_KINDS, ...SECRET_KINDS] } });
  for (const kind of SECRET_KINDS) assert.equal(report.kept[kind], undefined, kind);
  checkExportClean(greedy);
});

test('the secret kinds this package refuses are the ones @parcha/pi-durable-agent names', () => {
  assert.deepEqual([...SECRET_EXPORT_KINDS].sort(), [...SECRET_KINDS].sort());
  assert.ok(EXPORT_KINDS.every((kind) => kind.startsWith('agentrun.')) && !EXPORT_KINDS.some((kind) => SECRET_KINDS.includes(kind)));
});

test('a v3 run: the timeline, the journal and every kept document read the same from the export as from the source', { timeout: 120_000 }, async () => {
  const source = await build(join(dirOf(), 'run.sqlite'));
  const out = join(dirOf(), 'export.sqlite');
  const report = exportStore(source, out, { exportable });
  const [from, to] = [entriesOf(source), entriesOf(out)];
  assert.ok(from.length >= 3, 'the node\'s conversation has entries');
  assert.deepEqual(to, from);
  assert.deepEqual(timelineOf(to, { settled: true }), timelineOf(from, { settled: true }));
  assert.ok(timelineOf(to, { settled: true }).some((row) => row.kind === 'user_message'));
  assert.deepEqual(readJournal(out, 'run-1'), readJournal(source, 'run-1'));
  for (const kind of ['agentrun.driver', 'agentrun.nodes']) assert.ok(report.kept[kind]?.documents >= 1, kind);
  assert.equal(report.entries, from.length);
  // Whole values: every revision is a base row, and the values are those the source's replay gives.
  assert.deepEqual(rows(out, "SELECT DISTINCT kind FROM document_revisions"), [{ kind: 'base' }]);
  const wanted = recordingLines(source).lines.filter((line) => line.data.doc !== undefined && !line.kind.startsWith('pi.') && report.kept[line.kind]);
  const got = recordingLines(out).lines.filter((line) => line.data.doc !== undefined && !line.kind.startsWith('pi.'));
  assert.deepEqual(got.map((line) => [line.kind, line.data.key, line.commit, line.data.value]), wanted.map((line) => [line.kind, line.data.key, line.commit, line.data.value]));
  assert.equal(report.kept['agentrun.driver'].revisions, got.filter((line) => line.kind === 'agentrun.driver').length);
  checkExportClean(out);
});

const MAPPED = { v: 2, name: 'mapped', schemas: { Verdict: VERDICT, Input: { type: 'object', required: ['claims'], properties: { claims: { type: 'array' } } },
  Out: { type: 'object', required: ['count'], properties: { count: { type: 'integer' } } } }, input: { schemaId: 'Input' }, output: { schemaId: 'Out', path: 'result' },
  root: { node: 'chain', steps: [
    { node: 'map', label: 'each', itemsPath: 'claims', as: 'verdicts', maxConcurrency: 1, body: { node: 'chain', steps: [{ node: 'decide', label: 'Verdict', instructions: 'Decide buy or pass.', out: 'Verdict', as: 'decision' }] } },
    { node: 'code', label: 'count', code: 's => ({ result: { count: s.verdicts.length } })' },
  ] } };

test('a v4 run (the keyed layout): every item, state and conversation reads the same from the export as from the source', { timeout: 120_000 }, async () => {
  assert.ok(EXPORT_KINDS.includes('agentrun.items') && EXPORT_KINDS.includes('agentrun.states'));
  const source = await build(join(dirOf(), 'run.sqlite'), undefined, { workflow: MAPPED, input: { claims: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] }, layout: 'v4', verdicts: 3 });
  const out = join(dirOf(), 'export.sqlite');
  const report = exportStore(source, out, { exportable });
  const journal = readJournal(source, 'run-1');
  assert.equal(journal.state.schema ?? journal.state?.pin?.schema ?? 'agentrun.frozen_run.v4', 'agentrun.frozen_run.v4', 'the source is in the keyed layout');
  assert.ok(rows(source, "SELECT 1 FROM documents WHERE json_extract(kind, '$') = 'agentrun.items'").length >= 3, 'the source keeps one record per map item');
  for (const kind of ['agentrun.items', 'agentrun.states', 'agentrun.driver']) assert.ok(report.kept[kind]?.documents >= 1, kind);
  assert.deepEqual(readJournal(out, 'run-1'), journal);
  // The map's items and the states they reference: the same keys with the same final values, from the exported table.
  const latest = (file, kind) => Object.fromEntries(recordingLines(file).lines.filter((line) => line.kind === kind).map((line) => [line.data.key, line.data.value]));
  for (const kind of ['agentrun.items', 'agentrun.states']) {
    const [from, to] = [latest(source, kind), latest(out, kind)];
    assert.ok(Object.keys(from).length >= 1, kind);
    assert.deepEqual(to, from, kind);
  }
  assert.equal(Object.keys(latest(out, 'agentrun.items')).length, 3);
  // The timeline of every item's conversation.
  const conversations = conversationsOf(source);
  assert.ok(conversations.length >= 3);
  assert.deepEqual(conversationsOf(out), conversations);
  for (const conversation of conversations) {
    assert.deepEqual(timelineOf(entriesOf(out, conversation), { settled: true }), timelineOf(entriesOf(source, conversation), { settled: true }), `conversation ${conversation}`);
  }
  assert.equal(rows(out, "SELECT COUNT(*) AS n FROM documents WHERE json_extract(kind, '$') LIKE 'browser.%'")[0].n, 0);
  checkExportClean(out);
});

test('an unknown kind is dropped, and a kind a caller lists is kept', { timeout: 120_000 }, async () => {
  const source = await build(join(dirOf(), 'run.sqlite'), async (harness) => {
    await harness.commit(async (tx) => { Object.assign(await tx.doc(Other, 'k', null), { note: 'the host\'s own' }); }, ctx);
  });
  const dropped = exportStore(source, join(dirOf(), 'a.sqlite'), { exportable });
  assert.equal(dropped.kept['host.unknown'], undefined);
  assert.equal(dropped.dropped['host.unknown'], 1);
  const keptOut = join(dirOf(), 'b.sqlite');
  const kept = exportStore(source, keptOut, { exportable: { kinds: [...EXPORTABLE_KINDS, 'host.unknown'] } });
  assert.deepEqual(kept.kept['host.unknown'], { documents: 1, revisions: 1 });
  assert.deepEqual(recordingLines(keptOut).lines.filter((line) => line.kind === 'host.unknown').map((line) => line.data.value), [{ note: 'the host\'s own' }]);
  assert.ok(!recordingLines(keptOut).lines.some((line) => line.kind.startsWith('browser.') || line.kind.startsWith('transport.')));
});

test('a store over 10 MiB is refused and leaves no file; a cap above it is not accepted', { timeout: 120_000 }, async () => {
  const source = await build(join(dirOf(), 'run.sqlite'), async (harness) => {
    const journal = await documentStore(harness, 'big', { owner: 'big' }).open({ binding: 'b' });
    await journal.save({ filler: 'x'.repeat(EXPORT_MAX_BYTES + 1024) });
    await journal.close();
  });
  const dir = dirOf();
  const out = join(dir, 'big.sqlite');
  assert.throws(() => exportStore(source, out, { exportable }), (error) => error instanceof ExportRefused && error.code === 'too_large');
  assert.deepEqual(readdirSync(dir), [], 'no file at out, no half-written one beside it');
  assert.throws(() => exportStore(source, out, { exportable, maxBytes: EXPORT_MAX_BYTES + 1 }), (error) => error instanceof ExportRefused && error.code === 'bad_options');
  const small = await build(join(dirOf(), 'small.sqlite'));
  assert.throws(() => exportStore(small, join(dir, 'tiny.sqlite'), { exportable, maxBytes: 4096 }), (error) => error instanceof ExportRefused && error.code === 'too_large');
  assert.deepEqual(readdirSync(dir), []);
});

test('a kept value that holds a credential or an exact secret refuses the export, naming where and never the value', { timeout: 120_000 }, async () => {
  const exact = ['exact', 'secret', 'value', '12345'].join('-');
  const shaped = ['gh', 'p_', 'a'.repeat(36)].join('');
  assert.equal(credentialIn(shaped), 'github token');
  const withState = (state) => build(join(dirOf(), 'run.sqlite'), async (harness) => {
    const journal = await documentStore(harness, 'leaky', { owner: 'leaky' }).open({ binding: 'b' });
    await journal.save(state);
    await journal.close();
  });
  for (const [state, secrets, rule] of [[{ note: `has ${exact} inside` }, [exact], 'exact secret value'], [{ nested: [{ token: shaped }] }, [], 'github token']]) {
    const source = await withState(state);
    const dir = dirOf();
    const error = (() => { try { exportStore(source, join(dir, 'out.sqlite'), { exportable, secrets }); } catch (caught) { return caught; } })();
    assert.ok(error instanceof ExportRefused && error.code === 'found_secret', String(error));
    assert.deepEqual([error.where.kind, error.where.key, error.where.rule], ['agentrun.driver', 'leaky', rule]);
    assert.match(error.where.path, /^\/state\/(note|nested\/0\/token)$/);
    assert.ok(!error.message.includes(exact) && !error.message.includes(shaped), 'the message names the place, not the value');
    assert.deepEqual(readdirSync(dir), []);
  }
  // A secret in what the model was asked (a node's request, its conversation) is found too.
  const source = await build(join(dirOf(), 'run.sqlite'));
  const dir = dirOf();
  assert.throws(() => exportStore(source, join(dir, 'out.sqlite'), { exportable, secrets: ['Decide buy or pass.'] }), (error) => error.code === 'found_secret' && ['pi.entry', 'pi.conversation', 'agentrun.node', 'agentrun.nodes', 'agentrun.driver'].includes(error.where.kind));
  assert.deepEqual(readdirSync(dir), []);
  assert.throws(() => exportStore(source, join(dir, 'out.sqlite'), { exportable, secrets: ['short'] }), (error) => error.code === 'bad_options');
});

test('an image in an entry leaves the row for blobs: a reference with its hash, the bytes once, counted in the size', { timeout: 120_000 }, async () => {
  const source = await build(join(dirOf(), 'run.sqlite'));
  const png = Buffer.from('not really a png, but bytes'.repeat(40));
  const db = new DatabaseSync(source);
  const base = JSON.parse(rows(source, 'SELECT record FROM entries ORDER BY id LIMIT 1')[0].record);
  const conversation = rows(source, 'SELECT MIN(conversation_id) AS id FROM entries')[0].id;
  const record = JSON.stringify({ ...base, id: 9999, content: [{ type: 'text', text: 'a screenshot' }, { type: 'image', mimeType: 'image/png', data: png.toString('base64') }, { type: 'image', mimeType: 'image/png', data: png.toString('base64') }] });
  db.prepare('INSERT INTO entries (id, conversation_id, head, commit_seq, record) VALUES (9999, ?, NULL, 1, ?)').run(conversation, record);
  db.close();
  const out = join(dirOf(), 'out.sqlite');
  const report = exportStore(source, out, { exportable });
  const digest = createHash('sha256').update(png).digest('hex');
  const entry = JSON.parse(rows(out, 'SELECT record FROM entries WHERE id = 9999')[0].record);
  assert.deepEqual(entry.content.slice(1), Array(2).fill({ type: 'image', mimeType: 'image/png', blob: digest }));
  assert.equal(report.blobs, 1);
  const stored = rows(out, 'SELECT sha256, mime_type, bytes FROM blobs');
  assert.deepEqual(stored.map((row) => [row.sha256, row.mime_type, Buffer.from(row.bytes).equals(png)]), [[digest, 'image/png', true]]);
  assert.ok(!readFileSync(out).includes(Buffer.from(png.toString('base64'))), 'the base64 is nowhere in the file');
});

test('the limit is 10 MiB, 10,485,760 bytes: a file of exactly the cap is accepted and one byte over is refused', { timeout: 120_000 }, async () => {
  assert.equal(EXPORT_MAX_BYTES, 10_485_760);
  assert.throws(() => exportStore('unused', join(dirOf(), 'x.sqlite'), { exportable, maxBytes: EXPORT_MAX_BYTES + 1 }), (error) => error.code === 'bad_options');
  const source = await build(join(dirOf(), 'run.sqlite'));
  const dir = dirOf();
  const size = exportStore(source, join(dir, 'measure.sqlite'), { exportable }).bytes;
  const exact = exportStore(source, join(dir, 'exact.sqlite'), { exportable, maxBytes: size });
  assert.equal(exact.bytes, size, 'a file of exactly maxBytes is accepted');
  assert.throws(() => exportStore(source, join(dir, 'over.sqlite'), { exportable, maxBytes: size - 1 }), (error) => error.code === 'too_large');
  assert.deepEqual(readdirSync(dir).sort(), ['exact.sqlite', 'measure.sqlite']);
});

test('an export that exists, a source that does not, and a source left as it was', { timeout: 120_000 }, async () => {
  const source = await build(join(dirOf(), 'run.sqlite'));
  const out = join(dirOf(), 'out.sqlite');
  exportStore(source, out, { exportable });
  const before = sha(out);
  assert.throws(() => exportStore(source, out, { exportable }), (error) => error.code === 'out_exists');
  assert.equal(sha(out), before, 'an existing export is not overwritten');
  assert.throws(() => exportStore(join(dirOf(), 'none.sqlite'), join(dirOf(), 'x.sqlite'), { exportable }), (error) => error.code === 'source_missing');
  assert.equal(existsSync(`${out}.exporting`), false);
});
