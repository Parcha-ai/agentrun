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
import { journalEntries } from '../dist/runner/journal-reader.js';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';

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

for (const runtime of ['claude-code', 'codex']) for (const incomplete of [false, true]) test(`leased remote ${runtime} keeps saved instructions pinned with ${incomplete ? 'incomplete' : 'complete'} source policy evidence`, { timeout: 60_000 }, async t => {
 let stopped = false, worker, failure, releasePrepare;
 const gate = new Promise(resolve => { releasePrepare = resolve; });
 t.after(async () => { releasePrepare(); stopped = true; await worker; });
 const f = await nativeFixture(t), name = runtime === 'codex' ? 'AGENTS.md' : 'CLAUDE.md';
 const standing = 'SOURCE: preserve the checkout policy.' + (incomplete && runtime === 'claude-code' ? '\n@AGENTS.md' : ''), pinned = 'PINNED: keep release approvals under owner review.', later = 'LATER: replace the queued task policy.';
 const preparedOnly = 'PREPARED: retain the remote worker standing policy.';
 const policy = join(f.project, name), inputLog = join(f.root, 'remote-inputs.jsonl');
 await f.put(policy, standing);
 if (incomplete && runtime === 'claude-code') await f.put(join(f.project, 'AGENTS.md'), 'Never bypass owner review.');
 if (incomplete && runtime === 'codex') {
  await f.put(join(f.env.CODEX_HOME, 'config.toml'), 'model_instructions_file = "policy.md"\n');
  await f.put(join(f.env.CODEX_HOME, 'policy.md'), 'Never bypass owner review.');
 }
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
 const rows = await journalEntries(s.store.readJournal(runId), BACKGROUND_CONTEXT);
 const dispatched = rows.findIndex(row => row.kind === 'agentrun.native.sending' && row.data.phase === 'task');
 assert.ok(dispatched >= 0);
 const snapshot = rows.slice(0, dispatched).findLast(row => row.kind === 'agentrun.native.instructions').data;
 const configuration = rows.slice(0, dispatched).findLast(row => row.kind === 'agentrun.native.configuration').data;
 assert.equal(configuration.capabilities.launch, true, 'ordinary remote tasks remain available');
 assert.equal(snapshot.incomplete, prepared[0].instructions.incomplete);
 for (const field of ['codexConfigurationChecked', 'claudeConfigurationChecked', 'claudePolicySourcesChecked']) assert.equal(snapshot[field], prepared[0].instructions[field]);
 if (incomplete) {
  assert.ok(snapshot.incomplete);assert.equal(configuration.capabilities.notes, false);assert.equal(configuration.capabilities.skills, false);
  await assert.rejects(nativeSourceInstructions(s.store, runId), /incomplete/i);
 } else assert.equal(await nativeSourceInstructions(s.store, runId), snapshot.text);
 const evidence = snapshot.text;
 const processInput = JSON.stringify(await f.calls()) + await readFile(inputLog, 'utf8');
 assert.equal((await s.store.runs.get(runId)).revisionId, pinnedRevision);
 assert.equal(await readFile(policy, 'utf8'), standing);
 assert.deepEqual((await readdir(f.project)).sort(), incomplete && runtime === 'claude-code' ? ['AGENTS.md', 'CLAUDE.md'] : [name], 'the source policy and directory are untouched');
 assert.deepEqual({
  remoteOpenHasPinned: opened[0].payload.context?.includes(pinned) ?? false,
  nativeProcessHasPinned: processInput.includes(pinned),
  snapshotHasPreparedPolicy: evidence.includes(prepared[0].instructions.text),
  snapshotHasPinned: evidence.includes(pinned),
  laterRevisionReachedExecution: JSON.stringify(opened).includes(later) || processInput.includes(later),
  laterRevisionReachedSnapshot: evidence.includes(later),
 }, { remoteOpenHasPinned: true, nativeProcessHasPinned: true, snapshotHasPreparedPolicy: true, snapshotHasPinned: true, laterRevisionReachedExecution: false, laterRevisionReachedSnapshot: false });
});

