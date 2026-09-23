import assert from 'node:assert/strict';
import test from 'node:test';
import { validateWorkflow, runWorkflow } from '../dist/index.js';

const schema = { type: 'object', properties: { years: { type: 'array', items: { type: 'number' } } }, required: ['years'] };
const graph = (itemsPath, as) => ({ v: 2, name: 'Fictional collection contract',
  schemas: { Plan: schema, Result: { type: 'object' } }, output: { schemaId: 'Result' },
  root: { node: 'chain', steps: [
    { node: 'extract', label: 'plan', ...(as ? { as } : {}), instructions: 'Fictional year planner.', out: 'Plan' },
    { node: 'map', label: 'each-year', itemsPath, as: 'rows', body: {
      node: 'extract', label: 'row', instructions: 'Fictional row.', out: 'Result', as: 'row', state: { item: '{item}' },
    } },
  ] },
});
const validate = workflow => validateWorkflow(workflow, { executeCode: false, input: { question: 'fictional' } });

test('nonexecuting inspection rejects bare collection fields instead of dispatching a planner first', () => {
  for (const as of [undefined, 'schedule']) {
    const checked = validate(graph('years', as));
    assert.equal(checked.ok, false); assert.match(checked.errors.join(' '), /itemsPath "years" has no upstream producer/);
  }
});

test('implicit label and explicit as bindings remain valid and actually execute', async () => {
  for (const as of [undefined, 'schedule']) {
    const workflow = graph(`${as ?? 'plan'}.years`, as);
    assert.deepEqual(validate(workflow), { ok: true });
    const result = await runWorkflow(workflow, { question: 'fictional' }, { runNode: async request =>
      request.label === 'plan' ? { years: [2001, 2002] } : { year: JSON.parse(request.user).item } });
    assert.deepEqual(result.output.rows, [{ year: 2001 }, { year: 2002 }]);
  }
});

test('uncertain code-produced fields remain runtime checks; inspection never runs factories', () => {
  const workflow = graph('years');
  workflow.root.steps[0] = { node: 'code', label: 'dynamic', code: '(() => { throw new Error("INSPECTION_MUST_NOT_EXECUTE"); })()' };
  assert.deepEqual(validate(workflow), { ok: true });
});

test('implicit agent label is reachable by ordinary downstream state interpolation', () => {
  const workflow = graph('plan.years');
  workflow.root.steps[1] = { node: 'extract', label: 'consume', instructions: 'Fictional consumer.', state: { plan: '{plan}' }, requires: ['plan'], out: 'Result' };
  assert.deepEqual(validate(workflow), { ok: true });
});

test('a final output selecting an unwritten top-level key fails before any execution', async () => {
  const workflow = graph('plan.years');
  workflow.root = workflow.root.steps[0]; workflow.output.path = 'missing';
  const checked = validate(workflow);
  assert.equal(checked.ok, false); assert.match(checked.errors.join(' '), /output: path "missing" has no input or upstream producer/);
  workflow.output.path = 'plan';
  assert.deepEqual(validate(workflow), { ok: true });
  workflow.output.path = 'question';
  assert.deepEqual(validate(workflow), { ok: true }, 'an input value is also a producer; this check does not claim type equivalence');
});

test('escalation-only workflows need not produce a normal output', async () => {
  const workflow = graph('plan.years'); workflow.output.path = 'absent';
  workflow.root = { node: 'escalate', label: 'needs-evidence', kind: 'review', stage: 'review', summary: 'Fictional missing evidence.',
    when: { predicate: 'field_true', path: 'review' } };
  const input = { review: true };
  assert.deepEqual(validateWorkflow(workflow, { executeCode: false, input }), { ok: true });
  assert.equal((await runWorkflow(workflow, input, {})).status, 'escalated');
});
