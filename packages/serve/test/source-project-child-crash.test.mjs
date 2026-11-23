// A real isolated child writes through its ordinary tool, then exits before requesting a checkpoint.
// The model is scripted; source publication, HTTP admission, terminal journal and project storage are real.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { agent, follow, serve } from './support.mjs';
import { sourceSnapshotDigest } from '../dist/native/source-snapshot-types.js';
import { sourceWorkspace } from '../dist/source-sync/workspace.js';
import { commitSourceSnapshot } from '../dist/source-sync/snapshots.js';
import { sourceKey } from '../dist/source-sync/registry.js';
import { reconcileProjectCheckpoints } from '../dist/source-sync/checkpoints.js';
import { runFolder } from '../dist/workspace/paths.js';

async function fixture(t, moved) {
  const dir = await mkdtemp(join(tmpdir(), 'source-child-crash-'));
  let server;
  t.after(async () => { await server?.stop(); await rm(dir, { recursive: true, force: true }); });
  const model = join(dir, 'model.mjs'), calls = join(dir, 'calls.jsonl');
  await writeFile(model, `import { appendFileSync } from 'node:fs';
const textOf = m => typeof m?.content === 'string' ? m.content : (m?.content ?? []).map(c => c.type === 'text' ? c.text : '').join('');
export default function reply(context, faux) {
  const last = context.messages.at(-1), task = context.messages.findLast(m => m.role === 'user');
  appendFileSync(${JSON.stringify(calls)}, JSON.stringify({ pid: process.pid, role: last?.role, tool: last?.toolName }) + '\\n');
  if (last?.role === 'toolResult') {
    if (textOf(task).includes('Crash after writing')) process.exit(91);
    return faux.message(textOf(last));
  }
  return faux.message(textOf(task).includes('Crash after writing') || textOf(task).includes('Save before reopening')
    ? faux.toolCall('write', { path: 'state.txt', content: textOf(task).includes('Crash after writing') ? 'edited immediately before the child crashed' : 'saved before the reopened crash' })
    : faux.toolCall('read', { path: 'state.txt' }), { stopReason: 'toolUse' });
}
`);
  const logs = [];
  server = await serve(t, { faux: model, childRuns: { log: line => logs.push(line) } });
  const id = moved ? 'moved-crash' : 'ordinary-crash';
  assert.equal((await server.api('POST', '/agents', agent(id, { tools: ['read', 'write'], learning: false }))).status, 201);
  if (moved) {
    const bytes = Buffer.from('source baseline'), sha256 = createHash('sha256').update(bytes).digest('hex');
    const body = { version: 1, complete: true,
      source: { runtime: 'codex', machine_id: 'fixture', project: '/fixture/offline-source', selector: { kind: 'project' } },
      entries: [{ path: 'project', role: 'project', type: 'directory', mode: 0o755, bytes: 0 },
        { path: 'project/state.txt', role: 'project', type: 'file', mode: 0o644, bytes: bytes.length, sha256 }],
      blobs: { [sha256]: bytes.toString('base64') }, instructions: { text: '', layers: [] }, skills: [],
      configuration: { model: null, tools: [], permissions: {}, credentials: [] }, project: { git: null }, blockers: [] };
    const snapshot = { ...body, digest: sourceSnapshotDigest(body) };
    const entry = await server.store.agents.get(id), revision = await server.store.agents.revision(entry.currentRevision);
    await server.store.agents.addRevision({ agentId: id, id: 'moved-baseline', kind: revision.kind, ifCurrent: entry.currentRevision,
      body: { ...revision.body, sourceSync: { id: 'a'.repeat(64), snapshot: snapshot.digest, project: snapshot.digest, configuration: 'b'.repeat(64) } } });
    const cache = await sourceWorkspace(server.store, id, { data: server.data, sealKey: undefined, env: {} });
    try { await commitSourceSnapshot(cache.workspace, snapshot); } finally { await cache.end(); }
    await server.store.settings.put(sourceKey(id), { version: 1, id: 'a'.repeat(64), agent_id: id, source: snapshot.source,
      capture_revision: revision.id, generation: 'fixture-source-generation', enabled: false, sequence: 1, snapshot: snapshot.digest });
    const status = await server.api('GET', `/agents/${id}/source`);
    assert.equal(status.body.moved, true); assert.equal(status.body.state, 'paused', 'the original source is offline');
  }
  const start = content => server.api('POST', `/agents/${id}/runs`, { input: { content } });
  return { ...server, id, logs, calls, start };
}

