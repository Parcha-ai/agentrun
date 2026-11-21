import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, appendFile, writeFile, readFile, readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runCliLearningHook, flushCliLearning } from '../dist/cli-learning/hook.js';
import { saveConnection, connectionFile } from '../dist/cli-learning/state.js';

const rows = values => values.map(value => JSON.stringify(value)).join('\n') + '\n';
const answerRow = answer => ({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: answer }] } });

async function setup(t, runtime = 'codex') {
  const project = await mkdtemp(join(tmpdir(), 'agentrun-hook-'));
  t.after(() => rm(project, { recursive: true, force: true }));
  const dataDir = join(project, 'private-data'), transcript = join(project, 'native.jsonl');
  await writeFile(transcript, rows([{ type: 'session_meta', payload: { id: 'session-1', base_instructions: { text: 'Keep source permissions.' } } }]));
  const options = { project, dataDir, runtime };
  await saveConnection(dataDir, { version: 1, project, runtime, url: 'http://127.0.0.1:7340', connection_id: 'connection-1', agent_id: 'agent-1', token: 'private-connection-token' });
  const calls = [], receipts = new Map(), starts = new Map();
  let failEvents = false, offline = false;
  const fetcher = async (url, request) => {
    const path = new URL(url).pathname, body = JSON.parse(request.body);
    calls.push({ path, body, key: request.headers['Idempotency-Key'] });
    if (offline) throw new Error('Offline, never echo credentials');
    if (path.endsWith('/runs')) {
      const key = request.headers['Idempotency-Key'];
      if (starts.has(key)) assert.deepEqual(body, starts.get(key));
      else starts.set(key, body);
      if (!receipts.has(key)) receipts.set(key, { run_id: `run-${receipts.size + 1}`, agent_id: 'agent-1', token: 'private-run-token', learning: { enabled: true, revision: 'rev-1', context: 'Use the project test command.', workflows: [] } });
      return Response.json(receipts.get(key));
    }
    if (path.endsWith('/events') && failEvents) { failEvents = false; throw new Error('Server committed this batch but response was lost'); }
    return Response.json({ ok: true });
  };
  const dependencies = { fetch: fetcher, env: {}, snapshot: async () => ({ text: 'Keep source permissions.', files: [], truncated: false }) };
  const input = (event, turn, extra = {}) => ({ hook_event_name: event, session_id: 'session-1', [runtime === 'codex' ? 'turn_id' : 'prompt_id']: turn, cwd: project, transcript_path: transcript, model: 'native-model', ...extra });
  const prompt = (turn, text) => runCliLearningHook(options, input('UserPromptSubmit', turn, { prompt: text }), dependencies);
  const stop = (turn, text) => runCliLearningHook(options, input('Stop', turn, { last_assistant_message: text }), dependencies);
  const append = values => appendFile(transcript, rows(values));
  return { options, dependencies, input, prompt, stop, append, calls, transcript, failEvents: () => { failEvents = true; }, offline: value => { offline = value; } };
}

test('two native prompts preserve user dialogue and prove seed delivery only from native context', async t => {
  const f = await setup(t);
  const output = await f.prompt('turn-1', 'Use npm to test.');
  const context = output.hookSpecificOutput.additionalContext;
  await f.append([
    { type: 'response_item', payload: { type: 'message', role: 'developer', content: [{ type: 'input_text', text: context }] } },
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'SYNTHETIC DO NOT LEARN' }] } },
    answerRow('Tests passed with npm.'),
  ]);
  await f.stop('turn-1', 'Tests passed with npm.');
  await f.prompt('turn-2', 'Correction: this repository uses pnpm, always use pnpm here.');
  await f.append([answerRow('I will use pnpm for this repository.')]);
  await f.stop('turn-2', 'I will use pnpm for this repository.');
  const complete = f.calls.filter(call => call.path.endsWith('/complete'));
  assert.equal(complete.length, 2);
  assert.equal(complete[0].body.seed_observed, true);
  assert.equal(complete[1].body.seed_observed, false);
  assert.equal(complete[0].body.evidence_complete, true);
  const events = f.calls.filter(call => call.path === '/v2/cli-learning/runs/run-2/events').flatMap(call => call.body.events);
  assert.deepEqual(events.filter(event => event.type === 'message' && event.role === 'user').map(event => event.text), ['Use npm to test.', 'Correction: this repository uses pnpm, always use pnpm here.']);
  assert.doesNotMatch(JSON.stringify(f.calls), /SYNTHETIC DO NOT LEARN/);
  assert.equal((await stat(connectionFile(f.options.dataDir, 'codex', f.options.project))).mode & 0o777, 0o600);
});

