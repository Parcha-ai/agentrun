// Public starts and separate runner processes. The model generates the draft through the normal compile turn;
// neither workflow files nor promotion/check records are preseeded. No vendor or original source CLI is contacted.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { agent, follow, serve } from './support.mjs';
import { sourceSnapshotDigest } from '../dist/native/source-snapshot-types.js';
import { sourceWorkspace } from '../dist/source-sync/workspace.js';
import { commitSourceSnapshot } from '../dist/source-sync/snapshots.js';
import { promotionsOf } from '../dist/learn/promote.js';
import { projectCheckpointStatuses, reconcileProjectCheckpoints } from '../dist/source-sync/checkpoints.js';
import { KINDS } from '../dist/runner/journal-kinds.js';
import { startFakeMcp } from './fixtures/fake-mcp-server.mjs';

const flow = { v: 2, name: 'answer', schemas: {
  In: { type: 'object', required: ['content'], properties: { content: { type: 'string' } } },
  Answer: { type: 'object', required: ['answer'], properties: { answer: { type: 'number' } } },
}, input: { schemaId: 'In' }, output: { schemaId: 'Answer', path: 'answer' },
  root: { node: 'extract', label: 'answer', instructions: 'Answer the question from the task.', out: 'Answer', as: 'answer' } };
const draft = `\`\`\`\`workflow answer\n---\ndescription: Answers a question as a number.\nexample: {"content":"What is six times seven?"}\n---\n${JSON.stringify(flow)}\n\`\`\`\``;
async function until(read, what) {
  const end = Date.now() + 60_000;
  do { const result = await read(); if (result) return result; await new Promise(resolve => setTimeout(resolve, 25)); } while (Date.now() < end);
  assert.fail(`Timed out waiting for ${what}`);
}

