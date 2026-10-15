// The shared rebuild of a v4 run's map items (RECORDING.md draft 26) and its parts: the page's SHA-256 against
// node:crypto on the JSON a state's digest is taken over, the DSL's itemState through the helper panels use, and the build
// that inlines the DSL's module from its source, only while it imports nothing.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { createContext, Script } from 'node:vm';
// @ts-expect-error: the build script is plain JavaScript
import { bundle, checkModule, DSL_ITEM_STATE } from '../build.mjs';
import { canonicalJson, stateDelta } from '../../../packages/dsl/src/recovery/item-state.ts';
import { itemStateOf, partialResultsOf, statesBySha } from '../src/items.ts';
import { sha256Hex } from '../src/sha256.ts';

const nodeSha = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
const STATES: Record<string, unknown>[] = [
  {}, { a: 1 }, { b: [1, 2, { z: null, y: 'x' }], a: 'é 世界 🙂' }, { long: 'x'.repeat(1000) },
  { n: 1.5e300, small: -0.000001, t: true, f: false, s: 'a "quote" and a \\ backslash' }, { nested: { deeper: { deepest: [[], {}, ''] } } },
];

test('the page\'s SHA-256 is node\'s, on the JSON a state\'s digest is taken over and at every padding boundary', () => {
  for (const state of STATES) assert.equal(sha256Hex(canonicalJson(state)), nodeSha(canonicalJson(state)), canonicalJson(state).slice(0, 40));
  for (const length of [0, 1, 55, 56, 57, 63, 64, 65, 119, 120, 128, 1000]) assert.equal(sha256Hex('a'.repeat(length)), nodeSha('a'.repeat(length)), `${length} bytes`);
});

// A map item against its base, as the driver writes them (the DSL's own stateDelta and canonicalJson, node's SHA-256).
const PATH = '/root/steps/0/items/1/body';
const base = { query: 'acme', found: [] as string[] };
const state = { query: 'acme', found: ['registry'], kept: 1 };
const baseSha = nodeSha(canonicalJson(base));
const itemOf = (delta: object) => ({ base: baseSha, frame: { states: { [PATH]: delta } } });
const item = itemOf(stateDelta(base, state, nodeSha(canonicalJson(state))));
const states = statesBySha([{ driver: 'd', sha256: baseSha, state: base }, { not: 'a state' }]);

test('a v4 item\'s state rebuilds through the DSL\'s itemState with the page\'s SHA-256, or says why it cannot', () => {
  assert.deepEqual(itemStateOf(item, states, PATH), { state });
  assert.match((itemStateOf(item, new Map(), PATH) as { unreadable: string }).unreadable, /its base [0-9a-f]{64} is missing/);
  assert.match((itemStateOf(item, statesBySha([{ sha256: baseSha, state: { query: 'other' } }]), PATH) as { unreadable: string }).unreadable, /its base does not match its SHA-256/);
  assert.match((itemStateOf(itemOf(stateDelta(base, state, '0'.repeat(64))), states, PATH) as { unreadable: string }).unreadable, /does not rebuild to its SHA-256/);
  assert.match((itemStateOf(item, states, '/root/steps/9') as { unreadable: string }).unreadable, /keeps no state at \/root\/steps\/9/);
});

// A failed map's pin.partial: v3 keeps its results inline; v4 keeps one digest, of an agentrun.states list of each
// result's digest (null for an item that never finished), each result any JSON value (the driver's canonicalHash).
const RESULTS: unknown[] = [state, 'a string', 0, false, ['a', { b: 1 }]];
const resultDocs = RESULTS.map((result) => ({ driver: 'd', sha256: nodeSha(canonicalJson(result)), state: result }));
const slots = [resultDocs[0]!.sha256, null, ...resultDocs.slice(1).map((doc) => doc.sha256)];
const listDoc = { driver: 'd', sha256: nodeSha(canonicalJson(slots)), state: slots };
const v4 = { path: '/root/steps/0/map', as: 'found', results: listDoc.sha256 };
const read = [{ result: RESULTS[0] }, null, ...RESULTS.slice(1).map((result) => ({ result }))];
const unreadable = (slot: unknown) => (slot as { unreadable: string }).unreadable;

