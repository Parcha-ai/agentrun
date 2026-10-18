// The gallery's search index: what it carries for each demo and from where, what it leaves out, and every problem that
// keeps a demo out of it. Each test builds a small repository of its own: the real demo.json schemas, two workspace
// packages, a gallery demo with its recording beside it, and a demo that is not the gallery's.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { CATEGORIES, FORMAT, galleryIndex, modelsOf, needsOf, RECORDING_LIMIT } from './index.mjs';

const repo = new URL('../../', import.meta.url).pathname;
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const PNG = Buffer.from('a still frame, as the recording keeps it');
const POSTER = sha(PNG);
const key = (env, why, required = true) => ({ env, why, where: 'its provider', required, for: 'live' });
const KEYS = [
  { oneOf: [key('OPENAI_API_KEY', 'the lead'), key('GEMINI_API_KEY', 'the eyes'), [key('GATEWAY_URL', 'a gateway'), key('GATEWAY_KEY', 'its key')]], why: 'a model', for: 'live' },
  key('TYPESAFE_API_KEY', 'Jev'),
  key('FAL_KEY', 'optional', false),
];
const DEMO = {
  name: 'film-demo', title: 'A Film, Read', claim: 'One agent reads a film.', summary: 'One agent finds the second a thing is first seen in a film, and its box.',
  category: 'vision', tags: ['video', 'apollo-11'], extensions: ['@parcha/pi-vision', '@parcha/agentrun-jev'], author: 'octocat',
  poster: { blob: POSTER }, run: 'npx @parcha/agentrun-reference@<version> run examples/film-demo --live', keys: KEYS, panels: ['vision'],
  models: { lead: { needs: ['text', 'tools'], default: 'openai/gpt-6-luna' } }, programs: [], expectedCalls: 10, expectedCost: 0.1,
};
const MANIFEST = {
  format: 'agentrun.recording/1', title: 'A Film, Read', task: 'film-demo', model: 'openai/gpt-6-luna', models: { lead: 'openai/gpt-6-luna', eyes: 'google/gemini-3.8-flash', jev: 'jev-1.14.0' },
  recorded: { started: '2026-10-18T08:00:00.000Z', ended: '2026-10-18T08:00:15.395Z' },
  code: { repo: 'agentrun', commit: 'abc1234', packages: { '@earendil-works/pi-durable': '1.1.0', '@earendil-works/pi-ai': '1.1.0' } },
  generations: 1, kills: 0, cost: { usd: 0.12, parts: { lead: 0.12 } }, providers: 'real', source: { run: 'run-1', store_sha256: 'a'.repeat(64) },
};
const LINES = [
  { channel: 'live', source: 'host', kind: 'process.started', t: 0, seq: 0, data: { gen: 1 } },
  { channel: 'durable', source: 'workflow', kind: 'agentrun.driver', gen: 1, t: 1, commit: 1, order: 0, data: { generation: 1 } },
  { channel: 'live', source: 'vision', kind: 'EvidenceRecord', gen: 1, t: 2, seq: 0, data: { label: 'frame' }, blobs: [POSTER] },
];

/** A repository of its own: `demos` by folder, each `{ demo, manifest, lines, blobs }` (a demo with no manifest has no recording). */
function repository(t, { demos = { 'film-demo': {} }, featured = ['film-demo'], packages = ['@parcha/pi-vision', '@parcha/agentrun-jev'] } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'gallery-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'examples'), { recursive: true });
  for (const file of ['demo.schema.json', 'demo-spec.schema.json']) cpSync(join(repo, 'examples', file), join(root, 'examples', file));
  for (const name of packages) { mkdirSync(join(root, 'packages', name.split('/')[1]), { recursive: true }); writeFileSync(join(root, 'packages', name.split('/')[1], 'package.json'), JSON.stringify({ name })); }
  writeFileSync(join(root, 'examples', 'gallery.json'), JSON.stringify({ featured }));
  for (const [name, over] of Object.entries(demos)) {
    const folder = join(root, 'examples', name);
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, 'demo.json'), JSON.stringify(over.demo ?? { ...DEMO, name }));
    if (over.manifest === null) continue;
    const dir = join(folder, over.demo?.recording ?? 'recording');
    mkdirSync(join(dir, 'blobs'), { recursive: true });
    writeFileSync(join(dir, 'manifest.json'), JSON.stringify(over.manifest ?? { ...MANIFEST, task: name }));
    writeFileSync(join(dir, 'events.jsonl'), `${(over.lines ?? LINES).map((line) => JSON.stringify(line)).join('\n')}\n`);
    for (const [file, bytes] of Object.entries(over.blobs ?? { [`${POSTER}.png`]: PNG })) writeFileSync(join(dir, 'blobs', file), bytes);
  }
  return root;
}

