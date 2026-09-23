import assert from 'node:assert/strict';
import test from 'node:test';
import { JevError, createJevRunner } from '@parcha/agentrun-jev';
import { createPiRunner, PiRunError } from '../dist/runner.js';
import { WorkflowExtensionService } from '../dist/extension-service.js';
import { formatRunReport } from '../dist/presentation.js';

// Fictional data: no network, credentials, benchmark questions, or labels.
const secret = 'PRIVATE_BODY_HEADERS_MODEL_IDENTITY_SENTINEL';
const Result = { type: 'object', additionalProperties: false, required: ['accept'],
  properties: { accept: { type: 'boolean', description: 'Is the fictional claim supported?' } } };
const graph = (node = 'judge') => ({ v: 2, name: 'fictional-transport',
  schemas: { Result }, output: { schemaId: 'Result', path: 'decision' },
  root: node === 'judge'
    ? { node, label: 'check-source', state: { evidence: '{evidence}' }, out: 'Result', as: 'decision' }
    : { node, label: 'research-source', instructions: 'Return a fictional decision.', tools: [], out: 'Result', as: 'decision' } });
const safe = report => assert.doesNotMatch(JSON.stringify(report), new RegExp(secret));

test('typed Jev failures expose fixed categories and stage, without retry or provider data', async () => {
  for (const code of ['invalid_response', 'http', 'connection', 'timeout']) {
    const service = new WorkflowExtensionService(); service.prepare(graph());
    let calls = 0;
    const report = await service.run({ evidence: secret }, { deps: { runJudge: async () => {
      calls++; const error = new JevError(code, secret, 1, 503);
      error.cause = { body: secret, headers: secret, model: secret }; throw error;
    } } });
    assert.equal(report.status, 'failed');
    assert.equal(report.error.code, 'jev_' + code);
    assert.equal(report.error.stage, 'check-source');
    assert.equal(calls, 1); assert.equal(report.calls.judge, 1);
    assert.equal(report.error.status, code === 'http' ? 503 : undefined); safe(report);
  }
});

test('real Jev response validation reaches the safe category', async () => {
  let calls = 0;
  const judge = createJevRunner({ maxAttempts: 1, client: { async systemOne() {
    calls++; return { answers: { accept: { type: 'noul', noul: secret } }, model: secret };
  } } });
  const service = new WorkflowExtensionService(); service.prepare(graph());
  const report = await service.run({ evidence: 'fictional' }, { deps: { runJudge: judge } });
  assert.equal(report.error.code, 'jev_invalid_response'); assert.equal(calls, 1); safe(report);
  assert.equal(report.error.reason, 'noul_probability');
});

test('all fixed Jev reasons reach native reports and presentation without arbitrary metadata', async () => {
  for (const reason of ['answers_shape', 'answer_keys', 'answer_shape', 'answer_type', 'noul_probability', 'confidence',
    'probabilities', 'probability_keys', 'probability_mass', 'score_legend', 'score_consistency', 'choice_option', 'score_range',
    'response_shape', 'token_usage', 'model_identifier', 'cost_range', 'answer_validation', 'max_tokens_exceeded']) {
    const http = reason === 'max_tokens_exceeded';
    const service = new WorkflowExtensionService(); service.prepare(graph());
    const report = await service.run({ evidence: 'fictional' }, { deps: { runJudge: async () => {
      const error = new JevError(http ? 'http' : 'invalid_response', secret, 1, 400, undefined, { reason, provider: secret });
      error.cause = { body: secret }; throw error;
    } } });
    assert.equal(report.error.reason, reason); assert.equal(report.error.stage, 'check-source'); safe(report);
    const formatted = formatRunReport(report); assert(formatted.includes(`Reason: ${reason}`)); assert.doesNotMatch(formatted, new RegExp(secret));
    assert.equal(formatted.includes('HTTP status: 400'), http);
    await service.dispose();
  }
});

test('native boundary rejects mutated forged reasons/status and keeps unknown errors opaque', async () => {
  for (const status of [secret, NaN, Infinity, 99, 600, 400.5, 400]) {
    const service = new WorkflowExtensionService(); service.prepare(graph());
    const report = await service.run({ evidence: 'fictional' }, { deps: { runJudge: async () => {
      const error = new JevError('http', secret, 1);
      error.status = status; error.responseDiagnostic = { reason: secret, body: secret }; throw error;
    } } });
    assert.equal(report.error.code, 'jev_http'); assert.equal(report.error.status, status === 400 ? 400 : undefined);
    assert.equal(report.error.reason, undefined); safe(report); assert.doesNotMatch(formatRunReport(report), new RegExp(secret));
    await service.dispose();
  }
});

test('cancellation dominates a late typed Jev capacity error without changing retained report', async () => {
  const service = new WorkflowExtensionService(); service.prepare(graph());
  let entered, reject; const started = new Promise(resolve => { entered = resolve; });
  const running = service.run({ evidence: 'fictional' }, { deps: { runJudge: () => { entered(); return new Promise((_r, fail) => { reject = fail; }); } } });
  await started; service.stop(); const report = await running;
  assert.equal(report.status, 'interrupted'); assert.equal(report.error.code, 'cancelled');
  const retained = service.inspect().lastReport;
  reject(new JevError('http', secret, 1, 400, undefined, { reason: 'max_tokens_exceeded' }));
  await new Promise(resolve => setImmediate(resolve)); assert.deepEqual(service.inspect().lastReport, retained); safe(retained);
});