test('a failed map\'s results, through the DSL\'s partialResults: inline in v3; in v4 a list read by its digest, then each slot', () => {
  const held = statesBySha([...resultDocs, listDoc]);
  assert.deepEqual(partialResultsOf(v4, held), { slots: read });
  assert.deepEqual(partialResultsOf(v4, Object.fromEntries(held)), { slots: read }, 'states as a record too');
  assert.deepEqual(partialResultsOf({ ...v4, results: [RESULTS[0], null, 'x'] }, new Map()), { slots: [{ result: RESULTS[0] }, null, { result: 'x' }] }, 'v3: inline, nothing looked up');
  // The list missing, mismatched (its slots swapped under the same digest), or not a list of digests: none of it reads.
  assert.match(unreadable(partialResultsOf(v4, statesBySha(resultDocs))), /^the list of results [0-9a-f]{64} is missing$/);
  const swapped = { ...listDoc, state: [slots[2], null, slots[0], ...slots.slice(3)] };
  assert.match(unreadable(partialResultsOf(v4, statesBySha([...resultDocs, swapped]))), /^the list of results [0-9a-f]{64} does not match its SHA-256$/);
  const notList = { driver: 'd', sha256: nodeSha(canonicalJson({ a: 1 })), state: { a: 1 } };
  assert.deepEqual(partialResultsOf({ ...v4, results: notList.sha256 }, statesBySha([notList])), { unreadable: 'the list of results is not a list of digests' });
  assert.deepEqual(partialResultsOf({ path: v4.path, as: v4.as }, held), { unreadable: 'not a failed map\'s results' });
  // A slot whose document is missing or changed is unreadable alone; the others still read.
  const some = partialResultsOf(v4, statesBySha([listDoc, resultDocs[1], { ...resultDocs[4], state: 'changed' }])) as { slots: unknown[] };
  assert.match(unreadable(some.slots[0]), /^the result [0-9a-f]{64} is missing$/);
  assert.equal(some.slots[1], null);
  assert.deepEqual(some.slots[2], { result: RESULTS[1] });
  assert.match(unreadable(some.slots[5]), /^the result [0-9a-f]{64} does not match its SHA-256$/);
});

test('the build inlines the DSL\'s module from its source, and refuses it once it imports anything', () => {
  const built = bundle('items.ts') as { body: string; modules: string[] };
  assert.deepEqual(built.modules, [DSL_ITEM_STATE, 'sha256.ts', 'items.ts']);
  assert.doesNotMatch(built.body, /^\s*import\s/m, 'no import is left in the classic script');
  for (const code of ["import { x } from 'y';\nexport const a = 1;", "export { a } from './b.ts';", 'export const a = () => import("node:crypto");', "const { a } = require('b');"]) {
    assert.throws(() => checkModule(DSL_ITEM_STATE, code), /imports something; the viewer inlines it only while it imports nothing/, code);
  }
  assert.throws(() => checkModule('panel.ts', "import { x } from '../../../packages/dsl/src/workflow.ts';"), /imports a package/, 'no other file outside the viewer');
  assert.doesNotThrow(() => checkModule('panel.ts', `import { itemStateOf } from './items.ts';`));
});

test('the bundled code, as the page runs it, rebuilds the same state and reads the same results', () => {
  const context = createContext({ TextEncoder });
  new Script(`${(bundle('items.ts') as { body: string }).body}\nthis.got = { itemStateOf, partialResultsOf, statesBySha };`).runInContext(context);
  const got = (context as { got: { itemStateOf: typeof itemStateOf; partialResultsOf: typeof partialResultsOf; statesBySha: typeof statesBySha } }).got;
  assert.equal(JSON.stringify(got.itemStateOf(item, got.statesBySha([{ sha256: baseSha, state: base }]), PATH)), JSON.stringify({ state }));
  assert.match(JSON.stringify(got.itemStateOf(item, new Map(), PATH)), /is missing/);
  assert.equal(JSON.stringify(got.partialResultsOf(v4, got.statesBySha([...resultDocs, listDoc]))), JSON.stringify({ slots: read }));
  assert.match(JSON.stringify(got.partialResultsOf(v4, got.statesBySha(resultDocs))), /the list of results [0-9a-f]{64} is missing/);
});
