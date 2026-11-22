import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AgentBodyInvalid, bodyOf, learningSettingForBody } from '../dist/store/agent-body.js';
import { definitionOf } from '../dist/agents-store.js';
const cli = { runtime: 'codex', connection_id: 'connection', project: '/project' };

test('legacy CLI notes settings read as enabled without changing stored policy or admitting new notes settings', () => {
  const body = { instructions: '', skills: {}, tools: [], cli_learning: cli, learning: 'notes' };
  const before = structuredClone(body);
  assert.equal(learningSettingForBody(body), true);
  assert.equal(definitionOf({ id: 'cli-profile', name: 'CLI profile' }, { kind: 'agentic', body }, 1).learning, true);
  assert.deepEqual(body, before, 'a read must not rewrite the stored revision or its learning files');
  assert.equal(learningSettingForBody({ learning: 'notes' }), undefined, 'a managed revision does not gain legacy CLI behavior');
  for (const binding of [undefined, cli]) assert.throws(() => bodyOf({ kind: 'agentic', instructions: '', tools: [], learning: 'notes', ...(binding ? { cli_learning: binding } : {}) }), AgentBodyInvalid);
});

test('the current learning setting keeps Off, loop settings and absent settings distinct', () => {
  for (const learning of [true, false, { compile_after: 3, repick: true }, undefined]) {
    const body = { cli_learning: cli, ...(learning === undefined ? {} : { learning }) };
    assert.deepEqual(learningSettingForBody(body), learning);
  }
  assert.equal(learningSettingForBody(null), undefined);
});
