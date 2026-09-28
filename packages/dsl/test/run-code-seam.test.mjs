// `deps.runCode`: the host's executor for `code` nodes. Present, the interpreter calls it with the node,
// the state and the transform's context and uses what it resolves to as the transform's result, under
// the same patch rules and state checks; its rejection fails the node as the host typed it. Absent,
// the interpreter compiles and runs the transform in this process, as it always has.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runWorkflow, WorkflowStateError, WorkflowCodeError } from '../dist/index.js';

const record = { type: 'object' };
const flow = (root, extra = {}) => ({ v: 2, name: 'code-seam', schemas: { Out: record, ...(extra.schemas ?? {}) }, output: { schemaId: 'Out', path: 'final' }, root, ...extra.top });
// In this process the transform's `process` is shadowed to undefined, so this body throws here; a
// host executor that answers for it proves the interpreter never compiled it.
const unsafe = { node: 'code', label: 'count', code: '(s) => ({ n: process.pid })', as: 'counted' };
const finish = { node: 'code', label: 'finish', code: '(s) => ({ final: { n: s.counted.n } })' };

test('present: the interpreter hands the host the node, the state and the context, and merges what it returns', async () => {
  const calls = [];
  const result = await runWorkflow(flow({ node: 'chain', steps: [unsafe, finish] }), { question: 'q' }, {
    sop: 'SOP text',
    runCode: async (node, state, ctx) => {
      calls.push({ node, state: structuredClone(state), ctx: { ...ctx, signal: undefined } });
      return node.label === 'count' ? { n: 7 } : { final: { n: state.counted.n } };
    },
  });
  assert.equal(result.status, 'complete');
  assert.deepEqual(result.output, { n: 7 });
  assert.equal(calls.length, 2, 'every code node went to the host, the plain one too');
  assert.deepEqual(calls[0].node, unsafe);
  assert.deepEqual(calls[0].state, { question: 'q' });
  assert.deepEqual(calls[0].ctx, { sop: 'SOP text', label: 'count', executionPath: '/root/steps/0', signal: undefined });
  assert.equal(calls[1].ctx.executionPath, '/root/steps/1');
});

test('present: a map item and a child workflow reach the host with the item and the prefixed label', async () => {
  const seen = [];
  const runCode = async (node, state, ctx) => { seen.push({ label: node.label, ctxLabel: ctx.label, item: ctx.item?.index ?? null, path: ctx.executionPath }); return { doubled: (state.item ?? 1) * 2 }; };
  const mapped = await runWorkflow(flow({ node: 'chain', steps: [
    { node: 'map', label: 'each', itemsPath: 'values', as: 'outs', body: { node: 'code', label: 'double', code: '(s) => ({ doubled: s.item * 2 })' } },
    { node: 'code', label: 'finish', code: '(s) => ({ final: { outs: s.outs } })', as: 'final' },
  ] }), { values: [1, 2] }, { runCode: async (node, state, ctx) => node.label === 'finish' ? { outs: state.outs } : runCode(node, state, ctx) });
  assert.equal(mapped.status, 'complete');
  assert.deepEqual(seen.map(s => s.item).sort(), [0, 1]);
  assert.ok(seen.every(s => s.path.includes('/items/')), JSON.stringify(seen));

  seen.length = 0;
  const child = { v: 2, name: 'child', schemas: { In: record, Res: record }, input: { schemaId: 'In' }, output: { schemaId: 'Res', path: 'res' },
    root: { node: 'code', label: 'inner', code: '(s) => ({ res: { ok: true } })' } };
  const composed = await runWorkflow(flow({ node: 'chain', steps: [
    { node: 'workflow', label: 'sub', workflow: child, input: {}, out: 'Out', as: 'final' },
  ] }), {}, { runCode: async (node, _state, ctx) => { seen.push({ label: node.label, ctxLabel: ctx.label }); return { res: { ok: true } }; } });
  assert.equal(composed.status, 'complete');
  assert.deepEqual(seen, [{ label: 'sub/inner', ctxLabel: 'sub/inner' }]);
});

