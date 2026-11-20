// Real native traces → compilation → independent native shadow check → promoted workflow → original callbacks. No seeded workflow.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { isDeepStrictEqual } from 'node:util';
import { AgentRun } from '@parcha/agentrun-client';
import { POLICY } from './agent/lib/policy.ts';
import { readWorkflowAudit } from './agent/lib/release-tools.ts';
import { readWorkflowReport, workflowReport } from './workflow-report.mjs';

export const workflowTask = service => `Prepare a release brief for ${service} from its current release data. Return the formatter's brief verbatim as plain text: no Markdown, bold, headings, quotes, commentary, or extra lines.`;
export const teachWorkflow = workflowTask('demo-api') + ' For this and future release briefs, follow this reusable two-step procedure: call release_status for the requested service, then pass its entire returned status object unchanged to format_release_brief. Use the same procedure on later release briefs. Service names, versions and observations are fresh request data, never constants to remember.';
const TOOL_NAMES = ['mcp:release/release_status', 'mcp:release/format_release_brief'];
const TERMINAL = new Set(['completed', 'failed', 'cancelled']);
const DEMO_LEARNING = { compile_after: 5 };
const summarize = run => ({ runId: run.run_id, runtime: run.sdk?.runtime, sessionId: run.sdk?.session_id,
  status: run.status, revision: run.sdk?.learning_revision ?? null, learningState: run.learning?.state ?? null });

/** The journal is test-fixture data, independent of the model's claim that it ran a workflow. */
export function assertOriginalChain(result, rows, run, service, observations = new Set(), source) {
  const scoped = rows.filter(row => row.source === 'native' ? row.sessionId === result.sessionId : row.runId === run.run_id);
  const formatted = scoped.findLast(row => row.tool === 'format_release_brief' && (!source || row.source === source));
  assert.ok(formatted, 'The original formatter callback did not execute.');
  const read = scoped.find(row => row.tool === 'release_status' && row.source === formatted.source
    && row.result.observation === formatted.input.status.observation);
  assert.ok(read, 'The formatter did not receive a fresh observation from the original read callback.');
  assert.deepEqual(formatted.input.status, read.result, 'The formatter input changed the observed status.');
  assert.equal(read.input.service, service); assert.equal(read.result.service, service);
  assert.equal(read.result.version, service === 'demo-api' ? '2.4.0' : '3.1.2');
  assert.equal(read.result.tests, 'passed'); assert.equal(read.result.ready, true);
  assert.match(read.result.observation, /^[0-9a-f]{8}-[0-9a-f-]{27}$/i);
  assert.ok(!observations.has(read.result.observation), 'A prior callback result was replayed.');
  observations.add(read.result.observation);
  assert.equal(result.answer.trim(), formatted.result.brief, 'The native answer changed the original formatter result.');
  if (formatted.source === 'native') for (const name of ['release_status', 'format_release_brief']) {
    assert.ok(result.toolCalls.some(call => call.name === name && call.outcome === 'completed'), `The original ${name} tool has no completed native call.`);
  }
  return { read, formatted };
}

export function assertExecutableReuse(result, run, committed, chain) {
  assert.equal(run.sdk.learning_revision, committed.revision, 'The fresh run did not pin the committed workflow revision.');
  const call = result.toolCalls.find(call => call.name === 'agentrun__learned_workflow' && call.outcome === 'completed'
    && committed.workflows.some(item => item.name === call.workflow?.name));
  assert.ok(call, 'No committed workflow completed. Direct-tool fallback is not workflow reuse.');
  const trace = call.workflow;
  assert.equal(trace.runId, run.run_id); assert.equal(trace.revision, committed.revision); assert.equal(trace.complete, true);
  assert.equal(chain.read.source, 'workflow'); assert.equal(chain.formatted.source, 'workflow');
  assert.equal(chain.read.workflow, trace.name); assert.equal(chain.formatted.workflow, trace.name);
  const parents = trace.events.filter(event => event.name === 'learned_workflow' && event.status === 'completed');
  assert.ok(parents.length, 'The workflow trace has no completed interpreter invocation.');
  for (const name of TOOL_NAMES) assert.ok(trace.events.some(event => event.name === name && event.status === 'completed'
    && parents.some(parent => parent.id === event.parent_tool_use_id)), 'The workflow did not execute both original callback bindings.');
}