test('native prompt usage reaches completion and retries without recounting the session', async t => {
  const f = await setup(t);
  await f.prompt('turn-1', 'Count this prompt.');
  await f.append([
    { type: 'token_usage_record', payload: { thread_id: 'session-1', turn_id: 'turn-1', response_id: 'response-1', usage: { input_tokens: 100, cached_input_tokens: 60, cache_write_input_tokens: 0, output_tokens: 12 } } },
    answerRow('Done.'),
  ]);
  f.failEvents();
  await f.stop('turn-1', 'Done.');
  await f.append([{ type: 'token_usage_record', payload: { thread_id: 'session-1', turn_id: 'turn-2', response_id: 'response-2', usage: { input_tokens: 900, output_tokens: 900 } } }]);
  await flushCliLearning(f.options, { fetch: f.dependencies.fetch });
  const complete = f.calls.filter(call => call.path.endsWith('/complete'));
  assert.equal(complete.length, 1);
  assert.deepEqual(complete[0].body.usage, { input_tokens: 40, output_tokens: 12, cache_read_tokens: 60, cache_write_tokens: 0, cost_usd: null });
});

test('a lost events response retries the exact batch and retains dialogue before the network returns', async t => {
  const f = await setup(t);
  await f.prompt('turn-1', 'Always preserve the source approval policy.');
  await f.append([answerRow('I preserved it.')]);
  f.failEvents();
  await f.stop('turn-1', 'I preserved it.');
  await f.prompt('turn-2', 'Use that same rule again.');
  await f.append([answerRow('Still preserved.')]);
  await f.stop('turn-2', 'Still preserved.');
  const secondEvents = f.calls.filter(call => call.path === '/v2/cli-learning/runs/run-2/events').flatMap(call => call.body.events);
  assert.ok(secondEvents.some(event => event.role === 'user' && event.text === 'Always preserve the source approval policy.'));
  const result = await flushCliLearning(f.options, { fetch: f.dependencies.fetch });
  assert.equal(result.pending, 0);
  const retried = f.calls.filter(call => call.path === '/v2/cli-learning/runs/run-1/events');
  assert.equal(retried.length, 2);
  assert.deepEqual(retried[0], retried[1]);
  const before = f.calls.length;
  await flushCliLearning(f.options, { fetch: f.dependencies.fetch });
  assert.equal(f.calls.length, before);
});

test('offline start and completion survive without a model rerun and reconnect with the same source receipt', async t => {
  const f = await setup(t);
  f.offline(true);
  assert.equal(await f.prompt('turn-1', 'A task that continues while AgentRun is offline.'), undefined);
  await f.append([answerRow('The native task finished offline.')]);
  await f.stop('turn-1', 'The native task finished offline.');
  f.offline(false);
  const result = await flushCliLearning(f.options, { fetch: f.dependencies.fetch });
  assert.equal(result.delivered, 1);
  assert.equal(result.pending, 0);
  const attempts = f.calls.filter(call => call.path.endsWith('/runs'));
  assert.ok(attempts.length >= 2);
  assert.ok(attempts.every(call => call.key === attempts[0].key));
  assert.ok(attempts.every(call => JSON.stringify(call.body) === JSON.stringify(attempts[0].body)));
  assert.equal(f.calls.filter(call => call.path.endsWith('/complete')).at(-1).body.answer, 'The native task finished offline.');
});