test('a demo\'s index entry: what its author wrote from demo.json, what its run measured from its manifest, and no cost or counter', (t) => {
  const { problems, index } = galleryIndex(repository(t, { demos: { 'film-demo': {}, plain: { demo: { name: 'plain', title: 'Not In It', claim: 'A demo with no category.', keys: [], models: {}, programs: [], expectedCalls: 0, expectedCost: 0 }, manifest: null } } }), { commit: 'c0ffee', version: '0.1.0-beta.16' });
  assert.deepEqual(problems, []);
  assert.equal(index.format, FORMAT);
  assert.equal(index.repository, 'https://github.com/Parcha-ai/agentrun');
  assert.deepEqual([index.commit, index.version], ['c0ffee', '0.1.0-beta.16']);
  assert.deepEqual(index.demos.map((demo) => demo.id), ['film-demo'], 'a demo.json with no category is not the gallery\'s');
  const [demo] = index.demos;
  assert.deepEqual(demo, {
    id: 'film-demo', title: 'A Film, Read', summary: DEMO.summary, category: 'vision', tags: ['video', 'apollo-11'], extensions: ['@parcha/pi-vision', '@parcha/agentrun-jev'], author: 'octocat',
    featured: 1, poster: `replay/recordings/film-demo/blobs/${POSTER}.png`, replay: 'replay/?r=film-demo&embed=1&hide=durability', page: 'demo/film-demo/', source: 'examples/film-demo',
    run: 'npx @parcha/agentrun-reference@0.1.0-beta.16 run examples/film-demo --live',
    needs: [{ any: ['OPENAI_API_KEY', 'GEMINI_API_KEY', ['GATEWAY_URL', 'GATEWAY_KEY']] }, 'TYPESAFE_API_KEY'],
    providers: 'real', models: ['openai/gpt-6-luna', 'google/gemini-3.8-flash', 'jev-1.14.0'], date: '2026-10-18', duration_ms: 15395,
    search: 'a film, read one agent finds the second a thing is first seen in a film, and its box. vision vision video apollo-11 @parcha/pi-vision @parcha/agentrun-jev openai/gpt-6-luna google/gemini-3.8-flash jev-1.14.0 octocat',
  });
  assert.doesNotMatch(JSON.stringify(index), /cost|kills|generations|usd/, 'no cost and no counter anywhere');
  assert.deepEqual(index.categories, [{ ...CATEGORIES[0], count: 1 }], 'a category with no demo is not listed');
  assert.deepEqual(index.tags, [{ id: 'apollo-11', count: 1 }, { id: 'video', count: 1 }]);
  assert.deepEqual(index.extensions.map((each) => each.name), ['@parcha/agentrun-jev', '@parcha/pi-vision']);
  assert.deepEqual(index.featured, ['film-demo']);
  assert.deepEqual(galleryIndex(repository(t), { commit: 'c0ffee', version: '0.1.0-beta.16' }).index.demos, galleryIndex(repository(t), { commit: 'c0ffee', version: '0.1.0-beta.16' }).index.demos, 'the same input, the same index');
});