/** A committed draft passed the compiler's static and synthesized dry-run checks, not a runtime promotion grade. */
export function assertCompiledOrigin(item, document, detail, learning, proofRunIds) {
  assert.ok(proofRunIds.has(item.run), 'The workflow came from a run outside this proof.');
  assert.equal(detail?.run, item.run);
  assert.equal(detail.state, 'merged', 'The compile result was not committed.');
  assert.equal(detail.compiled?.workflow, item.name, 'The origin did not compile this workflow.');
  assert.ok(detail.compiled.attempts.length && detail.compiled.attempts.at(-1).ok
    && detail.compiled.attempts.at(-1).errors.length === 0, 'The compile draft did not pass its static and dry-run checks.');
  assert.equal(detail.compiled.digest, createHash('sha256').update(document).digest('hex').slice(0, 16),
    'The committed workflow differs from the checked compile draft.');
  assert.ok(detail.workflows.some(file => file.file === item.file && file.name === item.name && !file.pending));
  assert.ok(detail.merged && learning.log.items.some(change => change.commit === detail.merged
    && change.by?.run === item.run && change.files.includes(item.file)), 'No proof-owned learning commit records this workflow.');
  return { run: detail.run, revision: detail.merged, compiled: detail.compiled };
}

export function assertServerWorkflow(trace, rows) {
  const parents = trace.events.filter(event => event.name === 'learned_workflow' && event.status === 'completed');
  const children = trace.events.filter(event => TOOL_NAMES.includes(event.name) && event.status === 'completed');
  for (const event of [...parents, ...children]) assert.ok(rows.some(row => row.kind === 'tool_result'
    && row.tool_use_id === event.id && row.tool_name === event.name && row.tool_status === 'success'
    && (event.parent_tool_use_id === undefined || row.parent_tool_use_id === event.parent_tool_use_id)),
  'The canonical server timeline is missing a completed workflow or original callback child.');
}
const offered = item => !['pending', 'retired'].includes(item.status) && item.run;

