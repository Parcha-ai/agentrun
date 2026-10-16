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

/** A workflow run on a sqlite store, the v3 layout: the journal whole in `agentrun.driver`, its effects, one node's
 *  conversation with a scripted model. `extra` writes more into the same store before it closes. */
async function build(file, extra = async () => undefined) {
  const faux = fauxProvider();
  faux.setResponses([fauxAssistantMessage([fauxToolCall('submit', { verdict: 'buy' })], { stopReason: 'toolUse' })]);
  const models = createModels();
  models.setProvider(faux.provider);
  const nodes = nodeRunner({ agent: () => ({ model: { provider: 'faux', modelId: 'faux-1' } }) });
  const registry = createRegistry();
  registry.install(nodes.extension);
  const harness = await Harness.open(await openNodeSqliteStorage(file), { models, registry }, ctx);
  try {
    const { runNode } = nodes.on(hostScope(harness), ctx);
    const driver = await openRecovery(documentStore(harness, 'run-1'), WORKFLOW, { key: 'run-1' });
    try {
      const result = await runWorkflow(WORKFLOW, { claim: 'x' }, withRecovery(driver, { runNode }, { durableNodes: true }));
      assert.deepEqual(result.output, { verdict: 'buy' });
    } finally { await driver.close(); }
    await extra(harness);
  } finally { await harness.close(ctx); }
  return file;
}
const entriesOf = (file) => rows(file, 'SELECT record FROM entries WHERE conversation_id = (SELECT MIN(conversation_id) FROM entries) ORDER BY id').map((row) => JSON.parse(row.record));

test('a signed-in home, exported: no sign-in in any byte, the host stripped, and the secret kinds never listed in', { skip: signedInHomeSkip, timeout: 120_000 }, async () => {
  const home = await buildSignedInHome(dirOf());
  for (const [name, source] of [['agent', home.agentStore], ['run', home.runStore]]) {
    const before = sha(source);
    const out = join(dirOf(), `${name}.sqlite`);
    const report = exportStore(source, out, { exportable, secrets: [SIGN_IN_MARKER] });
    assert.equal(sha(source), before, 'the source is never changed');
    checkExportClean(out);
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

test('a store over 10 MB is refused and leaves no file; a cap above it is not accepted', { timeout: 120_000 }, async () => {
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