test('known incomplete policy and secrets stay explicit, with no secret in durable prompt receipts', async t => {
  const f = await setup(t);
  const secret = 'sk-proj-' + 'X'.repeat(40);
  f.dependencies.env = { OPENAI_API_KEY: secret };
  f.dependencies.snapshot = async () => ({ text: `Policy ${secret}`, files: [], truncated: false, incomplete: 'Native policy source missing.' });
  await f.prompt('turn-1', `Never print ${secret}.`);
  await f.append([answerRow(`I did not print ${secret}.`)]);
  await f.stop('turn-1', `I did not print ${secret}.`);
  assert.equal(f.calls.find(call => call.path.endsWith('/runs')).body.policy_complete, false);
  assert.doesNotMatch(JSON.stringify(f.calls), new RegExp(secret));
  const sessionRoot = join(f.options.dataDir, 'cli-learning', 'sessions');
  for (const project of await readdir(sessionRoot)) for (const session of await readdir(join(sessionRoot, project), { withFileTypes: true })) {
    if (!session.isDirectory() || session.name === 'pending') continue;
    for (const filename of await readdir(join(sessionRoot, project, session.name))) {
      if (filename.endsWith('.json')) assert.doesNotMatch(await readFile(join(sessionRoot, project, session.name, filename), 'utf8'), new RegExp(secret));
    }
  }
});

test('reflection child sessions and unregistered projects are not recursively enrolled', async t => {
  const f = await setup(t);
  await runCliLearningHook(f.options, f.input('UserPromptSubmit', 'turn-1', { prompt: 'Reflection' }), { ...f.dependencies, env: { AGENTRUN_CLI_LEARNING_CHILD: '1' } });
  assert.equal(f.calls.length, 0);
  await runCliLearningHook({ ...f.options, dataDir: join(f.options.project, 'not-connected') }, f.input('UserPromptSubmit', 'turn-1', { prompt: 'Ordinary prompt' }), f.dependencies);
  assert.equal(f.calls.length, 0);
});

test('an interrupt is cancelled, and seed text echoed by a user is not delivery proof', async t => {
  const f = await setup(t);
  const output = await f.prompt('turn-1', 'Do some work.');
  await f.append([{ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: output.hookSpecificOutput.additionalContext }] } }]);
  await runCliLearningHook(f.options, f.input('Interrupt', 'turn-1'), f.dependencies);
  const completion = f.calls.find(call => call.path.endsWith('/complete')).body;
  assert.equal(completion.status, 'cancelled');
  assert.equal(completion.evidence_complete, false);
  assert.equal(completion.seed_observed, false);
});

test('Claude completion pins the actual system snapshot rendered after first UserPromptSubmit', async t => {
  const f = await setup(t, 'claude-code');
  const { readTranscriptPolicy } = await import('../dist/cli-learning/policy.js');
  f.dependencies.snapshot = async options => ({ ...(await readTranscriptPolicy(options)), files: [], truncated: false });
  await f.prompt('prompt-1', 'Use the same source policy.');
  assert.equal(f.calls.find(call => call.path.endsWith('/runs')).body.policy_complete, false);
  await f.append([
    { type: 'user', sessionId: 'session-1', promptId: 'prompt-1', uuid: 'u1', parentUuid: null, message: { role: 'user', content: 'Use the same source policy.' } },
    { type: 'attachment', sessionId: 'session-1', uuid: 's1', parentUuid: 'u1', attachment: { type: 'prompt_snapshot', systemPrompt: ['Exact native Claude policy'] } },
    { type: 'assistant', sessionId: 'session-1', uuid: 'a1', parentUuid: 's1', message: { role: 'assistant', content: 'Done.' } },
  ]);
  await f.stop('prompt-1', 'Done.');
  const completion = f.calls.find(call => call.path.endsWith('/complete')).body;
  assert.equal(completion.source_policy.complete, true);
  assert.match(completion.source_policy.instructions, /Exact native Claude policy/);
  assert.equal(completion.evidence_complete, true);
});

test('a later Claude prompt snapshot cannot upgrade an earlier source window', async t => {
  const f = await setup(t, 'claude-code');
  const { readTranscriptPolicy } = await import('../dist/cli-learning/policy.js');
  f.dependencies.snapshot = async options => ({ ...(await readTranscriptPolicy(options)), files: [], truncated: false });
  await f.prompt('prompt-1', 'Original task.');
  await f.append([
    { type: 'user', sessionId: 'session-1', promptId: 'prompt-2', uuid: 'u2', parentUuid: null, message: { role: 'user', content: 'Different task.' } },
    { type: 'attachment', sessionId: 'session-1', uuid: 's2', parentUuid: 'u2', attachment: { type: 'prompt_snapshot', systemPrompt: ['Another prompt policy'] } },
    { type: 'assistant', sessionId: 'session-1', uuid: 'a2', parentUuid: 's2', message: { role: 'assistant', content: 'Done.' } },
  ]);
  await f.stop('prompt-1', 'Done.');
  const completion = f.calls.find(call => call.path.endsWith('/complete')).body;
  assert.equal(completion.source_policy.complete, false);
  assert.equal(completion.evidence_complete, false);
});

