import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile, appendFile, readFile, readdir, rm, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { runCliLearningHook, flushCliLearning } from '../dist/cli-learning/hook.js';
import { saveConnection, stateHash, journalRoot } from '../dist/cli-learning/state.js';
import { learningMain } from '../dist/cli-learning/cli.js';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'agentrun-journal-scope-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const project = join(root, 'project'), dataDir = join(root, 'private');
  await mkdir(project);
  const options = { runtime: 'codex', project, dataDir };
  const connection = { version: 1, runtime: 'codex', project, url: 'http://127.0.0.1:7340', connection_id: 'fixture-connection', agent_id: 'fixture-agent', token: 'fixture-first-credential' };
  await saveConnection(dataDir, connection);
  const transcript = join(project, 'transcript.jsonl');
  await writeFile(transcript, JSON.stringify({ type: 'session_meta', payload: { id: 'source-session' } }) + '\n');
  const input = (event, turn, more = {}) => ({ hook_event_name: event, session_id: 'source-session', turn_id: turn, cwd: project, transcript_path: transcript, ...more });
  const calls = [];
  const fetch = async (url, request) => {
    const path = new URL(url).pathname;
    calls.push({ origin: new URL(url).origin, path, body: JSON.parse(request.body) });
    return Response.json(path.endsWith('/runs') ? { run_id: 'run-' + calls.length, agent_id: 'fixture-agent', token: 'fixture-run-credential', learning: { enabled: false, revision: null, context: '', workflows: [] } } : { accepted: true });
  };
  const dependencies = { env: {}, snapshot: async () => ({ text: 'Fixture standing policy.', files: [], truncated: false }), fetch };
  const capture = async (turn, prompt, deps = dependencies) => {
    await runCliLearningHook(options, input('UserPromptSubmit', turn, { prompt }), deps);
    await appendFile(transcript, JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Fixture answer.' }] } }) + '\n');
    await runCliLearningHook(options, input('Stop', turn, { last_assistant_message: 'Fixture answer.' }), deps);
  };
  return { options, connection, calls, fetch, dependencies, capture };
}

async function journalFiles(dataDir) {
  const root = join(dataDir, 'cli-learning', 'sessions'), files = new Map();
  const walk = async (directory) => {
    for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile()) files.set(relative(root, path), await readFile(path, 'utf8'));
    }
  };
  await walk(root); return files;
}

for (const [label, change] of [
  ['server destination', { url: 'http://127.0.0.1:8340' }],
  ['revoked credential generation', { token: 'fixture-second-credential' }],
  ['connection identity', { connection_id: 'fixture-other-connection' }],
]) {
  test(`offline captures never follow a changed ${label}; fresh captures have no prior dialogue`, async t => {
    const f = await fixture(t);
    await f.capture('old-turn', 'Old destination private task.', { ...f.dependencies, fetch: async () => { throw new Error('offline'); } });
    const before = await journalFiles(f.options.dataDir);
    await saveConnection(f.options.dataDir, { ...f.connection, ...change });
    const result = await flushCliLearning(f.options, { fetch: f.fetch });
    assert.equal(f.calls.length, 0, 'no prior input, evidence or run credential reaches the new enrollment');
    assert.equal(result.blocked_journals, 1, 'unretryable captured evidence is explicit');
    assert.deepEqual(await journalFiles(f.options.dataDir), before, 'old evidence is preserved byte for byte');
    await f.capture('new-turn', 'New destination task.');
    assert.ok(f.calls.some(call => call.path.endsWith('/complete')), 'fresh normal prompts still capture');
    assert.ok(!JSON.stringify(f.calls).includes('Old destination private task.'), 'session history is also scoped');
  });
}

test('unbound legacy journals remain private and retry reports recovery needed without content', async t => {
  const f = await fixture(t);
  const root = join(f.options.dataDir, 'cli-learning', 'sessions', stateHash(`codex\0${f.options.project}`));
  const session = join(root, stateHash('source-session'));
  await mkdir(session, { recursive: true });
  const key = stateHash('legacy-turn');
  await writeFile(join(session, 'session.json'), JSON.stringify({ active: [key], history: [], completed: [] }));
  await writeFile(join(session, `${key}.json`), JSON.stringify({ version: 1, key, connectionId: f.connection.connection_id, start: { input: 'Legacy private task.' }, completion: { answer: 'Legacy answer.' }, events: [] }));
  const before = await journalFiles(f.options.dataDir), stdout = [], stderr = [];
  const code = await learningMain(['retry', '--project', f.options.project, '--runtime', 'codex', '--data', f.options.dataDir], {
    fetch: f.fetch, stdout: text => stdout.push(text), stderr: text => stderr.push(text),
  });
  assert.equal(code, 1);
  assert.equal(JSON.parse(stdout.at(-1)).blocked_journals, 1);
  assert.match(stderr.join('\n'), /journal.*preserved.*review/i);
  assert.ok(!JSON.stringify([...stdout, ...stderr]).includes('Legacy private task.'));
  assert.ok(!JSON.stringify([...stdout, ...stderr]).includes(f.connection.token));
  assert.equal(f.calls.length, 0);
  assert.deepEqual(await journalFiles(f.options.dataDir), before);
});


