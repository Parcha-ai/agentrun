// HTTP admission, real isolated runner processes and private project storage; only the model is scripted.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { agent, follow, serve } from './support.mjs';
import { sourceSnapshotDigest } from '../dist/native/source-snapshot-types.js';
import { sourceWorkspace } from '../dist/source-sync/workspace.js';
import { commitSourceSnapshot } from '../dist/source-sync/snapshots.js';

test('isolated run processes checkpoint their writes through the host and the next run reads the saved project', { timeout: 120_000 }, async t => {
  const fixture = await mkdtemp(join(tmpdir(), 'source-project-child-'));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  const model = join(fixture, 'model.mjs');
  await writeFile(model, `const textOf = m => typeof m?.content === 'string' ? m.content : (m?.content ?? []).map(c => c.type === 'text' ? c.text : '').join('');
export default function reply(context, faux) {
  const last = context.messages.at(-1);
  if (last?.role === 'toolResult') return faux.message(JSON.stringify({ pid: process.pid, result: textOf(last) }));
  return faux.message(textOf(last).includes('Store the change')
    ? faux.toolCall('write', { path: 'state.txt', content: 'saved across processes' })
    : faux.toolCall('read', { path: 'state.txt' }), { stopReason: 'toolUse' });
}
`);
  const lines = [], s = await serve(t, { faux: model, childRuns: { log: line => lines.push(line) } });
  assert.equal((await s.api('POST', '/agents', agent('moved-project', { tools: ['read', 'write'] }))).status, 201);
  const bytes = Buffer.from('source baseline'), sha256 = createHash('sha256').update(bytes).digest('hex');
  const body = { version: 1, complete: true,
    source: { runtime: 'codex', machine_id: 'fixture', project: '/fixture/project', selector: { kind: 'project' } },
    entries: [{ path: 'project', role: 'project', type: 'directory', mode: 0o755, bytes: 0 },
      { path: 'project/state.txt', role: 'project', type: 'file', mode: 0o644, bytes: bytes.length, sha256 }],
    blobs: { [sha256]: bytes.toString('base64') }, instructions: { text: '', layers: [] }, skills: [],
    configuration: { model: null, tools: [], permissions: {}, credentials: [] }, project: { git: null }, blockers: [] };
  const snapshot = { ...body, digest: sourceSnapshotDigest(body) };
  const entry = await s.store.agents.get('moved-project'), revision = await s.store.agents.revision(entry.currentRevision);
  await s.store.agents.addRevision({ agentId: entry.id, id: 'moved-baseline', kind: revision.kind, ifCurrent: entry.currentRevision,
    body: { ...revision.body, sourceSync: { id: 'a'.repeat(64), snapshot: snapshot.digest, project: snapshot.digest, configuration: 'b'.repeat(64) } } });
  const cache = await sourceWorkspace(s.store, entry.id, { data: s.data, sealKey: undefined, env: {} });
  try { await commitSourceSnapshot(cache.workspace, snapshot); } finally { await cache.end(); }
  async function run(content) {
    const started = await s.api('POST', `/agents/${entry.id}/runs`, { input: { content } });
    assert.equal(started.status, 202, JSON.stringify(started.body));
    const id = started.body.run_id;
    await follow(s.api, id, ['completed'], { deadlineMs: 60_000 });
    const view = (await s.api('GET', `/runs/${id}`)).body;
    const output = JSON.parse(view.result.final_answer);
    assert.notEqual(output.pid, process.pid, 'the actual runner process executes the scripted model');
    const receipts = await s.store.runs.projectCheckpoints({ agentId: entry.id, runId: id });
    assert.equal(receipts.length, 1, lines.join('\n'));
    assert.equal(receipts[0].checkpoint.status, 'candidate', JSON.stringify({ receipts, lines }));
    return { id, output };
  }
  const first = await run('Store the change.'), second = await run('Read the saved project.');
  assert.notEqual(second.id, first.id);
  assert.match(second.output.result, /saved across processes/);
  assert.equal(lines.some(line => /asked the store.*may not/.test(line)), false, lines.join('\n'));
});
