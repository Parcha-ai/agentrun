// Placed frames with no key: a scripted lead asks for the zoom's frames, on local boxes standing in for both sandboxes and with the scripted placer. It checks what a live run rests on: each frame
// is one tool call of the agent whose answer names its environment, its box by label and the line composed from the placement record; the frames the run kept are the ones the answers name; the
// boxes are ended; the result is the picture, and every row of its card cites the tool calls it counts; and the recording holds no dollar figure, no provider id and none of the placer's own
// sentences. Also: Jev through a base URL of the user's, the rates option, and a live run's refusal without its keys.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { demo } from '@parcha/agentrun-reference';
import { NodeExecutionEnv } from '@earendil-works/pi-durable/env/node';
import { jevPlacer } from '@parcha/pi-transport';
import { localBoxes } from '@parcha/pi-transport/box/local';
import { HEAVY_ITERATIONS, scriptedModels } from './placed-frames/fakes.ts';
import { jevBaseUrl, jevModels, leadCatalog, liveParts } from './placed-frames/live.ts';
import { options } from './placed-frames/run.ts';
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
  for (const frame of frames) {
    // The script's split, fixed by hand from params.mjs: 80 + 10 f iterations, heavy from 150.
    const heavy = 80 + 10 * frame.f >= 150;
    assert.deepEqual([frame.environment, frame.provider, frame.placed.by], [heavy ? 'modal' : 'daytona', 'local', 'scripted']);
    assert.equal(frame.box, heavy ? 'box-2' : 'box-1', 'a box by its label, the same for every frame placed in its environment');
    // The line is the example's own, composed from the record's target, who decided and the score: never the placer's sentence.
    assert.equal(frame.placed.line, heavy ? 'placed on modal: the script judged the frame needs what daytona cannot do (0.90)' : 'placed on daytona: the script judged daytona can do the frame (0.10)');
    assert.equal(frame.placed.need, heavy ? 0.9 : 0.1);
    assert.equal(frame.placed.reason, undefined, 'the placer\'s reason is not carried');
    assert.equal(sha256(readFileSync(join(run.dir, 'work', 'frames', `f${frame.f}.idx`))), frame.sha256, 'the frame kept is the one its answer names');
  }
  const released = kept.find((call) => call.tool === 'release').answer;
  assert.deepEqual(released, { boxes: [{ box: 'box-1', environment: 'daytona', provider: 'local' }, { box: 'box-2', environment: 'modal', provider: 'local' }] }, 'both boxes ended, and no receipt without rates');
  for (const environment of ['daytona', 'modal']) assert.deepEqual(readdirSync(join(run.dir, 'boxes', environment)), [], `no ${environment} box is left`);
  // The agent's own answer says what the results say.
  assert.deepEqual(run.record, { answer: '(scripted) Drew 12 frames: 7 on daytona and 5 on modal.' });

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
