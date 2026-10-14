// recordingLines: a run's store as durable recording lines (agentrun.recording/1, section 3.1), read-only. A workflow
// task's store read whole and polled; a driver checkpoint that prunes the history a bare export can see.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, test } from 'node:test';
import { BACKGROUND_CONTEXT as ctx } from '@earendil-works/chord/context';
import { Harness, createRegistry } from '@earendil-works/pi-durable';
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';
import * as recovery from '@parcha/agentrun-dsl/recovery';
import { workspaceFiles } from '@parcha/agentrun-dsl/recovery';
import { DECISION_ROW_VERSION, appendDecision, createWorkflowExtension, documentStore, durableDoc, recordCommits, recordingLines } from '@parcha/agentrun-pi/durable';

const root = mkdtempSync(join(tmpdir(), 'agentrun-recording-'));
after(() => rmSync(root, { recursive: true, force: true }));
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');

const WORKFLOW = {
  v: 2, name: 'recording',
  schemas: { Quote: { type: 'object', required: ['price'], properties: { price: { type: 'number' } } }, Out: { type: 'object', required: ['total'], properties: { total: { type: 'number' } } } },
  output: { schemaId: 'Out', path: 'result' },
  root: { node: 'chain', steps: [
    { node: 'call', label: 'quote', via: 'tool', tool: 'prices.quote', args: { sku: '{sku}' }, out: 'Quote', as: 'quote', deadline_s: 20 },
    { node: 'code', label: 'total', code: 's => ({ result: { total: s.quote.price * 2 } })' },
  ] },
};
const fileOf = () => join(mkdtempSync(join(root, 'run-')), 'run.sqlite');
/** The store's bytes: the database, and its write-ahead log when one holds anything (a read-only open of a database in
 *  WAL mode may leave an empty one; SQLite's read side, not a write). */
const bytesOf = (file) => [file, `${file}-wal`].filter((at) => existsSync(at) && readFileSync(at).length > 0).map((at) => `${at.endsWith('-wal') ? 'wal' : 'db'}:${createHash('sha256').update(readFileSync(at)).digest('hex')}`).join(' ');
/** The store's last commit, read directly. */
const lastCommit = (file) => { const db = new DatabaseSync(file, { readOnly: true }); try { return db.prepare('SELECT next_seq FROM durable_metadata').get().next_seq - 1; } finally { db.close(); } };
/** The validator's durable invariants (section 3): commit never decreases, (commit, order) strictly increases. */
const ordered = (lines) => lines.every((line, i) => i === 0 || line.commit > lines[i - 1].commit || (line.commit === lines[i - 1].commit && line.order > lines[i - 1].order));
/** `order` is the line's place inside its commit: 0, 1, 2, ... in each commit. */
const placed = (lines) => lines.every((line, i) => line.order === (i > 0 && lines[i - 1].commit === line.commit ? lines[i - 1].order + 1 : 0));

async function runTask(file, key) {
  const files = workspaceFiles(mkdtempSync(join(root, 'cwd-')));
  const flow = createWorkflowExtension({ options: () => ({ files }), run: () => ({ adapters: { runEffect: async () => ({ price: 21 }) } }) });
  const registry = createRegistry();
  registry.install(flow.extension);
  const harness = await Harness.open(await openNodeSqliteStorage(file), { registry, models: {} }, ctx);
  try { await (await flow.start(harness, { key, workflow: WORKFLOW, input: { sku: 'A-1' } }, ctx)).wait(ctx); } finally { await harness.close(ctx); }
}

