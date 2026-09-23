import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadSkillsFromDir, parseFrontmatter } from '@earendil-works/pi-coding-agent';
import { validateWorkflow } from '@parcha/agentrun-dsl';
import agentRunExtension from '../dist/extension.js';
import { WorkflowExtensionService } from '../dist/extension-service.js';

const skillDir = fileURLToPath(new URL('../skills/author/', import.meta.url));
const example = async name => JSON.parse(await readFile(join(skillDir, 'examples', name), 'utf8'));
const inlineExample = async () => {
  const main = await readFile(join(skillDir, 'SKILL.md'), 'utf8');
  return JSON.parse(main.match(/```json\n([\s\S]*?)\n```/)[1]);
};

test('Pi discovers the author skill and all progressive references remain inside the shipped skill', async () => {
  const loaded = loadSkillsFromDir({ dir: dirname(skillDir), source: 'test' });
  assert.deepEqual(loaded.diagnostics, []);
  const skill = loaded.skills.find(entry => entry.name === 'agentrun-author');
  assert.ok(skill);
  const { frontmatter } = parseFrontmatter(await readFile(skill.filePath, 'utf8'));
  assert.match(frontmatter.version, /^\d+\.\d+\.\d+$/);
  assert.ok(frontmatter.eval_contract.goal);
  assert.ok(frontmatter.eval_contract.dimensions.length >= 3);
  assert.ok(frontmatter.eval_contract.hard_fails.length >= 3);
  const seen = new Set();
  async function checkLinks(file) {
    if (seen.has(file)) return;
    seen.add(file);
    const text = await readFile(file, 'utf8');
    for (const [, link] of text.matchAll(/\]\(([^)#]+)(?:#[^)]*)?\)/g)) {
      assert.doesNotMatch(link, /^[a-z]+:/i, 'skill references must be local packaged files');
      const target = resolve(dirname(file), link);
      assert.ok(!relative(skillDir, target).startsWith('..'), 'reference escapes packaged skill directory');
      await readFile(target);
      if (target.endsWith('.md')) await checkLinks(target);
    }
  }
  await checkLinks(skill.filePath);
});

test('the extraction example passes native admission and preserves its typed result and scoped prompt', async () => {
  const { action, workflow, input } = await inlineExample();
  assert.equal(action, 'inspect');
  const service = new WorkflowExtensionService();
  service.prepare(workflow);
  const report = await service.run(input, { deps: { runNode: async request => {
    assert.deepEqual(JSON.parse(request.user), input);
    assert.deepEqual(request.tools, [], 'the example service supplied no tools');
    return { breakingChange: 'Requests require X-Workspace.', migrationAction: 'Send X-Workspace with the workspace slug.' };
  } } });
  assert.equal(report.status, 'complete');
  assert.equal(report.output.migrationAction, 'Send X-Workspace with the workspace slug.');
  assert.deepEqual(report.calls, { agent: 1, judge: 0, tool: 0 });
  const invalid = await service.run(input, { deps: { runNode: async () => ({ breakingChange: 'Requests require X-Workspace.' }) } });
  assert.equal(invalid.status, 'failed');
  await service.dispose();
});

test('the composition example projects each mapped change and supplies it to the dependent summary', async () => {
  const service = new WorkflowExtensionService();
  service.prepare(await example('review-release-notes.json'));
  const input = await example('review-release-notes.input.json');
  const changes = [
    { breakingChange: 'Requests require X-Workspace.', migrationAction: 'Send X-Workspace with the workspace slug.' },
    { breakingChange: '/events has been removed.', migrationAction: 'Send event queries to /v2/events.' },
  ];
  try {
    const report = await service.run(input, { deps: { runNode: async request => {
      const scoped = JSON.parse(request.user);
      if (scoped.text !== undefined) {
        assert.deepEqual(Object.keys(scoped), ['text']);
        const index = input.notes.indexOf(scoped.text);
        assert.ok(index >= 0);
        return changes[index];
      }
      assert.deepEqual(scoped, { changes });
      return { changes: scoped.changes, summary: 'Add the workspace header and update the event endpoint.' };
    } } });
    assert.equal(report.status, 'complete', JSON.stringify(report));
    assert.deepEqual(report.output.changes, changes);
    assert.deepEqual(report.calls, { agent: 3, judge: 0, tool: 0 });
  } finally { await service.dispose(); }
});

test('the direct read example uses the native Pi adapter without an agent or Jev adapter', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'agentrun-skill-read-'));
  const tools = new Map(), events = new Map();
  const controller = new AbortController();
  const ctx = { cwd, signal: controller.signal, hasUI: false, model: undefined,
    sessionManager: { getSessionId: () => 'author-skill-test' },
    modelRegistry: { getAll: () => [], streamSimple: () => assert.fail('tool-only workflow must not call a model') },
  };
  agentRunExtension({
    registerTool: tool => tools.set(tool.name, tool), registerCommand: () => {},
    on: (name, handler) => events.set(name, handler),
    getActiveTools: () => ['read'],
    getAllTools: () => [{ name: 'read', sourceInfo: { source: 'builtin' } }],
    getCommands: () => [{ name: 'skill:agentrun-author', source: 'skill' }],
    getThinkingLevel: () => 'off', sendMessage: () => {},
  });
  const call = args => tools.get('agentrun').execute('skill-read', args, controller.signal, undefined, ctx);
  try {
    await writeFile(join(cwd, 'README.md'), 'A local fixture read through the real Pi built-in.\n');
    await call({ action: 'inspect', workflow: await example('read-file.json'), input: await example('read-file.input.json') });
    const { details: report } = await call({ action: 'run' });
    assert.equal(report.status, 'complete', JSON.stringify(report));
    assert.match(report.output.content[0].text, /local fixture read through the real Pi built-in/);
    assert.deepEqual(report.calls, { agent: 0, judge: 0, tool: 1 });
    const { details: invalid } = await call({ action: 'run', input: {} });
    assert.equal(invalid.status, 'failed');
    assert.deepEqual(invalid.calls, { agent: 0, judge: 0, tool: 0 });
  } finally { await events.get('session_shutdown')(); await rm(cwd, { recursive: true, force: true }); }
});

