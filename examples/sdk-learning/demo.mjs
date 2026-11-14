// A live smoke test, not a quality benchmark. All fixtures are fictional and tools are read-only.
import assert from 'node:assert/strict';
import { AgentRun } from '@parcha/agentrun-client';

export const STATUS = Object.freeze({ service: 'demo-api', version: '2.4.0', state: 'ready', tests: 'passed' });
export const INSTRUCTIONS = 'You are a backend release reporter. Read the release status using the available read-only tool before answering. Report only observed values. Follow the user\'s report formatting preferences when they do not conflict with these instructions. Do not modify files or perform deployments.';
export const TASK = 'Read the release status and report the service, version, test result, and whether it is ready.';
export const TEACH = TASK + ' For this and future release status reports, my formatting preference is to begin your final answer with the exact prefix "Release brief:" and then give one concise sentence. Remember this preference for later release reports.';

/** The SDK task still belongs to the existing backend. Inspect only safe receipt metadata for demo assertions. */
export async function demonstrate({ runtime, createBackend, baseUrl = process.env.AGENTRUN_BASE_URL,
  apiKey = process.env.AGENTRUN_API_KEY, agentPrefix = `sdk-demo-${runtime}-${Date.now()}`, fetch: send = globalThis.fetch }) {
  if (!baseUrl || !apiKey) throw new Error('Set AGENTRUN_BASE_URL (ending /v2) and AGENTRUN_API_KEY in the backend environment.');
  const receipts = [];
  const capture = async (url, options) => {
    const response = await send(url, options);
    if (response.ok && options?.method === 'POST' && new URL(url).pathname.endsWith('/sdk-runs')) {
      const receipt = await response.clone().json();
      receipts.push({ runId: receipt.run_id, agentId: receipt.agent_id, consoleUrl: receipt.console_url,
        enabled: receipt.learning.enabled, revision: receipt.learning.revision,
        contextPresent: receipt.learning.enabled && (Boolean(receipt.learning.context?.trim()) ||
          receipt.learning.skills?.some(skill => Object.values(skill.files ?? {}).some(body => typeof body === 'string' && body.trim().length > 0))) });
    }
    return response;
  };
  const options = { baseUrl, apiKey, fetch: capture, instructions: INSTRUCTIONS, learningTimeoutMs: 180_000 };
  const client = new AgentRun({ baseUrl, apiKey, fetch: send });
  const agentId = `${agentPrefix}-on`, controlId = `${agentPrefix}-off`;
  const on = createBackend({ ...options, agentId, name: `${runtime} release reporter`, learning: true });
  const off = createBackend({ ...options, agentId: controlId, name: `${runtime} release reporter (control)`, learning: false });
  const taught = await on.report(TEACH);
  await on.flushLearning();
  const learned = await client.learning.get(agentId);
  const notes = learned.notes.items.filter(note => note.status === 'active' && (note.origin === 'run' || note.origin === 'you'));
  const skills = learned.skills.filter(skill => skill.status === 'active' && typeof skill.run === 'string' && skill.run.length > 0);
  const acceptedLessonFiles = [...notes.map(note => note.file), ...skills.map(skill => skill.file)];
  assert.ok(acceptedLessonFiles.length > 0, 'No checked note or skill was accepted. Inspect Learning Dojo before re-running; this demo never force-approves a lesson.');
  const reused = await on.report(TASK); // Fresh native session; no formatting preference in this user input.
  await on.flushLearning();
  const control = await off.report(TASK);
  await off.flushLearning();
  assert.match(reused.answer, /^Release brief:/i, 'The fresh run did not apply the accepted formatting preference.');
  assert.doesNotMatch(control.answer, /^Release brief:/i, 'The control independently chose the same prefix; this trial cannot establish learned reuse.');
  const second = receipts.filter(receipt => receipt.agentId === agentId)[1];
  assert.equal(second.revision, learned.main, 'The second run did not receive the accepted learning revision.');
  assert.ok(second.contextPresent, 'The second run had no approved learning context.');
  for (const result of [taught, reused, control]) {
    assert.ok(result.toolCalls > 0, 'The existing backend tool did not execute.');
    for (const fact of [STATUS.service, STATUS.version, STATUS.state, STATUS.tests]) {
      assert.ok(result.answer.toLowerCase().includes(fact), `The answer did not report the observed release fact: ${fact}`);
    }
  }
  return { agentId, controlId, acceptedRevision: learned.main, acceptedLessonFiles,
    taught, reused, control, runs: receipts };
}

export function requireLive(args = process.argv.slice(2)) {
  if (!args.includes('--live')) throw new Error('This example uses real models and creates demo agents. Run with --live after configuring the backend and AgentRun server.');
}
