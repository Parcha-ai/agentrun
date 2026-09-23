import assert from 'node:assert/strict';
import test from 'node:test';
import { validateWorkflow, runWorkflow } from '../dist/index.js';
import { compileTransform, compileTransformSyntax } from '../dist/code-exec.js';

const output = { type: 'object', required: ['value'], additionalProperties: false,
  properties: { value: { type: 'number' } } };
const plan = code => ({ v: 2, name: 'Fictional validation fixture',
  schemas: { Input: { type: 'object' }, Output: output }, input: { schemaId: 'Input' },
  output: { schemaId: 'Output', path: 'result' }, root: { node: 'code', label: 'transform', code } });

test('syntax-only compilation never invokes a factory expression or transform body', () => {
  Math.__syntaxFactory = 0;
  Math.__syntaxBody = 0;
  const source = '(() => { Math.__syntaxFactory++; return s => { Math.__syntaxBody++; return {result:{value:1}}; }; })()';
  try {
    compileTransformSyntax(source);
    assert.equal(Math.__syntaxFactory, 0);
    assert.equal(Math.__syntaxBody, 0);
    const fn = compileTransform(source);
    assert.equal(Math.__syntaxFactory, 1);
    assert.equal(Math.__syntaxBody, 0);
    assert.deepEqual(fn({}), { result: { value: 1 } });
    assert.equal(Math.__syntaxBody, 1);
  } finally { delete Math.__syntaxFactory; delete Math.__syntaxBody; }
});

test('executeCode:false skips factories and all probes, including child workflow validation', () => {
  Math.__validationFactory = 0;
  Math.__validationBody = 0;
  const child = plan('(() => { Math.__validationFactory++; return s => { Math.__validationBody++; return {result:{value:1}}; }; })()');
  const parent = { ...plan('s => ({})'), root: { node: 'workflow', label: 'child', workflow: child,
    input: { question: '{question}' }, out: 'Output', as: 'result' } };
  try {
    for (const workflow of [child, parent]) {
      assert.deepEqual(validateWorkflow(workflow, { executeCode: false, input: { question: 'Fictional input' },
        probeContext: { references: { 'fictional.txt': 'Fictional source' } } }), { ok: true });
      assert.equal(Math.__validationFactory, 0);
      assert.equal(Math.__validationBody, 0);
    }
    assert.deepEqual(validateWorkflow(parent, { inputKeys: ['question'] }), { ok: true });
    assert.ok(Math.__validationFactory > 0, 'trusted validation still evaluates factories');
    assert.ok(Math.__validationBody > 0, 'trusted input-aware validation still probes transforms');
  } finally { delete Math.__validationFactory; delete Math.__validationBody; }
});

test('nonexecuting validation rejects raw bodies, invalid references and unknown node fields', () => {
  for (const source of [undefined, null, 42, {}, '', '   ']) {
    const invalidSource = plan(source);
    if (source === undefined) delete invalidSource.root.code;
    assert.equal(validateWorkflow(invalidSource, { executeCode: false }).ok, false);
    assert.equal(validateWorkflow(invalidSource).ok, false);
    assert.throws(() => compileTransformSyntax(source), /source must be a non-empty string/);
    assert.throws(() => compileTransform(source), /source must be a non-empty string/);
  }
  const raw = validateWorkflow(plan('return {result:{value:1}};'), { executeCode: false });
  assert.equal(raw.ok, false);
  assert.match(raw.errors.join('\n'), /failed to compile/);
  const unknown = plan('s => ({result:{value:1}})');
  Object.assign(unknown.root, { state: {}, out: 'Output', instructions: 'Not a code-node field' });
  const invalidCode = validateWorkflow(unknown, { executeCode: false });
  assert.equal(invalidCode.ok, false);
  assert.match(invalidCode.errors.join('\n'), /unknown key\(s\) for a code node: state, out, instructions/);
  const judge = { ...plan('s => ({})'), root: { node: 'judge', label: 'check', out: 'Questions',
    as: 'result', instructions: 'Not a judge-node field' } };
  judge.schemas.Questions = { type: 'object', properties: { matches: { type: 'boolean', description: 'Does the supplied fictional row match?' } } };
  const invalidJudge = validateWorkflow(judge, { executeCode: false });
  assert.equal(invalidJudge.ok, false);
  assert.match(invalidJudge.errors.join('\n'), /unknown key\(s\) for a judge node: instructions/);
  const refs = plan('s => ({result:{value:1}})');
  refs.schemas.Record = output;
  refs.schemas.Records = { type: 'array', items: { $ref: 'Record' } };
  const invalidRefs = validateWorkflow(refs, { executeCode: false });
  assert.equal(invalidRefs.ok, false);
  assert.match(invalidRefs.errors.join('\n'), /unsupported \$ref form "Record"/);
  refs.schemas.Records.items.$ref = '#/definitions/Record';
  assert.deepEqual(validateWorkflow(refs, { executeCode: false }), { ok: true });
});

test('nonexecuting feedback retains mechanical reachability and never replaces trusted output checks', async () => {
  const unreachable = { ...plan('s => ({})'), root: { node: 'agent', label: 'requires-source',
    instructions: 'Return a fictional number', requires: ['absent'], out: 'Output', as: 'result' } };
  const invalid = validateWorkflow(unreachable, { executeCode: false, inputKeys: ['question'] });
  assert.equal(invalid.ok, false);
  assert.match(invalid.errors.join('\n'), /requires "absent"/);
  const incomplete = plan('s => ({result:{}})');
  assert.deepEqual(validateWorkflow(incomplete, { executeCode: false, inputKeys: [] }), { ok: true });
  const trusted = validateWorkflow(incomplete, { inputKeys: [] });
  assert.equal(trusted.ok, false);
  assert.match(trusted.errors.join('\n'), /never emits required field/);
  await assert.rejects(runWorkflow(incomplete, {}, {}), /never emits required field/);
  const notAFunction = plan('42');
  assert.deepEqual(validateWorkflow(notAFunction, { executeCode: false }), { ok: true }, 'syntax checks cannot establish a dynamic expression return type');
  assert.equal(validateWorkflow(notAFunction).ok, false);
  await assert.rejects(runWorkflow(notAFunction, {}, {}), /single.*function/);
  const valid = plan('s => ({result:{value:s.value+1}})');
  assert.equal((await runWorkflow(valid, { value: 2 }, {})).output.value, 3);
});
