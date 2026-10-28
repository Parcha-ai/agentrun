// demo.json's schema: the DemoSpec part generated from its type (regenerating gives the committed file, so the two never
// drift), the template's part listing every field (so a misspelt one is refused), its panels the viewer's own ids, and
// every examples/*/demo.json valid against both.
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import test from 'node:test';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv from 'ajv';
import TJS from 'typescript-json-schema';
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
  // The template is a static schema an editor reads, so it lists the ids itself: a panel the viewer gains fails here, in
  // the pull request that adds it, until the template lists it too.
  const listed = new Set(demo.properties.panels.items.enum);
  const viewer = new Set(panelsShown().map((panel) => panel.id));
  assert.deepEqual([...viewer].filter((id) => !listed.has(id)), [], 'viewer panels examples/demo.schema.json does not list in panels.items.enum');
  assert.deepEqual([...listed].filter((id) => !viewer.has(id)), [], 'ids examples/demo.schema.json lists that are no viewer panel');
});

test('the template lists every field the reference entry\'s own DemoSpec type reads, with its values', () => {
  // examples/reference/demo-spec.ts is the part of demo.json the entry acts on. A field it gains and the schema does not
  // list fails here; the schema may list more (the DSL's DemoSpec, the template's claim, panels and targets).
  const at = fileURLToPath(root);
  const program = TJS.programFromConfig(resolve(at, 'examples/tsconfig.json'), [resolve(at, 'examples/reference/demo-spec.ts')]);
  const typed = TJS.generateSchema(program, 'DemoSpec', { required: true, strictNullChecks: true, ref: false, ignoreErrors: false });
  assert.ok(typed, 'the DemoSpec type gives a schema');
  const listed = (schema, where) => Object.keys(schema.properties ?? {}).forEach((field) => assert.ok(field in where.properties, `${field} is read by the entry and missing from the schema`));
  const enums = (schema, where) => Object.entries(schema.properties ?? {}).forEach(([field, value]) => {
    const values = value.enum ?? (value.anyOf ?? []).flatMap((each) => each.enum ?? ('const' in each ? [each.const] : []));
    if (values.length && where.properties[field]?.enum) assert.deepEqual([...where.properties[field].enum].sort(), [...values].sort(), `${field}'s values`);
  });
  listed(typed, demo);
  const kinds = typed.properties.kills.items.anyOf;
  const crossing = kinds.find((each) => each.properties?.point);
  const storm = kinds.find((each) => each.properties?.storm);
  listed(crossing, demo.definitions.crossingKill);
  enums(crossing, demo.definitions.crossingKill);
  listed(storm, demo.definitions.stormKill);
  enums(storm, demo.definitions.stormKill);
  listed(storm.properties.storm, demo.definitions.stormKill.properties.storm);
  listed(typed.properties.boxes, demo.properties.boxes);
  enums(typed.properties.boxes, demo.properties.boxes);
  listed(typed.properties.input, demo.properties.input);
  // The single `kill` is the entry's alone, and it keeps only what its type has: the schema allows no more, so no
  // setting there is silently dropped.
  listed(typed.properties.kill, demo.properties.kill);
  for (const field of Object.keys(demo.properties.kill.properties)) assert.ok(field in typed.properties.kill.properties, `the schema's kill allows ${field}, which the entry drops`);
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
  kills: [{ point: 'effect.kept search', why: 'mid-call', kind: 'process', target: 'run', n: 2 }, { point: 'transport.tool.started', why: 'mid-install', target: 'tool', where: { tool: 'install', attempt: 1, retry: false } }, { storm: { kills: 3, gapMs: 1000 } }],
  panels: ['workflow-map', 'vision'],
  tools: [{ name: 'landing', local: 'examples/sample/tools/index.ts', hosted: null }],
  input: { flag: '--input', shape: 'examples/sample/workflow.ts, Input', default: { project: 'x' }, variants: {}, fixtures: { spacedeck: 'examples/sample/fixtures/spacedeck' } },
  sources: 'examples/sample/sources.json', boxes: { kind: 'docker', image: 'node:22-slim' },
  browser: true, codeMode: { timeoutMs: 30000, outputChars: 4000 },
  sites: { atlas: { title: 'Atlas', description: 'The project tracker', startUrl: 'https://atlas.example.com/' } },
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
    'a field a kill does not have': { ...sample, kills: [{ point: 'p', why: 'w', holdMs: 6 }] },
    'a single kill with settings the entry drops': { ...sample, kill: { point: 'p', why: 'w', target: 'tool', n: 2 } },
    'a hold that is not a whole number': { ...sample, kills: [{ point: 'vision.filing', why: 'w', hold: 1.5 }] },
    'sources from the root of the disk': { ...sample, sources: '/srv/sources.json' },
    'sources out of the demo\'s directory': { ...sample, sources: '../other/sources.json' },
    'sources that are not a JSON file': { ...sample, sources: 'sources.txt' },
    'a browser that is not true or false': { ...sample, browser: 'chrome' },
    'a code mode field that does not exist': { ...sample, codeMode: { timeout: 5 } },
    'a site with no start': { ...sample, sites: { atlas: { title: 'Atlas', description: 'd' } } },
    'a site whose start is not a web address': { ...sample, sites: { atlas: { title: 'Atlas', description: 'd', startUrl: 'atlas' } } },
    'a where with no fields': { ...sample, kills: [{ point: 'p', why: 'w', where: {} }] },
    'a where whose value is not a string, number or boolean': { ...sample, kills: [{ point: 'p', why: 'w', where: { tool: ['install'] } }] },
    'a where that is a list': { ...sample, kills: [{ point: 'p', why: 'w', where: [{ tool: 'install' }] }] },
    'a storm with a where': { ...sample, kills: [{ storm: { kills: 2, gapMs: 0 }, where: { tool: 'install' } }] },
    'hosted with a tool that has no hosted source': { ...sample, targets: ['local', 'hosted'] },
    'a title of one word': { ...sample, title: 'Sample' },
    'a box of an unknown kind': { ...sample, boxes: { kind: 'vm' } },
    'a capture that is not under fixtures/': { ...sample, input: { ...sample.input, fixtures: { spacedeck: 'examples/sample/elsewhere/spacedeck' } } },
    'a capture whose name is not a name': { ...sample, input: { ...sample.input, fixtures: { 'Space Deck': 'examples/sample/fixtures/spacedeck' } } },
    'fixtures as a key, not a map of captures': { ...sample, input: { ...sample.input, fixtures: { key: { project: 'x' } } } },
  };
  for (const [what, value] of Object.entries(wrong)) assert.notDeepEqual(problems(value), [], what);
  assert.deepEqual(problems({ ...sample, targets: ['local', 'hosted'], tools: [{ name: 'landing', local: 'a.ts', hosted: 'landing' }] }), [], 'hosted when every tool has a hosted source');
  // The reference entry's forms: sources beside the demo, or a path from its directory; code mode as a switch; a parking kill.
  for (const sources of [true, false, 'sources.json', 'data/sources.json']) assert.deepEqual(problems({ ...sample, sources }), [], `sources ${JSON.stringify(sources)}`);
  assert.deepEqual(problems({ ...sample, codeMode: true, browser: false }), []);
  assert.deepEqual(problems({ ...sample, kills: [{ point: 'vision.filing', why: 'several kept', hold: 3, waitMs: 3000 }] }), []);
});
