import assert from 'node:assert/strict';
import { test } from 'node:test';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { serve, follow } from './support.mjs';
import { nativeFixture } from './native-fixtures/setup.mjs';
import { openSqliteStore } from '../dist/store/index.js';
import { createDispatchLoop } from '../dist/runner/dispatch.js';
import { createNativeLoop, nativeSourceInstructions } from '../dist/runner/native-loop.js';
import { startRunner } from '../dist/runner/runner.js';

for (const runtime of ['claude-code', 'codex']) for (const instructions of ['', 'Saved policy: use the approved release channel and require owner review.']) {
  test(`${runtime} dispatches its pinned ${instructions ? 'saved' : 'empty'} instructions and grades that same policy`, { timeout: 30_000 }, async t => {
    let runner, runnerStore;
    t.after(async () => { await runner?.close(); await runnerStore?.close(); });
    const f = await nativeFixture(t);
    const sourcePath = join(f.project, runtime === 'codex' ? 'AGENTS.md' : 'CLAUDE.md');
    const sourcePolicy = 'Source policy: never publish without owner approval.';
    await f.put(sourcePath, sourcePolicy);
    const inputLog = join(f.root, 'inputs.jsonl');
    const env = { ...f.env, NATIVE_TEST_INPUT_LOG: inputLog };
    const names = ['PATH', 'HOME', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'NATIVE_TEST_LOG', 'NATIVE_TEST_INPUT_LOG'];
    const before = Object.fromEntries(names.map(name => [name, process.env[name]]));
    for (const name of names) process.env[name] = env[name];
    t.after(() => { for (const name of names) { if (before[name] === undefined) delete process.env[name]; else process.env[name] = before[name]; } });
    const { api, data } = await serve(t, { runner: false });
    const connected = await api('POST', '/native/connect', { project: f.project, runtime });
    assert.equal(connected.status, 200, JSON.stringify(connected.body));
    const id = connected.body.agent.agent_id;
    assert.equal((await api('PUT', `/agents/${id}/definition`, { definition: { instructions, learning: false } })).status, 200);
    const queued = await api('POST', `/agents/${id}/runs`, { input: { content: 'Answer this release request.' } });
    assert.equal(queued.status, 202, JSON.stringify(queued.body));
    assert.equal((await api('PUT', `/agents/${id}/definition`, { definition: { instructions: 'LATER_REVISION_MUST_NOT_REPLACE_PINNED_POLICY', learning: false } })).status, 200);
    runnerStore = await openSqliteStore({ dataDir: data, role: 'runner' });
    const dispatch = createDispatchLoop({
      launchOf: runId => runnerStore.runs.launch(runId),
      resolve: (_harness, launch) => createNativeLoop(launch, { store: runnerStore, data, sealKey: Buffer.alloc(32) }),
    });
    runner = startRunner({ store: runnerStore, createLoop: dispatch, name: 'saved-native-policy', leaseMs: 60_000, renewEveryMs: 1000, stopMarginMs: 5000, pollMs: 20, commandPollMs: 30 });
    await follow(api, queued.body.run_id, ['completed']);
    const calls = (await f.calls()).filter(call => call.args.includes(runtime === 'codex' ? 'exec' : '--print'));
    assert.equal(calls.length, 1, 'the queued task is dispatched exactly once');
    const inputs = (await readFile(inputLog, 'utf8')).trim().split('\n').map(JSON.parse);
    const taskContext = runtime === 'codex' ? inputs[0].prompt : calls[0].args[calls[0].args.indexOf('--append-system-prompt') + 1] ?? '';
    if (instructions) assert.ok(taskContext.includes(instructions), 'the saved instruction reaches the actual native process boundary');
    else assert.equal(calls[0].args.includes('--append-system-prompt') || inputs[0].prompt.includes('<agentrun_context>'), false, 'empty saved instructions add no override');
    assert.doesNotMatch(taskContext, /LATER_REVISION_MUST_NOT_REPLACE_PINNED_POLICY/);
    assert.equal(await readFile(sourcePath, 'utf8'), sourcePolicy, 'native source policy is not modified');
    const grading = await nativeSourceInstructions(runnerStore, queued.body.run_id);
    assert.ok(grading.includes(sourcePolicy));
    if (instructions) assert.ok(grading.includes(instructions), 'grading receives the same pinned saved policy as the task');
    assert.doesNotMatch(grading, /LATER_REVISION_MUST_NOT_REPLACE_PINNED_POLICY/);
  });
}
