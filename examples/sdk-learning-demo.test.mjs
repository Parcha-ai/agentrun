import assert from 'node:assert/strict';
import { test } from 'node:test';
import { demonstrate, STATUS, TASK, TEACH } from './sdk-learning/demo.mjs';

function fixture(runtime, notes) {
  const reports = [], flushes = [], revision = 'accepted-revision';
  const facts = Object.values(STATUS).join(' ');
  const fetch = async (url, options = {}) => {
    const path = new URL(url).pathname;
    if (options.method === 'POST' && path.endsWith('/sdk-runs')) {
      const body = JSON.parse(options.body);
      return Response.json({ run_id: `run-${reports.length}`, agent_id: body.agentId,
        console_url: 'https://demo.invalid/runs', learning: { enabled: body.learning,
          revision, context: body.learning && reports.length > 1 ? 'Release brief:' : '' } });
    }
    assert.equal(options.method, 'GET');
    assert.equal(path, `/v2/agents/${runtime}-on/learning`);
    return Response.json({ main: revision, notes: { items: notes }, skills: [] });
  };
  const createBackend = options => ({
    async report(input) {
      reports.push({ agentId: options.agentId, input });
      await options.fetch('https://demo.invalid/v2/sdk-runs', { method: 'POST',
        body: JSON.stringify({ agentId: options.agentId, learning: options.learning }) });
      return { answer: (options.learning ? 'Release brief: ' : '') + facts, toolCalls: 1 };
    },
    async flushLearning() { flushes.push(options.agentId); },
  });
  return { options: { runtime, agentPrefix: runtime, baseUrl: 'https://demo.invalid/v2',
    apiKey: 'fake-test-key', createBackend, fetch }, reports, flushes, revision };
}

for (const runtime of ['claude', 'codex']) {
  for (const origin of ['you', 'run']) {
    test(`${runtime} demo reuses an accepted ${origin}-origin note and checks the Off control`, async () => {
      const f = fixture(runtime, [
        { file: 'release-preference.md', status: 'active', origin },
        { file: 'rejected.md', status: 'rejected', origin: 'you' },
      ]);
      const result = await demonstrate(f.options);
      assert.deepEqual(result.acceptedLessonFiles, ['release-preference.md']);
      assert.equal(result.acceptedRevision, f.revision);
      assert.deepEqual(f.reports, [
        { agentId: `${runtime}-on`, input: TEACH },
        { agentId: `${runtime}-on`, input: TASK },
        { agentId: `${runtime}-off`, input: TASK },
      ]);
      assert.deepEqual(f.flushes, [`${runtime}-on`, `${runtime}-on`, `${runtime}-off`]);
      assert.equal(result.runs.length, 3);
      assert.equal(result.runs[1].contextPresent, true);
      assert.equal(result.runs[2].enabled, false);
    });
  }
  test(`${runtime} demo refuses a non-active preference before reuse`, async () => {
    const f = fixture(runtime, [{ file: 'rejected.md', status: 'rejected', origin: 'you' }]);
    await assert.rejects(demonstrate(f.options), /No checked note or skill was accepted/);
    assert.deepEqual(f.reports, [{ agentId: `${runtime}-on`, input: TEACH }]);
  });
}