test('featured first in the maintainers\' order, then the newest, then by id', (t) => {
  const at = (day) => ({ ...MANIFEST, recorded: { started: `2026-10-${day}T08:00:00.000Z`, ended: `2026-10-${day}T08:00:01.000Z` } });
  const demos = { alpha: { manifest: at('10') }, beta: { manifest: at('12') }, gamma: { manifest: at('11') }, delta: { manifest: at('09') } };
  const { problems, index } = galleryIndex(repository(t, { demos, featured: ['delta', 'alpha'] }));
  assert.deepEqual(problems, []);
  assert.deepEqual(index.demos.map((demo) => [demo.id, demo.featured]), [['delta', 1], ['alpha', 2], ['beta', null], ['gamma', null]]);
});

test('every problem that keeps a demo out of the gallery is named, where it is', (t) => {
  const bad = (over, message) => {
    const { problems } = galleryIndex(repository(t, over));
    assert.ok(problems.some((problem) => message.test(problem)), `${message}: ${problems.join(' | ')}`);
  };
  bad({ demos: { 'film-demo': { demo: { ...DEMO, summary: undefined } } } }, /film-demo\/demo\.json: \/ must have properties summary, .* when property category is present/);
  bad({ demos: { 'film-demo': { demo: { ...DEMO, category: 'cooking' } } } }, /film-demo\/demo\.json: \/category must be equal to one of the allowed values/);
  bad({ demos: { 'film-demo': { demo: { ...DEMO, run: 'npx agentrun replay examples/film-demo' } } } }, /film-demo\/demo\.json: \/run must match pattern/);
  bad({ demos: { 'film-demo': { demo: { ...DEMO, name: 'other' } } } }, /name is "other", but the example's folder is film-demo/);
  bad({ demos: { 'film-demo': {} }, packages: ['@parcha/pi-vision'] }, /extension @parcha\/agentrun-jev is not a package of this repository's workspace/);
  bad({ demos: { 'film-demo': { demo: { ...DEMO, poster: { blob: 'b'.repeat(64) } } } } }, /poster b{64} is not a blob of the recording/);
  bad({ demos: { 'film-demo': { blobs: { [`${POSTER}.json`]: PNG } } } }, /poster .*\.json is not a PNG, JPEG or WebP picture/);
  bad({ demos: { 'film-demo': { demo: { ...DEMO, recording: 'nowhere' }, manifest: null } } }, /examples\/film-demo\/nowhere: is not a recording: it has no manifest\.json/);
  bad({ demos: { 'film-demo': { manifest: { ...MANIFEST, generations: 2 } } } }, /examples\/film-demo\/recording\/manifest\.json: generations is 2, but the recording has 1 host process\.started lines/);
  bad({ demos: { 'film-demo': { manifest: { ...MANIFEST, store: { blob: 'c'.repeat(64), at: { gen: 1, commit: 1 } } } } } }, /carries the run's store, which the gallery does not publish/);
  bad({ demos: { 'film-demo': { blobs: { [`${POSTER}.png`]: PNG, 'notes.txt': `sk-${'a1'.repeat(20)}` } } } }, /examples\/film-demo\/recording\/.*notes\.txt: contains a/);
  bad({ featured: ['film-demo', 'missing'] }, /examples\/gallery\.json: featured "missing" is no gallery demo/);
  const big = Buffer.alloc(RECORDING_LIMIT + 1);
  bad({ demos: { 'film-demo': { blobs: { [`${POSTER}.png`]: PNG, [`${sha(big)}.bin`]: big } } } }, new RegExp(`examples/film-demo/recording: is \\d+ bytes, over the ${RECORDING_LIMIT} a recording may publish`));
});

test('a live run\'s needs are key names: a required key, a choice of any one, a set of keys taken together; never a value', () => {
  assert.deepEqual(needsOf(KEYS), [{ any: ['OPENAI_API_KEY', 'GEMINI_API_KEY', ['GATEWAY_URL', 'GATEWAY_KEY']] }, 'TYPESAFE_API_KEY']);
  assert.deepEqual(needsOf([{ env: 'X', required: true, for: 'scripted' }]), [], 'a key the scripted path alone needs is no live need');
  assert.deepEqual(needsOf(undefined), [], 'no key: "No key"');
  assert.deepEqual(modelsOf({ model: 'a/b', models: { lead: 'a/b', eyes: 'c/d', caps: 3 } }), ['a/b', 'c/d']);
});
