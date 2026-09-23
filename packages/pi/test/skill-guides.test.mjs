import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAgentRunExtension } from '../dist/extension.js';
import { join as joinPath } from 'node:path';
import { authorSkillDirectory, loadAuthorReference, loadAuthorSkillBundle } from '@parcha/agentrun-dsl';

const workflow = JSON.parse(await readFile(joinPath(authorSkillDirectory(), 'examples/read-source-decision.json'), 'utf8'));

test('native describe ships the packaged language, guides and the Pi host addendum', async () => {
  const tools = new Map(), events = new Map();
  createAgentRunExtension({ hostTools: () => [] })({
    registerTool: tool => tools.set(tool.name, tool), registerCommand() {},
    on: (name, handler) => events.set(name, handler),
    getCommands: () => [], getThinkingLevel: () => 'off', sendMessage() {},
  });
  const ctx = { cwd: process.cwd(), hasUI: false, sessionManager: { getSessionId: () => 'guide-test' },
    modelRegistry: { getAll: () => [] } };
  try {
    const result = await tools.get('agentrun').execute('describe', { action: 'describe' }, undefined, undefined, ctx);
    assert.deepEqual(result.details.tools, []);
    assert.equal(result.details.authoring.jev, loadAuthorReference('jev-decisions'));
    assert.equal(JSON.parse(result.content[0].text).authoring.jev, loadAuthorReference('jev-decisions'));
    assert.ok(loadAuthorSkillBundle().includes(loadAuthorReference('jev-decisions')));
    assert.equal(result.details.authoring.workflow, loadAuthorReference('workflow-format'));
    assert.equal(JSON.parse(result.content[0].text).authoring.workflow, loadAuthorReference('workflow-format'));
    assert.ok(loadAuthorSkillBundle().includes(loadAuthorReference('workflow-format')));
    assert.equal(result.details.authoring.language, loadAuthorReference('language'));
    assert.match(result.details.authoring.host, /^## Host: Pi extension/);
    assert.match(result.details.authoring.host, /\/agentrun run --trusted/);
    assert.match(result.details.authoring.host, /a host that configures its tools offers only those/);
    assert.doesNotMatch(result.details.authoring.host, /`artifact`/);
    assert.doesNotMatch(result.details.authoring.language, /\/agentrun|Pi extension/, 'the shared language carries no Pi vocabulary');
  } finally { await events.get('session_shutdown')(); }
});

test('shipped read→Jev→code graph preserves original context through the native trusted path', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'agentrun-source-guide-'));
  const tools = new Map(), commands = new Map(), events = new Map(), messages = [], states = [];
  const originals = {
    'current.txt': '# Current release\nClients MUST send X-Workspace.\n# Future proposals\nChanging authentication is NOT approved.',
    'proposal.txt': '# Draft proposal — NOT RELEASED\nClients might eventually send X-Workspace. No client change is currently required.',
  };
  for (const [path, content] of Object.entries(originals)) await writeFile(join(cwd, path), content);
  const question = 'Does this source announce a required client migration for the current release rather than a proposal?';
  const ctx = { cwd, hasUI: false, sessionManager: { getSessionId: () => 'source-guide-test' },
    modelRegistry: { getAll: () => [], streamSimple() { assert.fail('Jev/code graph must not call a generative model'); } } };
  createAgentRunExtension({ createJudge: () => async request => {
    states.push(request.state);
    assert.equal(request.state.question, question);
    const text = request.state.source.content[0].text;
    assert.ok(Object.values(originals).includes(text), 'judge receives exact host-read text, not a summary');
    return { answers: { matches: { type: 'noul', noul: text === originals['current.txt'] ? .94 : .07 } } };
  } })({
    registerTool: tool => tools.set(tool.name, tool), registerCommand: (name, command) => commands.set(name, command),
    on: (name, handler) => events.set(name, handler), getCommands: () => [], getThinkingLevel: () => 'off',
    getActiveTools: () => ['read'], getAllTools: () => [{ name: 'read', sourceInfo: { source: 'builtin' } }],
    sendMessage: message => messages.push(message),
  });
  const call = args => tools.get('agentrun').execute('source-test', args, undefined, undefined, ctx);
  try {
    await call({ action: 'inspect', workflow, input: { question, paths: Object.keys(originals) } });
    assert.equal(states.length, 0, 'inspection neither reads sources nor calls Jev');
    await assert.rejects(call({ action: 'run' }), /[Cc]ode|[Ee]xecutable/);
    assert.equal(states.length, 0, 'untrusted code executes nothing');
    await commands.get('agentrun').handler('run --trusted', ctx);
    const report = messages.at(-1).details;
    assert.equal(report.status, 'complete', JSON.stringify(report));
    assert.deepEqual(report.calls, { agent: 0, judge: 2, tool: 2 });
    assert.deepEqual(report.output.map(row => [row.path, row.probability]), [['current.txt', .94], ['proposal.txt', .07]]);
    for (const row of report.output) assert.equal(row.source.content[0].text, originals[row.path]);
    assert.equal(states.length, 2);
  } finally { await events.get('session_shutdown')(); await rm(cwd, { recursive: true, force: true }); }
});
