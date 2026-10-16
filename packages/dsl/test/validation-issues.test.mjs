import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dryRunWorkflow, inspectWorkflow, runWorkflow, validateWorkflow, WorkflowInvalidError } from '../dist/index.js';

// The closed set the issues draw from, written out here rather than imported: the test pins the published codes.
const CODES = ['DOCUMENT_INVALID', 'SHAPE_INVALID', 'WORKFLOW_FIELD_INVALID', 'SCHEMA_INVALID', 'SCHEMA_UNKNOWN', 'INPUT_INVALID',
  'NODE_KIND_UNKNOWN', 'NODE_KEY_UNKNOWN', 'NODE_FIELD_INVALID', 'STATE_KEY_RESERVED', 'STATE_PATH_UNPRODUCED', 'STATE_PATH_EXCLUDED',
  'PARALLEL_WRITE_CONFLICT', 'STRUCTURE_INVALID', 'PREDICATE_INVALID', 'CODE_INVALID'];

const schemas = {
  A: { type: 'object' },
  I: { type: 'object', required: ['doc'], properties: { doc: { type: 'object', properties: { a: { type: 'string' } }, additionalProperties: false } } },
};
const flow = (steps, extra = {}) => ({ v: 2, name: 'issues', schemas, output: { schemaId: 'A' }, root: { node: 'chain', steps }, ...extra });
const agent = (label, extra = {}) => ({ node: 'agent', label, instructions: 'Do it.', out: 'A', as: label, ...extra });

/** RFC 6901: resolve a pointer in a document; undefined when it names nothing. */
function resolvePointer(document, pointer) {
  if (pointer === '') return document;
  if (!pointer.startsWith('/')) return undefined;
  let cursor = document;
  for (const raw of pointer.slice(1).split('/')) {
    const key = raw.replace(/~1/g, '/').replace(/~0/g, '~');
    if (cursor === null || typeof cursor !== 'object' || !Object.hasOwn(cursor, key)) return undefined;
    cursor = cursor[key];
  }
  return cursor;
}

/** The structural contract every rejection keeps: issues line up with errors, codes come from the set, pointers resolve. */
function assertIssues(document, result, where) {
  assert.equal(result.ok, false, where);
  assert.ok(Array.isArray(result.issues), `${where}: issues is a list`);
  assert.deepEqual(result.issues.map((issue) => issue.message), result.errors, `${where}: issues[i].message === errors[i]`);
  for (const issue of result.issues) {
    assert.deepEqual(Object.keys(issue).sort(), ['code', 'message', 'path'], `${where}: ${issue.message}`);
    assert.ok(CODES.includes(issue.code), `${where}: unknown code ${issue.code}`);
    assert.notEqual(resolvePointer(document, issue.path), undefined, `${where}: ${issue.path} names nothing (${issue.message})`);
  }
}

const one = (document, code, options) => {
  const result = validateWorkflow(document, options);
  assertIssues(document, result, code);
  const found = result.issues.filter((issue) => issue.code === code);
  assert.ok(found.length, `${code}: not reported; got ${JSON.stringify(result.issues)}`);
  return found;
};

const cycle = flow([agent('a')]);
cycle.root.steps[0].metadata = { self: null };
cycle.root.steps[0].metadata.self = cycle.root.steps[0].metadata;

