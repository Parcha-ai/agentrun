import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import { mkdtemp, mkdir, readFile, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { runCliLearningHook, flushCliLearning } from '../dist/cli-learning/hook.js';
import { saveConnection, stateHash, journalRoot } from '../dist/cli-learning/state.js';

async function fixture(t) {
  const project = await mkdtemp(join(tmpdir(), 'agentrun-hook-lock-'));
  t.after(() => rm(project, { recursive: true, force: true }));
  const options = { runtime: 'codex', project, dataDir: join(project, 'private-data') };
  const connection = { version: 1, ...options, url: 'http://127.0.0.1:7340',
    connection_id: 'connection-1', agent_id: 'agent-1', token: 'fixture-connection-token' };
  await saveConnection(options.dataDir, connection);
  const root = journalRoot(options.dataDir, connection);
  const directory = join(root, stateHash('session-1'));
  await mkdir(directory, { recursive: true });
  const lock = join(directory, '.lock');
  const calls = [];
  const snapshot = async () => ({ text: 'Keep source permissions.', files: [], truncated: false });
  const dependencies = { env: {}, snapshot, fetch: async (url, request) => {
    const path = new URL(url).pathname, body = JSON.parse(request.body);
    calls.push({ path, body });
    return Response.json(path.endsWith('/runs') ? { run_id: body.turn_id, agent_id: 'agent-1',
      token: 'fixture-run-token', learning: { enabled: false, revision: null, context: '', workflows: [] } } : { accepted: true });
  } };
  const prompt = turn => runCliLearningHook(options, { hook_event_name: 'UserPromptSubmit',
    session_id: 'session-1', turn_id: turn, cwd: project, prompt: `Handle ${turn}.` }, dependencies);
  const pending = async () => (await readdir(join(root, 'pending')).catch(() => [])).filter(name => name.endsWith('.json'));
  return { options, directory, lock, calls, dependencies, snapshot, prompt, pending };
}

test('concurrent hooks recovering one dead owner never enter the same session together and preserve the waiting prompt', { timeout: 10_000 }, async t => {
  const f = await fixture(t);
  // The owner really exits with its complete lock record in place, including the
  // host, process namespace and process identity used by the shared lock helper.
  const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', `
    import { takeHold } from ${JSON.stringify(new URL('../dist/harness-install.js', import.meta.url).href)};
    const token = await takeHold(${JSON.stringify(f.directory)}, { holdPath: ${JSON.stringify(f.lock)}, timeoutMs: Infinity });
    if (!token) throw new Error('fixture owner did not acquire its lock');
    console.log('held');
  `]);
  assert.equal(stdout.trim(), 'held');

  const originalReadFile = fs.promises.readFile;
  let reads = 0, active = 0, maxActive = 0;
  let releaseFirstRead, firstEntered, releaseTask;
  const bothRead = new Promise(resolve => { releaseFirstRead = resolve; });
  const acquired = new Promise(resolve => { firstEntered = resolve; });
  const taskMayFinish = new Promise(resolve => { releaseTask = resolve; });
  // Both contenders read the same old owner. Delay the second return until the
  // first hook holds the replacement lock and is inside source policy capture.
  fs.promises.readFile = async (path, ...args) => {
    const value = await originalReadFile(path, ...args);
    if (path === f.lock && reads < 2) {
      const order = ++reads;
      if (order === 1) await bothRead;
      else { releaseFirstRead(); await acquired; }
    }
    return value;
  };
  syncBuiltinESMExports();
  const restore = () => { fs.promises.readFile = originalReadFile; syncBuiltinESMExports(); };
  t.after(() => { releaseFirstRead(); firstEntered(); releaseTask(); restore(); });
  f.dependencies.snapshot = async () => {
    active++;
    maxActive = Math.max(maxActive, active);
    firstEntered();
    if (active === 1) await taskMayFinish;
    active--;
    return f.snapshot();
  };
  const first = f.prompt('turn-a'), second = f.prompt('turn-b');
  try {
    // One hook must defer while the other owns the journal. If both enter,
    // the second finishes first and also releases the test barrier.
    await Promise.race([first, second]);
    releaseTask();
    await Promise.all([first, second]);
  } finally { releaseTask(); restore(); }
  assert.equal(reads, 2, 'both contenders saw the same dead owner');
  assert.equal(maxActive, 1, 'one session cannot capture two prompt windows concurrently');
  assert.equal((await f.pending()).length, 1, 'the contending prompt remains durable');
  await flushCliLearning(f.options, { fetch: f.dependencies.fetch });
  assert.deepEqual(f.calls.filter(call => call.path.endsWith('/runs')).map(call => call.body.turn_id).sort(), ['turn-a', 'turn-b']);
  assert.equal((await f.pending()).length, 0, 'retry acknowledges the waiting prompt after ownership clears');
});

for (const [name, record] of [['empty', ''], ['PID-only', JSON.stringify({ pid: 2147483647 })]]) {
  test(`an aged ${name} legacy hook lock preserves capture until its owner is explicitly resolved`, async t => {
    const f = await fixture(t);
    await writeFile(f.lock, record, { mode: 0o600 });
    const old = new Date(Date.now() - 60_000);
    await utimes(f.lock, old, old);
    await f.prompt('turn-a');
    const retry = await flushCliLearning(f.options, { fetch: f.dependencies.fetch });
    assert.equal(f.calls.length, 0, 'neither age nor an unscoped PID proves the prior owner is gone');
    assert.equal(await readFile(f.lock, 'utf8'), record);
    assert.equal(retry.pending, 1, 'the blocked prompt is visible as pending');
    await rm(f.lock); // The fixture owner explicitly resolves its legacy lock.
    await flushCliLearning(f.options, { fetch: f.dependencies.fetch });
    assert.equal(f.calls.filter(call => call.path.endsWith('/runs')).length, 1);
    assert.equal((await f.pending()).length, 0);
  });
}