for (const auditAsks of [false, true]) test(`moved project generates, checks and promotes a workflow in isolated processes, then ${auditAsks ? 'ends an approval-blocked audit without blocking the next run' : 'serves and audits it without publishing auxiliary edits'}`, { timeout: 180_000 }, async t => {
  const fixture = await mkdtemp(join(tmpdir(), 'source-learning-child-')); t.after(() => rm(fixture, { recursive: true, force: true }));
  const model = join(fixture, 'model.mjs'), calls = join(fixture, 'calls.jsonl'), askAudit = join(fixture, 'ask-audit');
  await writeFile(model, `import { appendFileSync, existsSync } from 'node:fs';
import { askedForCompile } from ${JSON.stringify(new URL('../dist/learn/compile.js', import.meta.url).href)};
const textOf = m => typeof m?.content === 'string' ? m.content : (m?.content ?? []).map(c => c.type === 'text' ? c.text : '').join('');
export default function reply(context, faux) {
  const user = context.messages.findLast(m => m.role === 'user'), last = context.messages.at(-1);
  const submit = [...(context.tools ?? []), ...context.messages.flatMap(m => m.toolsAdded ?? [])].find(tool => tool.name === 'submit');
  const node = !!submit;
  appendFileSync(${JSON.stringify(calls)}, JSON.stringify({ pid: process.pid, compile: !!askedForCompile(textOf(user)), node, auditAsk: existsSync(${JSON.stringify(askAudit)}), last: last?.role, result: last?.role === 'toolResult' ? textOf(last) : undefined, tools: context.messages.flatMap(m => m.toolsAdded ?? []).map(t => t.name) }) + '\\n');
  if (node && context.messages.some(m => m.role === 'toolResult' && m.toolName === 'submit')) return faux.message('Submitted.');
  if (node) return faux.message(faux.toolCall('submit', submit.parameters?.properties?.value ? { value: { answer: 42 } } : { answer: 42 }), { stopReason: 'toolUse' });
  if (askedForCompile(textOf(user))) return faux.message(${JSON.stringify(draft)});
  if (existsSync(${JSON.stringify(askAudit)}) && last?.role !== 'toolResult') return faux.message(faux.toolCall('mcp__fixture__add', { a: 6, b: 36 }), { stopReason: 'toolUse' });
  if (last?.role === 'toolResult') return faux.message(JSON.stringify({ answer: 42 }));
  return faux.message(JSON.stringify({ answer: 42 }));
}
`);
  const logs = [], s = await serve(t, { faux: model, ...(auditAsks ? { accounts: true, openSetup: true } : {}), childRuns: { log: line => logs.push(line) } });
  let mcp;
  if (auditAsks) {
    mcp = await startFakeMcp(); t.after(() => mcp.close());
    const saved = await s.api('PUT', '/settings/mcp-servers/fixture', { url: mcp.url, auth: { type: 'none' } });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
  }
  const learning = { compile_after: 2, agree_min: 1, alone_min: 1, agree_on: ['answer'], audit_every: 1 };
  const created = await s.api('POST', '/agents', agent('moved-learning', { tools: auditAsks ? ['mcp:fixture/add'] : [], ...(auditAsks ? { tool_settings: { 'mcp:fixture/add': { permission: 'ask' } } } : {}), learning }));
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const bytes = Buffer.from('The answer is 42.'), sha256 = createHash('sha256').update(bytes).digest('hex');
  const content = { version: 1, complete: true, source: { runtime: 'codex', machine_id: 'fixture', project: '/fixture/source-offline', selector: { kind: 'project' } },
    entries: [{ path: 'project', role: 'project', type: 'directory', mode: 0o755, bytes: 0 }, { path: 'project/reference.txt', role: 'project', type: 'file', mode: 0o644, bytes: bytes.length, sha256 }],
    blobs: { [sha256]: bytes.toString('base64') }, instructions: { text: '', layers: [] }, skills: [], configuration: { model: null, tools: [], permissions: {}, credentials: [] }, project: { git: null }, blockers: [] };
  const snapshot = { ...content, digest: sourceSnapshotDigest(content) }, agentId = 'moved-learning';
  const current = await s.store.agents.get(agentId), revision = await s.store.agents.revision(current.currentRevision);
  await s.store.agents.addRevision({ agentId, id: 'moved-revision', kind: revision.kind, ifCurrent: current.currentRevision,
    body: { ...revision.body, sourceSync: { id: 'a'.repeat(64), snapshot: snapshot.digest, project: snapshot.digest, configuration: 'b'.repeat(64) } }, ...(revision.mcpPin ? { mcpPin: revision.mcpPin } : {}) });
  const cache = await sourceWorkspace(s.store, agentId, { data: s.data, sealKey: undefined });
  try { await commitSourceSnapshot(cache.workspace, snapshot); } finally { await cache.end(); }
  async function start(content) {
    const response = await s.api('POST', `/agents/${agentId}/runs`, { input: { content } });
    assert.equal(response.status, 202, JSON.stringify(response.body));
    await follow(s.api, response.body.run_id, ['completed'], { deadlineMs: 60_000 });
    return s.store.runs.get(response.body.run_id);
  }
  const first = await start('What is six times seven?');
  assert.equal((await promotionsOf(s.store.settings, agentId)).length, 0);
  const second = await start('What is seven times six?');
  const proposal = await s.store.learning.proposal(second.id);
  assert.equal(proposal?.proposal?.compiled?.attempts?.some(one => one.ok), true, JSON.stringify({ proposal, logs }));
  const third = await start('What is two times twenty-one?');
  assert.equal(third.metrics?.path, 'agent');
  const replays = await until(async () => {
    const out = [];
    for (const row of await s.store.runs.list({ agentId })) if ((await s.store.runs.launch(row.id)).body.replay) out.push(row);
    return out.length === 2 && out.every(row => row.state === 'ended' && row.runner === null) && out;
  }, 'the two real replay runs');
  for (const row of replays) {
    assert.equal(row.metrics?.path, 'replay', JSON.stringify({ row, logs }));
    const receipt = await s.store.runs.projectCheckpoints({ agentId, runId: row.id });
    assert.equal(receipt.at(-1)?.checkpoint.status, 'discarded', JSON.stringify({ receipt, logs }));
  }
  if (auditAsks) await writeFile(askAudit, 'Ask before fetching.');
  const fourth = await start('What is fourteen times three?');
  assert.equal(fourth.metrics?.path, 'workflow', JSON.stringify({ fourth, logs }));
  const promoted = (await promotionsOf(s.store.settings, agentId)).find(row => row.decided === 'promote');
  assert.equal(promoted?.check?.n, 2); assert.equal(promoted?.check?.agreed, 2);
  assert.deepEqual([...promoted.check.of].sort(), [first.id, second.id].sort());
  const shadow = await until(async () => {
    for (const row of await s.store.runs.list({ agentId })) if ((await s.store.runs.launch(row.id)).body.audit?.of === fourth.id && ['ended', 'failed'].includes(row.state) && row.runner === null) return row;
  }, 'the real read-only audit');
  if (auditAsks) {
    await rm(askAudit);
    assert.equal(shadow.state, 'failed', JSON.stringify({ shadow, calls: await readFile(calls, 'utf8'), logs }));
    assert.match(shadow.summary, /it would wait on a person's approval of a tool call/);
    const { runEntries } = await import('../dist/store-reads/journal.js');
    const entries = await runEntries(s.store, shadow.id, BACKGROUND_CONTEXT);
    assert.ok(entries.some(row => row.kind === KINDS.ask && row.data?.tool === 'mcp:fixture/add'), 'the real audit reaches the ordinary approval gate');
    assert.ok(entries.some(row => row.kind === KINDS.answer && row.data?.decision === 'withdrawn'), 'the failed audit withdraws its pending approval');
    assert.equal(entries.some(row => row.kind === KINDS.callSent), false, 'no tool effect was dispatched');
    assert.equal(mcp.log.filter(row => row.method === 'tools/call').length, 0, 'the independent upstream saw no tool dispatch');
  }
  const receipt = await s.store.runs.projectCheckpoints({ agentId, runId: shadow.id });
  assert.equal(receipt.at(-1)?.checkpoint.status, 'discarded', JSON.stringify({ receipt, logs }));
  await reconcileProjectCheckpoints(s.store, agentId);
  const statuses = await projectCheckpointStatuses(s.store, agentId);
  assert.equal(statuses.some(row => replays.some(run => run.id === row.runId) || row.runId === shadow.id), false);
  if (auditAsks) {
    const next = await start('What is twenty-one times two?');
    assert.equal(next.state, 'ended', 'a failed but settled auxiliary audit must not block normal admission');
  }
  const callsRead = (await readFile(calls, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.ok(callsRead.some(call => call.compile), 'draft came from the actual compile request');
  assert.ok(callsRead.some(call => call.node), 'workflow checks executed real model-node requests through the scripted adapter');
  assert.ok(callsRead.every(call => call.pid !== process.pid), 'actual isolated processes served all model requests');
  assert.equal(logs.some(line => /asked the store.*may not/.test(line)), false, logs.join('\n'));
});