const perCode = [
  ['DOCUMENT_INVALID', cycle, undefined, ''],
  ['SHAPE_INVALID', flow([agent('a', { instructions: 7 })]), undefined, '/root/steps/0/instructions'],
  ['WORKFLOW_FIELD_INVALID', { ...flow([agent('a')]), v: 3 }, undefined, ''],
  ['SCHEMA_INVALID', { ...flow([agent('a')]), schemas: { ...schemas, B: { type: 'object', properties: { x: { $ref: 'https://example.com/x' } } } } }, undefined, '/schemas/B'],
  ['SCHEMA_UNKNOWN', flow([agent('a'), agent('b', { out: 'Nope' })]), undefined, '/root/steps/1'],
  ['INPUT_INVALID', flow([agent('a')], { input: { schemaId: 'I' } }), { input: {} }, ''],
  ['NODE_KIND_UNKNOWN', flow([agent('a'), { node: 'teleport', label: 't' }]), undefined, '/root/steps/1'],
  ['NODE_KEY_UNKNOWN', flow([agent('a', { colour: 'blue' })]), undefined, '/root/steps/0'],
  ['NODE_FIELD_INVALID', flow([agent('a'), { node: 'loop', label: 'l', maxIters: 0, until: { predicate: 'field_true', path: 'a.done' }, body: agent('b') }]), undefined, '/root/steps/1'],
  ['STATE_KEY_RESERVED', flow([agent('a', { as: '$mine' })]), undefined, '/root/steps/0'],
  ['STATE_PATH_UNPRODUCED', flow([agent('a', { requires: ['nowhere'] })]), { inputKeys: [] }, '/root/steps/0'],
  ['STATE_PATH_EXCLUDED', flow([agent('a', { requires: ['doc.b'] })], { input: { schemaId: 'I' } }), { inputKeys: ['doc'] }, '/root/steps/0'],
  ['PARALLEL_WRITE_CONFLICT', flow([{ node: 'parallel', label: 'p', branches: [agent('x'), agent('y', { as: 'x' })] }]), undefined, '/root/steps/0'],
  ['STRUCTURE_INVALID', flow([{ node: 'parallel', label: 'p', branches: [agent('x')] }]), undefined, '/root/steps/0'],
  ['PREDICATE_INVALID', flow([agent('a'), { node: 'escalate', label: 'e', when: { predicate: 'phase_of_moon' }, kind: 'k', stage: 's', summary: 'x' }]), undefined, '/root/steps/1'],
  ['CODE_INVALID', flow([{ node: 'code', label: 'c', code: 'return (' }]), undefined, '/root/steps/0'],
];

test('every code in the set has a rejection that reports it, at the pointer of the thing the rule is about', () => {
  assert.deepEqual(perCode.map(([code]) => code), CODES, 'one case per code, in the published order');
  for (const [code, document, options, pointer] of perCode) {
    const found = one(document, code, options);
    assert.ok(found.some((issue) => issue.path === pointer), `${code}: expected ${JSON.stringify(pointer)}, got ${JSON.stringify(found)}`);
  }
});

test('the message of every issue is the error text unchanged, in the same order', () => {
  const document = flow([agent('a', { instructions: '' }), { node: 'parallel', label: 'p', branches: [agent('b', { out: 'Zed' })] }]);
  const result = validateWorkflow(document);
  assertIssues(document, result, 'mixed');
  assert.deepEqual(result.errors, [
    'root.steps[0] (a): instructions required',
    'root.steps[1] (p): parallel needs at least two branches',
    'root.steps[1].branches[0] (b): out schema "Zed" not in workflow.schemas',
  ]);
  assert.deepEqual(result.issues.map(({ path, code }) => [path, code]), [
    ['/root/steps/0', 'NODE_FIELD_INVALID'], ['/root/steps/1', 'STRUCTURE_INVALID'], ['/root/steps/1/branches/0', 'SCHEMA_UNKNOWN'],
  ]);
  assert.deepEqual(validateWorkflow(flow([agent('a')])), { ok: true }, 'an accepted workflow carries no issues field');
});