test('redacted source prompts remain incomplete even when the final answer itself has no secrets', async t => {
  const f = await setup(t);
  const fakeProviderCredential = 'sk-proj-' + 'Y'.repeat(40);
  f.dependencies.env = { OPENAI_API_KEY: fakeProviderCredential };
  await f.prompt('turn-1', `Please use ${f.dependencies.env.OPENAI_API_KEY}.`);
  await f.append([answerRow('Done safely.')]);
  await f.stop('turn-1', 'Done safely.');
  const completion = f.calls.find(call => call.path.endsWith('/complete')).body;
  assert.equal(completion.evidence_complete, false);
  assert.match(completion.error, /redacted/);
  await f.prompt('turn-2', 'Use that same setting.');
  await f.append([answerRow('Done again.')]);
  await f.stop('turn-2', 'Done again.');
  assert.equal(f.calls.filter(call => call.path.endsWith('/complete')).at(-1).body.evidence_complete, false);
});


test('bounded source text survives offline retry and stays explicitly incomplete after redaction expansion', async t => {
  const cases = [
    { prompt: 'p'.repeat(130_000), answer: 'Ready.' },
    { prompt: 'Task.', answer: 'a'.repeat(130_000) },
    { prompt: 'Task.', answer: '😀'.repeat(32_769) },
    { prompt: 'Task.', answer: '\u0001'.repeat(40_000) },
    { prompt: 'password '.repeat(14_000), answer: 'password '.repeat(14_000), env: { OPENAI_API_KEY: 'password' } },
    // A cut through a held value must not expose its leading fragment.
    { prompt: 'p'.repeat(127_996) + 'abcdefghij', answer: 'Ready.', env: { OPENAI_API_KEY: 'abcdefghij' } },
  ];
  for (const source of cases) await t.test(`prompt ${source.prompt.length}, answer ${source.answer.length}, redacted ${Boolean(source.env)}`, async t => {
    const f = await setup(t);
    f.dependencies.env = source.env ?? {};
    f.offline(true);
    await f.prompt('turn-1', source.prompt);
    await f.append([
      { type: 'token_usage_record', payload: { thread_id: 'session-1', turn_id: 'turn-1', response_id: 'response-1', usage: { input_tokens: 100, cached_input_tokens: 60, cache_write_input_tokens: 0, output_tokens: 12 } } },
      answerRow(source.answer),
    ]);
    await f.stop('turn-1', source.answer);
    f.offline(false);
    const flushed = await flushCliLearning(f.options, { fetch: f.dependencies.fetch });
    assert.equal(flushed.delivered, 1);
    assert.equal(flushed.pending, 0);
    const started = f.calls.filter(call => call.path.endsWith('/runs')).at(-1).body;
    assert.ok(started.input.length <= 128_000);
    const completed = f.calls.find(call => call.path.endsWith('/complete')).body;
    assert.ok(completed.answer.length <= 128_000);
    if (!source.env) assert.deepEqual(completed.usage, { input_tokens: 40, output_tokens: 12, cache_read_tokens: 60, cache_write_tokens: 0, cost_usd: null }, 'a verified full-answer digest preserves exact usage despite local clipping');
    assert.equal(completed.evidence_complete, false);
    assert.match(completed.error, /limit|truncat|redact|withheld/i);
    for (const batch of f.calls.filter(call => call.path.endsWith('/events'))) {
      assert.ok(Buffer.byteLength(JSON.stringify(batch.body)) <= 256_000);
      assert.ok(batch.body.events.every(event => event.type !== 'message' || event.text.length <= 128_000));
    }
    if (source.env?.OPENAI_API_KEY === 'abcdefghij') assert.ok(!started.input.includes('abcd'), 'redact the entire secret before cutting text');
  });
});
