import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readReleaseStatus, formatReleaseBrief, readWorkflowAudit, releaseWorkflowTools } from './agent/lib/release-tools.ts';
import { assertCompiledOrigin, assertExecutableReuse, assertOriginalChain, demonstrateWorkflows, workflowTask } from './workflow-validate.mjs';

async function journal(t) {
  const dir = await mkdtemp(join(tmpdir(), 'eve-workflow-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return join(dir, 'callbacks.jsonl');
}

test('existing native callbacks keep exact fresh data across processes and reject another task or edited status', async t => {
  const auditPath = await journal(t), native = { auditPath, sessionId: 'native-first' };
  const status = await readReleaseStatus({ service: 'demo-api' }, native);
  assert.equal((await formatReleaseBrief({ status }, native)).brief, 'Release brief: demo-api 2.4.0; tests passed; ready.');
  await assert.rejects(formatReleaseBrief({ status: { ...status, version: 'invented' } }, native), /unchanged status/);
  await assert.rejects(formatReleaseBrief({ status }, { ...native, sessionId: 'other-task' }), /unchanged status/);
  await assert.rejects(formatReleaseBrief({ status }, { auditPath, runId: 'different', workflow: 'release' }), /unchanged status/);
  const fresh = await readReleaseStatus({ service: 'demo-worker' }, { auditPath, runId: 'workflow-run', workflow: 'release' });
  assert.notEqual(fresh.observation, status.observation);
  assert.equal((await formatReleaseBrief({ status: fresh }, { auditPath, runId: 'workflow-run', workflow: 'release' })).brief,
    'Release brief: demo-worker 3.1.2; tests passed; ready.');
  assert.equal((await stat(auditPath)).mode & 0o777, 0o600);
  assert.deepEqual((await readWorkflowAudit(auditPath)).map(row => row.source), ['native', 'native', 'workflow', 'workflow']);
  assert.equal(releaseWorkflowTools[0].execute, readReleaseStatus);
  assert.equal(releaseWorkflowTools[1].execute, formatReleaseBrief);
  const beforeUnknown = await readFile(auditPath, 'utf8');
  for (const service of ['missing-service', '__proto__', 'constructor', '', 1]) {
    await assert.rejects(readReleaseStatus({ service }, native), /Unknown fictional service/);
  }
  assert.equal(await readFile(auditPath, 'utf8'), beforeUnknown, 'Unknown services must not create observed callback data.');
  const { spawnSync } = await import('node:child_process');
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import {formatReleaseBrief} from ${JSON.stringify(new URL('./agent/lib/release-tools.ts', import.meta.url).href)};
    const result = await formatReleaseBrief({status: JSON.parse(process.argv[1])}, {auditPath: process.argv[2], sessionId: 'native-first'});
    process.stdout.write(result.brief);
  `, JSON.stringify(status), auditPath], { encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stdout, 'Release brief: demo-api 2.4.0; tests passed; ready.');
});

test('a real in-process workflow calls the original callback functions and emits only metadata', { timeout: 20_000 }, async t => {
  const { createWorkflowBridge } = await import('@parcha/agentrun-client/workflows');
  const engine = await import('@parcha/agentrun-dsl');
  const auditPath = await journal(t), events = [], calls = [];
  // Only the model/server receipt is scripted here. This unit fixture is never supplied to the live validator.
  const tools = releaseWorkflowTools.map(tool => ({ ...tool, execute(input, ctx) {
    calls.push(tool.execute); return tool.execute(input, { ...ctx, auditPath });
  } }));
  const doc = { v: 2, name: 'release-brief', schemas: { Input: tools[0].input_schema,
    Status: tools[0].output_schema, Brief: tools[1].output_schema }, input: { schemaId: 'Input' },
    output: { schemaId: 'Brief', path: 'brief' }, root: { node: 'chain', steps: [
      { node: 'call', label: 'status', via: 'tool', tool: tools[0].name, args: { service: '{service}' }, out: 'Status', as: 'status', deadline_s: 5 },
      { node: 'call', label: 'format', via: 'tool', tool: tools[1].name, args: { status: '{status}' }, out: 'Brief', as: 'brief', deadline_s: 5 },
    ] } };
  const bridge = createWorkflowBridge({ engine, tools, policy: () => 'allow' });
  let incomplete = false;
  const bound = bridge.bind({ runId: 'workflow-run', workflows: [{ name: 'release-brief', description: 'Read and format release data.', workflow: JSON.stringify(doc) }],
    protect() {}, markEvidenceIncomplete() { incomplete = true; }, async event(event) { events.push(event); } });
  try {
    const result = await bound.execute('release-brief', { service: 'demo-worker' }, AbortSignal.timeout(10_000));
    assert.notEqual(result.isError, true, JSON.stringify(result));
    assert.equal(result.content[0].text, 'Release brief: demo-worker 3.1.2; tests passed; ready.');
    assert.equal(incomplete, false); assert.deepEqual(calls, [readReleaseStatus, formatReleaseBrief]);
    const rows = await readWorkflowAudit(auditPath);
    assert.deepEqual(rows[1].input.status, rows[0].result);
    assert.ok(rows.every(row => row.source === 'workflow' && row.workflow === 'release-brief' && row.runId === 'workflow-run'));
    const parent = events.find(event => event.name === 'learned_workflow' && event.status === 'completed');
    assert.ok(parent);
    assert.ok(events.filter(event => event.name !== 'learned_workflow').every(event => event.parent_tool_use_id === parent.id));
    assert.ok(!JSON.stringify(events).includes(rows[0].result.observation), 'Private callback data must not appear in uploaded telemetry.');
    const unknown = await bound.execute('release-brief', { service: 'unlisted-service' }, AbortSignal.timeout(10_000));
    assert.equal(unknown.isError, true);
    assert.deepEqual(calls, [readReleaseStatus, formatReleaseBrief, readReleaseStatus],
      'A generic service string reaches the original read callback, whose runtime guard prevents formatting unknown data.');
    assert.deepEqual(await readWorkflowAudit(auditPath), rows, 'The failed unknown-service read must not fabricate audit evidence.');
    await bound.close();
    assert.equal((await bound.execute('release-brief', { service: 'demo-worker' }, AbortSignal.timeout(10_000))).isError, true);
  } finally { await bound.close(); await bridge.close(); }
});

async function proofFixture(t, { pending = false, fallback = false, uncertain = false, interrupt = false, preexisting = false, compiledFailure = false, unrelatedOrigin = false, missingServerChild = false, held = false } = {}) {
  const auditPath = await journal(t), agentId = 'eve-workflow-fixture', results = new Map(), runs = new Map(), prompts = [], reads = [], settings = [];
  let learning = false, version = 1, registered = preexisting, workflowRun, checkpoint, promoted = false;
  const document = '{"unit-test":"scripted compiled document"}', digest = createHash("sha256").update(document).digest("hex").slice(0, 16);
  const accepted = () => Boolean(workflowRun);
  const view = () => ({ main: accepted() ? 'revision-workflow' : 'revision-empty', corrections: '',
    workflows: accepted() ? [{ status: pending ? 'pending' : held ? 'held' : promoted ? 'serving' : 'checking', run: workflowRun, name: 'release-brief', file: 'workflows/release-brief/workflow.json' }] : [],
    log: { items: accepted() ? [{ commit: 'revision-workflow', by: { run: unrelatedOrigin ? 'foreign-run' : workflowRun }, files: ['workflows/release-brief/workflow.json'] }] : [] } });
  const client = { agents: {
    async get() {
      if (!registered) throw Object.assign(new Error('No agent registered.'), { code: 'not_found' });
      return { etag: `"${version}"`, body: { definition: { version, sdk: { runtime: 'eve' }, learning } } };
    },
    async create({ definition }) {
      assert.equal(registered, false); assert.equal(definition.id, agentId); assert.equal(definition.learning, false);
      registered = true; return this.get();
    },
    async update(id, { definition }, headers) {
      assert.equal(id, agentId); assert.equal(headers['If-Match'], `"${version}"`); assert.equal(definition.version, undefined);
      learning = definition.learning; settings.push(learning); version++;
      return this.get();
    },
    async runs() { return { runs: [...runs.values()] }; },
  }, runs: {
    async get(id) { assert.ok(runs.has(id)); return structuredClone(runs.get(id)); },
    async learning(id) { return { run: id, state: 'merged', merged: 'revision-workflow',
      compiled: { workflow: 'release-brief', attempts: [{ ok: !compiledFailure, errors: compiledFailure ? ['dry run failed'] : [] }], digest, promoted },
      workflows: [{ name: 'release-brief', file: 'workflows/release-brief/workflow.json' }] }; },
    async timeline(id) {
      const result = [...results.values()].find(saved => saved.result.toolCalls.some(call => call.workflow?.runId === id)).result;
      const events = result.toolCalls.find(call => call.workflow).workflow.events;
      return { has_more: false, rows: events.filter((event, index) => !missingServerChild || index !== 2).map(event => ({
        kind: 'tool_result', tool_use_id: event.id, tool_name: event.name, tool_status: 'success', parent_tool_use_id: event.parent_tool_use_id,
      })) };
    },
  }, learning: { async get() { return view(); }, async read() { return { body: document }; } } };

  const invokeNative = async (input, { onStarted }) => {
    prompts.push(input);
    if (uncertain) { uncertain = false; throw new Error('A connection closed before a session receipt was returned.'); }
    const sessionId = `session-${prompts.length}`, runId = `run-${prompts.length}`;
    await onStarted({ sessionId, deliveryId: `delivery-${prompts.length}` });
    const service = input.includes('demo-worker') ? 'demo-worker' : 'demo-api';
    const workflow = promoted && learning !== false && !fallback;
    const revision = learning === false ? null : view().main;
    const ctx = { auditPath, ...(workflow ? { runId, workflow: 'release-brief' } : { sessionId }) };
    const status = await readReleaseStatus({ service }, ctx), brief = await formatReleaseBrief({ status }, ctx);
    const parent = `parent-${runId}`;
    const toolCalls = workflow ? [{ callId: `call-${runId}`, name: 'agentrun__learned_workflow', outcome: 'completed',
      workflow: { name: 'release-brief', revision, runId, complete: true, events: [
        { id: parent, name: 'learned_workflow', status: 'completed' },
        ...releaseWorkflowTools.map((tool, index) => ({ id: `child-${index}-${runId}`, name: tool.name, status: 'completed', parent_tool_use_id: parent })),
      ] } }] : ['release_status', 'format_release_brief'].map(name => ({ name, callId: `${runId}-${name}`, outcome: 'completed' }));
    const result = { sessionId, turnId: 'turn-0', answer: brief.brief, toolCalls };
    const run = { run_id: runId, status: 'completed', sdk: { runtime: 'eve', session_id: sessionId, learning_revision: revision },
      ...(learning === false ? {} : { learning: { state: 'merged' } }) };
    results.set(sessionId, { input, result }); runs.set(runId, run);
    // A separate native answer is required before this scripted check fixture promotes a draft.
    if (workflowRun && !promoted && !held && learning !== false) promoted = true;
    // Current compile_after counts the agent's own completed runs, including its Off baseline.
    if (typeof learning === 'object' && runs.size >= learning.compile_after) workflowRun ??= runId;
    if (interrupt) { interrupt = false; throw new Error('A native delivery completed after the connection closed.'); }
    return result;
  };
  const options = { agentId, eveBaseUrl: 'http://127.0.0.1:7443', auditPath, client, invokeNative, pollMs: 100, pollIntervalMs: 1,
    checkpoint: async value => { checkpoint = structuredClone(value); },
    async readNative(id, { expectedTask }) { reads.push(id); const saved = results.get(id); assert.ok(saved); assert.equal(saved.input, expectedTask); return structuredClone(saved.result); },
  };
  return { options, prompts, settings, runs, reads, results, proof: () => checkpoint, changeOwnerLearning(value) { learning = value; version++; } };
}

test('live-proof orchestration compiles normal native traces with current checks, proves fresh callback reuse, and switches the same agent Off', async t => {
  const f = await proofFixture(t), proof = await demonstrateWorkflows(f.options);
  assert.equal(proof.stage, 'passed'); assert.equal(f.prompts.length, 8);
  assert.deepEqual(f.settings, [{ compile_after: 5 }, false]);
  assert.equal(f.prompts.at(-2), workflowTask('demo-worker')); assert.equal(f.prompts.at(-1), workflowTask('demo-worker'));
  assert.equal(proof.committed.workflows[0].run, proof.sessions.practice_3.run.runId);
  assert.equal(proof.sessions.shadow_check.callbacks.read.source, 'native');
  assert.equal(proof.check.runId, proof.sessions.shadow_check.run.runId);
  assert.equal(proof.check.state, 'promoted');
  assert.equal(proof.sessions.reused.callbacks.read.source, 'workflow');
  assert.equal(proof.sessions.control_off.callbacks.read.source, 'native');
  assert.equal(new Set(Object.values(proof.sessions).map(row => row.callbacks.read.result.observation)).size, 8);
  const settings = [...f.settings];
  const resumed = await demonstrateWorkflows({ ...f.options, resume: proof });
  assert.equal(resumed.stage, 'passed'); assert.equal(f.prompts.length, 8); assert.equal(f.reads.length, 8);
  assert.deepEqual(f.settings, settings, 'A finished proof must not toggle settings or submit more paid work when resumed.');
});

test('workflow proof never changes a pre-existing agent or replaces owner settings changed during a paused proof', async t => {
  const existing = await proofFixture(t, { preexisting: true });
  existing.changeOwnerLearning({ compile_after: 40, agree_min: 0.95 });
  await assert.rejects(demonstrateWorkflows(existing.options), /new dedicated agent id/);
  assert.equal(existing.prompts.length, 0); assert.deepEqual(existing.settings, []);
  const paused = await proofFixture(t, { interrupt: true });
  await assert.rejects(demonstrateWorkflows(paused.options), /connection closed/);
  paused.changeOwnerLearning({ compile_after: 30 });
  await assert.rejects(demonstrateWorkflows({ ...paused.options, resume: paused.proof() }), /owner changed learning/);
  assert.equal(paused.prompts.length, 1); assert.deepEqual(paused.settings, []);
});

test('workflow proof stops at pending owner review without auto-approving or invoking reuse', async t => {
  const f = await proofFixture(t, { pending: true });
  await assert.rejects(demonstrateWorkflows(f.options), /needs owner review/);
  assert.equal(f.prompts.length, 5); assert.equal(f.proof().sessions.reused, undefined);
});

test('good direct-tool output is never counted as executable workflow reuse', async t => {
  const f = await proofFixture(t, { fallback: true });
  await assert.rejects(demonstrateWorkflows(f.options), /original formatter callback did not execute/);
  assert.equal(f.prompts.length, 7); assert.equal(f.proof().sessions.control_off, undefined);
  const result = f.results.get('session-7').result, run = f.runs.get('run-7');
  const chain = assertOriginalChain(result, await readWorkflowAudit(f.options.auditPath), run, 'demo-worker');
  assert.throws(() => assertExecutableReuse(result, run, f.proof().committed, chain), /No committed workflow completed/);
});

test('uncertain submissions cannot be retried by resume, but confirmed native sessions are read without resending', async t => {
  const uncertain = await proofFixture(t, { uncertain: true });
  await assert.rejects(demonstrateWorkflows(uncertain.options), /before a session receipt/);
  await assert.rejects(demonstrateWorkflows({ ...uncertain.options, resume: uncertain.proof() }), /previous submission is uncertain/);
  assert.equal(uncertain.prompts.length, 1);
  const confirmed = await proofFixture(t, { interrupt: true });
  await assert.rejects(demonstrateWorkflows(confirmed.options), /connection closed/);
  const proof = await demonstrateWorkflows({ ...confirmed.options, resume: confirmed.proof() });
  assert.equal(proof.stage, 'passed'); assert.equal(confirmed.prompts.length, 8);
  assert.deepEqual(confirmed.reads, ['session-1']);
});

test('example source keeps workflows opt-in and binds explicit original native tool names', async () => {
  const connect = await readFile(new URL('./connect.mjs', import.meta.url), 'utf8');
  const formatter = await readFile(new URL('./agent/tools/format_release_brief.ts', import.meta.url), 'utf8');
  const mount = await readFile(new URL('./connection/agentrun-workflows.ts', import.meta.url), 'utf8');
  assert.match(connect, /COPYFILE_EXCL/); assert.match(connect, /--workflows/);
  assert.match(formatter, /EVE_WORKFLOW_AUDIT_PATH \? tool : null/);
  assert.match(mount, /tools: releaseWorkflowTools/);
  assert.deepEqual(releaseWorkflowTools.map(tool => tool.nativeName), ['release_status', 'format_release_brief']);
  assert.ok(releaseWorkflowTools.every(tool => tool.readOnly && tool.permission === 'allow'));
});

for (const [name, option, message] of [
  ['failed compile checks', { compiledFailure: true }, /static and dry-run checks/],
  ['foreign commit provenance', { unrelatedOrigin: true }, /proof-owned learning commit/],
  ['missing canonical callback', { missingServerChild: true }, /canonical server timeline/],
]) test(`workflow proof refuses ${name}`, async t => {
  const f = await proofFixture(t, option);
  await assert.rejects(demonstrateWorkflows(f.options), message);
  assert.equal(f.proof().sessions.control_off, undefined);
});

test('a held compiled draft cannot pass the workflow proof or reach a reuse task', async t => {
  const f = await proofFixture(t, { held: true });
  await assert.rejects(demonstrateWorkflows(f.options), /shadow check did not promote/);
  assert.equal(f.proof().sessions.shadow_check.callbacks.read.source, 'native');
  assert.equal(f.proof().sessions.reused, undefined);
  assert.equal(f.proof().sessions.control_off, undefined);
  assert.equal(f.prompts.length, 6);
});

test('compile provenance refuses a changed workflow or a successful draft with no commit', () => {
  const item = { run: 'origin', name: 'brief', file: 'workflows/brief/workflow.json' }, document = '{}';
  const detail = { run: 'origin', state: 'merged', merged: 'commit', workflows: [item],
    compiled: { workflow: 'brief', attempts: [{ ok: true, errors: [] }], digest: createHash('sha256').update(document).digest('hex').slice(0, 16) } };
  const learning = { log: { items: [{ commit: 'commit', by: { run: 'origin' }, files: [item.file] }] } };
  assertCompiledOrigin(item, document, detail, learning, new Set(['origin']));
  assert.throws(() => assertCompiledOrigin(item, '{"changed":true}', detail, learning, new Set(['origin'])), /differs from the checked compile draft/);
  assert.throws(() => assertCompiledOrigin(item, document, { ...detail, merged: null }, learning, new Set(['origin'])), /proof-owned learning commit/);
  assert.throws(() => assertCompiledOrigin(item, document, detail, learning, new Set(['other'])), /outside this proof/);
});


test('base example writes an explicit owner correction, reuses its revision on changed data, then proves same-agent Off', async () => {
  const { demonstrate, CORRECTION } = await import('./validate.mjs');
  let learning = false, correction = '', version = 1, saved, writes = 0;
  const runs = [], results = new Map(), inputs = [];
  const client = { agents: {
    async get() { return { etag: `"${version}"`, body: { definition: { version, sdk: { runtime: 'eve' }, learning } } }; },
    async update(id, { definition }, headers) { assert.equal(headers['If-Match'], `"${version}"`); learning = definition.learning; version++; return this.get(); },
    async runs() { return { runs }; },
  }, runs: { async get(id) { return runs.find(run => run.run_id === id); } }, learning: {
    async get() { return { main: correction ? 'owner-revision' : 'empty', corrections: correction, workflows: [],
      log: { items: correction ? [{ commit: 'owner-revision', by: { user: true }, files: ['corrections.md'] }] : [] } }; },
    async corrections() { return { body: { text: correction, etag: '"correction-version"' } }; },
    async writeCorrections(id, body, headers) { assert.equal(headers['If-Match'], '"correction-version"'); correction = body.text; writes++; },
  } };
  const options = { agentId: 'owner-example', eveBaseUrl: 'http://127.0.0.1:7443', client,
    checkpoint: async value => { saved = structuredClone(value); },
    async invokeNative(input, { onStarted }) {
      inputs.push(input); assert.ok(!input.includes(CORRECTION));
      const sessionId = `owner-session-${inputs.length}`, service = input.includes('demo-worker') ? 'demo-worker' : 'demo-api';
      await onStarted({ sessionId });
      const release = { service, version: service === 'demo-api' ? '2.4.0' : '3.1.2', tests: 'passed', ready: true, observation: (await import('node:crypto')).randomUUID() };
      const result = { sessionId, answer: `${learning ? 'Launch note: ' : ''}${service} ${release.version} tests passed, ready.`,
        toolCalls: [{ name: 'release_status', outcome: 'completed', release }] };
      runs.push({ run_id: `owner-run-${inputs.length}`, status: 'completed', sdk: { runtime: 'eve', session_id: sessionId, learning_revision: learning ? 'owner-revision' : null } });
      results.set(sessionId, result); return result;
    },
    async readNative(id) { return results.get(id); },
  };
  const proof = await demonstrate(options);
  assert.equal(proof.stage, 'passed'); assert.equal(proof.kind, 'eve-owner-correction');
  assert.equal(proof.correction.ownerCommit, 'owner-revision'); assert.equal(writes, 1);
  assert.equal(inputs.length, 3); assert.equal(learning, false);
  assert.equal((await demonstrate({ ...options, resume: saved })).stage, 'passed');
  assert.equal(inputs.length, 3); assert.equal(writes, 1);
  // An interrupted proof may not replace owner settings with either its On or Off control.
  for (const stage of ['reused', 'control_off']) {
    const paused = structuredClone(proof);
    paused.stage = stage;
    paused.sessions = { connected_off: proof.sessions.connected_off,
      ...(stage === 'control_off' ? { reused: proof.sessions.reused } : {}) };
    paused.settings = [{ learning: true, version: 2 }];
    learning = { compile_after: 40 }; version++;
    const ownerVersion = version;
    let stopped;
    try { await demonstrate({ ...options, resume: paused }); } catch (error) { stopped = error; }
    assert.deepEqual(learning, { compile_after: 40 }, 'Keep the owner settings intact.');
    assert.equal(version, ownerVersion, 'Do not write even with a fresh ETag.');
    assert.equal(inputs.length, 3, 'Do not submit another native task.');
    assert.equal(writes, 1, 'Do not write another correction.');
    assert.match(stopped?.message ?? '', /owner changed learning/);
  }
});