test('a reconnect during queued-hook replay cannot redirect the next pending prompt', async t => {
  const f = await fixture(t);
  const root = journalRoot(f.options.dataDir, f.connection), session = join(root, stateHash('source-session'));
  await mkdir(session, { recursive: true });
  await writeFile(join(session, '.lock'), JSON.stringify({ pid: process.pid }));
  for (const turn of ['first', 'second']) await runCliLearningHook(f.options, {
    hook_event_name: 'UserPromptSubmit', session_id: 'source-session', turn_id: turn,
    cwd: f.options.project, prompt: `Prior enrollment ${turn} task.`,
  }, f.dependencies);
  await unlink(join(session, '.lock'));
  let changed = false;
  await assert.rejects(flushCliLearning(f.options, { fetch: async (url, request) => {
    const response = await f.fetch(url, request);
    if (!changed) { changed = true; await saveConnection(f.options.dataDir, { ...f.connection, url: 'http://127.0.0.1:8340', token: 'fixture-new-generation' }); }
    return response;
  } }), /enrollment changed/);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].origin, f.connection.url);
  assert.equal((await readdir(join(root, 'pending'))).length, 1, 'the unprocessed source prompt remains in its original private journal');
});

test('a still-loaded hook for the prior destination cannot queue a prompt for later retry to the new destination', async t => {
  const f = await fixture(t);
  await saveConnection(f.options.dataDir, { ...f.connection, url: 'http://127.0.0.1:8340', token: 'fixture-new-generation' });
  const before = await journalFiles(f.options.dataDir);
  await runCliLearningHook({ ...f.options, url: f.connection.url }, {
    hook_event_name: 'UserPromptSubmit', session_id: 'source-session', turn_id: 'old-loaded-hook',
    cwd: f.options.project, prompt: 'Task submitted under the old trusted hook declaration.',
  }, f.dependencies);
  assert.equal(f.calls.length, 0, 'a stale hook declaration cannot dispatch to the new enrollment');
  assert.deepEqual(await journalFiles(f.options.dataDir), before, 'a rejected destination must not queue task data under the new enrollment');
  const retried = await flushCliLearning(f.options, { fetch: f.fetch });
  assert.equal(f.calls.length, 0, 'retry cannot silently retarget a rejected hook');
  assert.equal(retried.pending, 0);
  await f.capture('new-loaded-hook', 'Task submitted after activating the new hook.');
  assert.ok(f.calls.some(call => call.path.endsWith('/complete')), 'fresh capture remains available');
  assert.ok(f.calls.every(call => call.origin === 'http://127.0.0.1:8340'));
});

for (const when of ['while the begin response is pending', 'after guidance was cached']) {
  test(`disconnect ${when} prevents returning pinned guidance from a loaded hook`, async t => {
    const f = await fixture(t);
    const input = { hook_event_name: 'UserPromptSubmit', session_id: 'source-session', turn_id: 'pinned-context',
      cwd: f.options.project, prompt: 'A normal source task.' };
    const disable = () => saveConnection(f.options.dataDir, { ...f.connection, revocation_pending: true });
    const dependencies = { ...f.dependencies, fetch: async (url, request) => {
      await f.fetch(url, request);
      if (when === 'while the begin response is pending') await disable();
      return Response.json({ run_id: 'fixture-pinned-run', agent_id: 'fixture-agent', token: 'fixture-run-credential',
        learning: { enabled: true, revision: 'fixture-revision', context: '# Learned\nUse the owner correction.', workflows: [] } });
    } };
    const first = await runCliLearningHook(f.options, input, dependencies);
    if (when === 'after guidance was cached') {
      assert.match(first.hookSpecificOutput.additionalContext, /Use the owner correction/);
      await disable();
      assert.equal(await runCliLearningHook(f.options, input, dependencies), undefined);
    } else {
      assert.equal(first, undefined, 'guidance must not return after local disconnect won during the response');
      const files = await journalFiles(f.options.dataDir);
      assert.ok([...files.values()].some(text => JSON.parse(text).receipt?.run_id === 'fixture-pinned-run'),
        'the admitted receipt remains durable for diagnosis without returning its guidance');
    }
    assert.equal(f.calls.length, 1, 'a locally disabled capture never retries the cached begin');
  });
}
