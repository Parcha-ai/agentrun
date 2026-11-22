// Real Mode 1 HTTP upload/admission plus a scripted isolated runner. No provider or external service calls.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { agent, follow, serve } from './support.mjs';
import { sourceSnapshotDigest } from '../dist/native/source-snapshot-types.js';
import { sourceWorkspace } from '../dist/source-sync/workspace.js';
import { commitSourceSnapshot, readSourceSnapshot } from '../dist/source-sync/snapshots.js';
import { sourceIOPrefix } from '../dist/source-sync/io.js';
import { readLaunchBody } from '../dist/run-launch.js';
import { runFolder, sourceRunControlFolder } from '../dist/workspace/paths.js';

async function fixture(t, options = {}, collision = false) {
  const s = await serve(t, options), id = 'moved-uploads';
  assert.equal((await s.api('POST', '/agents', agent(id, { tools: ['read'] }))).status, 201);
  const bytes = Buffer.from('authored project input'), sha256 = createHash('sha256').update(bytes).digest('hex');
  const body = { version: 1, complete: true, source: { runtime: 'codex', machine_id: 'fixture', project: '/fixture/project', selector: { kind: 'project' } },
    entries: [{ path: 'project', role: 'project', type: 'directory', mode: 0o755, bytes: 0 },
      { path: 'project/inputs', role: 'project', type: 'directory', mode: 0o750, bytes: 0 },
      { path: `project/inputs/${collision ? 'upload.csv' : 'authored.txt'}`, role: 'project', type: 'file', mode: 0o640, bytes: bytes.length, sha256 }],
    blobs: { [sha256]: bytes.toString('base64') }, instructions: { text: '', layers: [] }, skills: [],
    configuration: { model: null, tools: [], permissions: {}, credentials: [] }, project: { git: null }, blockers: [] };
  const snapshot = { ...body, digest: sourceSnapshotDigest(body) }, entry = await s.store.agents.get(id), revision = await s.store.agents.revision(entry.currentRevision);
  await s.store.agents.addRevision({ agentId: id, id: 'moved-baseline', kind: revision.kind, ifCurrent: entry.currentRevision,
    body: { ...revision.body, sourceSync: { id: 'a'.repeat(64), snapshot: snapshot.digest, project: snapshot.digest, configuration: 'b'.repeat(64) } } });
  const cache = await sourceWorkspace(s.store, id, { data: s.data, sealKey: undefined, env: {} });
  try { await commitSourceSnapshot(cache.workspace, snapshot); } finally { await cache.end(); }
  const made = await s.api('POST', '/files', { path: 'upload.csv', size_bytes: 17 });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  const sent = await fetch(new URL(made.body.upload.url, `http://127.0.0.1:${s.port}`), {
    method: 'PUT', headers: { authorization: `Bearer ${s.token}`, 'content-type': 'text/csv' }, body: 'fixture,value\n17\n',
  });
  assert.equal(sent.status, 200, await sent.text());
  return { ...s, id, file: made.body.file, snapshot };
}

test('Mode 1 moved uploads are placed and pinned before admission despite an authored inputs directory', async t => {
  const f = await fixture(t, { runner: false });
  const started = await f.api('POST', `/agents/${f.id}/runs`, { input: { content: 'Read the uploaded CSV.' }, file_ids: [f.file.file_id] });
  assert.equal(started.status, 202, JSON.stringify(started.body));
  const runId = started.body.run_id, launch = readLaunchBody((await f.store.runs.launch(runId)).body);
  assert.equal(launch.filesPlaced, true, 'Mode 1 must also pin already copied files');
  assert.deepEqual(launch.sourceProject.inputs, ['inputs/upload.csv']);
  assert.equal(await readFile(join(runFolder(f.data, f.id, runId), 'inputs/upload.csv'), 'utf8'), 'fixture,value\n17\n');
  assert.equal(await readFile(join(runFolder(f.data, f.id, runId), 'inputs/authored.txt'), 'utf8'), 'authored project input');
  const marker = JSON.parse(await readFile(join(sourceRunControlFolder(f.data, f.id, runId), 'source-seed.json'), 'utf8'));
  assert.deepEqual(marker.inputs, launch.sourceProject.inputs);
  assert.equal(createHash('sha256').update(await readFile(join(sourceRunControlFolder(f.data, f.id, runId), 'source-seed.json'))).digest('hex'), launch.sourceProject.receipt);
  assert.deepEqual(await readdir(join(f.data, 'files', '.held')).catch(() => []), []);
});

