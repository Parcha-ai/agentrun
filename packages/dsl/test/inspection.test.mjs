import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspectWorkflow, formatWorkflowTree } from '../dist/inspection.js';

const object = { type: 'object' };
const plan = root => ({ v: 2, name: 'review-records', schemas: { Input: object, Result: object },
  input: { schemaId: 'Input' }, output: { schemaId: 'Result' }, root });

test('inspection does not execute code or semantic probes', () => {
  delete globalThis.__inspectionExecuted;
  const workflow = plan({ node: 'code', label: 'unsafe', code: 's => {globalThis.__inspectionExecuted = true; throw new Error("must not run");}' });
  const before = JSON.stringify(workflow);
  const result = inspectWorkflow(workflow);
  assert.equal(globalThis.__inspectionExecuted, undefined);
  assert.equal(JSON.stringify(workflow), before);
  assert.equal(result.checked, 'structure-only');
  assert.equal(result.requires.executableCode, true);
  assert.equal(result.sha256.length, 64);
  assert.deepEqual(result.requires.adapters, []);
});

test('nested branches have distinct escaped addresses and complete capability requirements', () => {
  const child = plan({ node: 'chain', steps: [
    { node: 'call', label: 'search', via: 'tool', tool: 'searchRecords', args: {}, out: 'Result', as: 'records', deadline_s: 5 },
    { node: 'agent', label: 'research', instructions: 'Find missing evidence.', out: 'Result', as: 'finding', tools: ['fetch'], sopSection: ['IDENTITY', 'EVIDENCE'], verify: { out: 'Result' } },
  ] });
  const workflow = plan({ node: 'route', label: 'choose', state: {}, instructions: 'Choose research.', branches: {
    'needs/research~now': { body: { node: 'workflow', label: 'research', workflow: child, input: {}, out: 'Result', as: 'result' } },
    done: { body: { node: 'code', label: 'research', code: 's => ({})' } },
  } });
  const result = inspectWorkflow(workflow);
  assert.deepEqual(result.requires.adapters, ['runEffect', 'runJudge', 'runNode']);
  assert.deepEqual(result.requires.tools, ['fetch', 'searchRecords']);
  assert.deepEqual(result.requires.sopSections, ['EVIDENCE', 'IDENTITY']);
  assert.equal(new Set(result.nodes.map(n => n.path)).size, result.nodes.length);
  assert.ok(result.nodes.some(n => n.path === '/root/branches/needs~1research~0now/body/workflow/root/steps/0'));
  assert.match(formatWorkflowTree(result), /route needs\/research~now: research \[workflow\]/);
  assert.match(formatWorkflowTree(result), /search \[call\] → records/);
});

test('inspection rejects malformed, cyclic and excessively deep documents with a diagnostic', () => {
  assert.throws(() => inspectWorkflow({}), /Cannot inspect workflow/);
  assert.throws(() => inspectWorkflow(plan({ node: 'teleport' })), /Cannot inspect workflow/);
  const cyclic = plan({ node: 'chain', steps: [] });
  cyclic.root.steps.push(cyclic.root);
  assert.throws(() => inspectWorkflow(cyclic), /Cannot inspect workflow/);
  let root = { node: 'code', label: 'leaf', code: 's => ({})' };
  for (let i = 0; i < 200; i++) root = { node: 'chain', steps: [root] };
  assert.throws(() => inspectWorkflow(plan(root)), /Cannot inspect workflow/);
});

test('terminal rendering escapes control sequences in authored labels', () => {
  const text = formatWorkflowTree(inspectWorkflow(plan({ node: 'code', label: 'look\u001b[2J\nforged', code: 's => ({})' })));
  assert.equal(text.includes('\u001b'), false);
  assert.match(text, /look\\u001b\[2J\\u000aforged/);
});

test('CLI inspection requires no trust flag and produces JSON without executing authored effects', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agentrun-inspect-'));
  try {
    const file = join(directory, 'workflow.json');
    const marker = join(directory, 'executed');
    const workflow = plan({ node: 'call', label: 'write', via: 'shell', command: `touch ${marker}`, as: 'done', deadline_s: 1 });
    await writeFile(file, JSON.stringify(workflow));
    const cli = new URL('../dist/cli.js', import.meta.url);
    const output = execFileSync(process.execPath, [cli.pathname, 'inspect', file, '--json'], { encoding: 'utf8' });
    assert.equal(JSON.parse(output).checked, 'structure-only');
    await assert.rejects(readFile(marker), { code: 'ENOENT' });
    assert.throws(() => execFileSync(process.execPath, [cli.pathname, 'inspect', file, '--typo'], { stdio: 'pipe' }), /Usage: agentrun inspect/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
