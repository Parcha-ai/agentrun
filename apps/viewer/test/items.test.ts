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
import { itemStateOf, resultOf, statesBySha } from '../src/items.ts';
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

// A failed map's finished results, each any JSON value kept once in agentrun.states by its digest (the driver's canonicalHash).
const RESULTS: unknown[] = [state, 'a string', 0, false, ['a', { b: 1 }]];
const resultDocs = RESULTS.map((result) => ({ driver: 'd', sha256: nodeSha(canonicalJson(result)), state: result }));

test('a failed map\'s result is read by its digest, any JSON value, or says why it cannot be', () => {
  const held = statesBySha(resultDocs);
  for (const [index, result] of RESULTS.entries()) assert.deepEqual(resultOf(resultDocs[index]!.sha256, held), { result }, JSON.stringify(result));
  assert.deepEqual(resultOf(resultDocs[1]!.sha256, Object.fromEntries(held)), { result: 'a string' }, 'states as a record too');
  assert.match((resultOf(resultDocs[0]!.sha256, new Map()) as { unreadable: string }).unreadable, /its document [0-9a-f]{64} is missing/);
  assert.match((resultOf(resultDocs[1]!.sha256, statesBySha([{ sha256: resultDocs[1]!.sha256, state: 'another string' }])) as { unreadable: string }).unreadable, /does not match its SHA-256/);
  for (const slot of [null, 'abc', 7, resultDocs[0]!.sha256.toUpperCase()]) assert.deepEqual(resultOf(slot, held), { unreadable: 'not a digest' }, String(slot));
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

test('the bundled code, as the page runs it, rebuilds the same state and reads the same result', () => {
  const context = createContext({ TextEncoder });
  new Script(`${(bundle('items.ts') as { body: string }).body}\nthis.got = { itemStateOf, resultOf, statesBySha };`).runInContext(context);
  const got = (context as { got: { itemStateOf: typeof itemStateOf; resultOf: typeof resultOf; statesBySha: typeof statesBySha } }).got;
  assert.equal(JSON.stringify(got.itemStateOf(item, got.statesBySha([{ sha256: baseSha, state: base }]), PATH)), JSON.stringify({ state }));
  assert.match(JSON.stringify(got.itemStateOf(item, new Map(), PATH)), /is missing/);
  assert.equal(JSON.stringify(got.resultOf(resultDocs[4]!.sha256, got.statesBySha(resultDocs))), JSON.stringify({ result: RESULTS[4] }));
});
