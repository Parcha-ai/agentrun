// The seed home's generic workflows skill: every workflow in it passes the agentrun tool's own inspect and dry run (no
// model, no tool call), what it says about optional input fields holds, it names nothing of this job, and the seed home
// offers it.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { dryRunWorkflow, inspectWorkflow } from '@parcha/agentrun-dsl';
import { WorkflowExtensionService } from '@parcha/agentrun-pi';
import { dryRunStatus } from './gates.mjs';
import { ANY_HOST, fetchPageTool } from './tools.mjs';

const HOME = join(import.meta.dirname, 'agent-v2');
const SKILL = readFileSync(join(HOME, 'skills', 'workflows', 'SKILL.md'), 'utf8');
const workflows = [...SKILL.matchAll(/```json\n([\s\S]*?)```/g)].map((m) => JSON.parse(m[1]));
const TOOLS = [fetchPageTool({ allowDomain: ANY_HOST })].map(({ name, description, parameters, resultSchema }) => ({ name, description, parameters, resultSchema }));

// The agentrun tool's inspect (createWorkflowTool's admit): every tool the workflow uses is one the host registered,
// then the checker's preflight against the input.
function inspect(workflow, input) {
  const names = TOOLS.map((t) => t.name);
  const missing = inspectWorkflow(workflow).requires.tools.filter((name) => !names.includes(name));
  if (missing.length) throw new Error(`uses tools the host has not registered: ${missing.join(', ')}`);
  return new WorkflowExtensionService({ allowedTools: names }).preflight(workflow, input);
}

test('every workflow in the skill inspects clean and its dry run passes', async () => {
  assert.equal(workflows.length, 1);
  for (const workflow of workflows) {
    const input = { url: 'https://www.example.com/hours', field: 'opening hours' };
    assert.doesNotThrow(() => inspect(workflow, input), workflow.name);
    assert.deepEqual(await dryRunWorkflow(workflow, { input }), { ok: true }, workflow.name);
    assert.deepEqual(inspectWorkflow(workflow).nodes.map((n) => n.kind), ['chain', 'call', 'escalate', 'extract', 'escalate', 'judge', 'escalate']);
  }
});

const Input = { type: 'object', properties: { url: { type: 'string', minLength: 1 }, topic: { type: 'string', minLength: 1 } }, required: ['topic'], additionalProperties: false };
const Page = { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] };
const read = (url) => ({ node: 'call', label: 'read-page', via: 'tool', tool: 'fetch_page', args: { url }, out: 'Page', as: 'page', deadline_s: 30 });
const ask = { node: 'escalate', label: 'ask-for-url', when: { predicate: 'field_equals', path: 'routing.taken', value: 'no' }, kind: 'needs_input', stage: 'start', summary: 'No url to start from.' };
const routed = (yes) => ({
  v: 2, name: 'optional-url', schemas: { Input, Page, Start: { type: 'object', properties: { given: { type: 'string', enum: ['yes', 'no'] }, url: { type: ['string', 'null'] } }, required: ['given', 'url'], additionalProperties: false } },
  input: { schemaId: 'Input' }, output: { schemaId: 'Page', path: 'page' },
  root: { node: 'chain', steps: [
    { node: 'extract', label: 'start', instructions: 'Return given yes and the url when the input has a url, else given no and url null.', tools: [], out: 'Start', as: 'start' },
    { node: 'route', label: 'by-url', valuePath: 'start.given', as: 'routing', branches: { yes: { body: yes }, no: { body: ask } } },
  ] },
});

test('an optional input field: inspection refuses it, a branch fails on it at run time, the two ways the skill names pass', async () => {
  const direct = { v: 2, name: 'direct', schemas: { Input, Page }, input: { schemaId: 'Input' }, output: { schemaId: 'Page', path: 'page' }, root: read('{url}') };
  assert.throws(() => inspect(direct, { topic: 'hours' }), /interpolates \{url\} but no upstream node produces "url"/);
  assert.doesNotThrow(() => inspect(routed(read('{url}')), { topic: 'hours' }));
  assert.match((await dryRunWorkflow(routed(read('{url}')), { input: { topic: 'hours' } })).problems.join(' '), /interpolation path "url" is not present in the state/);

  const required = { ...direct, schemas: { ...direct.schemas, Input: { ...Input, required: ['topic', 'url'] } } };
  assert.doesNotThrow(() => inspect(required, { topic: 'hours', url: 'https://www.example.com/' }));
  for (const input of [{ topic: 'hours' }, { topic: 'hours', url: 'https://www.example.com/' }]) {
    assert.doesNotThrow(() => inspect(routed(read('{start.url}')), input));
    assert.deepEqual(await dryRunWorkflow(routed(read('{start.url}')), { input }), { ok: true });
  }
});

test('the skill is generic: it names nothing of this job', () => {
  for (const word of ['sic', 'segment', 'company', 'companies', 'filing', 'filed', 'ticker', 'revenue', 'sec.gov', 'edgar', 'annual report', 'classif']) {
    assert.doesNotMatch(SKILL.toLowerCase(), new RegExp(`\\b${word.replace('.', '\\.')}`), word);
  }
  assert.ok(SKILL.split('\n').length <= 72, `${SKILL.split('\n').length} lines`);
});

test('the seed home offers the skill', () => {
  const definition = JSON.parse(readFileSync(join(HOME, 'agent.json'), 'utf8'));
  assert.deepEqual(definition.skills, ['classify', 'workflows']);
  assert.match(SKILL, /^---\nname: workflows\ndescription: .+\n---\n/);
});

test('a judge is answered yes in a dry run: a stop on its no passes the host\'s gate, a stop on its yes never does', async () => {
  const [example] = workflows;
  assert.deepEqual(await dryRunStatus(example), { status: 'passed', problems: [], skipped: [] });
  const flipped = structuredClone(example);
  const stop = flipped.root.steps.at(-1);
  stop.when = { predicate: 'field_true', path: 'check.supported' };
  const status = await dryRunStatus(flipped);
  assert.equal(status.status, 'not_run');
  assert.match(status.skipped.join(' '), /escalated:needs_input@check on synthetic values/);
  assert.match(SKILL, /A dry run answers every `judge` question yes/);
});

test('compose: a saved part embedded as a workflow step runs as a complete inline child, its input mapped from the parent', async () => {
  const [part] = workflows;
  const Input = { type: 'object', properties: { site: { type: 'string', minLength: 1 } }, required: ['site'], additionalProperties: false };
  const whole = {
    v: 2, name: 'whole', schemas: { Input, Found: part.schemas.Found },
    input: { schemaId: 'Input' }, output: { schemaId: 'Found', path: 'found' },
    root: { node: 'chain', steps: [{ node: 'workflow', label: 'the part', workflow: part, input: { url: '{site}', field: 'opening hours' }, out: 'Found', as: 'found' }] },
  };
  const input = { site: 'https://www.example.com/hours' };
  assert.doesNotThrow(() => inspect(whole, input));
  assert.deepEqual(await dryRunWorkflow(whole, { input }), { ok: true });
  assert.equal((await dryRunStatus(whole)).status, 'passed', 'the host gate passes it');
  assert.deepEqual(inspectWorkflow(whole).requires.tools, ['fetch_page'], 'the child\'s tools are the whole\'s');
  assert.match(SKILL, /# Compose\n\nA `workflow` step runs a complete inline child/);
});