test('a node issue points where inspectWorkflow puts that node, through route names and child workflows', () => {
  const child = { v: 2, name: 'child', schemas, input: { schemaId: 'A' }, output: { schemaId: 'A' }, root: { node: 'chain', steps: [agent('c', { out: 'Gone' })] } };
  const document = flow([
    agent('a'),
    { node: 'route', label: 'r', valuePath: 'a.kind', branches: { 'yes/no~maybe': { body: agent('y', { out: 'Nope' }) }, other: { body: agent('o') } } },
    { node: 'workflow', label: 'w', as: 'w', out: 'A', input: {}, workflow: child },
  ]);
  const result = validateWorkflow(document);
  assertIssues(document, result, 'nested');
  const paths = result.issues.map((issue) => issue.path);
  assert.ok(paths.includes('/root/steps/1/branches/yes~1no~0maybe/body'), JSON.stringify(result.issues));
  assert.ok(paths.includes('/root/steps/2/workflow/root/steps/0'), JSON.stringify(result.issues));
  const nodePaths = new Set(inspectWorkflow(document).nodes.map((node) => node.path));
  for (const issue of result.issues) assert.ok(nodePaths.has(issue.path), `${issue.path} is an inspected node (${issue.message})`);
  const childIssue = result.issues.find((issue) => issue.path === '/root/steps/2/workflow/root/steps/0');
  assert.equal(childIssue.code, 'SCHEMA_UNKNOWN');
  assert.equal(childIssue.message, 'root.steps[2] (w) child: root.steps[0] (c): out schema "Gone" not in workflow.schemas');
});

test('a missing body is reported on the node that should hold it, never on the absent key', () => {
  const document = flow([{ node: 'map', label: 'm', itemsPath: 'a', as: 'out' }]);
  const result = validateWorkflow(document);
  assertIssues(document, result, 'bodiless map');
  const missing = result.issues.find((issue) => issue.code === 'NODE_KIND_UNKNOWN');
  assert.deepEqual([missing.path, missing.message], ['/root/steps/0', 'root.steps[0].body: unknown node kind "undefined"']);
});

test('one node object used at two positions is reported at each position', () => {
  // A TypeScript author may place the same object twice; each placement is its own node in the document.
  const shared = { node: 'extract', label: 'facts', instructions: 'Read it.', out: 'Facts', as: 'facts' };
  const document = { v: 2, name: 'reuse', schemas: { ...schemas, Facts: { type: 'object', properties: { report_markdown: { type: 'string' } } } },
    output: { schemaId: 'A' }, root: { node: 'chain', steps: [shared, { node: 'parallel', label: 'p', branches: [agent('x'), shared] }, { node: 'report', label: 'r', instructions: 'Write it.' }] } };
  const result = validateWorkflow(document);
  assertIssues(document, result, 'reused node');
  const owned = result.issues.filter((issue) => issue.message.includes('must not emit report_markdown'));
  assert.deepEqual(owned.map((issue) => issue.path), ['/root/steps/0', '/root/steps/1/branches/1']);
});

test('every invalid conformance case keeps the issue contract', () => {
  const dir = fileURLToPath(new URL('../../../spec/lean/conformance/', import.meta.url));
  let invalid = 0;
  for (const file of readdirSync(dir).filter((name) => name.endsWith('.json'))) {
    const c = JSON.parse(readFileSync(join(dir, file), 'utf8'));
    for (const options of [undefined, { inputKeys: Object.keys(c.input ?? {}) }, ...(c.input ? [{ input: c.input }] : [])]) {
      const result = validateWorkflow(c.workflow, options);
      if (result.ok) continue;
      invalid += 1;
      assertIssues(c.workflow, result, `${file} ${JSON.stringify(options)}`);
    }
  }
  assert.ok(invalid > 0, 'the corpus holds rejections');
});

test('WorkflowInvalidError carries the same issues as validateWorkflow', async () => {
  const document = flow([agent('a', { as: '$mine' })]);
  const expected = validateWorkflow(document);
  assertIssues(document, expected, 'reserved as');
  const error = await runWorkflow(document, {}, {}).then(() => null, (thrown) => thrown);
  assert.ok(error instanceof WorkflowInvalidError);
  assert.deepEqual(error.problems, expected.errors);
  assert.deepEqual(error.issues, expected.issues);
  assert.deepEqual(error.issues.map(({ path, code }) => [path, code]), [['/root/steps/0', 'STATE_KEY_RESERVED']]);
});

