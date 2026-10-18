// The judge seam's optional `assets` and `model`: the type compiles strictly, the interpreter's own calls are unchanged by them, and what a host
// adds to a call (as pi-vision's `vision.judge` does) reaches the judge function as it was given.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { runWorkflow } from '../dist/index.js';

const workflow = {
  v: 2, name: 'judged',
  schemas: { Q: { type: 'object', required: ['ok'], properties: { ok: { type: 'boolean', description: 'Is it fine?' } } }, Out: { type: 'object', required: ['ok'], properties: { ok: { type: 'boolean' } } } },
  output: { schemaId: 'Out', path: 'final' },
  root: { node: 'chain', steps: [
    { node: 'judge', label: 'fine', state: { text: 'a thing' }, out: 'Q', as: 'verdict' },
    { node: 'code', label: 'finish', code: '(s) => ({ final: { ok: s.verdict.ok } })' },
  ] },
};
const answer = { answers: { ok: { type: 'noul', noul: 0.9 } }, model: 'jev-1.14.0', usage: null, cost_usd: null };

test('the optional assets and model type strictly, and the shapes that are not an image are refused', () => {
  execFileSync(process.execPath, [
    fileURLToPath(new URL('../../../node_modules/typescript/bin/tsc', import.meta.url)),
    '--noEmit', '--strict', '--target', 'ES2023', '--module', 'NodeNext', '--moduleResolution', 'NodeNext',
    fileURLToPath(new URL('./judge-assets-types.ts', import.meta.url)),
  ], { encoding: 'utf8' });
});

test('the interpreter\'s own call to the judge carries neither field: its parameters are what they were', async () => {
  const seen = [];
  const result = await runWorkflow(workflow, {}, { runJudge: async (params) => { seen.push(params); return answer; } });
  assert.equal(result.status, 'complete');
  assert.equal(seen.length, 1);
  assert.equal('assets' in seen[0], false);
  assert.equal('model' in seen[0], false);
  assert.deepEqual(Object.keys(seen[0]).sort().filter((key) => !['decisionId', 'executionPath', 'item', 'signal'].includes(key)), ['kind', 'label', 'questions', 'state']);
});

test('what a host puts on a call reaches the judge unchanged: the same bytes, types, references and model', async () => {
  const photo = { bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47]), mime: 'image/png' };
  const scan = { bytes: new Uint8Array([0xff, 0xd8, 0xff]), mime: 'image/jpeg' };
  const assets = { '<photo>': photo, '<scan>': scan };
  const seen = [];
  const judge = async (params) => { seen.push(params); return answer; };
  // A host that asks a judge about images adds them to the interpreter's parameters, as vision.judge does.
  const params = { label: 'look', kind: 'judge', state: 'See <photo> and <scan>.', questions: { ok: { type: 'noul', instructions: 'Is <photo> fine?' } }, assets, model: 'jev-1.14.0' };
  await judge(params);
  assert.equal(seen[0].assets, assets);
  assert.equal(seen[0].assets['<photo>'].bytes, photo.bytes, 'the same Uint8Array, not a copy');
  assert.equal(seen[0].assets['<scan>'].mime, 'image/jpeg');
  assert.equal(seen[0].model, 'jev-1.14.0');
  // And through a decorator over the interpreter's judge, the way a host wraps it: it adds them, the inner judge reads them.
  const inner = [];
  const decorated = (base) => async (call) => base({ ...call, assets, model: 'jev-preview' });
  await runWorkflow(workflow, {}, { runJudge: decorated(async (p) => { inner.push(p); return answer; }) });
  assert.equal(inner[0].assets['<photo>'].bytes, photo.bytes);
  assert.equal(inner[0].model, 'jev-preview');
  assert.equal(inner[0].label, 'fine', 'the interpreter\'s own fields are still there');
});
