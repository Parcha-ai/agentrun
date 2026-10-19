// the demo's inputs and sources: --input captures, --fetch-sources, sourcesFor, the environment a live child gets and the manifest hook.
// One of the files the reference entry's demo tests are split into (each under about two minutes serial on CI); the shared helpers are in reference-demo-helpers.mjs.
// The reference entry as a demo's platform (item A of the entry brief): the spec's kills list through the supervisor (a named crossing, a storm, a box kind),
// --input, --max-usd, the browser choice, and the box the job's tools run in. The demo here is the reference job itself, started through demo-fixture.ts.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { appendFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fold, readEvents } from '../scripts/recording/fold.mjs';
import { validateRecording } from '../scripts/recording/validate.mjs';
import { effectiveBoxes } from '../packages/reference/dist/demo-spec.js';
import { BOX_CROSSINGS, localPlace, capJudge, chooseBrowser, crossings, demo, tapBox, JEV_CAPS, JEV_LIST_PRICE, jevCost, killsOf, maxUsdOf, parseInput, plansOf } from '@parcha/agentrun-reference';
import { ORIGINAL, FIXTURE, BASELINE, run, composeHost, destroyBoxes, meterKnown, RUN_LABEL, localBoxes, ctx, finish, lines, planFor, recordingPlace, specWith, SITES, signInHome, filesIn, killSpec, boxed } from './reference-demo-helpers.mjs';

