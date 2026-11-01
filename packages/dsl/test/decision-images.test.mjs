// Images on decision nodes: `images` maps a token the state or a question names to an image reference, resolved like a
// state value (inside a map, from the item). The host's loadImage reads each one before the provider is asked, and the
// receipt names every image by digest, never by bytes, with the state the judge saw (64 KB at most).
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DECISION_STATE_MAX_BYTES, judgeFromProvider, judgeFromProviders, runWorkflow, validateWorkflow,
} from '../dist/index.js';
import { workflowGraph } from '../dist/graph.js';

const PNG = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64'));
const SCHEMAS = {
  Input: { type: 'object', required: ['docs'], properties: { docs: { type: 'array' } } },
  Any: { type: 'object' },
  Seal: { type: 'object', required: ['sealed'], properties: { sealed: { type: 'boolean', description: 'Does the page <page1> carry a seal?' } } },
};
const judge = (extra = {}) => ({ node: 'judge', label: 'seal', state: { name: '{item.name}', page: '<page1>' }, out: 'Seal', as: 'verdict', images: { '<page1>': '{item.pages.0.image}' }, ...extra });
const flow = (body, map = {}) => ({
  v: 2, name: 'images', schemas: SCHEMAS, input: { schemaId: 'Input' }, output: { schemaId: 'Any' },
  root: { node: 'map', label: 'each', itemsPath: 'docs', as: 'verdicts', resultPath: 'verdict', body, ...map },
});
const DOCS = [{ name: 'Acme', pages: [{ page: 1, image: 'pages/acme/1.png' }] }, { name: 'Brill', pages: [{ page: 1, image: 'pages/brill/1.png' }] }];

/** A provider that takes images and answers yes, keeping what it was asked. */
function imageProvider(over = {}) {
  const asked = [];
  return {
    asked,
    provider: { id: 'jev', needs: [], capabilities: { types: ['noul', 'choice', 'score'], inputs: ['text', 'json', 'image'], evidence: 'none', probability: 'model', grounding: false, replay: 'never', maxQuestions: null, maxStateBytes: null, ...over },
      decide: async (request) => {
        asked.push(request);
        return { answers: Object.fromEntries(Object.keys(request.questions).map((id) => [id, { type: 'noul', noul: 0.8 }])), evidence: [], model: 'jev-test', usage: null, cost_usd: 0.0001, cost_basis: 'estimate', provider_request_id: null };
      } },
  };
}

test('a decision node takes images: a token map whose references resolve like state values, the token named in its state or questions', () => {
  const ok = validateWorkflow(flow(judge()));
  assert.equal(ok.ok, true, ok.errors?.join('\n'));
  const problems = (body) => { const checked = validateWorkflow(flow(body)); return checked.ok ? '' : checked.errors.join('\n'); };
  assert.match(problems(judge({ images: {} })), /images must be a non-empty object map/);
  assert.match(problems(judge({ images: { '<page1>': 3 } })), /images\.<page1> must be an image reference/);
  assert.match(problems(judge({ images: { '<p"1>': '{item.pages.0.image}' } })), /must be plain, non-empty text/);
  assert.match(problems(judge({ images: { '<other>': '{item.pages.0.image}' } })), /images token "<other>" appears in neither/);
  // The token in a question's text is enough.
  assert.equal(problems(judge({ state: { name: '{item.name}' } })), '');
  for (const kind of [
    { node: 'pick', label: 'p', itemsPath: 'item.pages', describe: 'page {item.page}', instructions: 'Which page of <page1> is signed?', as: 'picked', images: { '<page1>': '{item.pages.0.image}' } },
    { node: 'route', label: 'r', state: { page: '<page1>' }, instructions: 'Is it altered?', branches: { yes: { body: { node: 'code', label: 'y', as: 'verdict', code: '() => 1' } }, no: { body: { node: 'code', label: 'n', as: 'verdict', code: '() => 0' } } }, images: { '<page1>': '{item.pages.0.image}' } },
  ]) assert.equal(problems(kind), '', kind.node);
  assert.match(problems({ node: 'route', label: 'r', valuePath: 'item.name', branches: { a: { body: { node: 'code', label: 'y', as: 'verdict', code: '() => 1' } }, b: { body: { node: 'code', label: 'n', as: 'verdict', code: '() => 0' } } }, images: { '<page1>': 'x.png' } }), /images belongs to a route Jev chooses/);
});

test('inside a map each item sends its own image: loaded by the host, sent under its token, and named in the receipt by digest with the state the judge saw', async () => {
  const { provider, asked } = imageProvider();
  const loads = [];
  const receipts = [];
  const runJudge = judgeFromProviders({ providers: { jev: provider }, default: 'jev', loadImage: async (ref) => { loads.push(ref); return { bytes: PNG, mime: 'image/png' }; } });
  const result = await runWorkflow(flow(judge()), { docs: DOCS }, { runJudge, decisionProviders: { providers: { jev: provider }, default: 'jev' }, recordDecision: async (receipt) => { receipts.push(receipt); } });
  assert.equal(result.status, 'complete');
  assert.deepEqual(loads.sort(), ['pages/acme/1.png', 'pages/brill/1.png']);
  assert.deepEqual(asked.map((r) => [r.state.name, r.images['<page1>'].ref, r.images['<page1>'].mime, r.images['<page1>'].bytes.byteLength]).sort(), [['Acme', 'pages/acme/1.png', 'image/png', PNG.byteLength], ['Brill', 'pages/brill/1.png', 'image/png', PNG.byteLength]]);
  assert.equal(receipts.length, 2);
  for (const receipt of receipts) {
    const doc = DOCS[receipt.item];
    assert.deepEqual(receipt.images.map(({ token, ref, mime, bytes }) => ({ token, ref, mime, bytes })), [{ token: '<page1>', ref: doc.pages[0].image, mime: 'image/png', bytes: PNG.byteLength }]);
    assert.match(receipt.images[0].sha256, /^[0-9a-f]{64}$/);
    assert.deepEqual([receipt.state, receipt.state_truncated], [{ name: doc.name, page: '<page1>' }, false]);
    assert.ok(!JSON.stringify(receipt).includes(Buffer.from(PNG).toString('base64')), 'no bytes in the receipt');
  }
});

