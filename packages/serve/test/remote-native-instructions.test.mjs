import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { readFile, readdir } from 'node:fs/promises';
import { serve, follow } from './support.mjs';
import { nativeFixture } from './native-fixtures/setup.mjs';
import { nativeSourceInstructions } from '../dist/runner/native-loop.js';

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

// The real source bridge and native CLI fixture sit behind the connector's leased HTTP protocol.
function sourceBridge(t, env) {
 const child = spawn(process.execPath, [fileURLToPath(new URL('../dist/native/remote-worker-bridge.js', import.meta.url))], { env, stdio: ['pipe', 'pipe', 'pipe'] });
 const pending = new Map(), events = []; let next = 0, stderr = '';
 child.stderr.on('data', chunk => { stderr += chunk; });
 createInterface({ input: child.stdout }).on('line', line => {
  const message = JSON.parse(line);
  if (message.event) { events.push(message); return; }
  const waiter = pending.get(message.id);
  if (waiter) { pending.delete(message.id); clearTimeout(waiter.timer); message.error ? waiter.reject(new Error(message.error)) : waiter.resolve(message.result); }
 });
 child.on('exit', code => { for (const waiter of pending.values()) { clearTimeout(waiter.timer); waiter.reject(new Error(`Source bridge exited ${code}: ${stderr}`)); } pending.clear(); });
 t.after(async () => {
  child.stdin.end();
  if (child.exitCode !== null) return;
  await new Promise(resolve => { const timer = setTimeout(() => child.kill('SIGTERM'), 3000); child.once('exit', () => { clearTimeout(timer); resolve(); }); });
 });
 return { events, call: (type, body = {}) => new Promise((resolve, reject) => {
  const id = `policy-${++next}`, timer = setTimeout(() => { pending.delete(id); reject(new Error(`Source ${type} timed out: ${stderr}`)); }, 10_000);
  pending.set(id, { resolve, reject, timer }); child.stdin.write(JSON.stringify({ ...body, id, type }) + '\n');
 }) };
}

for (const runtime of ['claude-code', 'codex']) test(`leased remote ${runtime} keeps saved instructions pinned in execution and prepared grading evidence`, { timeout: 60_000 }, async t => {
 let stopped = false, worker, failure, releasePrepare;
 const gate = new Promise(resolve => { releasePrepare = resolve; });
 t.after(async () => { releasePrepare(); stopped = true; await worker; });
 const f = await nativeFixture(t), name = runtime === 'codex' ? 'AGENTS.md' : 'CLAUDE.md';
 const standing = 'SOURCE: preserve the checkout policy.', pinned = 'PINNED: keep release approvals under owner review.', later = 'LATER: replace the queued task policy.';
 const preparedOnly = 'PREPARED: retain the remote worker standing policy.';
 const policy = join(f.project, name), inputLog = join(f.root, 'remote-inputs.jsonl');
 await f.put(policy, standing);
 const source = sourceBridge(t, { ...f.env, NATIVE_TEST_INPUT_LOG: inputLog });
 const target = (await source.call('discover', { payload: { project: f.project, runtime } })).targets.find(target => target.selector.kind === 'project');
 assert.ok(target);
 const s = await serve(t, { runner: true });
 t.after(() => { if (failure) throw failure; });
 const request = async (method, path, body, credential = s.token) => {
  const response = await fetch(s.baseUrl + path, { method, headers: { Authorization: `Bearer ${credential}`, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: response.status, body: await response.json() };
 };
 const enrollment = await request('POST', '/connectors/enrollment', { label: 'Saved policy source' }); assert.equal(enrollment.status, 200);
 const registered = await request('POST', '/connectors', { installation_id: `saved-policy-${runtime}`, operation_id: 'saved-policy-registration', capabilities: { native_execution: true } }, enrollment.body.enrollment_token);
 assert.equal(registered.status, 200, JSON.stringify(registered.body));
 const call = (path, body) => request('POST', `/connectors/${registered.body.connector.id}${path}`, body, registered.body.credential);
 const imported = await call('/import', { target_id: 'selected-project', target }); assert.equal(imported.status, 200, JSON.stringify(imported.body));
 const agentId = imported.body.agent_id, opened = [], prepared = [];
 assert.equal((await call('/poll', { worker_id: 'saved-policy-worker' })).status, 200);
 assert.equal((await s.api('PUT', `/agents/${agentId}/definition`, { definition: { instructions: pinned, learning: false } })).status, 200);
 worker = (async () => { while (!stopped) {
  const polled = await call('/poll', { worker_id: 'saved-policy-worker' }); assert.equal(polled.status, 200, JSON.stringify(polled.body));
  for (const command of polled.body.commands) {
   assert.equal(command.target_id, 'selected-project', 'only the locally allowed source target is dispatched');
   const eventStart = source.events.length;
   if (command.type === 'open') opened.push(command);
   const result = await source.call(command.type, { target, session_key: command.session_key, payload: command.payload });
   if (command.type === 'prepare') {
    assert.ok(result.instructions.text.includes(standing));
    // Source-owned evidence can include policy unavailable to a server-side filesystem snapshot.
    result.instructions.text += '\n' + preparedOnly;
    prepared.push(result); await gate;
   }
   const events = source.events.slice(eventStart).map(message => message.event);
   if (events.length) {
    const sent = await call(`/commands/${command.command_id}/events`, { lease_token: command.lease_token, sequence: 0, events });
    assert.equal(sent.status, 200, JSON.stringify(sent.body));
   }
   const completed = await call(`/commands/${command.command_id}/complete`, { lease_token: command.lease_token, result });
   assert.equal(completed.status, 200, JSON.stringify(completed.body));
  }
  await pause(10);
 } })().catch(error => { failure = error; });
 const started = await s.api('POST', `/agents/${agentId}/runs`, { input: { content: 'Report the release state.' } }); assert.equal(started.status, 202, JSON.stringify(started.body));
 const runId = started.body.run_id, pinnedRevision = (await s.store.runs.get(runId)).revisionId;
 for (const by = Date.now() + 10_000; !prepared.length;) { if (failure) throw failure; assert.ok(Date.now() < by, 'the source prepares under its actual HTTP lease'); await pause(10); }
 assert.equal((await s.api('PUT', `/agents/${agentId}/definition`, { definition: { instructions: later, learning: false } })).status, 200);
 assert.notEqual((await s.store.agents.get(agentId)).currentRevision, pinnedRevision);
 releasePrepare(); await follow(s.api, runId, ['completed']);
 assert.equal(opened.length, 1);
 const evidence = await nativeSourceInstructions(s.store, runId);
 const processInput = JSON.stringify(await f.calls()) + await readFile(inputLog, 'utf8');
 assert.equal((await s.store.runs.get(runId)).revisionId, pinnedRevision);
 assert.equal(await readFile(policy, 'utf8'), standing);
 assert.deepEqual((await readdir(f.project)).sort(), [name], 'the source policy and directory are untouched');
 assert.deepEqual({
  remoteOpenHasPinned: opened[0].payload.context?.includes(pinned) ?? false,
  nativeProcessHasPinned: processInput.includes(pinned),
  gradeHasPreparedPolicy: evidence.includes(prepared[0].instructions.text),
  gradeHasPinned: evidence.includes(pinned),
  laterRevisionReachedExecution: JSON.stringify(opened).includes(later) || processInput.includes(later),
  laterRevisionReachedGrade: evidence.includes(later),
 }, { remoteOpenHasPinned: true, nativeProcessHasPinned: true, gradeHasPreparedPolicy: true, gradeHasPinned: true, laterRevisionReachedExecution: false, laterRevisionReachedGrade: false });
});
