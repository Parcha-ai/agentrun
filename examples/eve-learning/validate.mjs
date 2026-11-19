// Opt-in integration proof. Never re-send a paid task after a failure or uncertain result.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { AgentRun } from '@parcha/agentrun-client';
import { readReport, report } from './invoke.mjs';

const PREFIX = 'Launch note:';
const VISIBLE_PREFIX = /^(?:Launch note:|\*\*Launch note:\*\*)/i;
const task = service => `Read release status for ${service} and report its service, version, test result and readiness.`;
export const CORRECTION = `Begin every release status report with the exact prefix "${PREFIX}" and use one concise sentence.`;
const POLL_MS = 180_000;
const TERMINAL = new Set(['completed', 'failed', 'cancelled']);

// Only safe summary metadata: never admission tokens, keys, or arbitrary server error payloads.
function runSummary(run) {
  return { runId: run.run_id, status: run.status, sessionId: run.sdk?.session_id,
    runtime: run.sdk?.runtime, model: run.sdk?.model, revision: run.sdk?.learning_revision ?? null,
    learningState: run.learning?.state ?? null, learningReason: run.learning?.reason ?? null };
}

async function poll(read, description) {
  const signal = AbortSignal.timeout(POLL_MS);
  while (!signal.aborted) {
    const result = await read({ signal, timeoutMs: 10_000 });
    if (result) return result;
    await delay(1_000, undefined, { signal });
  }
  throw new Error(`Timed out waiting for ${description}; inspect the recorded session before running another paid task.`);
}

async function runForSession(client, agentId, sessionId) {
  return poll(async options => {
    const page = await client.agents.runs(agentId, { limit: 100 }, options);
    const matches = page.runs.filter(run => run.sdk?.runtime === 'eve' && run.sdk.session_id === sessionId);
    assert.ok(matches.length <= 1, 'One fresh eve session unexpectedly produced multiple AgentRun runs.');
    if (!matches.length) return null;
    const run = await client.runs.get(matches[0].run_id, options);
    if (!TERMINAL.has(run.status)) return null;
    assert.equal(run.status, 'completed', 'The recorded eve task did not complete successfully.');
    return run;
  }, 'the recorded eve run');
}

async function setLearning(client, agentId, learning) {
  const current = await client.agents.get(agentId);
  assert.equal(current.body.definition.sdk?.runtime, 'eve', 'The id is not the connected eve agent.');
  if (current.body.definition.learning === learning) return { learning, version: current.body.definition.version, etag: current.etag, unchanged: true };
  assert.ok(current.etag, 'The server did not supply an ETag for the learning-setting change.');
  const { version: previousVersion, ...definition } = current.body.definition;
  const updated = await client.agents.update(agentId, {
    definition: { ...definition, learning },
  }, { 'If-Match': current.etag });
  assert.equal(updated.body.definition.learning, learning, 'The learning-setting change was not applied.');
  return { learning, version: updated.body.definition.version, etag: updated.etag };
}

function verifyOriginalTool(result, service, previousObservations) {
  const expectedVersion = service === 'demo-api' ? '2.4.0' : '3.1.2';
  const calls = result.toolCalls.filter(call => call.name === 'release_status' && call.outcome === 'completed' && call.release?.service === service);
  assert.ok(calls.length > 0, 'The original release_status callback did not return the requested service.');
  for (const call of calls) {
    assert.equal(call.release.version, expectedVersion, 'The native tool returned the wrong fixture version.');
    assert.equal(call.release.tests, 'passed', 'The native tool did not return the expected test result.');
    assert.equal(call.release.ready, true, 'The native tool did not return readiness.');
    assert.match(call.release.observation, /^[0-9a-f]{8}-[0-9a-f-]{27}$/i, 'The native tool did not return a fresh observation id.');
    assert.ok(!previousObservations.has(call.release.observation), 'A tool observation was replayed instead of executing the original callback.');
    previousObservations.add(call.release.observation);
  }
  for (const fact of [service, expectedVersion, 'passed', 'ready']) {
    assert.ok(result.answer.toLowerCase().includes(fact), `The answer omitted an observed release fact: ${fact}`);
  }
}