test('a workflow task\'s store: every revision a line with its whole value, then every task at the last commit; gen from the driver; the bytes unchanged', async () => {
  const file = fileOf();
  await runTask(file, 'run-1');
  const before = bytesOf(file);
  const { lines, last } = recordingLines(file);
  assert.equal(bytesOf(file), before, 'a reader never writes');
  assert.ok(ordered(lines) && placed(lines));
  assert.equal(last, lastCommit(file));
  assert.ok(lines.every((line) => line.channel === 'durable' && line.source === (line.kind.startsWith('pi.') ? 'pi' : 'workflow') && !('t' in line)));

  // Documents: `{ doc, key?, value, version }`, the whole value after each revision, and the last one is what the store
  // reads now.
  const documents = lines.filter((line) => line.data.doc !== undefined);
  for (const line of documents) assert.deepEqual([line.kind, typeof line.data.version, 'value' in line.data], [line.data.doc, 'number', true]);
  const effects = documents.filter((line) => line.kind === 'agentrun.effects');
  assert.deepEqual(effects.map((line) => line.data.value.status), ['unknown', 'completed'], 'the admission, then the completion');
  assert.deepEqual(effects.map((line) => [line.data.key, line.path]), Array(2).fill(['run-1\u0000step:/root/steps/0#call:0', '/root/steps/0']));
  assert.deepEqual(effects[1].data.value.result.value, { price: 21 });
  // The DSL's own reader of an effect id reads the same path.
  assert.equal(recovery.frozenEffectPath(effects[0].data.key.split('\u0000')[1]).path, effects[0].path);
  // durableDoc reads session documents; pi's conversation documents carry their conversation instead.
  const latest = new Map(documents.filter((line) => line.conv === undefined).map((line) => [JSON.stringify([line.data.doc, line.data.key ?? null]), line.data.value]));
  assert.ok(latest.size >= 3);
  for (const [id, value] of latest) { const [doc, key] = JSON.parse(id); assert.deepEqual(durableDoc(file, doc, key ?? undefined), value, doc); }
  assert.ok(documents.filter((line) => line.kind.startsWith('pi.')).every((line) => line.conv === 1));

  // Tasks: every task's current record once, at the last commit, after that commit's other lines, by id.
  const tasks = lines.filter((line) => line.data.doc === undefined);
  assert.deepEqual(tasks.map((line) => [line.kind, line.commit, line.data.state.status]), [['agentrun.workflow', last, 'terminal']]);
  assert.equal(lines.at(-1), tasks.at(-1));

  // gen: the driver's generation from its first revision on; the run's entry is committed before the journal opens.
  const firstDriver = lines.findIndex((line) => line.kind === 'agentrun.driver');
  assert.ok(firstDriver > 0 && lines.slice(0, firstDriver).every((line) => line.gen === undefined), 'no gen before the first driver revision');
  assert.ok(lines.slice(firstDriver).every((line) => line.gen === 1));

  // A recorder polling with after = last sees nothing new until a commit lands.
  assert.deepEqual(recordingLines(file, { after: last }), { lines: [], last });
});

test('polled with after = last as commits land, the document lines are one read\'s, and tasks come back at each read\'s last commit', async () => {
  const file = fileOf();
  await runTask(file, 'run-1');
  const first = recordingLines(file);
  await runTask(file, 'run-2');
  const second = recordingLines(file, { after: first.last });
  const whole = recordingLines(file);
  const notTasks = (lines) => lines.filter((line) => line.data.doc !== undefined);
  assert.deepEqual([...notTasks(first.lines), ...notTasks(second.lines)], notTasks(whole.lines));
  assert.deepEqual(second.lines.filter((line) => line.data.doc === undefined).map((line) => [line.kind, line.data.input.key, line.commit]),
    [['agentrun.workflow', 'run-1', whole.last], ['agentrun.workflow', 'run-2', whole.last]]);
  assert.equal(second.last, whole.last);
  assert.ok(second.lines.every((line) => line.commit > first.last));
});

