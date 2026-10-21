// Placed frames with no key: a scripted lead asks for the zoom's frames, on local boxes standing in for both sandboxes and with the scripted placer. It checks what a live run rests on: each frame
// is one tool call of the agent whose answer names its environment, its box by label and the line composed from the placement record; the frames the run kept are the ones the answers name; the
// boxes are ended; the result is the picture, and every row of its card cites the tool calls it counts; and the recording holds no dollar figure, no provider id and none of the placer's own
// sentences. Also: Jev through a base URL of the user's, the rates option, and a live run's refusal without its keys.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { demo } from '@parcha/agentrun-harness';
import { NodeExecutionEnv } from '@earendil-works/pi-durable/env/node';
import { err, ok } from '@earendil-works/pi-durable/env';
import { BoxError, jevPlacer } from '@parcha/pi-transport';
import { localBoxes } from '@parcha/pi-transport/box/local';
import { HEAVY_ITERATIONS, scriptedModels } from './placed-frames/fakes.ts';
import { jevBaseUrl, jevModels, leadCatalog, liveParts } from './placed-frames/live.ts';
import { options } from './placed-frames/run.ts';
import { result } from './placed-frames/result.ts';
import { ENVIRONMENTS, factsOf, placedFrames, placedLine, REST, stepOf } from './placed-frames/tools.ts';
import { iterationsOf } from './placed-frames/programs/params.mjs';

const FRAMES = 12;
/** A stand-in for a key: this test's server never checks it, it only reads it back. */
const PLACEHOLDER = ['stand', 'in', 'for', 'a', 'test'].join('-');
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const scratch = async (t) => { const dir = await mkdtemp(join(tmpdir(), 'placed-frames-')); t.after(() => rm(dir, { recursive: true, force: true })); return dir; };
/** Every file under a folder, with its bytes as text. */
const texts = (dir) => readdirSync(dir, { recursive: true, withFileTypes: true }).filter((entry) => entry.isFile()).map((entry) => readFileSync(join(entry.parentPath, entry.name), 'latin1'));

