import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createJevRunner } from '../packages/jev/dist/index.js';
import { EffectOutcomeUnknownError, workflowSha256 } from '../packages/dsl/dist/index.js';
import { workflow } from './support-answer.mjs';
import { scenarios, createScriptedAdapters } from './support-answer-fixtures.mjs';
import { parseArgs } from './run-support-answer.mjs';
import { validateHostConfig, runLiveSupport, runSupportWithAdapters, SupportSetupError, SupportRunError } from './support-answer-live.mjs';

const host = () => ({ runNode: async () => {}, runEffect: async () => {} });
const runtime = dirname(fileURLToPath(import.meta.url));
const invoke = (args, env = {}) => spawnSync(process.execPath, [join(runtime, 'run-support-answer.mjs'), ...args], {
  encoding: 'utf8', timeout: 15_000, env: { ...process.env, TYPESAFE_API_KEY: '', ...env },
});

test('CLI parses scripted, live, and custom-input modes without ambiguity', () => {
  assert.deepEqual(parseArgs([]), {});
  assert.deepEqual(parseArgs(['payment', '--config', './host.mjs']), { scenario: 'payment', config: './host.mjs' });
  assert.deepEqual(parseArgs(['--config', './host.mjs', '--input', './input.json']), { config: './host.mjs', input: './input.json' });
  for (const args of [['--input', 'input.json'], ['password', '--config', 'a', '--input', 'b'], ['--config'], ['--config', 'a', '--config', 'b'], ['--live'], ['other']]) assert.throws(() => parseArgs(args));
});

test('help needs no credentials and documents exit codes', () => {
  const run = invoke(['--help']);
  assert.equal(run.status, 0);
  assert.match(run.stdout, /--config/);
  assert.match(run.stdout, /2 single-case escalation/);
  assert.equal(run.stderr, '');
});

test('missing or placeholder Jev key directs setup without printing credentials', () => {
  for (const key of [undefined, '', '  ', 'your-key', '<your-key>']) {
    assert.throws(() => validateHostConfig(host(), { TYPESAFE_API_KEY: key }), error => {
      assert.ok(error instanceof SupportSetupError);
      assert.match(error.message, /https:\/\/console.typesafe.ai\/keys/);
      assert.match(error.message, /CLI login does not supply/);
      return true;
    });
  }
});

test('existing environment key is reused; explicit server binding wins without mutation', () => {
  const env = { TYPESAFE_API_KEY: 'fake-test-key' };
  assert.equal(validateHostConfig(host(), env).jev.apiKey, env.TYPESAFE_API_KEY);
  const config = { ...host(), jev: { apiKey: 'not-a-secret', maxAttempts: 1 } };
  assert.equal(validateHostConfig(config, env).jev.apiKey, 'not-a-secret');
  assert.deepEqual(config.jev, { apiKey: 'not-a-secret', maxAttempts: 1 });
});

test('live config rejects replacement judges and fake transports', () => {
  for (const config of [
    { ...host(), runJudge: async () => ({}) },
    { ...host(), jev: { fetch: async () => ({}) } },
    { ...host(), jev: { client: {} } },
    { ...host(), timeoutMs: 0 },
    { runNode: async () => {} },
  ]) assert.throws(() => validateHostConfig(config, { TYPESAFE_API_KEY: 'fake-test-key' }), SupportSetupError);
});

test('missing Jev configuration stops before tools or agents run', async () => {
  let calls = 0;
  await assert.rejects(runLiveSupport(scenarios.payment.input, {
    runNode: async () => { calls++; }, runEffect: async () => { calls++; },
  }, { env: {} }), /TYPESAFE_API_KEY/);
  assert.equal(calls, 0);
});

