import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { runCliLearningHook } from '../dist/cli-learning/hook.js';
import { saveConnection } from '../dist/cli-learning/state.js';

test('shared Codex hooks capture a nested worktree only in its own enrollment, while keeping ordinary subdirectories', async t => {
  const root = await mkdtemp(join(tmpdir(), 'agentrun-hook-worktree-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const main = join(root, 'main'), nested = join(main, 'worktrees', 'nested');
  const git = (...args) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'user.name=Fixture',
    '-c', 'user.email=fixture@example.invalid', ...args], { stdio: 'pipe' });
  git('init', main);
  git('-C', main, 'commit', '--allow-empty', '-m', 'fixture');
  git('-C', main, 'worktree', 'add', '--detach', nested);
  const dataDir = join(root, 'private-data'), transcript = join(root, 'native.jsonl');
  await writeFile(transcript, JSON.stringify({ type: 'session_meta', payload: { id: 'native-session',
    base_instructions: { text: 'Keep project boundaries.' } } }) + '\n');
  const options = project => ({ project, dataDir, runtime: 'codex' });
  for (const [project, id] of [[main, 'main'], [nested, 'nested']]) {
    await saveConnection(dataDir, { version: 1, project, runtime: 'codex', url: 'http://127.0.0.1:7340',
      connection_id: id, agent_id: id, token: 'private-connection-token' });
  }
  const calls = [];
  const dependencies = { env: {}, snapshot: async () => ({ text: 'Keep project boundaries.', files: [], truncated: false }),
    fetch: async (url) => {
      const path = new URL(url).pathname;
      calls.push(path);
      return Response.json({ run_id: 'native-run', agent_id: path.split('/').at(-2), token: 'private-run-token',
        learning: { enabled: true, revision: 'accepted-revision', context: 'Accepted project guidance.', workflows: [] } });
    } };
  const input = cwd => ({ hook_event_name: 'UserPromptSubmit', session_id: 'native-session', turn_id: 'turn-1',
    cwd, transcript_path: transcript, prompt: 'Inspect the project without editing it.' });

  assert.equal(await runCliLearningHook(options(main), input(nested), dependencies), undefined);
  assert.deepEqual(calls, [], 'the main checkout must not capture or seed a nested worktree prompt');
  assert.match((await runCliLearningHook(options(nested), input(nested), dependencies)).hookSpecificOutput.additionalContext, /Accepted project guidance/);
  assert.deepEqual(calls, ['/v2/cli-learning/connections/nested/runs']);

  const subdirectory = join(main, 'src');
  await mkdir(subdirectory);
  assert.match((await runCliLearningHook(options(main), input(subdirectory), dependencies)).hookSpecificOutput.additionalContext, /Accepted project guidance/);
  assert.deepEqual(calls, ['/v2/cli-learning/connections/nested/runs', '/v2/cli-learning/connections/main/runs']);
});