test('native Pi error event reaches model category, without inspecting provider prose', async () => {
  let listener, prompts = 0;
  const runner = createPiRunner({ model: {}, timeoutMs: null, sessionFactory: async () => ({
    session: {
      subscribe(fn) { listener = fn; return () => {}; },
      async prompt() { prompts++; listener({ type: 'turn_start' }); listener({
        type: 'turn_end', message: { role: 'assistant', stopReason: 'error', errorMessage: secret },
      }); },
      async abort() {}, dispose() {},
    },
  }) });
  const service = new WorkflowExtensionService(); service.prepare(graph('agent'));
  const report = await service.run({}, { deps: { runNode: runner } });
  assert.equal(report.error.code, 'model_response_failed');
  assert.equal(report.error.stage, 'research-source'); assert.equal(prompts, 1); safe(report);
});

test('real Pi runner bounds survive the service and presentation boundary', async () => {
  for (const reason of ['timeout', 'turn_limit', 'submission_limit']) {
    let listener;
    const runner = createPiRunner({ model: {}, maxTurns: 1, maxSubmissions: 1,
      timeoutMs: reason === 'timeout' ? 100 : null,
      sessionFactory: async ({ customTools }) => ({ session: {
        subscribe(fn) { listener = fn; return () => {}; },
        async prompt() {
          listener({ type: 'turn_start' });
          if (reason === 'timeout') return new Promise(() => {});
          if (reason === 'submission_limit') await customTools.find(tool => tool.name === 'submit').execute('bad-result', { value: secret });
          listener({ type: 'turn_end' });
        },
        async abort() {}, dispose() {},
      } }),
    });
    const service = new WorkflowExtensionService(); service.prepare(graph('agent'));
    const report = await service.run({}, { deps: { runNode: runner } });
    assert.equal(report.status, 'failed');
    assert.equal(report.error.code, 'pi_' + reason);
    assert.equal(report.error.stage, 'research-source');
    assert.equal(report.calls.agent, 1);
    assert.match(formatRunReport(report), new RegExp('pi_' + reason));
    safe(report); assert.doesNotMatch(formatRunReport(report), new RegExp(secret));
    await service.dispose();
  }
});

test('typed Pi stop diagnostics never copy error text, causes, or counters', async () => {
  for (const reason of ['timeout', 'turn_limit', 'submission_limit', 'no_submission', 'aborted']) {
    const service = new WorkflowExtensionService(); service.prepare(graph('agent'));
    const report = await service.run({}, { deps: { runNode: async () => {
      const error = new PiRunError(reason, secret, secret);
      error.message = secret; error.cause = { body: secret }; throw error;
    } } });
    assert.equal(report.error.code, 'pi_' + reason);
    assert.equal(report.error.stage, 'research-source'); safe(report);
    await service.dispose();
  }
});

test('unknown and duck-typed errors remain opaque rather than being misclassified', async () => {
  for (const error of [new Error(secret), { name: 'JevError', code: 'http', message: secret },
    { name: 'PiRunError', reason: 'model_error', message: secret }, new PiRunError(secret, 0, 0)]) {
    const service = new WorkflowExtensionService(); service.prepare(graph('agent'));
    const report = await service.run({}, { deps: { runNode: async () => { throw error; } } });
    assert.equal(report.error.code, 'execution_failed'); safe(report);
  }
});

test('operator cancellation dominates late transport failure, and retained report remains stable', async () => {
  const service = new WorkflowExtensionService(); service.prepare(graph('agent'));
  let enter, reject;
  const entered = new Promise(resolve => { enter = resolve; });
  const running = service.run({}, { deps: { runNode: () => {
    enter(); return new Promise((_resolve, fail) => { reject = fail; });
  } } });
  await entered; service.stop();
  const report = await running;
  assert.equal(report.status, 'interrupted'); assert.equal(report.error.code, 'cancelled');
  const retained = service.inspect().lastReport;
  const error = new PiRunError('model_error', 1, 0); error.message = secret; reject(error);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(service.inspect().lastReport, retained); safe(retained);
});

test('parallel failures retain the failed node stage without leaking sibling data', async () => {
  const source = graph('agent');
  source.schemas.All = { type: 'object' }; source.output = { schemaId: 'All' };
  source.root = { node: 'parallel', label: 'parallel-check', branches: [
    { ...source.root, label: 'failing-node', as: 'left' },
    { ...source.root, label: 'waiting-node', as: 'right' },
  ] };
  const service = new WorkflowExtensionService(); service.prepare(source);
  let enter;
  const entered = new Promise(resolve => { enter = resolve; });
  const report = await service.run({}, { deps: { runNode: async ({ label }) => {
    if (label === 'waiting-node') { enter(); return new Promise(() => {}); }
    await entered; const error = new PiRunError('model_error', 1, 0); error.message = secret; throw error;
  } } });
  assert.equal(report.error.code, 'model_response_failed');
  assert.equal(report.error.stage, 'failing-node'); safe(report);
});