/** Bounded paid work; polling and resume perform reads, never replay a submitted native task. */
export async function demonstrateWorkflows({ baseUrl = process.env.AGENTRUN_BASE_URL, apiKey = process.env.AGENTRUN_API_KEY,
  agentId = process.env.AGENTRUN_AGENT_ID, eveBaseUrl = process.env.EVE_BASE_URL, eveBearer = process.env.EVE_BEARER_TOKEN,
  auditPath = process.env.EVE_WORKFLOW_AUDIT_PATH, checkpoint = async () => {}, resume,
  client: suppliedClient, invokeNative = workflowReport, readNative = readWorkflowReport, readAudit = readWorkflowAudit,
  pollMs = 180_000, pollIntervalMs = 1_000 } = {}) {
  assert.ok(agentId && eveBaseUrl && auditPath && (suppliedClient || baseUrl && apiKey), 'Set the AgentRun and Eve connection environment and EVE_WORKFLOW_AUDIT_PATH.');
  // The generated client parses JSON files. Preserve their response text as well so a digest
  // comparison covers the exact checked bytes, including whitespace, without a second request.
  const fileTexts = new Map();
  const client = suppliedClient ?? new AgentRun({ baseUrl, apiKey, timeoutMs: 10_000, maxRetries: 0,
    fetch: async (url, options) => {
      const response = await fetch(url, options);
      const path = new URL(url).pathname;
      if (response.ok && options?.method === 'GET' && path.includes('/learning/files/')) {
        const text = await response.clone().text();
        assert.ok(Buffer.byteLength(text) <= 256 * 1024, 'Workflow document exceeds the proof bound.');
        fileTexts.set(decodeURIComponent(path.split('/learning/files/')[1]), text);
      }
      return response;
    },
  });
  if (resume) {
    assert.equal(resume.kind, 'eve-executable-workflow'); assert.equal(resume.version, 3, 'Older proofs did not require a native shadow check; start a fresh proof.'); assert.equal(resume.agentId, agentId);
    assert.ok(resume.sessions && Array.isArray(resume.settings), 'Malformed saved workflow proof.');
  }
  const priorStage = resume?.stage;
  const proof = resume ? structuredClone(resume) : { kind: 'eve-executable-workflow', version: 3, agentId,
    startedAt: new Date().toISOString(), stage: 'preflight', sessions: {}, settings: [] };
  if (resume) { proof.resumptions = [...proof.resumptions ?? [], { at: new Date().toISOString(), stage: priorStage, failure: proof.failure }]; delete proof.failure; }
  const save = () => checkpoint(proof);
  const poll = async (read, what) => {
    const deadline = Date.now() + pollMs;
    while (Date.now() < deadline) { const value = await read(); if (value) return value; await delay(pollIntervalMs); }
    throw new Error(`Timed out waiting for ${what}. Inspect the saved proof before any more paid tasks.`);
  };
  const setLearning = async learning => {
    assert.equal(proof.createdAgent, true, 'Only the dedicated agent created by this proof may change learning settings.');
    const current = await client.agents.get(agentId);
    assert.equal(current.body.definition.sdk?.runtime, 'eve');
    assert.deepEqual(current.body.definition.learning, proof.settings.at(-1)?.learning ?? false,
      'The owner changed learning outside this proof. Inspect the settings; this demo will not overwrite them.');
    if (isDeepStrictEqual(current.body.definition.learning, learning)) return;
    assert.ok(current.etag, 'No version guard for learning setting.');
    const { version, ...definition } = current.body.definition;
    const updated = await client.agents.update(agentId, { definition: { ...definition, learning } }, { 'If-Match': current.etag });
    assert.deepEqual(updated.body.definition.learning, learning);
    proof.settings.push({ learning, version: updated.body.definition.version }); await save();
  };
  const readLearning = async () => {
    const learning = await client.learning.get(agentId);
    assert.equal(learning.corrections?.trim() ?? '', '', 'This automatic workflow proof must not use owner-written corrections.');
    assert.ok(!learning.workflows.some(item => item.status === 'pending'), 'A workflow needs owner review. The proof never force-approves it.');
    return learning;
  };
  const observations = new Set(), sessions = new Set();
  const invoke = async (stage, input, service, source) => {
    proof.stage = stage; await save();
    const saved = proof.sessions[stage];
    if (resume && (saved || priorStage === stage)) assert.ok(saved?.sessionId, 'A previous submission is uncertain. Inspect it; do not submit a replacement.');
    let result;
    if (saved?.sessionId) result = await readNative(saved.sessionId, { expectedTask: input, baseUrl: eveBaseUrl, bearer: eveBearer });
    else {
      proof.sessions[stage] = { state: 'submitting' }; await save();
      result = await invokeNative(input, { baseUrl: eveBaseUrl, bearer: eveBearer, onStarted: async receipt => {
        proof.sessions[stage] = { ...receipt, state: 'started' }; await save();
      } });
    }
    assert.ok(!sessions.has(result.sessionId), 'A previous conversation was reused.'); sessions.add(result.sessionId);
    proof.sessions[stage] = { ...result, state: 'native_completed' }; await save();
    const run = await poll(async () => {
      const page = await client.agents.runs(agentId, { limit: 100 });
      const matches = page.runs.filter(row => row.sdk?.runtime === 'eve' && row.sdk.session_id === result.sessionId);
      assert.ok(matches.length <= 1, 'A fresh native turn produced duplicate admissions.');
      if (!matches.length) return null;
      const row = await client.runs.get(matches[0].run_id);
      if (!TERMINAL.has(row.status)) return null;
      assert.equal(row.status, 'completed'); return row;
    }, 'the recorded native run');
    if (saved?.run?.runId) assert.equal(saved.run.runId, run.run_id);
    const chain = assertOriginalChain(result, await readAudit(auditPath), run, service, observations, source);
    proof.sessions[stage] = { ...result, run: summarize(run), callbacks: chain, state: 'verified' }; await save();
    return { result, run, chain };
  };
  const settle = async runId => poll(async () => {
    const run = await client.runs.get(runId);
    await readLearning();
    return ['merged', 'dropped'].includes(run.learning?.state) ? run : null;
  }, 'workflow compilation');

  await save();
  try {
    let existing;
    try { existing = await client.agents.get(agentId); } catch (error) { if (error.code !== 'not_found') throw error; }
    if (existing) {
      assert.equal(existing.body.definition.sdk?.runtime, 'eve');
      assert.ok(resume && proof.createdAgent === true,
        'Use a new dedicated agent id. This proof does not change a pre-existing agent or its learning settings.');
    } else {
      assert.ok(!resume, 'The saved proof agent no longer exists.');
      await client.agents.create({ definition: { id: agentId, name: 'Eve workflow learning demonstration',
        instructions: POLICY, sdk: { runtime: 'eve' }, learning: false } }, { 'Idempotency-Key': randomUUID() });
      proof.createdAgent = true; await save();
    }
    const baseline = await invoke('connected_off', teachWorkflow, 'demo-api', 'native');
    assert.equal(baseline.run.sdk.learning_revision, null); assert.equal(baseline.run.learning ?? null, null);
    assert.equal(baseline.result.toolCalls.filter(call => call.workflow).length, 0);
    // Main counts prior completed native runs, including the connected Off baseline.
    // Compile after five qualifying runs; never insert notes, corrections, skills or workflow files.
    if (!proof.sessions.taught?.sessionId) await setLearning(DEMO_LEARNING);
    const taught = await invoke('taught', teachWorkflow, 'demo-api', 'native');
    await settle(taught.run.run_id);
    let learned = await readLearning();
    for (let index = 1; index <= 4; index++) {
      const stage = `practice_${index}`;
      if (learned.workflows.some(offered) && !proof.sessions[stage]) break;
      if (!proof.sessions[stage]?.sessionId) await setLearning(DEMO_LEARNING);
      const practice = await invoke(stage, workflowTask('demo-api'), 'demo-api');
      await settle(practice.run.run_id); learned = await readLearning();
    }
    const active = learned.workflows.filter(offered);
    assert.ok(active.length, 'No committed workflow after the bounded ordinary practice cadence. Inspect Dojo before more paid work.');
    if (!proof.committed) {
      const workflows = [];
      for (const item of active) {
        const response = await client.learning.read(agentId, item.file);
        const document = fileTexts.get(item.file) ?? response.body;
        assert.equal(typeof document, 'string', 'The exact workflow response text is required to verify its digest.');
        const origin = assertCompiledOrigin(item, document, await client.runs.learning(item.run), learned,
          new Set(Object.values(proof.sessions).map(saved => saved.run?.runId)));
        workflows.push({ name: item.name, file: item.file, run: item.run, status: item.status, document, origin });
      }
      proof.committed = { revision: learned.main, workflows, qualifyingRuns: Object.entries(proof.sessions)
        .filter(([stage]) => stage === 'connected_off' || stage === 'taught' || stage.startsWith('practice_'))
        .map(([, saved]) => saved.run.runId) }; await save();
    }
    assert.ok(proof.committed.revision && (proof.committed.revision === learned.main || learned.log.items.some(row => row.commit === proof.committed.revision)), 'The saved committed revision is absent from real learning history.');
    // A compile/dry-run result is only a draft. Let one independent native turn answer first; its private
    // shadow execution is compared with that answer, without advertising the candidate as a reusable tool.
    if (!proof.sessions.shadow_check?.sessionId) await setLearning(DEMO_LEARNING);
    const checked = await invoke('shadow_check', workflowTask('demo-worker'), 'demo-worker', 'native');
    assert.equal(checked.result.toolCalls.filter(call => call.workflow || call.name === 'agentrun__learned_workflow').length, 0,
      'An unpromoted draft was offered before the independent native answer.');
    await settle(checked.run.run_id);
    const checkedLearning = await readLearning();
    for (const workflow of proof.committed.workflows) {
      const candidate = checkedLearning.workflows.find(item => item.name === workflow.name && item.run === workflow.run);
      assert.equal(candidate?.status, 'serving', 'The native shadow check did not promote the compiled workflow. Do not reuse a checking or held draft.');
    }
    proof.check = { runId: checked.run.run_id, workflows: proof.committed.workflows.map(({ name }) => name), state: 'promoted' };
    await save();
    if (!proof.sessions.reused?.sessionId) await setLearning(DEMO_LEARNING);
    const reused = await invoke('reused', workflowTask('demo-worker'), 'demo-worker', 'workflow');
    assertExecutableReuse(reused.result, reused.run, proof.committed, reused.chain);
    const rows = []; let after = 0;
    for (let page = 0; page < 10; page++) {
      const timeline = await client.runs.timeline(reused.run.run_id, { after, limit: 100 });
      rows.push(...timeline.rows);
      if (!timeline.has_more) break;
      assert.ok(timeline.next_after > after && page < 9, 'Canonical timeline was incomplete or exceeded the proof bound.');
      after = timeline.next_after;
    }
    const invocation = reused.result.toolCalls.find(call => call.workflow)?.workflow;
    assertServerWorkflow(invocation, rows);
    proof.serverWorkflow = rows.filter(row => row.kind === 'tool_result' && row.tool_status === 'success')
      .map(({ tool_use_id, tool_name, parent_tool_use_id }) => ({ tool_use_id, tool_name, parent_tool_use_id }));
    await save();
    if (!proof.sessions.control_off?.sessionId) await setLearning(false);
    const off = await invoke('control_off', workflowTask('demo-worker'), 'demo-worker', 'native');
    assert.equal(off.run.sdk.learning_revision, null); assert.equal(off.run.learning ?? null, null);
    assert.equal(off.result.toolCalls.filter(call => call.workflow || call.name === 'agentrun__learned_workflow').length, 0, 'The Off run still offered or executed a learned workflow.');
    proof.stage = 'passed'; proof.finishedAt = new Date().toISOString(); await save(); return proof;
  } catch (error) {
    proof.failure = { name: /^[A-Za-z]+$/.test(error.name) ? error.name : 'Error',
      ...(error.name === 'AssertionError' ? { message: error.message } : {}) };
    await save(); throw error;
  }
}

if (import.meta.main) {
  const args = process.argv.slice(2); let output, resumePath;
  if (!args.includes('--live')) throw new Error('This starts up to nine native model tasks and server compilation. Configure the example and pass --live.');
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--live') continue;
    if (!['--output', '--resume'].includes(args[i]) || !args[i + 1] || args[i + 1].startsWith('--')) throw new Error('Usage: node workflow-validate.mjs --live --output new-proof.json [--resume saved-proof.json]');
    if (args[i] === '--output') output = args[++i]; else resumePath = args[++i];
  }
  output ??= resumePath;
  assert.ok(output, 'An evidence output path is required before any paid task.');
  const resume = resumePath ? JSON.parse(await readFile(resumePath, 'utf8')) : undefined;
  let created = output === resumePath && Boolean(resumePath);
  try {
    const result = await demonstrateWorkflows({ resume, checkpoint: async value => {
      await writeFile(output, JSON.stringify(value, null, 2) + '\n', { flag: created ? 'w' : 'wx', mode: 0o600 }); created = true;
    } });
    console.log(JSON.stringify(result, null, 2));
  } catch (error) { console.error(`Workflow proof stopped (${error.name}). Inspect the checkpoint; no paid task was automatically retried.`); process.exitCode = 1; }
}