test('Mode 1 upload collision refuses admission and releases fully rolled-back ownership', async t => {
  const f = await fixture(t, { runner: false }, true);
  const before = await f.store.runs.list({ agentId: f.id });
  const refused = await f.api('POST', `/agents/${f.id}/runs`, { input: { content: 'Do not overwrite project content.' }, file_ids: [f.file.file_id] });
  assert.equal(refused.status, 409, JSON.stringify(refused.body));
  assert.match(refused.body.error.message, /upload.*authored project file/i);
  assert.deepEqual(await f.store.runs.list({ agentId: f.id }), before);
  assert.deepEqual(await f.store.settings.all({ prefix: sourceIOPrefix(f.id) }), []);
  assert.deepEqual(await readdir(join(f.data, 'files', '.held')).catch(() => []), []);
});

test('a real moved child reads its upload; follow-up keeps one copy and checkpoints keep only authored inputs', { timeout: 120_000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'source-upload-model-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const model = join(dir, 'model.mjs');
  await writeFile(model, `export default function reply(context, faux) {
    const last = context.messages.at(-1);
    if (last?.role === 'toolResult') return faux.message(JSON.stringify({ pid: process.pid, content: last.content }));
    return faux.message(faux.toolCall('read', { path: 'inputs/upload.csv' }), { stopReason: 'toolUse' });
  }\n`);
  const f = await fixture(t, { faux: model, childRuns: { log: () => {} } });
  const started = await f.api('POST', `/agents/${f.id}/runs`, { input: { content: 'Read the uploaded CSV.' }, file_ids: [f.file.file_id] });
  assert.equal(started.status, 202, JSON.stringify(started.body)); const runId = started.body.run_id;
  await follow(f.api, runId, ['completed'], { deadlineMs: 60_000 });
  for (const turn of [0, 1]) {
    if (turn) {
      const resumed = await f.api('POST', `/runs/${runId}/messages`, { content: 'Read the same uploaded CSV again.' });
      assert.equal(resumed.status, 202, JSON.stringify(resumed.body));
      await follow(f.api, runId, ['completed'], { deadlineMs: 60_000 });
    }
    const view = (await f.api('GET', `/runs/${runId}`)).body, answer = JSON.parse(view.result.final_answer);
    assert.notEqual(answer.pid, process.pid); assert.match(JSON.stringify(answer.content), /fixture,value/);
    assert.deepEqual((await readdir(join(runFolder(f.data, f.id, runId), 'inputs'))).sort(), ['authored.txt', 'message.md', 'upload.csv']);
  }
  const receipts = await f.store.runs.projectCheckpoints({ agentId: f.id, runId });
  assert.equal(receipts.length, 2); assert.ok(receipts.every(row => row.checkpoint.status === 'candidate'), JSON.stringify(receipts));
  const cache = await sourceWorkspace(f.store, f.id, { data: f.data, sealKey: undefined, env: {} });
  try {
    for (const row of receipts) {
      const snapshot = await readSourceSnapshot(cache.workspace, row.checkpoint.digest);
      assert.ok(snapshot.entries.some(entry => entry.path === 'project/inputs/authored.txt'));
      assert.ok(!snapshot.entries.some(entry => ['project/inputs/upload.csv', 'project/inputs/message.md'].includes(entry.path)));
    }
  } finally { await cache.end(); }
});
