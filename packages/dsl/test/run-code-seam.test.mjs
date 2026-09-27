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