test('a dry run says whether every check ran: passed, not_run or failed, with ok as before', async () => {
  const plain = { v: 2, name: 'dry', schemas: { A: { type: 'object', properties: { n: { type: 'number' } } } }, output: { schemaId: 'A' }, root: { node: 'code', label: 'c', code: '() => ({ n: 1 })' } };
  assert.deepEqual(await dryRunWorkflow(plain), { ok: true, status: 'passed' });
  const pattern = { ...plain, schemas: { A: { type: 'object', properties: { n: { type: 'string', pattern: '^[0-9]+$' } } } }, root: { node: 'code', label: 'c', code: '() => ({ n: "1" })' } };
  const skipped = await dryRunWorkflow(pattern);
  assert.equal(skipped.ok, true, 'ok keeps its meaning');
  assert.equal(skipped.status, 'not_run');
  assert.ok(skipped.skipped.some((reason) => /pattern/.test(reason)), JSON.stringify(skipped));
  const escalating = { ...plain, root: { node: 'chain', steps: [{ node: 'code', label: 'c', code: '() => ({ n: 1 })' }, { node: 'escalate', label: 'e', when: { predicate: 'field_equals', path: 'n', value: 1 }, kind: 'review', stage: 's', summary: 'x' }] } };
  const escalated = await dryRunWorkflow(escalating);
  assert.equal(escalated.status, 'not_run', JSON.stringify(escalated));
  const unsynthesizable = { ...plain, schemas: { ...plain.schemas, In: { type: 'object', required: ['x'], properties: { x: { type: 'integer', minimum: 5, maximum: 1 } } } }, input: { schemaId: 'In' } };
  const noInput = await dryRunWorkflow(unsynthesizable);
  assert.equal(noInput.status, 'not_run', JSON.stringify(noInput));
  const failing = await dryRunWorkflow({ ...plain, root: { node: 'code', label: 'c', code: '() => ({ n: "one" })' } });
  assert.equal(failing.ok, false);
  assert.equal(failing.status, 'failed');
  const invalid = await dryRunWorkflow({ ...plain, root: { node: 'teleport' } });
  assert.deepEqual([invalid.ok, invalid.status], [false, 'failed']);
});

test('agentrun dry-run keeps its exit codes; --strict exits 3 when a check did not run', async (t) => {
  const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
  const dir = await mkdtemp(join(tmpdir(), 'agentrun-strict-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const write = async (name, value) => { const file = join(dir, name); await writeFile(file, JSON.stringify(value)); return file; };
  const plain = { v: 2, name: 'dry', schemas: { A: { type: 'object', properties: { n: { type: 'number' } } } }, output: { schemaId: 'A' }, root: { node: 'code', label: 'c', code: '() => ({ n: 1 })' } };
  const passed = await write('passed.json', plain);
  const notRun = await write('not-run.json', { ...plain, schemas: { A: { type: 'object', properties: { n: { type: 'string', format: 'date' } } } }, root: { node: 'code', label: 'c', code: '() => ({ n: "2026-01-01" })' } });
  const failed = await write('failed.json', { ...plain, root: { node: 'code', label: 'c', code: '() => ({ n: "one" })' } });
  const run = (...args) => spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', timeout: 10_000 });
  const exit = (...args) => { const r = run(...args); return [r.status, r.stderr.trim()]; };
  assert.deepEqual(exit('dry-run', passed, '--trusted'), [0, '']);
  assert.deepEqual(exit('dry-run', notRun, '--trusted'), [0, '']);
  assert.deepEqual(exit('dry-run', failed, '--trusted'), [1, '']);
  assert.deepEqual(exit('dry-run', passed, '--trusted', '--strict'), [0, '']);
  assert.deepEqual(exit('dry-run', notRun, '--trusted', '--strict'), [3, '']);
  assert.deepEqual(exit('dry-run', failed, '--strict', '--trusted'), [1, '']);
  assert.equal(JSON.parse(run('dry-run', notRun, '--trusted', '--strict').stdout).status, 'not_run');
  const [code, stderr] = exit('validate', passed, '--trusted', '--strict');
  assert.equal(code, 1);
  assert.match(stderr, /--strict/);
});
