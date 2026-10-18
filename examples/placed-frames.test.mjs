// Placed frames at $0: the zoom on local boxes standing in for both sandboxes, with the scripted placer. It checks what a live run rests on: each frame is one tool call whose
// answer names its environment, its box by label and the placer's reason; the frames the run kept are the ones the answers name; the boxes are ended; the result is the picture;
// and the recording holds no dollar figure and no provider id. Also: Jev through a base URL of the user's, the rates option, and a live run's refusal without its keys.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { demo } from '@parcha/agentrun-reference';
import { jevPlacer } from '@parcha/pi-transport';
import { localBoxes } from '@parcha/pi-transport/box/local';
import { HEAVY_ITERATIONS, scriptedModels } from './placed-frames/fakes.ts';
import { jevModels, liveParts } from './placed-frames/live.ts';
import { options } from './placed-frames/run.ts';
import { ENVIRONMENTS, factsOf, frameTools, REST, stepOf } from './placed-frames/tools.ts';
import { iterationsOf } from './placed-frames/programs/params.mjs';

const FRAMES = 12;
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const scratch = async (t) => { const dir = await mkdtemp(join(tmpdir(), 'placed-frames-')); t.after(() => rm(dir, { recursive: true, force: true })); return dir; };
/** Every file under a folder, with its bytes as text. */
const texts = (dir) => readdirSync(dir, { recursive: true, withFileTypes: true }).filter((entry) => entry.isFile()).map((entry) => readFileSync(join(entry.parentPath, entry.name), 'latin1'));