test('a kill of kind box is written as a box kill, and the process\'s box is taken away with it', { timeout: 300_000 }, async (t) => {
  const { result, recording } = await run(t, { boxes: { kind: 'local', runIn: true }, kills: [{ point: 'judge.asked verdict', why: 'the machine goes with the process', kind: 'box' }] }, ['--kill', '--json']);
  assert.equal(result.processes.at(-1).outcome.status, 'complete', JSON.stringify(result.processes.at(-1)));
  assert.deepEqual(result.kills.map((kill) => kill.kind), ['box']);
  const kill = readEvents(recording).find((line) => line.source === 'host' && line.kind === 'kill');
  assert.equal(kill.data.kind, 'box');
  assert.deepEqual(validateRecording(recording), []);
});
test('--fetch-sources: the entry fetches the demo\'s sources.json into the run\'s work/ before the job runs, and a no-key run without the flag does not', { timeout: 300_000 }, async (t) => {
  const { createServer } = await import('node:http');
  const { createHash } = await import('node:crypto');
  const body = 'a checked scan';
  const asked = [];
  // Only the file's own path counts: on a shared machine a stray probe of this port is not the entry's request.
  const server = createServer((request, response) => { if (request.url === '/files/scan.png') asked.push(request.url); response.end(body); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const tmp = await mkdtemp(join(tmpdir(), 'reference-sources-'));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const file = join(tmp, 'sources.json');
  writeFileSync(file, JSON.stringify({ items: [{ id: 'scan-1', url: `http://127.0.0.1:${server.address().port}/files/scan.png`, bytes: body.length, sha256: createHash('sha256').update(body).digest('hex') }] }));
  const plain = await run(t, { sources: file }, ['--json']);
  assert.equal(plain.result.processes.at(-1).outcome.status, 'complete');
  assert.deepEqual(asked, [], 'a no-key run uses the files the demo commits: nothing fetched');
  const fetched = await run(t, { sources: file }, ['--json', '--fetch-sources', '--cache', join(tmpdir(), `reference-cache-${process.pid}-${Date.now()}`)]);
  assert.equal(fetched.result.processes.at(-1).outcome.status, 'complete');
  assert.deepEqual(asked, ['/files/scan.png']);
  assert.equal(readFileSync(join(fetched.result.dir, 'work', 'scan-1.png'), 'utf8'), body);
});
test('sourcesFor: only the items the input needs are fetched (--fetch-sources); without the flag a run that lacks their files is refused in one line, and names the fix', { timeout: 300_000 }, async (t) => {
  const { createServer } = await import('node:http');
  const { createHash } = await import('node:crypto');
  const bodies = { '/a-1.png': 'default company page', '/o-1.png': 'other company page' };
  const asked = [];
  const server = createServer((request, response) => { if (request.url in bodies) asked.push(request.url); response.end(bodies[request.url] ?? 'x'); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const tmp = await mkdtemp(join(tmpdir(), 'reference-sourcesfor-'));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const items = Object.entries(bodies).map(([path, body]) => ({ id: path.slice(1, 4), url: `http://127.0.0.1:${server.address().port}${path}`, bytes: body.length, sha256: createHash('sha256').update(body).digest('hex') }));
  writeFileSync(join(tmp, 'items.json'), JSON.stringify(items));
  const cache = join(tmp, 'cache');
  const fetched = await run(t, {}, ['--json', '--fetch-sources', '--cache', cache], { DEMO_SOURCES_ITEMS: join(tmp, 'items.json') });
  assert.equal(fetched.result.processes.at(-1).outcome.status, 'complete');
  assert.deepEqual(asked, ['/a-1.png'], 'the default company\'s item only');
  assert.equal(readFileSync(join(fetched.result.dir, 'work', 'a-1.png'), 'utf8'), 'default company page');
  // Again with the cache: nothing asked.
  asked.length = 0;
  await run(t, {}, ['--json', '--fetch-sources', '--cache', cache], { DEMO_SOURCES_ITEMS: join(tmp, 'items.json') });
  assert.deepEqual(asked, [], 'served from the cache');
  // Without the flag, no-key: the files must be committed; the refusal is one line naming the fix.
  const refused = await run(t, {}, ['--json'], { DEMO_SOURCES_ITEMS: join(tmp, 'items.json') });
  const outcome = refused.result.processes.at(-1).outcome;
  assert.equal(outcome.status, 'error');
  assert.match(outcome.message, /^this input needs 1 source file\(s\) a no-key run does not have \(a-1\.png\): run with --fetch-sources, or --live$/);
});
test('the result hook: the entry writes the result line and its blob from what the demo makes (agentrun.cited/1), not from the raw record', { timeout: 300_000 }, async (t) => {
  const { result, recording } = await run(t, {}, ['--json'], { DEMO_RESULT: '1' });
  assert.equal(result.processes.at(-1).outcome.status, 'complete');
  assert.deepEqual(validateRecording(recording), []);
  const manifest = JSON.parse(readFileSync(join(recording, 'manifest.json'), 'utf8'));
  assert.equal(manifest.result.title, 'A cited result');
  const cited = JSON.parse(readFileSync(join(recording, 'blobs', `${manifest.result.blob}.json`), 'utf8'));
  assert.equal(cited.format, 'agentrun.cited/1');
  assert.equal(cited.rows[0].value, 'Acme Ltd');
  assert.ok(readFileSync(join(recording, 'blobs', `${cited.rows[0].cites[0].blob}.txt`), 'utf8') === 'a cited file', 'keep() stored the file in the recording\'s blobs');
  const line = readEvents(recording).find((entry) => entry.source === 'host' && entry.kind === 'result');
  assert.equal(line.data.title, 'A cited result');
});
test('--input <name> runs a capture from input.fixtures: a name not in the map is refused with the known captures, and a path outside fixtures/ is refused', async (t) => {
  const { mkdirSync, writeFileSync: write, rmSync } = await import('node:fs');
  const fixtures = new URL('./reference/fixtures/', import.meta.url);
  const capture = new URL('./other-ltd.json', fixtures);
  const spec = { input: { fixtures: { 'other-ltd': 'examples/reference/fixtures/other-ltd.json', 'acme-ltd': 'examples/reference/fixtures/acme-ltd.json' } } };
  // A name that is not a capture, on fakes: refused, and the refusal lists the captures there are.
  await assert.rejects(() => run(t, spec, ['--json', '--input', 'nobody']), (error) => /--input nobody is not a capture of reference/.test(error.message) && /The captures are: other-ltd, acme-ltd\./.test(error.message) && /--live/.test(error.message));
  await assert.rejects(() => run(t, {}, ['--json', '--input', 'nobody']), /It has none/);
  // A capture in the map whose file is not there says where to put it.
  await assert.rejects(() => run(t, spec, ['--json', '--input', 'other-ltd']), /examples\/reference\/fixtures\/other-ltd\.json, which does not exist/);
  // A path outside this demo's fixtures/ is refused, whatever it names.
  for (const path of ['examples/reference/job.ts', 'examples/other/fixtures/x.json', 'examples/reference/fixtures/../job.ts', '/etc/passwd']) await assert.rejects(() => run(t, { input: { fixtures: { escape: path } } }, ['--json', '--input', 'escape']), /not a path under examples\/reference\/fixtures\//, path);
  // The job's own input and an inline object need no capture.
  const own = await run(t, spec, ['--json', '--input', '{"company":"Acme Ltd"}']);
  assert.equal(own.result.processes.at(-1).outcome.status, 'complete');
  // With its fixture in place, the name runs the job on it.
  mkdirSync(fixtures, { recursive: true });
  write(capture, '{"company":"Other Ltd"}');
  t.after(() => { rmSync(capture, { force: true }); try { rmSync(fixtures); } catch { /* not empty or gone */ } });
  const other = await run(t, spec, ['--json', '--input', 'other-ltd']);
  assert.equal(other.result.record.company, 'Other Ltd');
});
test('a live child gets exactly the environment names demo.json declares (keys, oneOf members, programs) and nothing undeclared; its live vision is built from the host and the running run like the fakes\'', { timeout: 300_000 }, async (t) => {
  const { declaredEnv } = await import('../packages/reference/dist/demo-spec.js');
  const keys = [
    { oneOf: [{ env: 'OPENAI_API_KEY', required: true }, { env: 'GEMINI_API_KEY' }] },
    { env: 'TYPESAFE_API_KEY', required: true },
    { oneOf: [[{ env: 'BROWSERBASE_API_KEY' }, { env: 'BROWSERBASE_PROJECT_ID' }], { env: 'CHROME_PATH' }] },
  ];
  assert.deepEqual([...declaredEnv({ name: 'x', keys, programs: [{ name: 'chrome', env: 'CHROME_BIN' }] })].sort(), ['BROWSERBASE_API_KEY', 'BROWSERBASE_PROJECT_ID', 'CHROME_BIN', 'CHROME_PATH', 'GEMINI_API_KEY', 'OPENAI_API_KEY', 'TYPESAFE_API_KEY']);
  // Values are made up from the names, so no literal that looks like a credential is in the source.
  const secrets = Object.fromEntries(['OPENAI_API_KEY', 'TYPESAFE_API_KEY', 'BROWSERBASE_API_KEY', 'BROWSERBASE_PROJECT_ID', 'GITHUB_TOKEN', 'UNDECLARED_SECRET', 'ANTHROPIC_API_KEY'].map((name) => [name, `value-for-${name.toLowerCase()}`]));
  // The test fixture's own settings are declared like any other name the child may see (`programs`), so the rule is exact.
  const programs = [{ name: 'fixture spec', env: 'DEMO_SPEC' }, { name: 'fixture probe', env: 'DEMO_LIVE_PROBE' }];
  const { result } = await run(t, { keys, programs }, ['--json', '--live'], { DEMO_LIVE_PROBE: '1', DEMO_SPEC_NOTE: 'also not declared', ...secrets });
  assert.equal(result.processes.at(-1).outcome.status, 'complete', JSON.stringify(result.processes.at(-1)));
  const seen = JSON.parse(readFileSync(join(result.dir, 'env-seen.json'), 'utf8'));
  for (const name of ['OPENAI_API_KEY', 'TYPESAFE_API_KEY', 'BROWSERBASE_API_KEY', 'BROWSERBASE_PROJECT_ID', 'PATH']) assert.ok(seen.includes(name), `${name} reaches the child`);
  for (const name of ['GITHUB_TOKEN', 'UNDECLARED_SECRET', 'ANTHROPIC_API_KEY', 'DEMO_SPEC_NOTE']) assert.ok(!seen.includes(name), `${name} was not declared and does not reach a live child`);
  assert.deepEqual(JSON.parse(readFileSync(join(result.dir, 'live-vision.json'), 'utf8')), { hasHost: true, harnessUndefinedAtBuild: true, input: { company: 'Acme Ltd' }, place: { root: result.dir, work: join(result.dir, 'work') } }, 'live vision gets (host, running, { input, place }) like fakes.vision');
  const givenLive = await run(t, { keys, programs }, ['--json', '--live', '--input', '{"company":"Gamma Ltd"}'], { DEMO_LIVE_PROBE: '1', ...secrets });
  assert.deepEqual(JSON.parse(readFileSync(join(givenLive.result.dir, 'live-vision.json'), 'utf8')).input, { company: 'Gamma Ltd' }, 'live sees --input too');
});
test('the manifest hook adds fields, the run is named by the input file, and --see-also links finished recordings by name', { timeout: 300_000 }, async (t) => {
  const tmp = await mkdtemp(join(tmpdir(), 'reference-manifest-'));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const earlier = join(tmp, 'weak-eyes-pass');
  mkdirSync(earlier);
  writeFileSync(join(earlier, 'manifest.json'), JSON.stringify({ title: 'A weak-eyes pass', format: 'agentrun.recording/1', recorded: { started: '2026-10-16T00:00:00.000Z', ended: '2026-10-16T00:01:00.000Z' } }));
  writeFileSync(join(earlier, 'events.jsonl'), '');
  writeFileSync(join(tmp, 'apollo-11.json'), '{"company":"Acme Ltd"}');
  const first = await run(t, {}, ['--json', '--input', join(tmp, 'apollo-11.json'), '--see-also', earlier], { DEMO_MANIFEST: '1' });
  const manifest = JSON.parse(readFileSync(join(first.recording, 'manifest.json'), 'utf8'));
  assert.deepEqual(manifest.sources, [{ file: 'a.pdf', sha256: 'ab' }]);
  assert.deepEqual(manifest.models, { lead: 'x' });
  assert.equal(manifest.source.run, 'reference-apollo-11');
  assert.deepEqual(manifest.see_also, [{ recording: 'weak-eyes-pass', label: 'A weak-eyes pass' }], 'linked by name, not by the path on this machine');
  assert.equal(manifest.format, 'agentrun.recording/1');
  const plain = await run(t, {}, ['--json']);
  const bare = JSON.parse(readFileSync(join(plain.recording, 'manifest.json'), 'utf8'));
  assert.equal(bare.source.run, 'reference');
  assert.ok(!('see_also' in bare));
  await assert.rejects(() => run(t, {}, ['--json'], { DEMO_MANIFEST: 'reserved' }), /"source" is written by the entry/);
  await assert.rejects(() => run(t, {}, ['--json', '--see-also', join(tmp, 'nope')]), /not a finished recording/);
  // A manifest with only a title is no recording: it has no format, no end and no lines.
  const titled = join(tmp, 'titled');
  mkdirSync(titled);
  writeFileSync(join(titled, 'manifest.json'), JSON.stringify({ title: 'Earlier pass' }));
  await assert.rejects(() => run(t, {}, ['--json', '--see-also', titled]), /not a finished recording/);
});
test('fakes.input is the no-key default (--input still wins), the models the live parts chose reach manifest(), and a refused child\'s reason is in the summary', { timeout: 300_000 }, async (t) => {
  const smaller = await run(t, {}, ['--json'], { DEMO_FAKES_INPUT: '1' });
  assert.equal(smaller.result.record.company, 'Beta Ltd', 'no --input: the fakes\' input');
  const named = await run(t, {}, ['--json', '--input', '{"company":"Gamma Ltd"}'], { DEMO_FAKES_INPUT: '1' });
  assert.equal(named.result.record.company, 'Gamma Ltd', '--input wins');
  // Live: the job's own input is the default, and manifest() is told what the live parts chose.
  const programs = [{ name: 'fixture spec', env: 'DEMO_SPEC' }, { name: 'fixture probe', env: 'DEMO_LIVE_PROBE' }];
  const keys = [[{ env: 'BROWSERBASE_API_KEY' }, { env: 'BROWSERBASE_PROJECT_ID' }]];
  const browser = Object.fromEntries(['BROWSERBASE_API_KEY', 'BROWSERBASE_PROJECT_ID'].map((name) => [name, `value-for-${name.toLowerCase()}`]));
  const live = await run(t, { keys, programs }, ['--json', '--live'], { DEMO_LIVE_PROBE: '1', DEMO_FAKES_INPUT: '1', DEMO_MANIFEST: 'models', ...browser });
  assert.equal(live.result.processes.at(-1).outcome.status, 'complete');
  assert.equal(live.result.record.company, 'Acme Ltd', 'live: the job\'s own input, not the fakes\'');
  assert.deepEqual(JSON.parse(readFileSync(join(live.recording, 'manifest.json'), 'utf8')).chosen, { lead: 'chosen-lead', eyes: 'chosen-eyes' });
  assert.equal(JSON.parse(readFileSync(join(live.recording, 'manifest.json'), 'utf8')).model, 'chosen-lead', 'a live recording names the lead model the run chose, not "live"');
  // The summary says why a child stopped.
  const lines = [];
  const log = console.log;
  console.log = (...args) => lines.push(args.join(' '));
  try {
    const tmp = await mkdtemp(join(tmpdir(), 'reference-stopped-'));
    t.after(() => rm(tmp, { recursive: true, force: true }));
    writeFileSync(join(tmp, 'items.json'), JSON.stringify([{ id: 'a-1', url: 'http://127.0.0.1:1/a-1.png', bytes: 1, sha256: 'a'.repeat(64) }]));
    await run(t, {}, [], { DEMO_SOURCES_ITEMS: join(tmp, 'items.json'), DEMO_FAKES_INPUT: '', DEMO_LIVE_PROBE: '', DEMO_MANIFEST: '' });
  } finally { console.log = log; }
  assert.ok(lines.some((line) => /^  stopped: this input needs 1 source file\(s\)/.test(line)), lines.join('\n'));
});
test('a directory a run already used keeps its identity: a demo whose name differs from the saved run\'s resumes it under the saved name', { timeout: 300_000 }, async (t) => {
  const tmp = await mkdtemp(join(tmpdir(), 'reference-identity-'));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const dir = join(tmp, 'run');
  const first = await run(t, {}, ['--json', '--dir', dir]);
  assert.equal(first.result.processes.at(-1).outcome.status, 'complete');
  const saved = JSON.parse(readFileSync(join(dir, 'run.json'), 'utf8')).run;
  assert.match(saved, /^reference/, 'the run is named for its demo (and an invocation)');
  // The same directory again, by a demo of another name (a directory saved before the run was named for its demo): it is not refused, and stays what it was.
  const again = await run(t, { name: 'another-demo' }, ['--json', '--dir', dir]);
  assert.equal(again.result.processes.at(-1).outcome.status, 'complete', JSON.stringify(again.result.processes.at(-1)));
  assert.equal(JSON.parse(readFileSync(join(dir, 'run.json'), 'utf8')).run, saved, 'resumed under the saved name');
});