test('the sift and route reference fragments filter notes and stop uncertain reports', async () => {
  const reference = await readFile(join(skillDir, 'references/workflow-format.md'), 'utf8');
  const [sift, route] = [...reference.matchAll(/```json\n([\s\S]*?)\n```/g)].map(match => JSON.parse(match[1]));
  const workflow = await example('review-release-notes.json');
  workflow.schemas.MigrationQuestions = { type: 'object', required: ['actionable'], properties: {
    actionable: { type: 'boolean', description: 'Does the note state a concrete client migration action?' },
  } };
  workflow.root.steps.unshift(sift);
  workflow.root.steps[1].itemsPath = 'selected.items';
  workflow.root.steps[2] = route;
  assert.deepEqual(validateWorkflow(workflow, { inputKeys: ['notes'] }), { ok: true });
  const input = await example('review-release-notes.input.json');
  const change = { breakingChange: 'Requests require X-Workspace.', migrationAction: 'Send X-Workspace with the workspace slug.' };
  const service = new WorkflowExtensionService();
  service.prepare(workflow);
  try {
    for (const confidence of [0.95, 0.4]) {
      const extracted = [], summarized = [];
      const report = await service.run(input, { deps: {
        runJudge: async ({ questions }) => ({ answers: Object.fromEntries(Object.entries(questions).map(([id, question]) => [id,
          question.type === 'noul'
            ? { type: 'noul', noul: id.startsWith('0.') ? 0.95 : 0.1 }
            : { type: 'choice', choice: 'ready', probabilities: { ready: 0.95, needs_details: 0.05 }, confidence },
        ])) }),
        runNode: async request => {
          const state = JSON.parse(request.user);
          if ('text' in state) { extracted.push(state.text); return change; }
          summarized.push(state.changes);
          return { changes: state.changes, summary: 'Send the workspace header.' };
        },
      } });
      assert.deepEqual(extracted, [input.notes[0]], 'a discarded note must never reach extraction');
      if (confidence >= 0.8) {
        assert.equal(report.status, 'complete', JSON.stringify(report));
        assert.deepEqual(summarized, [[change]]);
        assert.deepEqual(report.output.changes, [change]);
        assert.deepEqual(report.calls, { agent: 2, judge: 2, tool: 0 });
      } else {
        assert.equal(report.status, 'escalated', JSON.stringify(report));
        assert.equal(report.output, undefined);
        assert.deepEqual(summarized, [], 'an uncertain route must not call the report writer');
        assert.equal(report.escalation.summary, 'Migration details need clarification.');
        assert.deepEqual(report.calls, { agent: 1, judge: 2, tool: 0 });
      }
    }
  } finally { await service.dispose(); }
});

test('the skill references carry the dsl package\'s author contract and Jev guide verbatim, and the guide the extension describes begins with the contract', async () => {
  const { loadAuthorContract } = await import('@parcha/agentrun-dsl');
  const { loadPiWorkflowGuide, loadPiJevGuide } = await import('../dist/skill-bundle.js');
  const shared = loadAuthorContract();
  const strip = text => text.replace(/^<!-- Generated from [^\n]*-->\n\n/, '');
  assert.equal(strip(await readFile(join(skillDir, 'references', 'dsl-contract.md'), 'utf8')), shared.contract);
  assert.equal(strip(await readFile(join(skillDir, 'references', 'jev-decisions.md'), 'utf8')), shared.jevDecisions);
  assert.equal(strip(loadPiJevGuide()), shared.jevDecisions);
  const guide = loadPiWorkflowGuide();
  assert.ok(strip(guide).startsWith(shared.contract.trim()), 'describe.authoring.workflow begins with the shared contract');
  assert.ok(guide.includes('# Workflow format'), 'and continues with the Pi host addendum');
});