test('the zoom on fakes: the agent asks for one placed tool call a frame, each answer naming its environment, its box by label and the line composed from the record; the picture is the result', { timeout: 300_000 }, async (t) => {
  const tmp = await scratch(t);
  const recording = join(tmp, 'recording');
  const run = await demo({ ...options, argv: ['--record', recording, '--dir', join(tmp, 'run')] });
  assert.deepEqual(run.processes.map((process) => process.outcome?.status), ['complete']);
  assert.deepEqual(run.kills, []);
  // The agent's own calls, as the recording holds them: one `frame` each and one `release`; no judge is asked, and the lead is a model turn.
  const events = readFileSync(join(recording, 'events.jsonl'), 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
  const started = events.filter((event) => event.kind === 'tool_execution_start').map((event) => event.data);
  assert.equal(started.filter((call) => call.toolName === 'frame').length, FRAMES, 'one call a frame');
  assert.equal(started.filter((call) => call.toolName === 'release').length, 1);
  const ledger = readFileSync(join(run.dir, 'ledger.jsonl'), 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
  assert.ok(ledger.some((row) => row.kind === 'model'), 'the lead is a model');
  assert.equal(ledger.filter((row) => row.kind === 'judge').length, 0, 'no judge is asked');

  // Each call's record as the tools kept it beside the frames: the tool, its arguments and its answer.
  const kept = readdirSync(join(run.dir, 'work', 'frames')).filter((name) => name.endsWith('.call.json')).map((name) => JSON.parse(readFileSync(join(run.dir, 'work', 'frames', name), 'utf8')));
  const frames = kept.filter((call) => call.tool === 'frame').map((call) => call.answer).sort((a, b) => a.f - b.f);
  assert.deepEqual(frames.map((frame) => frame.f), [...Array(FRAMES).keys()]);
  const labelOf = {};
  for (const frame of frames) {
    // The script's split, fixed by hand from params.mjs: 80 + 10 f iterations, heavy from 150.
    const heavy = 80 + 10 * frame.f >= 150;
    assert.deepEqual([frame.environment, frame.provider, frame.placed.by], [heavy ? 'modal' : 'daytona', 'local', 'scripted']);
    // Which environment's box is made first depends on which frame's placement answers first, so the labels are not fixed: each environment has one label, the same for every frame placed in it.
    assert.match(frame.box, /^box-[12]$/);
    labelOf[frame.environment] ??= frame.box;
    assert.equal(frame.box, labelOf[frame.environment], 'a box by its label, the same for every frame placed in its environment');
    // The line is the example's own, composed from the record's target, who decided and the score: never the placer's sentence.
    assert.equal(frame.placed.line, heavy ? 'placed on modal: the script judged the frame needs what daytona cannot do (0.90)' : 'placed on daytona: the script judged daytona can do the frame (0.10)');
    assert.equal(frame.placed.need, heavy ? 0.9 : 0.1);
    assert.equal(frame.placed.reason, undefined, 'the placer\'s reason is not carried');
    assert.equal(sha256(readFileSync(join(run.dir, 'work', 'frames', `f${frame.f}.idx`))), frame.sha256, 'the frame kept is the one its answer names');
  }
  const released = kept.find((call) => call.tool === 'release').answer;
  assert.deepEqual(new Set(Object.values(labelOf)), new Set(['box-1', 'box-2']), 'two environments, two labels');
  assert.deepEqual(released.boxes, [...Object.entries(labelOf)].map(([environment, box]) => ({ box, environment, provider: 'local' })).sort((a, b) => a.box.localeCompare(b.box, 'en', { numeric: true })), 'both boxes ended, by the labels the frames carry');
  assert.equal(released.receipts, undefined, 'no receipt without rates');
  for (const environment of ['daytona', 'modal']) assert.deepEqual(readdirSync(join(run.dir, 'boxes', environment)), [], `no ${environment} box is left`);
  // The boxes' own log beside the frames: by label, with when each was made, each command's start and end, and when it ended; no provider id, address or path.
  const boxesText = readFileSync(join(run.dir, 'work', 'frames', 'boxes.json'), 'utf8');
  const log = JSON.parse(boxesText);
  assert.equal(log.format, 'placed-frames.boxes/1');
  assert.deepEqual(log.boxes.map((box) => [box.box, box.provider]), [['box-1', 'local'], ['box-2', 'local']]);
  for (const box of log.boxes) {
    assert.ok(box.created && box.ended && box.created <= box.ended, `${box.box}: made, then ended`);
    assert.equal(box.execs.filter((exec) => exec.what === 'check node').length, 1);
    assert.ok(box.execs.every((exec) => exec.start <= exec.end && exec.exitCode === 0), `${box.box}: every command has its start, end and exit code`);
  }
  assert.equal(log.boxes.flatMap((box) => box.execs).filter((exec) => exec.what.startsWith('tile ')).length, FRAMES * 4, 'four tiles a frame');
  // The ids stay in their own internal file at the root of the run's directory: by label, with the provider's id, never in boxes.json or the recording.
  const ids = JSON.parse(readFileSync(join(run.dir, 'box-ids.internal.json'), 'utf8'));
  assert.ok(!readdirSync(join(run.dir, 'work', 'frames')).some((name) => name.includes('box-ids')), 'not under frames/, which a result may cite or copy');
  assert.deepEqual(Object.keys(ids.boxes), ['box-1', 'box-2']);
  assert.ok(Object.values(ids.boxes).every((box) => box.provider === 'local' && /^local-[0-9a-f]{12}$/.test(box.id)), 'each label maps to its provider id');
  assert.doesNotMatch(boxesText, /local-[0-9a-f]{12}|\/home\/|\/tmp\/|\/var\/|https?:/, 'no provider id, path or address');
  // The agent's own answer says what the results say.
  assert.deepEqual(run.record, { answer: '(scripted) Drew 12 frames: 7 on daytona and 5 on modal.' });

  // The report the host keeps (draft 41): the page the result hook wrote, with every picture and every call it cites. Twelve pictures in a grid, each captioned with its box, its environment and the score,
  // and each citing the frame call that drew it; the sheet below. No dollar figure, no provider id.
  const artifact = JSON.parse(readFileSync(join(recording, 'manifest.json'), 'utf8')).artifact;
  assert.equal(artifact.entry, 'index.html');
  const blobOfFile = (path) => readFileSync(join(recording, 'blobs', `${artifact.files[path]}.${path.slice(path.lastIndexOf('.') + 1)}`));
  const page = blobOfFile('index.html').toString('utf8');
  assert.doesNotMatch(page, /<script|<iframe|<form|\$\s?\d|local-[0-9a-f]{12}|https?:/, 'a page with no script, dollar figure, provider id or outside address');
  const figures = [...page.matchAll(/<figure>([\s\S]*?)<\/figure>/g)].map((match) => match[1]);
  assert.equal(figures.length, FRAMES, 'twelve frames in the grid');
  assert.match(page, /grid-template-columns: repeat\(4,/, 'four to a row');
  for (const [i, figure] of figures.entries()) {
    const src = /<img src="([^"]+)"/.exec(figure)[1];
    assert.equal(src, `frames/frame-${String(i + 1).padStart(2, '0')}.png`, 'in the order of the zoom');
    assert.deepEqual([...blobOfFile(src).subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], `${src} is a PNG the recording holds`);
    const caption = /<figcaption>([\s\S]*?)<\/figcaption>/.exec(figure)[1];
    const call = JSON.parse(blobOfFile(/<a class="cite" href="([^"]+)"/.exec(caption)[1]));
    assert.deepEqual([call.tool, call.args.f], ['frame', i], 'each picture cites the call that drew it');
    const heavy = 80 + 10 * i >= 150;
    assert.match(caption, new RegExp(`<strong>box-[12] \u00b7 ${heavy ? 'modal' : 'daytona'}</strong>`), 'the caption names its box and environment');
    assert.match(caption, new RegExp(`the script's need score ${heavy ? '0\\.90' : '0\\.10'}`), 'and the score of the placement record');
    assert.ok(caption.includes(call.answer.box), 'the caption and the call name one box');
  }
  assert.ok(artifact.files['sheet.png'], 'the sheet is kept with the report');
  assert.equal(spawnSync(process.execPath, ['--no-warnings=ExperimentalWarning', join(import.meta.dirname, '..', 'scripts', 'recording', 'validate.mjs'), recording], { encoding: 'utf8' }).status, 0, 'the recording is valid');

  // The recording: the picture is the result, and it holds no dollar figure and no provider id.
  const manifest = JSON.parse(readFileSync(join(recording, 'manifest.json'), 'utf8'));
  assert.equal(manifest.format, 'agentrun.recording/1');
  assert.deepEqual([manifest.kills, manifest.generations, manifest.placer, manifest.lead], [0, 1, 'a script (no Jev call)', 'a scripted lead (pi-ai faux)']);
  const cited = JSON.parse(readFileSync(join(recording, 'blobs', `${manifest.result.blob}.json`), 'utf8'));
  assert.deepEqual(cited.rows.map((row) => [row.label, row.value]), [['the zoom', `${FRAMES} frames, in order, 4 to a row`], ['daytona', 'frames 1, 2, 3, 4, 5, 6, 7'], ['modal', 'frames 8, 9, 10, 11, 12']]);
  // Grounding: every row cites what it rests on. An environment's row cites each tool call placed there, kept in the recording (its tool, arguments and answer), and the release call;
  // the zoom's row cites the sheet and each frame's own picture, whose hash is the one the frame's answer names for its pixels' picture.
  const blobOf = (hash, extension) => readFileSync(join(recording, 'blobs', `${hash}.${extension}`));
  for (const row of cited.rows.slice(1)) {
    const list = row.value.replace('frames ', '').split(', ').map(Number);
    const calls = row.cites.filter((cite) => /^the call for frame/.test(cite.note));
    assert.deepEqual(calls.map((cite) => JSON.parse(blobOf(cite.blob, 'json')).args.f + 1), list, `${row.label}: one cited call for each frame it counts`);
    for (const cite of calls) {
      const call = JSON.parse(blobOf(cite.blob, 'json'));
      assert.equal(sha256(blobOf(cite.blob, 'json')), cite.blob);
      assert.deepEqual([call.tool, call.answer.environment], ['frame', row.label]);
    }
    const released = row.cites.filter((cite) => cite.note === 'the release call, which names the box');
    assert.equal(released.length, 1);
    assert.ok(JSON.parse(blobOf(released[0].blob, 'json')).answer.boxes.some((box) => box.environment === row.label));
  }
  const pictures = cited.rows[0].cites.slice(1);
  assert.equal(pictures.length, FRAMES, 'the sheet row cites each frame\'s picture');
  for (const [f, cite] of pictures.entries()) {
    assert.equal(sha256(blobOf(cite.blob, 'png')), cite.blob);
    assert.match(cite.note, new RegExp(`^frame ${f + 1}, drawn in box-[12]$`));
  }
  const blob = cited.rows[0].cites[0].blob;
  const picture = readFileSync(join(recording, 'blobs', `${blob}.png`));
  assert.equal(sha256(picture), blob);
  assert.deepEqual([...picture.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 'a PNG');
  const recorded = [readFileSync(join(recording, 'events.jsonl'), 'latin1'), readFileSync(join(recording, 'manifest.json'), 'latin1'), ...texts(join(recording, 'blobs')).filter((text) => !text.startsWith('\x89PNG'))].join('\n');
  assert.doesNotMatch(recorded, /\$\s?\d|usd_per|cost_usd"\s*:\s*\d/, 'no dollar figure');
  assert.doesNotMatch(recorded, /local-[0-9a-f]{12}/, 'no provider id');
  assert.doesNotMatch(recorded, /Moved to|Stays in|Back to|Jev judged the step/, 'the placer\'s own sentence is nowhere in the recording');
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
  process.env.TYPESAFE_API_KEY = PLACEHOLDER;
  t.after(() => { if (before === undefined) delete process.env.TYPESAFE_API_KEY; else process.env.TYPESAFE_API_KEY = before; });
  const placer = await jevPlacer(jevModels(`http://127.0.0.1:${server.address().port}/typesafe`), { provider: 'typesafe', modelId: 'jev-latest' }, { rest: REST, timeoutMs: 10_000 });
  assert.ok(placer.ok, String(placer.error?.message));
  const record = await placer.value.decide({ session: 's', phase: 'message', what: 'hands', current: REST, options: ENVIRONMENTS.map(factsOf), next: stepOf(0, FRAMES) }, BACKGROUND_CONTEXT);
  assert.ok(seen.length >= 1, 'the proxy was asked');
  assert.equal(seen[0].method, 'POST');
  assert.match(seen[0].url, /^\/typesafe\//);
  assert.equal(seen[0].auth, `Bearer ${PLACEHOLDER}`);
  assert.ok(seen[0].body.includes('Draw frame 1 of 12'));
  // A placer that gets no answer keeps the call at rest and says why: never an invented answer.
  assert.deepEqual([record.target, record.moved, record.error?.code], [REST, false, 'classifier']);
  assert.equal(placedLine(record, REST, 'Jev'), 'placed on daytona: Jev gave no answer (classifier), so the frame stays on daytona');
});

test('the placed line is composed from the record\'s fields, whatever the placer wrote as its reason', () => {
  const answers = (need) => ({ need: { type: 'bool', probability: need } });
  const reason = 'Moved to "modal" (the placer\'s own prose): Jev judged the step needs what "daytona" cannot do (0.91).';
  assert.equal(placedLine({ target: 'modal', moved: true, answers: answers(0.91), reason }, 'daytona', 'Jev'), 'placed on modal: Jev judged the frame needs what daytona cannot do (0.91)');
  assert.equal(placedLine({ target: 'daytona', moved: false, answers: answers(0.09), reason }, 'daytona', 'Jev'), 'placed on daytona: Jev judged daytona can do the frame (0.09)');
  assert.doesNotMatch(placedLine({ target: 'modal', moved: true, answers: answers(0.91), reason }, 'daytona', 'Jev'), /Moved to|Stays in|Back to|the step/);
});

test('the judgment line follows the need, apart from where the frame went', () => {
  const answers = (need) => ({ need: { type: 'bool', probability: need } });
  const high = placedLine({ target: 'daytona', moved: false, answers: answers(0.9) }, 'daytona', 'Jev');
  assert.equal(high, 'placed on daytona: Jev judged the frame needs what daytona cannot do (0.90), and chose daytona as the place');
  assert.doesNotMatch(high, /can do the frame/, 'a high need never reads as "can do"');
  assert.equal(placedLine({ target: 'modal', moved: true, answers: answers(0.5) }, 'daytona', 'Jev'), 'placed on modal: Jev judged the frame needs what daytona cannot do (0.50)', 'at the threshold it is a need');
  assert.equal(placedLine({ target: 'daytona', moved: false, answers: answers(0.49) }, 'daytona', 'Jev'), 'placed on daytona: Jev judged daytona can do the frame (0.49)');
});

/** A provider whose boxes fail the upload (the tile program never arrives), and whose first destroys fail `destroyFailures` times. */
function failingSetup(provider, { destroyFailures = 0 } = {}) {
  const counts = { created: 0, destroyed: 0, attempts: 0 };
  let failures = destroyFailures;
  return {
    counts,
    provider: {
      name: provider.name, list: (...args) => provider.list(...args), attach: (...args) => provider.attach(...args),
      async create(...args) {
        const made = await provider.create(...args);
        if (!made.ok) return made;
        counts.created += 1;
        const target = made.value;
        return ok(new Proxy(target, { get(self, key) {
          if (key === 'upload') return async () => err(new BoxError('unknown', 'the upload failed'));
          if (key === 'destroy') return async (context) => { counts.attempts += 1; if (failures > 0) { failures -= 1; return err(new BoxError('unknown', 'the box would not end')); } counts.destroyed += 1; return self.destroy(context); };
          const value = Reflect.get(self, key);
          return typeof value === 'function' ? value.bind(self) : value;
        } }));
      },
    },
  };
}

test('a sandbox whose setup fails is ended, one that cannot be ended is kept for release to end, and nothing is left', async (t) => {
  const tmp = await scratch(t);
  const run = async ({ destroyFailures }) => {
    const work = join(tmp, `work-${destroyFailures}`);
    mkdirSync(work, { recursive: true });
    const flaky = failingSetup(localBoxes({ root: join(tmp, `boxes-${destroyFailures}`), path: `${process.execPath.replace(/\/[^/]+$/, '')}:/usr/bin:/bin` }), { destroyFailures });
    const extension = placedFrames({ providers: () => Object.fromEntries(ENVIRONMENTS.map((environment) => [environment.id, flaky.provider])), models: scriptedModels(), placer: 'scripted' });
    const tool = (name) => extension.tools.find((each) => each.name === name);
    const api = { env: new NodeExecutionEnv({ cwd: work }) };
    await assert.rejects(tool('frame').execute({ f: 0, frames: FRAMES }, api, BACKGROUND_CONTEXT), /the upload failed/);
    return { flaky, tool, api };
  };
  const clean = await run({ destroyFailures: 0 });
  assert.deepEqual([clean.flaky.counts.created, clean.flaky.counts.destroyed], [1, 1], 'a failed setup ends the sandbox it made');
  const released = await clean.tool('release').execute({}, clean.api, BACKGROUND_CONTEXT);
  assert.deepEqual(JSON.parse(released.content[0].text), { boxes: [] }, 'nothing is left for release');
  const stuck = await run({ destroyFailures: 1 });
  assert.deepEqual([stuck.flaky.counts.created, stuck.flaky.counts.destroyed, stuck.flaky.counts.attempts], [1, 0, 1], 'the first attempt to end it failed');
  await stuck.tool('release').execute({}, stuck.api, BACKGROUND_CONTEXT);
  assert.deepEqual([stuck.flaky.counts.destroyed, stuck.flaky.counts.attempts], [1, 2], 'release tried again, and it ended');
  const hopeless = await run({ destroyFailures: 5 });
  await assert.rejects(hopeless.tool('release').execute({}, hopeless.api, BACKGROUND_CONTEXT), /would not end/, 'a sandbox that will not end fails the release, so the run is not taken for finished');
});

test('a run that stopped short is not published as finished: an omitted frame and an omitted release are refused', async (t) => {
  const tmp = await scratch(t);
  const drawn = (frames, omit, withRelease) => {
    const dir = join(tmp, `run-${frames}-${omit.join('')}-${withRelease}`);
    const framesDir = join(dir, 'work', 'frames');
    mkdirSync(framesDir, { recursive: true });
    for (let f = 0; f < frames; f += 1) {
      if (omit.includes(f)) continue;
      const environment = f < 2 ? 'daytona' : 'modal';
      writeFileSync(join(framesDir, `f${f}.idx`), Buffer.alloc(192 * 108));
      writeFileSync(join(framesDir, `f${f}.call.json`), JSON.stringify({ tool: 'frame', args: { f, frames }, answer: { f, environment, provider: 'local', box: environment === 'daytona' ? 'box-1' : 'box-2', placed: { by: 'scripted', need: 0.1, line: 'x' } } }));
    }
    if (withRelease) writeFileSync(join(framesDir, 'release.call.json'), JSON.stringify({ tool: 'release', args: {}, answer: { boxes: [{ box: 'box-1', environment: 'daytona', provider: 'local' }, { box: 'box-2', environment: 'modal', provider: 'local' }] } }));
    return dir;
  };
  const keep = () => 'a'.repeat(64);
  assert.ok(result({ answer: 'done' }, { dir: drawn(4, [], true), keep }).json, 'a whole run is published');
  assert.throws(() => result({ answer: 'done' }, { dir: drawn(4, [2], true), keep }), /the run is incomplete: frame 3 not drawn/);
  assert.throws(() => result({ answer: 'done' }, { dir: drawn(4, [1, 3], true), keep }), /frames 2, 4 not drawn/);
  assert.throws(() => result({ answer: 'done' }, { dir: drawn(4, [], false), keep }), /the release call was never answered/);
});

test('rates are an option: with them each box ends with its receipt; without them there is none', async (t) => {
  const tmp = await scratch(t);
  const run = async (rates) => {
    const work = join(tmp, `work-${Boolean(rates)}`);
    mkdirSync(work, { recursive: true });
    const extension = placedFrames({ providers: () => Object.fromEntries(ENVIRONMENTS.map((environment) => [environment.id, localBoxes({ root: join(tmp, String(Boolean(rates)), environment.id), path: `${process.execPath.replace(/\/[^/]+$/, '')}:/usr/bin:/bin` })])), models: scriptedModels(), placer: 'scripted', ...(rates ? { rates } : {}) });
    const tool = (name) => extension.tools.find((each) => each.name === name);
    const api = { env: new NodeExecutionEnv({ cwd: work }) };
    await tool('frame').execute({ f: 0, frames: FRAMES }, api, BACKGROUND_CONTEXT);
    await tool('frame').execute({ f: 11, frames: FRAMES }, api, BACKGROUND_CONTEXT);
    const released = await tool('release').execute({}, api, BACKGROUND_CONTEXT);
    assert.deepEqual(released.content, released.output, 'the answer is in both the content and the output');
    return JSON.parse(released.content[0].text);
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

test('the lead is a key away: Gemini\'s own, or a gateway that serves it and passes Jev through at /typesafe/v1', () => {
  assert.throws(() => leadCatalog({}), /--live needs GEMINI_API_KEY/);
  assert.throws(() => leadCatalog({ VIDEO_MODEL_BASE_URL: 'http://gateway.example/v1' }), /needs VIDEO_MODEL_API_KEY/);
  assert.ok(leadCatalog({ VIDEO_MODEL_BASE_URL: 'http://gateway.example/v1', VIDEO_MODEL_API_KEY: 'x' }));
  assert.equal(jevBaseUrl({ VIDEO_MODEL_BASE_URL: 'http://gateway.example/v1' }), 'http://gateway.example/typesafe/v1');
  assert.equal(jevBaseUrl({ TYPESAFE_BASE_URL: 'https://proxy.example/v1' }), 'https://proxy.example/v1');
  assert.equal(jevBaseUrl({}), undefined);
});

test('a live run with every provider key but no lead is refused before any box is made', async () => {
  const keys = { DAYTONA_API_KEY: 'x', MODAL_TOKEN_ID: 'x', MODAL_TOKEN_SECRET: 'x', TYPESAFE_API_KEY: 'x' };
  await assert.rejects(liveParts({ env: keys }), /--live needs GEMINI_API_KEY/);
});
