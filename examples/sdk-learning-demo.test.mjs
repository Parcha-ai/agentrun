import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CORRECTION, demonstrate, STATUS, TASK } from './sdk-learning/demo.mjs';

/** A server with one agent's corrections.md: GET answers it with its version, PUT replaces it on that version only.
 *  `keeps: false` answers the PUT but keeps nothing, as a server whose write never reached main. */
function fixture(runtime, { keeps = true } = {}) {
  const reports = [], flushes = [], writes = [];
  const facts = Object.values(STATUS).join(' ');
  let corrections = '', version = 1;
  const etag = () => `"v${version}"`;
  const revision = () => `main-${version}`;
  const fetch = async (url, options = {}) => {
    const path = new URL(url).pathname;
    if (options.method === 'POST' && path.endsWith('/sdk-runs')) {
      const body = JSON.parse(options.body);
      return Response.json({ run_id: `run-${reports.length}`, agent_id: body.agentId,
        console_url: 'https://demo.invalid/runs', learning: { enabled: body.learning,
          revision: body.learning ? revision() : null, context: body.learning ? corrections : '' } });
    }
    assert.ok(path.startsWith(`/v2/agents/${runtime}-on/learning`), path);
    if (path.endsWith('/learning/corrections')) {
      if (options.method === 'PUT') {
        const ifMatch = new Headers(options.headers).get('if-match');
        assert.equal(ifMatch, etag(), 'the write names the version it read');
        const { text } = JSON.parse(options.body);
        writes.push(text);
        if (keeps) { corrections = text; version += 1; }
        return Response.json({ text, etag: etag(), cap_bytes: 2048 }, { headers: { etag: etag() } });
      }
      return Response.json({ text: corrections, etag: etag(), cap_bytes: 2048 }, { headers: { etag: etag() } });
    }
    assert.equal(path, `/v2/agents/${runtime}-on/learning`);
    return Response.json({ agent: `${runtime}-on`, main: revision(), corrections, workflows: [] });
  };
  const createBackend = options => ({
    async report(input) {
      reports.push({ agentId: options.agentId, input });
      const answered = await options.fetch('https://demo.invalid/v2/sdk-runs', { method: 'POST',
        body: JSON.stringify({ agentId: options.agentId, learning: options.learning }) });
      const given = (await answered.json()).learning.context.includes(CORRECTION);
      return { answer: (given ? 'Release brief: ' : '') + facts, toolCalls: 1 };
    },
    async flushLearning() { flushes.push(options.agentId); },
  });
  return { options: { runtime, agentPrefix: runtime, baseUrl: 'https://demo.invalid/v2',
    apiKey: 'fake-test-key', createBackend, fetch }, reports, flushes, writes };
}

for (const runtime of ['claude', 'codex']) {
  test(`${runtime} demo writes the owner's correction, reuses it in a fresh run, and checks the Off control`, async () => {
    const f = fixture(runtime);
    const result = await demonstrate(f.options);
    assert.deepEqual(f.writes, [`- ${CORRECTION}\n`]);
    assert.equal(result.corrections, `- ${CORRECTION}\n`);
    assert.equal(result.correctedRevision, 'main-2');
    assert.deepEqual(f.reports, [
      { agentId: `${runtime}-on`, input: TASK },
      { agentId: `${runtime}-on`, input: TASK },
      { agentId: `${runtime}-off`, input: TASK },
    ]);
    assert.deepEqual(f.flushes, [`${runtime}-on`, `${runtime}-on`, `${runtime}-off`]);
    assert.equal(result.runs.length, 3);
    assert.equal(result.runs[0].correctionGiven, false);
    assert.equal(result.runs[1].correctionGiven, true);
    assert.equal(result.runs[1].revision, 'main-2');
    assert.equal(result.runs[2].enabled, false);
  });
  test(`${runtime} demo stops before reuse when main does not hold the correction`, async () => {
    const f = fixture(runtime, { keeps: false });
    await assert.rejects(demonstrate(f.options), /corrections\.md on main does not hold the owner's correction/);
    assert.deepEqual(f.reports, [{ agentId: `${runtime}-on`, input: TASK }]);
  });
}