/** Owner-authored corrections delivery, not autonomous learning. Three fresh native eve sessions. */
export async function demonstrate({ baseUrl = process.env.AGENTRUN_BASE_URL, apiKey = process.env.AGENTRUN_API_KEY,
  agentId = process.env.AGENTRUN_AGENT_ID, eveBaseUrl = process.env.EVE_BASE_URL,
  eveBearer = process.env.EVE_BEARER_TOKEN, checkpoint = async () => {}, resume,
  client: suppliedClient, invokeNative = report, readNative = readReport } = {}) {
  if ((!suppliedClient && (!baseUrl || !apiKey)) || !agentId || !eveBaseUrl) throw new Error('Set AGENTRUN_BASE_URL, AGENTRUN_API_KEY, AGENTRUN_AGENT_ID and EVE_BASE_URL in the environment.');
  const client = suppliedClient ?? new AgentRun({ baseUrl, apiKey, timeoutMs: 10_000, maxRetries: 0 });
  if (resume) {
    assert.equal(resume.kind, 'eve-owner-correction', 'Legacy autonomous note/skill proofs cannot be resumed.');
    assert.equal(resume.agentId, agentId, 'The saved proof belongs to another AgentRun agent.');
    assert.equal(resume.prefix, PREFIX, 'The saved proof uses a different teaching preference.');
    assert.ok(!resume.runtime || resume.runtime === 'eve', 'The saved proof belongs to another runtime.');
    assert.ok(resume.sessions && typeof resume.sessions === 'object' && Array.isArray(resume.settings), 'The saved proof is malformed.');
    for (const saved of Object.values(resume.sessions)) assert.ok(!saved.run || saved.run.runtime === 'eve', 'A saved run belongs to another runtime.');
  }
  const priorStage = resume?.stage;
  const evidence = resume ? structuredClone(resume) : { kind: 'eve-owner-correction', agentId, prefix: PREFIX, startedAt: new Date().toISOString(), stage: 'preflight', sessions: {}, settings: [] };
  evidence.runtime = 'eve';
  if (resume) {
    evidence.resumptions = [...evidence.resumptions ?? [], { at: new Date().toISOString(), stage: priorStage, ...(evidence.failure ? { failure: evidence.failure } : {}) }];
    delete evidence.failure;
  }
  const save = async () => checkpoint(evidence);
  await save();
  const observations = new Set();
  const sessionIds = new Set();
  try {
    // Refuse to quietly test against an agent with pre-existing learning or change another runtime's settings.
    let existing;
    try { existing = await client.agents.get(agentId); }
    catch (error) { if (error.code !== 'not_found') throw error; }
    if (existing) {
      assert.equal(existing.body.definition.sdk?.runtime, 'eve', 'Use the dedicated eve example id.');
      if (!resume) {
        assert.equal(existing.body.definition.learning, false, 'Start with the example agent learning Off.');
        const before = await client.learning.get(agentId);
        assert.equal(before.corrections?.trim() ?? '', '', 'Use a fresh demonstration agent without owner corrections.');
        assert.equal(before.workflows.length, 0, 'Use a fresh demonstration agent without workflows.');
      }
    }
    if (resume) assert.ok(existing, 'The connected agent from the saved proof no longer exists.');

    const invoke = async (stage, input, service) => {
      evidence.stage = stage;
      await save();
      const saved = evidence.sessions[stage];
      if (resume && (saved || priorStage === stage)) assert.ok(saved?.sessionId, 'The previous task submission has no confirmed session id; inspect it rather than sending a replacement.');
      let result;
      if (saved?.sessionId) {
        result = await readNative(saved.sessionId, { expectedTask: input, baseUrl: eveBaseUrl, bearer: eveBearer });
        if (saved.turnId) assert.equal(result.turnId, saved.turnId, 'The saved native turn identity changed.');
      } else {
        evidence.sessions[stage] = { state: 'submitting' };
        await save();
        result = await invokeNative(input, { baseUrl: eveBaseUrl, bearer: eveBearer,
          onStarted: async receipt => { evidence.sessions[stage] = { ...receipt, state: 'started' }; await save(); } });
      }
      evidence.sessions[stage] = { ...result, ...(saved?.run ? { run: saved.run } : {}), state: 'native_completed' };
      await save(); // Keep the native result even if telemetry or an assertion fails next.
      assert.ok(!sessionIds.has(result.sessionId), 'The learning comparison reused native conversation history.');
      sessionIds.add(result.sessionId);
      verifyOriginalTool(result, service, observations);
      const run = await runForSession(client, agentId, result.sessionId);
      if (saved?.run?.runId) assert.equal(run.run_id, saved.run.runId, 'The saved AgentRun run identity changed.');
      evidence.sessions[stage].run = runSummary(run);
      await save();
      return { result, run };
    };

    const connected = await invoke('connected_off', task('demo-api'), 'demo-api');
    assert.equal(connected.run.sdk.learning_revision, null, 'The Off run unexpectedly received learning.');
    assert.equal(connected.run.learning ?? null, null, 'The Off run unexpectedly started learning.');
    assert.doesNotMatch(connected.result.answer, VISIBLE_PREFIX, 'The baseline independently used the special prefix; this comparison is inconclusive.');
    if (!evidence.correction) {
      evidence.settings.push(await setLearning(client, agentId, true));
      const current = (await client.learning.corrections(agentId)).body;
      assert.equal(current.text.trim(), '', 'The owner added corrections outside this proof.');
      assert.ok(current.etag, 'No version guard for owner corrections.');
      evidence.correction = { state: 'submitting', text: `- ${CORRECTION}\n` };
      await save();
      await client.learning.writeCorrections(agentId, { text: evidence.correction.text }, { 'If-Match': current.etag });
      evidence.correction.state = 'written'; await save();
    }
    // An interrupted write is resolved by reading the exact body, never blindly re-sent.
    const learned = await client.learning.get(agentId);
    assert.equal(learned.corrections, evidence.correction.text, 'The owner correction write is absent or changed; inspect it before proceeding.');
    const correctionCommit = learned.log.items.find(change => change.by?.user === true && change.files.includes('corrections.md'));
    assert.ok(correctionCommit, 'The correction has no owner-authored provenance.');
    const correctedRevision = evidence.correction.revision ?? learned.main;
    assert.ok(correctedRevision && (correctedRevision === learned.main || learned.log.items.some(change => change.commit === correctedRevision)));
    evidence.correction = { ...evidence.correction, state: 'verified', revision: correctedRevision, ownerCommit: correctionCommit.commit };
    await save();
    if (!evidence.sessions.reused?.sessionId) {
      evidence.settings.push(await setLearning(client, agentId, true));
      await save();
    }
    const reused = await invoke('reused', task('demo-worker'), 'demo-worker');
    assert.equal(reused.run.sdk.learning_revision, correctedRevision, 'The fresh run did not receive the owner correction revision.');
    assert.match(reused.result.answer, VISIBLE_PREFIX, 'The fresh session did not apply the owner correction to the new service.');

    if (!evidence.sessions.control_off?.sessionId) {
      evidence.settings.push(await setLearning(client, agentId, false));
      await save();
    }
    const control = await invoke('control_off', task('demo-worker'), 'demo-worker');
    assert.equal(control.run.sdk.learning_revision, null, 'The Off control unexpectedly received learning.');
    assert.equal(control.run.learning ?? null, null, 'The Off control unexpectedly started learning.');
    assert.doesNotMatch(control.result.answer, VISIBLE_PREFIX, 'The Off control independently chose the same prefix; this comparison is inconclusive.');
    evidence.stage = 'passed';
    evidence.finishedAt = new Date().toISOString();
    await save();
    return evidence;
  } catch (error) {
    // An external error can contain a URL or header. Persist only the safe class/code and failing stage.
    evidence.failure = { name: /^[A-Za-z]+$/.test(error.name) ? error.name : 'Error',
      ...(error.name === 'AssertionError' ? { message: error.message } : {}),
      ...(typeof error.code === 'string' && /^[a-zA-Z0-9_]+$/.test(error.code) ? { code: error.code } : {}) };
    await save();
    throw error;
  }
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (!args.includes('--live')) throw new Error('This writes one explicit owner correction and starts three real eve model tasks. Run with --live after the original baseline and extension setup.');
  let output, resumePath;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--live') continue;
    if (!['--output', '--resume'].includes(args[i]) || !args[i + 1] || args[i + 1].startsWith('--')) throw new Error('Usage: node validate.mjs --live [--output new-evidence.json] [--resume saved-proof.json]');
    if (args[i] === '--output') output = args[++i]; else resumePath = args[++i];
  }
  const resume = resumePath ? JSON.parse(await readFile(resumePath, 'utf8')) : undefined;
  output ??= resumePath;
  assert.ok(output, 'An evidence output path is required before any paid task.');
  let created = output === resumePath && Boolean(resumePath);
  try {
    const evidence = await demonstrate({ resume, checkpoint: async value => {
      if (output) {
        await writeFile(output, `${JSON.stringify(value, null, 2)}\n`, { flag: created ? 'w' : 'wx', mode: 0o600 });
        created = true;
      }
    } });
    console.log(JSON.stringify(evidence, null, 2));
  } catch (error) {
    console.error(`Validation stopped (${error.name}); inspect the last saved stage and native session before retrying. No paid task was automatically retried.`);
    process.exitCode = 1;
  }
}