async function preparedLearning(t, runtime, mode) {
 let stopped = false, worker, failure;
 t.after(async () => { stopped = true; await worker; if (failure) throw failure; });
 const f = await nativeFixture(t), policy = join(f.project, runtime === 'codex' ? 'AGENTS.md' : 'CLAUDE.md');
 await f.put(policy, 'SOURCE: preserve owner review.');
 // Fixed protocol events avoid the maintained CLI fixture's deliberate `hang`
 // prompt sentinel matching ordinary reflection words such as `changed`.
 const sessionId = runtime === 'claude-code' ? '11111111-1111-4111-8111-111111111111' : '22222222-2222-4222-8222-222222222222';
 const events = runtime === 'claude-code' ? [
  { type: 'system', subtype: 'init', session_id: sessionId, model: 'native-claude' },
  { type: 'assistant', message: { content: [{ type: 'text', text: 'native answer' }] } },
  { type: 'result', subtype: 'success', session_id: sessionId, result: 'native answer', usage: { input_tokens: 7, output_tokens: 3, cache_read_input_tokens: 2 }, total_cost_usd: 0.01, permission_denials: [] },
 ] : [
  { type: 'thread.started', thread_id: sessionId },
  { type: 'item.completed', item: { id: 'message-1', type: 'agent_message', text: 'native answer' } },
  { type: 'turn.completed', usage: { input_tokens: 9, output_tokens: 4, cached_input_tokens: 2 } },
 ];
 const source = sourceBridge(t, { ...f.env, NATIVE_TEST_EVENTS: JSON.stringify(events) }), seen = [], prepared = [];
 const target = (await source.call('discover', { payload: { project: f.project, runtime } })).targets.find(row => row.selector.kind === 'project');
 assert.ok(target.capabilities.notes, 'the queued launch initially supports learning');
 const s = await serve(t, { runner: true });
 const request = async (path, body, credential = s.token) => {
  const reply = await fetch(s.baseUrl + path, { method: 'POST', headers: { Authorization: `Bearer ${credential}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { status: reply.status, body: await reply.json() };
 };
 const enrollment = await request('/connectors/enrollment', { label: 'Learning eligibility source' }); assert.equal(enrollment.status, 200);
 const registered = await request('/connectors', { installation_id: `eligibility-${runtime}`, operation_id: 'eligibility-registration', capabilities: { native_execution: true } }, enrollment.body.enrollment_token); assert.equal(registered.status, 200);
 const call = (path, body) => request(`/connectors/${registered.body.connector.id}${path}`, body, registered.body.credential);
 const imported = await call('/import', { target_id: 'selected-project', target }); assert.equal(imported.status, 200);
 const agentId = imported.body.agent_id;
 await call('/poll', { worker_id: 'eligibility-worker' });
 const pinned = 'PINNED: keep release approvals.' + (mode === 'truncated' ? 'Saved policy requires owner review of every release.\n'.repeat(750) : '');
 assert.equal((await s.api('PUT', `/agents/${agentId}/definition`, { definition: { instructions: pinned, learning: mode === 'off' ? false : 'notes' } })).status, 200);
 // Discovery/import admitted complete policy. Preparation sees the later source
 // state; truncation happens only after its complete snapshot gains saved text.
 if (['incomplete', 'use', 'off', 'failed'].includes(mode)) {
  if (runtime === 'claude-code') { await f.put(policy, 'SOURCE: preserve owner review.\n@AGENTS.md'); await f.put(join(f.project, 'AGENTS.md'), 'Require owner review.'); }
  else { await f.put(join(f.env.CODEX_HOME, 'config.toml'), 'model_instructions_file = "policy.md"\n'); await f.put(join(f.env.CODEX_HOME, 'policy.md'), 'Require owner review.'); }
 }
 if (mode === 'truncated') await f.put(policy, 'SOURCE: preserve owner review.\n' + 'Source policy requires owner review of every release.\n'.repeat(750));
 const note = '---\nname: Owner report format\ndescription: A requested status report label\ntype: user\n---\nStart release reports with Launch state, then the current status.\n';
 const verdict = JSON.stringify({ merge: false, reason: 'Inspect complete policy learning without promoting fixture material.', items: [{ file: 'release-label.md', decision: 'drop', question: 'General', why: 'This test checks learning eligibility.' }] });
 worker = (async () => { while (!stopped) {
  const polled = await call('/poll', { worker_id: 'eligibility-worker' }); assert.equal(polled.status, 200, JSON.stringify(polled.body));
  for (const command of polled.body.commands) {
   seen.push(command); const start = source.events.length;
   const result = await source.call(command.type, { target, session_key: command.session_key, payload: command.payload });
   if (command.type === 'prepare') {
    if (mode === 'capabilities') result.target.capabilities = { ...result.target.capabilities, notes: false, skills: false };
    prepared.push(result);
   }
   if (command.type === 'send' && command.payload.reflection) result.answer = '```note release-label.md\n' + note + '```';
   if (command.type === 'grade') result.answer = verdict;
   const events = source.events.slice(start).map(row => row.event);
   if (events.length) assert.equal((await call(`/commands/${command.command_id}/events`, { lease_token: command.lease_token, sequence: 0, events })).status, 200);
   const failed = mode === 'failed' && command.type === 'send' && !command.payload.reflection;
   assert.equal((await call(`/commands/${command.command_id}/complete`, { lease_token: command.lease_token, ...(failed ? { error: 'Scripted source task failed.' } : { result }) })).status, 200);
  }
  await pause(10);
 } })().catch(error => { failure = error; });
 const started = await s.api('POST', `/agents/${agentId}/runs`, { input: { content: 'Remember my status preference: start release reports with Launch state, then the status.' }, ...(mode === 'use' ? { learning: 'use' } : {}) }); assert.equal(started.status, 202, JSON.stringify(started.body));
 const runId = started.body.run_id;
 await follow(s.api, runId, [mode === 'failed' ? 'failed' : 'completed']);
 const last = (await s.api('GET', `/runs/${runId}`)).body;
 if (failure) throw failure;
 const rows = await journalEntries(s.store.readJournal(runId), BACKGROUND_CONTEXT);
 const snapshot = rows.find(row => row.kind === 'agentrun.native.instructions').data;
 if (mode === 'truncated') { assert.equal(prepared[0].instructions.truncated, false); assert.equal(prepared[0].instructions.incomplete, undefined); assert.equal(snapshot.truncated, true, 'ordinary policy prose plus the pinned instructions really exceeds the final evidence bound'); }
 if (mode === 'incomplete') assert.ok(snapshot.incomplete);
 assert.equal(prepared.length, 1);
 assert.equal(seen.filter(row => row.type === 'send' && !row.payload.reflection).length, 1, 'the ordinary native task is dispatched exactly once');
 assert.equal(seen.filter(row => row.type === 'send' && row.payload.reflection).length, mode === 'complete' ? 1 : 0, 'unavailable policy must be refused before any reflection request reaches the source');
 if (mode === 'complete') {
  for (const by = Date.now() + 10_000;;) {
   const learning = (await s.api('GET', `/runs/${runId}/learning`)).body;
   if (learning.state === 'dropped') break;
   assert.ok(Date.now() < by, JSON.stringify(learning)); await pause(25);
  }
  assert.equal(seen.filter(row => row.type === 'grade').length, 1, 'complete policy still reaches the ordinary isolated grader');
 } else {
  assert.equal(seen.filter(row => row.type === 'grade').length, 0);
  const kept = await s.store.learning.proposal(runId);
  if (['incomplete', 'truncated', 'failed', 'capabilities'].includes(mode)) {
   const learning = (await s.api('GET', `/runs/${runId}/learning`)).body;
   assert.deepEqual([last.learning?.state, learning?.state], ['dropped', 'dropped'], 'both terminal views settle unavailable learning instead of remaining seeded');
   assert.ok(kept); assert.equal(kept.turn, null); assert.equal(kept.proposal.state, 'dropped'); assert.equal(kept.proposal.reason, 'checker');
   assert.match(kept.proposal.detail, /self-improvement.*skipped/i); assert.equal(kept.learningRunId ?? null, null, 'an unasked drop queues no grading run');
  } else assert.equal(kept, undefined, 'off/use keep their existing no-proposal behavior');
 }
 const skip = rows.filter(row => row.kind === 'agentrun.phase' && /self-improvement.*skipped/i.test(row.data.summary));
 if (['incomplete', 'truncated', 'failed', 'capabilities'].includes(mode)) {
  assert.equal(skip.length, 1, 'the unavailable-learning reason is durable beside the task');
  assert.match(skip[0].data.summary, /incomplete|policy|evidence|capabilit/i);
 } else assert.equal(skip.length, 0, 'complete/off/use behavior acquires no new skip reason');
 assert.ok(seen.find(row => row.type === 'open').payload.context.includes('PINNED: keep release approvals.'), 'saved task context remains in the native open');
 const calls = (await f.calls()).filter(row => row.args.includes('--print') || row.args.includes('exec'));
 assert.equal(calls.length, mode === 'complete' ? 3 : 1, 'actual scripted native task/reflection/grade invocation count agrees with the leased commands');
 if (runtime === 'codex') assert.equal(last.cost.usd, null, 'unknown native job cost stays unknown when reflection is skipped');
 return { rows, last };
}

for (const runtime of ['claude-code', 'codex']) for (const mode of ['incomplete', 'truncated', 'complete']) test(`prepared policy ${runtime} ${mode} gates automatic learning before reflection`, { timeout: 60_000 }, t => preparedLearning(t, runtime, mode));
for (const mode of ['use', 'off', 'failed', 'capabilities']) test(`prepared policy codex ${mode} gates automatic learning before reflection`, { timeout: 60_000 }, t => preparedLearning(t, 'codex', mode));