test('the zoom on fakes: one placed tool call a frame, each answer naming its environment, its box by label and the reason; the picture is the result', { timeout: 300_000 }, async (t) => {
  const tmp = await scratch(t);
  const recording = join(tmp, 'recording');
  const run = await demo({ ...options, argv: ['--record', recording, '--dir', join(tmp, 'run')] });
  assert.deepEqual(run.processes.map((process) => process.outcome?.status), ['complete']);
  assert.deepEqual(run.kills, []);
  const ledger = readFileSync(join(run.dir, 'ledger.jsonl'), 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
  assert.equal(ledger.filter((row) => row.kind === 'tool' && row.name === 'frame').length, FRAMES, 'one call a frame');
  assert.equal(ledger.filter((row) => row.kind === 'tool' && row.name === 'release').length, 1);
  assert.equal(ledger.filter((row) => row.kind === 'model' || row.kind === 'judge').length, 0, 'no model and no judge is asked');

  const answers = readdirSync(join(run.dir, 'answers')).map((name) => JSON.parse(readFileSync(join(run.dir, 'answers', name), 'utf8')).value);
  const frames = answers.filter((value) => typeof value?.f === 'number').sort((a, b) => a.f - b.f);
  assert.deepEqual(frames.map((frame) => frame.f), [...Array(FRAMES).keys()]);
  for (const frame of frames) {
    // The script's split, fixed by hand from params.mjs: 80 + 10 f iterations, heavy from 150.
    const heavy = 80 + 10 * frame.f >= 150;
    assert.deepEqual([frame.environment, frame.provider, frame.placed.by], [heavy ? 'modal' : 'daytona', 'local', 'scripted']);
    assert.equal(frame.box, heavy ? 'box-2' : 'box-1', 'a box by its label, the same for every frame placed in its environment');
    assert.match(frame.placed.reason, heavy ? /^Moved to "modal" .*the script judged/ : /^Stays in "daytona": the script judged/);
    assert.equal(frame.placed.need, heavy ? 0.9 : 0.1);
    assert.equal(sha256(readFileSync(join(run.dir, 'work', 'frames', `f${frame.f}.idx`))), frame.sha256, 'the frame kept is the one its answer names');
  }
  const released = answers.find((value) => Array.isArray(value?.boxes));
  assert.deepEqual(released, { boxes: [{ box: 'box-1', environment: 'daytona', provider: 'local' }, { box: 'box-2', environment: 'modal', provider: 'local' }] }, 'both boxes ended, and no receipt without rates');
  for (const environment of ['daytona', 'modal']) assert.deepEqual(readdirSync(join(run.dir, 'boxes', environment)), [], `no ${environment} box is left`);
  assert.deepEqual(run.record, { frames: FRAMES, placed: { daytona: [1, 2, 3, 4, 5, 6, 7], modal: [8, 9, 10, 11, 12] }, boxes: released.boxes });

  // The recording: the picture is the result, and it holds no dollar figure and no provider id.
  const manifest = JSON.parse(readFileSync(join(recording, 'manifest.json'), 'utf8'));
  assert.equal(manifest.format, 'agentrun.recording/1');
  assert.deepEqual([manifest.kills, manifest.generations, manifest.cost.usd, manifest.placer], [0, 1, null, 'a script (no Jev call)']);
  const cited = JSON.parse(readFileSync(join(recording, 'blobs', `${manifest.result.blob}.json`), 'utf8'));
  assert.deepEqual(cited.rows.map((row) => [row.label, row.value]), [['the zoom', `${FRAMES} frames, in order, 4 to a row`], ['daytona', 'frames 1, 2, 3, 4, 5, 6, 7'], ['modal', 'frames 8, 9, 10, 11, 12']]);
  const blob = cited.rows[0].cites[0].blob;
  const picture = readFileSync(join(recording, 'blobs', `${blob}.png`));
  assert.equal(sha256(picture), blob);
  assert.deepEqual([...picture.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 'a PNG');
  const recorded = [readFileSync(join(recording, 'events.jsonl'), 'latin1'), readFileSync(join(recording, 'manifest.json'), 'latin1'), ...texts(join(recording, 'blobs')).filter((text) => !text.startsWith('\x89PNG'))].join('\n');
  assert.doesNotMatch(recorded, /\$\s?\d|usd_per|cost_usd"\s*:\s*\d/, 'no dollar figure');
  assert.doesNotMatch(recorded, /local-[0-9a-f]{12}/, 'no provider id');
});

test('the placer asks with the frame as numbers only, and the scripted split follows the iterations', () => {
  for (let f = 0; f < FRAMES; f += 1) {
    const step = stepOf(f, FRAMES);
    for (const environment of ENVIRONMENTS) assert.ok(!step.includes(environment.id), `step ${f} names no environment`);
    assert.ok(step.includes(`at ${iterationsOf(f)} iterations per pixel`));
  }
  assert.equal(HEAVY_ITERATIONS, 150);
  assert.deepEqual(ENVIRONMENTS.map(factsOf).map((facts) => [facts.id, facts.cpus]), [['daytona', null], ['modal', 2]]);
  assert.equal(REST, 'daytona');
});

test('live Jev goes to the base URL the user gives (a proxy that passes TypeSafe through), with the key from TYPESAFE_API_KEY', async (t) => {
  const seen = [];
  const server = createServer((request, response) => { let body = ''; request.on('data', (chunk) => { body += chunk; }); request.on('end', () => { seen.push({ method: request.method, url: request.url, auth: request.headers.authorization, body }); response.writeHead(503).end(); }); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const before = process.env.TYPESAFE_API_KEY;
  process.env.TYPESAFE_API_KEY = 'placeholder-key-for-a-test';
  t.after(() => { if (before === undefined) delete process.env.TYPESAFE_API_KEY; else process.env.TYPESAFE_API_KEY = before; });
  const placer = await jevPlacer(jevModels(`http://127.0.0.1:${server.address().port}/typesafe`), { provider: 'typesafe', modelId: 'jev-latest' }, { rest: REST, timeoutMs: 10_000 });
  assert.ok(placer.ok, String(placer.error?.message));
  const record = await placer.value.decide({ session: 's', phase: 'message', what: 'hands', current: REST, options: ENVIRONMENTS.map(factsOf), next: stepOf(0, FRAMES) }, BACKGROUND_CONTEXT);
  assert.ok(seen.length >= 1, 'the proxy was asked');
  assert.equal(seen[0].method, 'POST');
  assert.match(seen[0].url, /^\/typesafe\//);
  assert.equal(seen[0].auth, 'Bearer placeholder-key-for-a-test');
  assert.ok(seen[0].body.includes('Draw frame 1 of 12'));
  // A placer that gets no answer keeps the call at rest and says why: never an invented answer.
  assert.deepEqual([record.target, record.moved, record.error?.code], [REST, false, 'classifier']);
});

test('rates are an option: with them each box ends with its receipt; without them there is none', async (t) => {
  const tmp = await scratch(t);
  const run = async (rates) => {
    const tools = frameTools({ providers: () => Object.fromEntries(ENVIRONMENTS.map((environment) => [environment.id, localBoxes({ root: join(tmp, String(Boolean(rates)), environment.id), path: `${process.execPath.replace(/\/[^/]+$/, '')}:/usr/bin:/bin` })])), models: scriptedModels(), placer: 'scripted', ...(rates ? { rates } : {}) });
    const place = { root: tmp, work: join(tmp, `work-${Boolean(rates)}`) };
    await tools.frame({ f: 0, frames: FRAMES }, { live: false, place });
    await tools.frame({ f: 11, frames: FRAMES }, { live: false, place });
    return tools.release();
  };
  const without = await run(undefined);
  assert.equal(without.receipts, undefined);
  const priced = await run([{ provider: 'local', kind: 'none', usdPerSecond: 0.001, source: 'a test', priced: '2026-10-18' }]);
  assert.deepEqual(priced.receipts.map((receipt) => [receipt.box, receipt.provider, receipt.kind]), [['box-1', 'local', 'none'], ['box-2', 'local', 'none']]);
});

test('a live run without its keys is refused before any box is made, naming the key', async () => {
  await assert.rejects(liveParts({ env: {} }), /--live needs DAYTONA_API_KEY/);
  await assert.rejects(liveParts({ env: { DAYTONA_API_KEY: 'x' } }), /--live needs MODAL_TOKEN_ID/);
});
