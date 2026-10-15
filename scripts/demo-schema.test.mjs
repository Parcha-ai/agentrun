// demo.json's schema: the DemoSpec part generated from its type (regenerating gives the committed file, so the two never
// drift), the template's part listing every field (so a misspelt one is refused), its panels the viewer's own ids, and
// every examples/*/demo.json valid against both.
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import test from 'node:test';
import Ajv from 'ajv';
import { generated, output } from './generate-demo-schema.mjs';
import { panelsShown } from '../apps/viewer/src/panels.ts';
import '../apps/viewer/src/app.ts';

const root = new URL('../', import.meta.url);
const read = (path) => JSON.parse(readFileSync(new URL(path, root), 'utf8'));
const spec = read('examples/demo-spec.schema.json');
const demo = read('examples/demo.schema.json');
const validate = new Ajv({ allErrors: true }).addSchema(spec).compile(demo);
const problems = (value) => (validate(value) ? [] : validate.errors.map((error) => `${error.instancePath || '/'} ${error.message}`));

test('the DemoSpec schema is what its type gives', () => {
  assert.equal(readFileSync(output, 'utf8'), generated(), 'run node scripts/generate-demo-schema.mjs');
});

test('the template lists every DemoSpec field, so a misspelt one is refused, and its panels are the viewer\'s own ids', () => {
  for (const key of Object.keys(spec.properties)) assert.ok(key in demo.properties, `${key} is a DemoSpec field the template does not list`);
  assert.deepEqual([...demo.properties.panels.items.enum].sort(), panelsShown().map((panel) => panel.id).sort());
});

test('every examples/*/demo.json is a valid demo', () => {
  const dirs = readdirSync(new URL('examples/', root), { withFileTypes: true }).filter((entry) => entry.isDirectory() && existsSync(new URL(`examples/${entry.name}/demo.json`, root)));
  for (const { name } of dirs) assert.deepEqual(problems(read(`examples/${name}/demo.json`)), [], `examples/${name}/demo.json`);
});

const key = (env) => ({ env, why: 'a fake key', where: 'nowhere', required: true });
const sample = {
  name: 'sample', title: 'A sample demo', claim: 'One agent does a job and survives a kill.',
  models: { lead: { needs: ['text', 'tools'], default: 'openai/model' }, judge: { jev: true } },
  keys: [{ ...key('FAKE_A_KEY'), for: 'live' }, { oneOf: [key('FAKE_B_KEY'), [key('FAKE_C_KEY'), key('FAKE_C_PROJECT')]], why: 'one provider' }],
  programs: [{ cmd: 'node', why: 'runs it', required: true, min: '22.19.0' }],
  expectedCalls: 10, expectedCost: 0.1, targets: ['local'],
  kills: [{ point: 'effect.kept search', why: 'mid-call', kind: 'process', target: 'run', n: 2 }, { storm: { kills: 3, gapMs: 1000 } }],
  panels: ['workflow-map', 'vision'],
  tools: [{ name: 'landing', local: 'examples/sample/tools/index.ts', hosted: null }],
  input: { flag: '--input', shape: 'examples/sample/workflow.ts, Input', default: { project: 'x' }, variants: {}, fixtures: { spacedeck: 'examples/sample/fixtures/spacedeck' } },
  sources: 'examples/sample/sources.json', boxes: { kind: 'docker', image: 'node:22-slim' },
};

test('a whole demo.json is valid, and each kind of mistake is refused', () => {
  assert.deepEqual(problems(sample), []);
  const wrong = {
    'a misspelt field': { ...sample, panel: ['vision'] },
    'a panel the viewer does not have': { ...sample, panels: ['workflow'] },
    'a DemoSpec field missing': (({ expectedCost: _cost, ...rest }) => rest)(sample),
    'a key with no where': { ...sample, keys: [{ env: 'FAKE_A_KEY', why: 'w', required: true }] },
    'a kill target that is not run or tool': { ...sample, kills: [{ point: 'p', why: 'w', target: 'box' }] },
    'a storm with no gap': { ...sample, kills: [{ storm: { kills: 2 } }] },
    'a field a kill does not have': { ...sample, kills: [{ point: 'p', why: 'w', hold: 6 }] },
    'hosted with a tool that has no hosted source': { ...sample, targets: ['local', 'hosted'] },
    'a title of one word': { ...sample, title: 'Sample' },
    'a box of an unknown kind': { ...sample, boxes: { kind: 'vm' } },
    'a capture that is not under fixtures/': { ...sample, input: { ...sample.input, fixtures: { spacedeck: 'examples/sample/elsewhere/spacedeck' } } },
    'a capture whose name is not a name': { ...sample, input: { ...sample.input, fixtures: { 'Space Deck': 'examples/sample/fixtures/spacedeck' } } },
    'fixtures as a key, not a map of captures': { ...sample, input: { ...sample.input, fixtures: { key: { project: 'x' } } } },
  };
  for (const [what, value] of Object.entries(wrong)) assert.notDeepEqual(problems(value), [], what);
  assert.deepEqual(problems({ ...sample, targets: ['local', 'hosted'], tools: [{ name: 'landing', local: 'a.ts', hosted: 'landing' }] }), [], 'hosted when every tool has a hosted source');
});