test('the decision id names the images by reference: another image is another decision, and a node without images keeps its id', async () => {
  const ids = async (body, docs = DOCS) => {
    const { provider } = imageProvider();
    const receipts = [];
    await runWorkflow(flow(body), { docs }, { runJudge: judgeFromProvider(provider, { loadImage: async () => ({ bytes: PNG, mime: 'image/png' }) }), recordDecision: async (r) => { receipts.push(r); } });
    return receipts.sort((a, b) => a.item - b.item).map((r) => r.id);
  };
  const plain = await ids(judge({ images: undefined, state: { name: '{item.name}' } }));
  const imaged = await ids(judge());
  const moved = await ids(judge(), DOCS.map((d) => ({ ...d, pages: [{ page: 1, image: `moved/${d.pages[0].image}` }] })));
  assert.notDeepEqual(plain, imaged);
  assert.notDeepEqual(imaged, moved);
});

test('a state over 64 KB is kept in the receipt as its first 64 KB of JSON text, marked truncated', async () => {
  const { provider } = imageProvider();
  const receipts = [];
  const big = 'x'.repeat(DECISION_STATE_MAX_BYTES + 10);
  await runWorkflow(flow(judge({ state: { name: '{item.name}', page: '<page1>', text: big } })), { docs: DOCS.slice(0, 1) }, { runJudge: judgeFromProvider(provider, { loadImage: async () => ({ bytes: PNG, mime: 'image/png' }) }), recordDecision: async (r) => { receipts.push(r); } });
  assert.equal(receipts[0].state_truncated, true);
  assert.equal(typeof receipts[0].state, 'string');
  assert.equal(Buffer.byteLength(receipts[0].state), DECISION_STATE_MAX_BYTES);
});

test('a provider without image input is refused before the run for a node with images, and through the seam before anything is sent', async () => {
  const { provider, asked } = imageProvider({ inputs: ['text', 'json'] });
  const deps = { runJudge: judgeFromProvider(provider, { loadImage: async () => ({ bytes: PNG, mime: 'image/png' }) }), decisionProviders: { providers: { jev: provider }, default: 'jev' } };
  await assert.rejects(runWorkflow(flow(judge()), { docs: DOCS }, deps), /sends images, and the decision provider jev takes no image input/);
  await assert.rejects(judgeFromProvider(provider, { loadImage: async () => ({ bytes: PNG, mime: 'image/png' }) })({ label: 'x', kind: 'judge', state: '<p>', questions: { q: { type: 'noul', instructions: 'Q?' } }, images: { '<p>': 'a.png' } }), (error) => error.code === 'invalid_request');
  assert.equal(asked.length, 0);
});

test('an image reference that resolves to no string fails the item, and a collecting map goes on', async () => {
  const { provider } = imageProvider();
  const docs = [DOCS[0], { name: 'Nopage', pages: [{ page: 1, image: null }] }];
  const result = await runWorkflow(flow(judge(), { onItemFailure: 'collect', failedAs: 'failed' }), { docs }, { runJudge: judgeFromProvider(provider, { loadImage: async () => ({ bytes: PNG, mime: 'image/png' }) }) });
  assert.equal(result.status, 'complete');
  assert.deepEqual(result.state.verdicts, [{ sealed: true }, null]);
  assert.equal(result.state.failed[0].item_index, 1);
  assert.match(result.state.failed[0].message, /image <page1> resolves to null/);
});

test('workflowGraph names each decision node\'s provider, model, questions and image tokens', () => {
  const graph = workflowGraph(flow(judge({ provider: 'jev', model: 'jev-1.14' })));
  const node = graph.nodes.find((n) => n.kind === 'judge');
  assert.deepEqual([node.provider, node.model, node.images], ['jev', 'jev-1.14', ['<page1>']]);
  assert.deepEqual(node.questions, [{ id: 'sealed', type: 'noul', instructions: 'Does the page <page1> carry a seal?' }]);
  const map = graph.nodes.find((n) => n.kind === 'map');
  assert.deepEqual([map.provider, map.questions, map.images], [undefined, undefined, undefined]);
  const route = workflowGraph({ v: 2, name: 'r', schemas: SCHEMAS, output: { schemaId: 'Any' }, root: { node: 'route', label: 'r', provider: 'openrouter', model: 'liquid/d1', state: { a: 1 }, instructions: 'Which?', branches: { yes: { body: { node: 'code', label: 'y', code: '() => 1' } }, no: { body: { node: 'code', label: 'n', code: '() => 0' } } } } });
  assert.deepEqual(route.nodes[0], { ...route.nodes[0], provider: 'openrouter', model: 'liquid/d1', questions: [{ id: 'branch', type: 'choice', instructions: 'Which?', options: ['yes', 'no'] }] });
});

test('inspectWorkflow names a decision node\'s provider, model and image tokens', async () => {
  const { inspectWorkflow } = await import('../dist/index.js');
  const node = inspectWorkflow(flow(judge({ provider: 'openrouter', model: 'liquid/d1' }))).nodes.find((n) => n.kind === 'judge');
  assert.deepEqual([node.provider, node.model, node.images], ['openrouter', 'liquid/d1', ['<page1>']]);
});