for (const name of Object.keys(scenarios)) {
  test(`${name}: real Jev adapter with explicit test client preserves the DSL and observed call ordering`, async () => {
    const scripted = createScriptedAdapters(name);
    const transportCalls = [];
    // Test-only fake transport, passed to the low-level test API. Live CLI accepts no such option.
    const runJudge = createJevRunner({ maxAttempts: 1, client: {
      async systemOne(request, options) {
        assert.ok(options.signal instanceof AbortSignal);
        transportCalls.push(request);
        const label = transportCalls.length === 1 ? 'check-existing-answer' : 'recheck-agent-answer';
        const response = await scripted.deps.runJudge({ ...request, kind: 'judge', label });
        return { ...response, model: 'jev-test-fixture', usage: { input_tokens: 21, output_tokens: 4 } };
      },
    } });
    const { report, result } = await runSupportWithAdapters(scenarios[name].input, {
      ...scripted.deps, runJudge,
    }, { mode: 'test-only fake transport' });
    const investigated = ['payment', 'unresolved'].includes(name);
    assert.equal(report.workflow_sha256, workflowSha256(workflow));
    assert.deepEqual(report.calls.map(call => call.kind), investigated ? ['tool', 'judge', 'agent', 'judge'] : ['tool', 'judge']);
    assert.equal(report.judgeCalls, investigated ? 2 : 1);
    assert.equal(report.agentCalls, investigated ? 1 : 0);
    assert.equal(report.status, name === 'unresolved' ? 'escalated' : 'complete');
    assert.equal(report.status, result.status);
    for (const judge of report.calls.filter(call => call.kind === 'judge')) {
      assert.equal(judge.status, 'returned');
      assert.equal(judge.model, 'jev-test-fixture');
      assert.deepEqual(judge.usage, { input_tokens: 21, output_tokens: 4 });
      assert.match(judge.request_sha256, /^[a-f0-9]{64}$/);
      assert.ok(['yes', 'no', 'uncertain'].includes(judge.answer.choice));
    }
    const serialized = JSON.stringify(report);
    assert.ok(!serialized.includes(scenarios[name].input.request), 'Do not log request text.');
    assert.ok(!serialized.includes(scenarios[name].found.text), 'Do not log answer text.');
    assert.ok(!serialized.includes(scenarios[name].found.sources[0]), 'Do not log source references.');
  });
}

test('adapter errors retain failed-call evidence without raw error/customer data', async () => {
  const scripted = createScriptedAdapters('payment');
  const failure = new Error('SECRET-CUSTOMER-AND-KEY');
  await assert.rejects(runSupportWithAdapters(scenarios.payment.input, {
    ...scripted.deps,
    runNode: async () => { throw failure; },
  }), error => {
    assert.ok(error instanceof SupportRunError);
    assert.equal(error.report.status, 'failed');
    assert.deepEqual(error.report.calls.map(call => call.kind), ['tool', 'judge', 'agent']);
    assert.equal(error.report.calls.at(-1).status, 'failed');
    assert.equal(error.cause, failure, 'The host retains the original adapter failure.');
    assert.equal(Object.getOwnPropertyDescriptor(error, 'cause').enumerable, false);
    assert.ok(!JSON.stringify(error).includes('SECRET-CUSTOMER-AND-KEY'));
    assert.ok(!JSON.stringify(error.report).includes('SECRET-CUSTOMER-AND-KEY'));
    return true;
  });
});