test('a driver checkpoint prunes what a bare export sees: a line before the earliest surviving driver revision has no gen, and a recorder reading each commit saw them all', async () => {
  const file = fileOf();
  const harness = await Harness.open(await openNodeSqliteStorage(file), { registry: createRegistry(), models: {} }, ctx);
  const polled = [];
  let last = 0;
  const poll = () => { const read = recordingLines(file, { after: last }); polled.push(...read.lines); last = read.last; };
  try {
    const journal = await documentStore(harness, 'run-1').open({ binding: 'binding-1' });
    poll();
    await appendDecision(harness, { v: DECISION_ROW_VERSION, at: '2026-10-14T00:00:00.000Z', node: 'n', kind: 'ask', item: null, execution_path: '/root', request_sha256: null, request_bytes: 0,
      model: null, questions: {}, answers: {}, rule: { kind: 'ask', gte: 0.5 }, action: true, usage: null, cost_usd: null, latency_ms: 0 }, ctx);
    poll();
    // The driver document writes a new base after 32 deltas, and pi deletes the revisions before it.
    for (let step = 0; step < 40; step += 1) { await journal.save({ step }); poll(); }
    await journal.close();
  } finally { await harness.close(ctx); }
  const bare = recordingLines(file).lines;
  const decision = (lines) => lines.find((line) => line.kind === 'agentrun.decisions');
  assert.equal(decision(polled).gen, 1, 'read as it landed, the decision has its generation');
  assert.equal(decision(bare).gen, undefined, 'read after the checkpoint, no driver revision at or before it survives');
  const drivers = (lines) => lines.filter((line) => line.kind === 'agentrun.driver').length;
  assert.equal(drivers(polled), 41, 'the open and every save');
  assert.ok(drivers(bare) < 32, `the bare export keeps only the revisions since the last base (${drivers(bare)})`);
  assert.ok(ordered(polled) && ordered(bare));
});

const child = fileURLToPath(new URL('./fixtures/durable-recording-child.mjs', import.meta.url));
const runChild = (mode, file, lines, killAt = '') => new Promise((resolve) => {
  const proc = spawn(process.execPath, [child, mode, file], { env: { ...process.env, LINES: lines, KILL_AT: killAt } });
  let out = '', err = '';
  proc.stdout.on('data', (d) => { out += d; });
  proc.stderr.on('data', (d) => { err += d; });
  proc.on('close', (code, signal) => resolve({ exit: signal ?? code, err, rows: out.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)) }));
});
const pick = (result, key) => result.rows.find((row) => row[key] !== undefined)?.[key];
const isTask = (line) => line.data?.doc === undefined && line.data?.state !== undefined;
const at = (line) => `${line.commit}:${line.order}`;
const docId = (line) => JSON.stringify([line.data.doc, line.data.key ?? null, line.conv ?? null]);