test('present: the host result passes the interpreter\'s own state checks, and a host rejection is the node\'s failure as typed', async () => {
  await assert.rejects(
    runWorkflow(flow({ node: 'chain', steps: [{ node: 'code', label: 'bad', code: '(s) => ({})' }, finish] }), {}, { runCode: async () => ({ $host: { forged: true } }) }),
    error => error instanceof WorkflowStateError && error.code === 'state_invalid' && error.stage === 'bad',
  );
  class HostCodeFailure extends Error { code = 'output_invalid'; }
  await assert.rejects(
    runWorkflow(flow({ node: 'chain', steps: [unsafe, finish] }), {}, { runCode: async () => { throw new HostCodeFailure('child printed no JSON'); } }),
    error => error instanceof HostCodeFailure && error.code === 'output_invalid',
  );
});

test('absent: the interpreter runs the transform itself, in this process', async () => {
  const ok = await runWorkflow(flow({ node: 'chain', steps: [{ node: 'code', label: 'count', code: '(s) => ({ n: s.values.length })', as: 'counted' }, finish] }), { values: [1, 2, 3] }, {});
  assert.equal(ok.status, 'complete');
  assert.deepEqual(ok.output, { n: 3 });
  await assert.rejects(runWorkflow(flow({ node: 'chain', steps: [unsafe, finish] }), {}, {}), error => error instanceof WorkflowCodeError);
});

test('a dry run with the seam present hands every code node to the host and never runs a body in this process; absent, it runs them in-process as before', async () => {
  const { dryRunWorkflow } = await import('../dist/index.js');
  const doc = flow({ node: 'chain', steps: [
    { node: 'extract', label: 'plan', instructions: 'plan', out: 'Plan', as: 'plan' },
    { node: 'code', label: 'count', code: '(s) => ({ n: s.plan.items.length })', as: 'counted' },
    { node: 'code', label: 'finish', code: '(s) => ({ final: { n: s.counted.n } })' },
  ] }, { schemas: { Plan: { type: 'object', required: ['items'], properties: { items: { type: 'array', items: { type: 'string' } } } } } });
  // The in-process executor builds each body's factory with the Function constructor and calls it to
  // evaluate the body. Syntax checking builds the factory and never calls it; a dry run with the seam
  // must never call one, validation probes included.
  const Real = globalThis.Function;
  let compiled = 0;
  const seen = [];
  globalThis.Function = new Proxy(Real, { construct(target, args) {
    const factory = Reflect.construct(target, args);
    // Only a code node's body is counted (its factory's source holds the body); the validator compiler builds functions too.
    const body = String(args.at(-1));
    if (!body.includes('s.plan.items.length') && !body.includes('s.counted.n')) return factory;
    return new Proxy(factory, { apply(fn, self, callArgs) { compiled += 1; return Reflect.apply(fn, self, callArgs); } });
  } });
  try {
    const withSeam = await dryRunWorkflow(doc, { runCode: async (node, state) => { seen.push(node.label); return node.label === 'count' ? { n: state.plan.items.length } : { final: { n: state.counted.n } }; } });
    assert.deepEqual(withSeam, { ok: true });
    assert.deepEqual(seen, ['count', 'finish']);
    assert.equal(compiled, 0, 'no code body was evaluated in this process');
  } finally { globalThis.Function = Real; }
  // Absent, the dry run runs the bodies itself, and the counter sees it.
  globalThis.Function = new Proxy(Real, { construct(target, args) { const factory = Reflect.construct(target, args); return String(args.at(-1)).includes('s.counted.n') ? new Proxy(factory, { apply(fn, self, callArgs) { compiled += 1; return Reflect.apply(fn, self, callArgs); } }) : factory; } });
  try { assert.deepEqual(await dryRunWorkflow(doc), { ok: true }); } finally { globalThis.Function = Real; }
  assert.ok(compiled > 0, 'without the seam the bodies were evaluated here');
  // A host rejection is a dry-run problem, as any failure on the deterministic path is.
  const refused = await dryRunWorkflow(doc, { runCode: async () => { throw Object.assign(new Error('sandbox refused the body'), { code: 'effect_code_unsafe' }); } });
  assert.equal(refused.ok, false);
  assert.match(refused.problems[0], /sandbox refused the body/);
});