for (const outcome of ['fulfilled', 'rejected']) {
  test(`cancelled tool retains its real late ${outcome} settlement without leaking it`, { timeout: 2000 }, async () => {
    const controller = new AbortController();
    const started = Promise.withResolvers();
    const pending = Promise.withResolvers();
    let toolCalls = 0;
    const running = runSupportWithAdapters(scenarios.password.input, {
      ...createScriptedAdapters('password').deps,
      runEffect: async params => {
        toolCalls++;
        assert.ok(params.signal instanceof AbortSignal);
        started.resolve();
        return pending.promise;
      },
    }, { signal: controller.signal });
    await started.promise;
    controller.abort();
    let failure;
    await assert.rejects(running, error => {
      failure = error;
      assert.ok(error instanceof SupportRunError);
      assert.ok(error.cause instanceof EffectOutcomeUnknownError);
      assert.equal(error.report.error.code, 'effect_outcome_unknown');
      assert.equal(error.report.calls[0].status, 'started', 'The underlying tool is still pending.');
      assert.equal(error.report.judgeCalls, 0);
      return true;
    });
    const receipt = { text: 'PRIVATE-LATE-RECEIPT', sources: ['PRIVATE-SOURCE'] };
    const rejection = new Error('PRIVATE-LATE-REJECTION');
    if (outcome === 'fulfilled') pending.resolve(receipt);
    else pending.reject(rejection);
    const settled = await failure.cause.settlement;
    assert.equal(settled.status, outcome);
    if (outcome === 'fulfilled') assert.equal(settled.value, receipt);
    else assert.equal(settled.reason, rejection);
    assert.equal(toolCalls, 1, 'An uncertain effect is never automatically retried.');
    assert.equal(failure.report.judgeCalls, 0, 'Late settlement does not resume the workflow.');
    assert.ok(failure.report.events.some(event => event.type === 'effect.late_settled'));
    assert.doesNotMatch(JSON.stringify(failure), /PRIVATE-LATE|PRIVATE-SOURCE/);
  });
}

test('agent params retain host contracts and cancellation bounds an uncooperative adapter', async () => {
  const scripted = createScriptedAdapters('payment');
  const controller = new AbortController();
  const running = runSupportWithAdapters(scenarios.payment.input, {
    ...scripted.deps,
    runNode: async params => {
      assert.equal(params.kind, 'agent');
      assert.ok(Array.isArray(params.system));
      assert.ok(params.user.includes('existingAnswer'));
      assert.deepEqual(params.schema.required, ['text', 'sources']);
      assert.deepEqual(params.tools, ['support.read']);
      assert.ok(params.signal instanceof AbortSignal);
      setTimeout(() => controller.abort(), 10);
      return new Promise(() => {});
    },
  }, { signal: controller.signal });
  await assert.rejects(running, error => {
    assert.equal(error.report.error.code, 'cancelled_or_timeout');
    assert.equal(error.report.calls.at(-1).status, 'failed');
    assert.equal(error.report.judgeCalls, 1, 'No recheck begins after cancellation.');
    return true;
  });
});

test('CLI loads config and custom JSON, but refuses missing Jev access without invoking host', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'support-config-test-'));
  try {
    const config = join(temporary, 'config.mjs'), input = join(temporary, 'input.json');
    await writeFile(config, `export default {runNode: async()=>{throw new Error('HOST-MUST-NOT-RUN')}, runEffect: async()=>{throw new Error('HOST-MUST-NOT-RUN')}};`);
    await writeFile(input, JSON.stringify({ request: 'Private input not for logs.' }));
    const run = invoke(['--config', config, '--input', input]);
    assert.equal(run.status, 1);
    assert.match(run.stderr, /https:\/\/console.typesafe.ai\/keys/);
    assert.ok(!run.stderr.includes('HOST-MUST-NOT-RUN'));
    assert.ok(!run.stderr.includes('Private input'));
    assert.equal(run.stdout, '');
    await writeFile(config, `throw new Error('SECRET-IN-CONFIG-IMPORT');`);
    const broken = invoke(['--config', config]);
    assert.equal(broken.status, 1);
    assert.match(broken.stderr, /Could not load the trusted host config/);
    assert.ok(!broken.stderr.includes('SECRET-IN-CONFIG-IMPORT'));
  } finally { await rm(temporary, { recursive: true, force: true }); }
});

test('scripted CLI still runs all scenarios without a key and marks the stop path', () => {
  const all = invoke([]);
  assert.equal(all.status, 0);
  for (const name of Object.keys(scenarios)) assert.ok(all.stdout.includes(`"scenario": "${name}"`));
  assert.equal(all.stderr, '');
  assert.equal(invoke(['unresolved']).status, 2);
  const password = invoke(['password']);
  assert.equal(password.status, 0);
  assert.match(password.stdout, /"agentCalls": 0/);
  assert.match(password.stdout, /"judgeCalls": 1/);
});