for (const [point, status] of [['after-admit', 'unknown'], ['after-complete', 'completed']]) {
  test(`killed ${point}: the recorder inside the processes writes the export's lines but the commit in flight, tasks at their real commit, and the next snapshot holds what that commit made`, async () => {
    const dir = mkdtempSync(join(root, `recorded-${point}-`));
    const file = join(dir, 'run.sqlite'), out = join(dir, 'lines.jsonl');
    const first = await runChild('start', file, out, point);
    assert.equal(first.exit, 'SIGKILL', first.err);
    const killed = first.rows.find((row) => row.kill !== undefined)?.commit;
    const second = await runChild('resume', file, out);
    assert.equal(second.exit, 0, second.err);
    const [s1, s2] = [pick(first, 'snapshot'), pick(second, 'snapshot')];
    assert.ok(s1 < killed && killed <= s2, JSON.stringify({ s1, killed, s2 }));

    const recorded = readFileSync(out, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
    const events = recorded.filter((line) => !line.snapshot);
    assert.ok(ordered(events), 'commit never decreases and (commit, order) strictly increases across the non-snapshot lines');
    assert.ok(events.every((line) => typeof line.t === 'number'));
    const exported = recordingLines(file).lines;

    // Documents and entries: each exported line is recorded as it is, unless it landed before the first process
    // subscribed, in the commit the kill cut, or in the next process before it took its snapshot.
    const byPlace = new Map(events.filter((line) => !isTask(line)).map((line) => [at(line), line]));
    const missing = [];
    for (const line of exported.filter((line) => !isTask(line))) {
      const seen = byPlace.get(at(line));
      if (!seen) { missing.push(line.commit); continue; }
      const { t: _, gen, ...rest } = seen;
      const { gen: exportedGen, ...expected } = line;
      assert.deepEqual(rest, expected, at(line));
      if (exportedGen !== undefined) assert.equal(gen, exportedGen, at(line));
    }
    assert.ok(missing.includes(killed), 'the commit in flight is lost');
    assert.deepEqual(missing.filter((commit) => commit > s1 && commit <= killed), missing.filter((commit) => commit === killed), 'and no other commit of the first process');
    assert.ok(missing.every((commit) => commit <= s1 || (commit >= killed && commit <= s2)));

    // Tasks: at their real commit. The run's entry and its task are created in one commit, and the task's last line is
    // its record as the store keeps it.
    const workflow = events.filter((line) => isTask(line) && line.kind === 'agentrun.workflow');
    const entry = events.find((line) => line.kind === 'agentrun.task');
    assert.equal(workflow[0].commit, entry.commit);
    assert.ok(workflow.length >= 2 && workflow.every((line, i) => i === 0 || line.commit > workflow[i - 1].commit));
    assert.deepEqual(workflow.at(-1).data, exported.find((line) => isTask(line) && line.kind === 'agentrun.workflow').data);

    // The resumed process's snapshot: every document at its open, equal to the export's latest value at or before it,
    // the effect the lost commit wrote included.
    const snapshot = recorded.filter((line) => line.snapshot && line.commit === s2);
    const state = new Map();
    for (const line of exported) if (!isTask(line) && line.data.doc !== undefined && line.commit <= s2) state.set(docId(line), line.data.value);
    assert.deepEqual(new Map(snapshot.map((line) => [docId(line), line.data.value])), state);
    assert.equal(snapshot.find((line) => line.kind === 'agentrun.effects').data.value.status, status);
    assert.ok(snapshot.every((line, i) => line.order === i));
  });
}

test('an execution path is read back from the ids the DSL builds: an effect\'s id, and a node attempt\'s session key', async () => {
  let emit;
  const recorded = [];
  const stop = recordCommits({ subscribeCommits: (listener) => { emit = listener; return () => {}; } }, { write: (lines) => { recorded.push(...lines); } });
  const document = (id, kind, key) => ({ type: 'document', record: { id, kind, key, scope: { kind: 'session' } }, conversationId: undefined, version: 1, value: {}, ops: [] });
  const paths = ['/root/steps/0', '/root/steps/2/items/3', '/root/steps/1/branches/a:b', '/root/steps/0#call:1/x'];
  const cases = [
    ...paths.flatMap((path, i) => [
      { path, effect: recovery.frozenEffectId(i % 2 ? 'adapt' : 'step', path, i * 7) },
      { path, node: recovery.frozenStepSessionId('run-1', `label: ${i}`, 'step', path, i) },
    ]),
    // A label holding the frame marker: the key names no single path, so the line names none.
    { path: undefined, node: recovery.frozenStepSessionId('run-1', 'x:step:/fake', 'step', '/root/steps/0', 0) },
  ];
  emit({ seq: 1, changes: cases.map((c, i) => c.effect ? document(i + 1, 'agentrun.effects', `run-1\u0000${c.effect}`) : document(i + 1, 'agentrun.nodes', c.node)) }, ctx);
  await stop();
  assert.deepEqual(recorded.map((line) => line.path), cases.map((c) => c.path));
  // The DSL's own reader of an effect id reads every id alike.
  for (const c of cases.filter((c) => c.effect)) assert.equal(recovery.frozenEffectPath(c.effect).path, c.path);
});

test('two journals in one store: a commit\'s generation is its own driver revisions\', in the recorder as in the export', async () => {
  const file = fileOf();
  const harness = await Harness.open(await openNodeSqliteStorage(file), { registry: createRegistry(), models: {} }, ctx);
  const recorded = [];
  const stop = recordCommits(harness, { write: (lines) => { recorded.push(...lines); } });
  try {
    for (let i = 0; i < 2; i += 1) { const journal = await documentStore(harness, 'run-1').open({ binding: 'binding-1' }); await journal.save({ i }); await journal.close(); }
    const other = await documentStore(harness, 'run-2').open({ binding: 'binding-1' });
    await other.save({ other: true });
    await other.close();
  } finally { await stop(); await harness.close(ctx); }
  const exported = recordingLines(file).lines;
  assert.deepEqual(recorded.map((line) => [line.commit, line.order, line.gen]), exported.map((line) => [line.commit, line.order, line.gen]));
  const generations = (key) => [...new Set(recorded.filter((line) => line.data.key === key).map((line) => line.gen))];
  assert.deepEqual([generations('run-1'), generations('run-2')], [[1, 2], [1]], 'the second journal opens at generation 1 after the first reached 2');
});

test('a record in a node attempt\'s conversation takes the node\'s path: its entries, documents and tasks, from a snapshot or a later commit', async () => {
  const node = (id, conversation, path) => ({ type: 'document', record: { id, kind: 'agentrun.nodes', key: recovery.frozenStepSessionId('run-1', `node ${id}`, 'step', path, 0), scope: { kind: 'session' } },
    conversationId: undefined, version: 1, value: { conversation, digest: null, startedMs: null, closed: false }, ops: [] });
  const snapshot = [{ channel: 'durable', source: 'workflow', kind: 'agentrun.nodes', commit: 1, order: 0, gen: 3, snapshot: true, data: { doc: 'agentrun.nodes', key: node(4, 7, '/root/steps/3').record.key, value: { conversation: 7 }, version: 1 } }];
  let emit;
  const recorded = [];
  const stop = recordCommits({ subscribeCommits: (listener) => { emit = listener; return () => {}; } }, { from: snapshot, write: (lines) => { recorded.push(...lines); } });
  emit({ seq: 2, changes: [
    { type: 'entry', value: { id: 20, conversationId: 7, kind: 'pi.assistant', model: [] } },
    { type: 'document', record: { id: 5, kind: 'pi.usage', scope: { kind: 'conversation', conversationId: 7 } }, conversationId: 7, version: 1, value: {}, ops: [] },
    { type: 'task', value: { id: 21, conversationId: 7, kind: 'pi.generation', state: { status: 'running' } } },
    { type: 'entry', value: { id: 22, conversationId: 8, kind: 'pi.user' } },
  ] }, ctx);
  emit({ seq: 3, changes: [node(6, 8, '/root/steps/4'), { type: 'entry', value: { id: 23, conversationId: 8, kind: 'pi.user' } }] }, ctx);
  await stop();
  assert.deepEqual(recorded.map((line) => [line.commit, line.kind, line.conv, line.path, line.gen]), [
    [2, 'pi.usage', 7, '/root/steps/3', 3], [2, 'pi.assistant', 7, '/root/steps/3', 3], [2, 'pi.user', 8, undefined, 3], [2, 'pi.generation', 7, '/root/steps/3', 3],
    [3, 'agentrun.nodes', undefined, '/root/steps/4', 3], [3, 'pi.user', 8, '/root/steps/4', 3],
  ]);
});

test('a host\'s gen never overrides a driver generation: the recorder takes its snapshot\'s, and gen fills in only before any driver revision', async () => {
  const run = async (options, changes) => {
    let emit;
    const recorded = [];
    const stop = recordCommits({ subscribeCommits: (listener) => { emit = listener; return () => {}; } }, { ...options, write: (lines) => { recorded.push(...lines); } });
    emit({ seq: 9, changes }, ctx);
    await stop();
    return recorded.map((line) => line.gen);
  };
  const entry = { type: 'entry', value: { id: 30, conversationId: 1, kind: 'pi.user' } };
  const driver = { channel: 'durable', source: 'workflow', kind: 'agentrun.driver', commit: 8, order: 0, gen: 4, snapshot: true, data: { doc: 'agentrun.driver', key: 'run-1', value: { generation: 4 }, version: 1 } };
  // A host passing its own count (a lease, a process number) lower than the driver's.
  assert.deepEqual(await run({ gen: 3, from: [driver] }, [entry]), [4]);
  assert.deepEqual(await run({ gen: 3 }, [entry]), [3], 'no driver revision yet: the host\'s gen');
  assert.deepEqual(await run({ gen: 3, from: [] }, [entry]), [3]);
});