for (const { moved, reopened } of [{ moved: true, reopened: false }, { moved: true, reopened: true }, { moved: false, reopened: false }]) test(`${reopened ? 'a reopened moved' : moved ? 'a moved' : 'an ordinary'} child crash after an actual write ${moved ? 'requires explicit project review before another run' : 'does not invent a source checkpoint'}`, { timeout: 120_000 }, async t => {
  const f = await fixture(t, moved), started = await f.start(reopened ? 'Save before reopening.' : 'Crash after writing.');
  assert.equal(started.status, 202, JSON.stringify(started.body));
  const runId = started.body.run_id;
  let priorReceipt;
  if (reopened) {
    await follow(f.api, runId, ['completed'], { deadlineMs: 60_000 });
    priorReceipt = (await f.store.runs.projectCheckpoints({ agentId: f.id, runId })).at(-1);
    assert.equal(priorReceipt?.checkpoint.status, 'candidate', 'the earlier turn really captured a project');
    // The test's standalone runner leaves publication to the normal recovery/admission reconciler.
    // Exercise that real CAS on the child's committed candidate before reopening the same run.
    await reconcileProjectCheckpoints(f.store, f.id, { runId });
    assert.equal((await f.store.agents.get(f.id)).currentRevision, priorReceipt.checkpoint.revision);
    const published = await f.api('GET', `/agents/${f.id}/source`);
    assert.equal(published.body.project_issues?.length ?? 0, 0, 'the saved earlier project has no unresolved review');
    const resumed = await f.api('POST', `/runs/${runId}/messages`, { content: 'Crash after writing.' });
    assert.equal(resumed.status, 202, JSON.stringify(resumed.body));
  }
  await follow(f.api, runId, ['failed'], { deadlineMs: 60_000 });
  assert.equal(await readFile(join(runFolder(f.data, f.id, runId), 'state.txt'), 'utf8'), 'edited immediately before the child crashed');
  const calls = (await readFile(f.calls, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.ok(calls.some(row => row.role === 'toolResult' && row.tool === 'write'), 'the ordinary write finished before the forced crash');
  assert.ok(calls.every(row => row.pid !== process.pid), 'the crashing model actually ran in the isolated child');
  const receipts = await f.store.runs.projectCheckpoints({ agentId: f.id, runId });
  const next = await f.start('Read the saved project.');
  let incorrectlyAdmittedAnswer;
  if (next.status === 202) {
    await follow(f.api, next.body.run_id, ['completed'], { deadlineMs: 60_000 });
    incorrectlyAdmittedAnswer = (await f.api('GET', `/runs/${next.body.run_id}`)).body.result?.final_answer;
  }
  if (!moved) {
    assert.equal(next.status, 202, JSON.stringify(next.body));
    assert.deepEqual(receipts, []);
    return;
  }
  assert.equal(next.status, 409, JSON.stringify({ next: next.body, receipts, incorrectlyAdmittedAnswer, logs: f.logs }));
  assert.equal(next.body.error.code, 'agent_not_runnable');
  assert.equal(receipts.length, reopened ? 2 : 1, 'the later real failed terminal entry remains visible beside any earlier captured project');
  const crashedReceipt = receipts.at(-1);
  if (reopened) assert.ok(crashedReceipt.entryId > priorReceipt.entryId, 'the reopened failure has its own newer durable entry');
  const status = await f.api('GET', `/agents/${f.id}/source`);
  assert.equal(status.body.state, 'needs_attention');
  assert.deepEqual(status.body.project_issues.map(row => row.run_id), [runId]);
  assert.equal(status.body.project_issues[0].status, 'uncertain');
  assert.equal(status.body.project_issues[0].entry_id, crashedReceipt.entryId);
  assert.equal((await f.store.agents.get(f.id)).currentRevision, priorReceipt?.checkpoint.revision ?? 'moved-baseline', 'crashed changes are never silently published');
  if (reopened) {
    const staleReview = await f.api('POST', `/agents/${f.id}/source/project-review`, { receipts: [{ run_id: runId, entry_id: priorReceipt.entryId }] });
    assert.equal(staleReview.status, 412, 'reviewing an earlier receipt cannot acknowledge the later crash');
  }
  const reviewed = await f.api('POST', `/agents/${f.id}/source/project-review`, { receipts: [{ run_id: runId, entry_id: crashedReceipt.entryId }] });
  assert.equal(reviewed.status, 200, JSON.stringify(reviewed.body));
  const accepted = await f.start('Read the saved project.');
  assert.equal(accepted.status, 202, JSON.stringify(accepted.body));
  await follow(f.api, accepted.body.run_id, ['completed'], { deadlineMs: 60_000 });
  assert.match((await f.api('GET', `/runs/${accepted.body.run_id}`)).body.result.final_answer, reopened ? /saved before the reopened crash/ : /source baseline/);
  assert.equal(await readFile(join(runFolder(f.data, f.id, runId), 'state.txt'), 'utf8'), 'edited immediately before the child crashed', 'review retains the failed run files for recovery');
});
