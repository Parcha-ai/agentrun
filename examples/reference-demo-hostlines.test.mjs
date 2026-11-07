// the host lines a place's status gives (box.receipt) and a box place's recording brought home.
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
import { effectiveBoxes } from '../packages/harness/dist/demo-spec.js';
import { BOX_CROSSINGS, localPlace, priceJudge, chooseBrowser, crossings, demo, tapBox, JEV_LIST_PRICE, jevCost, killsOf, maxUsdOf, parseInput, plansOf } from '@parcha/agentrun-harness';
import { ORIGINAL, FIXTURE, BASELINE, run, composeHost, destroyBoxes, meterKnown, RUN_LABEL, localBoxes, ctx, finish, lines, planFor, recordingPlace, specWith, SITES, signInHome, filesIn, killSpec, boxed } from './reference-demo-helpers.mjs';

// ---- host lines from the place --------------------------------------------------------------------------------------------------------------

test('a place\'s signals may end with signals-failed or throw: a signals.failed host line, the attempt ends as after a failed kill, nothing ends the supervisor; and a message holds no absolute path outside the run\'s directory', { timeout: 300_000 }, async (t) => {
  const tmp = await mkdtemp(join(tmpdir(), 'reference-signals-failed-'));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const file = join(tmp, 'spec.json');
  Object.assign(process.env, { DEMO_SPEC: file });
  t.after(() => { for (const name of Object.keys(process.env)) if (!(name in ORIGINAL)) delete process.env[name]; Object.assign(process.env, ORIGINAL); });
  const unhandled = [];
  const onUnhandled = (reason) => unhandled.push(reason);
  process.on('unhandledRejection', onUnhandled);
  t.after(() => process.off('unhandledRejection', onUnhandled));
  const hostLines = (recording, kind) => readEvents(recording).filter((line) => line.source === 'host' && line.kind === kind);
  // A message: a path outside the run\'s directory becomes <path>, the run\'s own stays, and it is capped at 240 characters.
  const { messageOf } = await import('../packages/harness/dist/demo.js');
  assert.equal(messageOf(new Error('cannot reach /srv/elsewhere/x and /run/root/store/run.sqlite at http://host/a/b'), '/run/root'), 'cannot reach <path> and /run/root/store/run.sqlite at http://host/a/b');
  assert.equal(messageOf('/run/root and /run/rootless', '/run/root'), '/run/root and <path>');
  assert.equal(messageOf('x'.repeat(500), '/run/root').length, 240);
  // A path outside the run is replaced whole: a folder with a space in its name, and a Windows drive path.
  const aliceHome = ['', 'home', 'alice'].join('/');
  assert.equal(messageOf(`could not read ${aliceHome}/Private Documents/report.txt now`, '/run/root'), 'could not read <path> now');
  assert.equal(messageOf('could not read C:\\Users\\alice\\private.txt, giving up', '/run/root'), 'could not read <path>, giving up');
  assert.equal(messageOf('could not read C:\\Users\\alice\\My Files\\x.txt now', '/run/root'), 'could not read <path> now');
  // kill.failed: the same scrub.
  writeFileSync(file, JSON.stringify({ name: 'reference', kills: [{ point: 'judge.asked verdict', why: 'asked through the place' }] }));
  const { options } = await import(`${FIXTURE}?options=${Date.now()}`);
  const killRecording = join(tmp, 'kill-recording');
  const failedKill = await demo({ ...options, argv: ['--kill', '--json', '--record', killRecording], place: ({ paths, self, destroyBoxes, requestFile }) => {
    const inner = localPlace({ self, paths, destroyBoxes, requestFile });
    return { ...inner, kill: async (runner, kind) => { await inner.kill(runner, kind); throw Object.assign(new Error(`cannot reach /srv/elsewhere/x and ${paths.root}/store/run.sqlite`), { code: 'S3_GONE' }); } };
  } });
  assert.deepEqual(failedKill.failedKills.map((entry) => entry.code), ['S3_GONE']);
  assert.equal(hostLines(killRecording, 'kill.failed')[0].data.message, `cannot reach <path> and ${failedKill.dir}/store/run.sqlite`);
  // signals-failed: the iterator ends with it.
  writeFileSync(file, JSON.stringify({ name: 'reference' }));
  const { options: plain } = await import(`${FIXTURE}?options=${Date.now()}`);
  const endedRecording = join(tmp, 'ended-recording');
  const ended = await demo({ ...plain, argv: ['--json', '--record', endedRecording], place: ({ paths, self, destroyBoxes, requestFile }) => ({
    ...localPlace({ self, paths, destroyBoxes, requestFile }),
    signals: () => ({ [Symbol.asyncIterator]() { let done = false; return { next: async () => (done ? { done: true, value: undefined } : (done = true, { done: false, value: { kind: 'signals-failed', code: 'S3_DOWN', message: `the reader lost /srv/elsewhere/x under ${paths.root}/signals` } })), return: async () => ({ done: true, value: undefined }) }; } }),
  }) });
  assert.deepEqual(ended.failedSignals, [{ gen: 1, code: 'S3_DOWN' }]);
  assert.deepEqual(hostLines(endedRecording, 'signals.failed').map((line) => [line.data.gen, line.data.code, line.data.message]), [[1, 'S3_DOWN', `the reader lost <path> under ${ended.dir}/signals`]]);
  assert.equal(ended.processes.length, 1, 'the attempt ended as after a failed kill: no further process');
  assert.equal(hostLines(endedRecording, 'kill').length, 0);
  // A reader that throws: the same line, and the supervisor is fine.
  const threwRecording = join(tmp, 'threw-recording');
  const threw = await demo({ ...plain, argv: ['--json', '--record', threwRecording], place: ({ paths, self, destroyBoxes, requestFile }) => ({
    ...localPlace({ self, paths, destroyBoxes, requestFile }),
    signals: () => ({ [Symbol.asyncIterator]() { return { next: async () => { throw Object.assign(new Error('the reader threw at /srv/elsewhere/y'), { code: 'BOOM' }); }, return: async () => ({ done: true, value: undefined }) }; } }),
  }) });
  assert.deepEqual(threw.failedSignals, [{ gen: 1, code: 'BOOM' }]);
  assert.deepEqual(hostLines(threwRecording, 'signals.failed').map((line) => [line.data.code, line.data.message]), [['BOOM', 'the reader threw at <path>']]);
  assert.deepEqual(unhandled, [], 'nothing in the pump ended the supervisor');
  assert.deepEqual(validateRecording(threwRecording), []);
});
test('a place with recordHome: the child writes its recording inside the place, the supervisor brings it home each tick and once final before the manifest, blobs first, and the recording validates', { timeout: 300_000 }, async (t) => {
  const tmp = await mkdtemp(join(tmpdir(), 'reference-recordhome-'));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const file = join(tmp, 'spec.json');
  writeFileSync(file, JSON.stringify({ name: 'reference' }));
  Object.assign(process.env, { DEMO_SPEC: file, DEMO_RESULT: '1' });
  t.after(() => { for (const name of Object.keys(process.env)) if (!(name in ORIGINAL)) delete process.env[name]; Object.assign(process.env, ORIGINAL); });
  const { options } = await import(`${FIXTURE}?options=${Date.now()}`);
  const calls = [];
  const recording = join(tmp, 'recording');
  const result = await demo({ ...options, argv: ['--json', '--record', recording], place: boxed(tmp, { calls }) });
  assert.equal(result.processes.at(-1).outcome.status, 'complete');
  assert.ok(calls.length >= 1 && calls.at(-1).final === true, 'the last call is the final one');
  assert.ok(calls.every((call) => call.manifest === false), 'every call, the final one too, is before the manifest');
  assert.deepEqual(calls.at(-1).attempts, [1]);
  assert.equal(readFileSync(join(tmp, 'box', 'record-1', '.spool', 'started'), 'utf8'), readFileSync(join(recording, 'manifest.json'), 'utf8') && JSON.parse(readFileSync(join(recording, 'manifest.json'), 'utf8')).recorded.started, 'the child wrote the recording\'s clock into its own directory from RECORD_STARTED');
  const lines = readEvents(recording);
  assert.ok(lines.some((line) => line.source === 'workflow'), 'the child\'s own lines came home');
  assert.ok(existsSync(join(recording, 'blobs')) && readdirSync(join(recording, 'blobs')).every((name) => !name.startsWith('.')), 'its blobs came home, none left half written');
  assert.deepEqual(validateRecording(recording), []);
});
test('recording.carry.failed: a tick that fails is retried, a final failure refuses the recording when the attempt ended on its own, and does not when its box was lost (lost: true, the recording stands)', { timeout: 300_000 }, async (t) => {
  const tmp = await mkdtemp(join(tmpdir(), 'reference-carry-failed-'));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const file = join(tmp, 'spec.json');
  Object.assign(process.env, { DEMO_SPEC: file });
  t.after(() => { for (const name of Object.keys(process.env)) if (!(name in ORIGINAL)) delete process.env[name]; Object.assign(process.env, ORIGINAL); });
  writeFileSync(file, JSON.stringify({ name: 'reference' }));
  const { options } = await import(`${FIXTURE}?options=${Date.now()}`);
  const failed = (recording) => readEvents(recording).filter((line) => line.source === 'host' && line.kind === 'recording.carry.failed');
  // A tick that fails once: a line, no refusal, and the final call brings everything home. Ticks are the only non-final carries, so the child is held
  // (a step that waits on a file) until the first one has happened: a child that finishes inside one tick would have no tick to fail.
  const tick = join(tmp, 'tick');
  const released = join(tmp, 'tick-released');
  let retried;
  process.env.DEMO_LINGER_UNTIL = released;
  try {
    const { options: held } = await import(`${FIXTURE}?options=held-${Date.now()}`);
    let ticked = false;
    retried = await demo({ ...held, argv: ['--json', '--record', tick], place: boxed(join(tmp, 'b1'), { failOn: ({ final }) => { if (final || ticked) return undefined; ticked = true; writeFileSync(released, ''); return 'CARRY_FAILED'; } }) });
  } finally {
    delete process.env.DEMO_LINGER_UNTIL;
  }
  assert.equal(retried.processes.at(-1).outcome.status, 'complete');
  assert.deepEqual(failed(tick).map((line) => [line.data.gen, line.data.code, 'lost' in line.data]), [[1, 'CARRY_FAILED', false]]);
  assert.ok(!failed(tick)[0].data.message.includes(tmp) && failed(tick)[0].data.message.includes('<path>'), 'paths in the message are <path>');
  assert.ok(readEvents(tick).some((line) => line.source === 'workflow'), 'and the child\'s lines are home');
  // A final failure after a runner that ended on its own: refused, no manifest.
  const refused = join(tmp, 'refused');
  await assert.rejects(() => demo({ ...options, argv: ['--json', '--record', refused], place: boxed(join(tmp, 'b2'), { failOn: ({ final }) => (final ? 'CARRY_FAILED' : undefined) }) }), /the recording is refused: the place could not bring home process 1's recording \(CARRY_FAILED\)/);
  assert.ok(!existsSync(join(refused, 'manifest.json')));
  // The same failure for an attempt whose box was lost: the recording stands, with lost: true.
  writeFileSync(file, JSON.stringify({ name: 'reference', kills: [{ point: 'event workflow.judge.answered', why: 'the box is taken away', kind: 'box' }] }));
  const { options: boxKill } = await import(`${FIXTURE}?options=${Date.now()}`);
  const lost = join(tmp, 'lost');
  let firstFinal = true;
  const stood = await demo({ ...boxKill, argv: ['--kill', '--json', '--record', lost], place: boxed(join(tmp, 'b3'), { kind: 'box', failOn: ({ final }) => { if (!final || !firstFinal) return undefined; firstFinal = false; return 'BOX_GONE'; } }) });
  assert.equal(stood.processes.at(-1).outcome.status, 'complete');
  assert.deepEqual(failed(lost).map((line) => [line.data.gen, line.data.code, line.data.lost]), [[1, 'BOX_GONE', true]]);
  assert.ok(existsSync(join(lost, 'manifest.json')), 'the recording stands');
  assert.deepEqual(validateRecording(lost), []);
});
test('the box child\'s own recorder redacts the box\'s host name and boot id even where no sign-in file is handed down (no AGENTRUN_HOME): a box-side line holding them is clean', async () => {
  const { trackSecrets } = await import('../packages/harness/dist/secrets.js');
  const { hostname } = await import('node:os');
  const boot = existsSync('/proc/sys/kernel/random/boot_id') ? readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim() : undefined;
  const { redact } = trackSecrets({}, { name: 'x' }, join(tmpdir(), 'no-such-sign-in', 'auth.json'));
  const line = JSON.stringify({ data: { text: `the box ${hostname()} booted as ${boot ?? 'no-boot-id'} and says hello` } });
  const cleaned = redact(line);
  if (hostname().length >= 4 && hostname() !== 'localhost') assert.ok(!cleaned.includes(hostname()), 'the box\'s host name is gone');
  if (boot) assert.ok(!cleaned.includes(boot), 'and its boot id');
  assert.ok(cleaned.includes('says hello'));
});
test('RECORD_STARTED gives a fresh recording directory its clock (an existing one is left alone), and a spool rolls into segments past segmentBytes that a second process still counts as one', async (t) => {
  const { openRecorder, startedAt } = await import('../packages/harness/dist/record.js');
  const tmp = await mkdtemp(join(tmpdir(), 'reference-segments-'));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const clock = '2026-10-16T09:00:00.000Z';
  const fresh = join(tmp, 'fresh');
  assert.equal(startedAt(fresh, clock), clock, 'a fresh directory takes the value it is given');
  assert.equal(startedAt(fresh, '2030-01-01T00:00:00.000Z'), clock, 'an existing one is left alone');
  // Segments: a tiny segment size rolls the stream; the lines are all there, in segments `<stream>.<n>.jsonl`.
  const dir = join(tmp, 'rec');
  const first = openRecorder({ dir, started: clock, segmentBytes: 300 });
  for (let index = 0; index < 8; index += 1) first.live('workflow', 'x', { text: 'x'.repeat(100), index });
  await first.detach();
  const names = readdirSync(join(dir, '.spool')).filter((name) => name.endsWith('.jsonl')).sort();
  assert.ok(names.length >= 3 && names.every((name) => /^live-\d+-\d+\.\d+\.jsonl$/.test(name)), names.join(','));
  const lines = names.flatMap((name) => readFileSync(join(dir, '.spool', name), 'utf8').split('\n').filter(Boolean)).map((entry) => JSON.parse(entry));
  assert.deepEqual(lines.map((line) => line.data.index).sort(), [0, 1, 2, 3, 4, 5, 6, 7]);
  assert.ok(names.every((name) => statSync(join(dir, '.spool', name)).size <= 600), 'each segment is small');
  // A second process counts the first as one process, not one per segment. A stream is named for its process's pid and the
  // millisecond it opened; a second process never shares both, so this one, in the same process, opens in a later millisecond.
  const firstOpened = Number(/^live-\d+-(\d+)\./.exec(names[0])[1]);
  while (Date.now() <= firstOpened) await new Promise((resolve) => setTimeout(resolve, 1));
  const second = openRecorder({ dir, segmentBytes: 300 });
  second.live('workflow', 'x', { index: 'second' });
  await second.detach();
  const all = readdirSync(join(dir, '.spool')).filter((name) => name.endsWith('.jsonl')).flatMap((name) => readFileSync(join(dir, '.spool', name), 'utf8').split('\n').filter(Boolean)).map((entry) => JSON.parse(entry));
  assert.equal(all.find((line) => line.data.index === 'second').gen, 2, 'the second process is process 2');
  assert.equal(all.find((line) => line.data.index === 0).gen, 1);


});
test('a box.receipt line is written for each box place.status() reports once its `to` appears: box-N by first appearance, seconds, the price and the cost (null with no price), never the provider\'s id; a place that reports none writes none', { timeout: 300_000 }, async (t) => {
  const tmp = await mkdtemp(join(tmpdir(), 'reference-box-receipts-'));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const file = join(tmp, 'spec.json');
  writeFileSync(file, JSON.stringify({ name: 'reference', kills: [{ point: 'judge.asked verdict', why: 'asked through the place' }] }));
  Object.assign(process.env, { DEMO_SPEC: file });
  t.after(() => { for (const name of Object.keys(process.env)) if (!(name in ORIGINAL)) delete process.env[name]; Object.assign(process.env, ORIGINAL); });
  const { options } = await import(`${FIXTURE}?options=${Date.now()}`);
  const lines = (recording, kind) => readEvents(recording).filter((line) => line.source === 'host' && line.kind === kind);
  const recording = join(tmp, 'recording');
  const priced = { provider: 'prov', kind: 'sandbox', id: 'sbx-9f31c0', from: '2026-10-16T10:00:00.000Z', usdPerSecond: 0.0001, source: 'https://prices.example/page 2026-10-01', priced: true };
  const unpriced = { provider: 'prov', kind: 'sandbox', id: 'sbx-77ab12', from: '2026-10-16T10:01:00.000Z', source: 'none published', priced: false };
  const result = await demo({ ...options, argv: ['--kill', '--json', '--record', recording], place: ({ paths, self, destroyBoxes, requestFile }) => {
    const inner = localPlace({ self, paths, destroyBoxes, requestFile });
    let boxes = [];
    return {
      ...inner,
      status: async () => ({ record: null, boxes }),
      start: async (order) => { boxes = [priced, unpriced]; return inner.start(order); },
      // The first box ends when the process is killed; the second ends with the takeover.
      kill: async (runner, kind) => { boxes = [{ ...priced, to: '2026-10-16T10:00:30.000Z' }, unpriced]; await inner.kill(runner, kind); },
      recover: async (last, kind, order) => { const next = await inner.recover(last, kind, order); boxes = [{ ...priced, to: '2026-10-16T10:00:30.000Z' }, { ...unpriced, to: '2026-10-16T10:03:00.000Z' }]; return next; },
    };
  } });
  const receipts = lines(recording, 'box.receipt').map((line) => line.data);
  assert.deepEqual(receipts.map((row) => [row.box, row.seconds, row.usd_per_second, row.cost_usd, row.priced]), [['box-1', 30, 0.0001, 0.003, true], ['box-2', 120, null, null, false]], 'one per box, in order of first appearance; the unpriced box has no cost');
  assert.deepEqual(Object.keys(receipts[0]).sort(), ['box', 'cost_usd', 'from', 'kind', 'priced', 'provider', 'seconds', 'source', 'to', 'usd_per_second']);
  assert.ok(!readFileSync(join(recording, 'events.jsonl'), 'utf8').match(/sbx-9f31c0|sbx-77ab12/), 'the provider\'s id is not in the recording');
  assert.equal(result.usd, null, 'one box has no price: the run\'s cost reads unknown, never the priced box alone');
  assert.deepEqual(validateRecording(recording), []);
  const plain = join(tmp, 'plain');
  await demo({ ...options, argv: ['--kill', '--json', '--record', plain] });
  assert.equal(lines(plain, 'box.receipt').length, 0);
});
test('boxes of one provider, kind and start are two boxes, labelled box-N when they first appear (not when they end), and the cap counts the priced boxes beside an unpriced one', { timeout: 300_000 }, async (t) => {
  const { tmp, options } = await specWith(t, { name: 'reference', kills: [{ point: 'judge.asked verdict', why: 'asked through the place' }] });
  const recording = join(tmp, 'recording');
  const same = { provider: 'prov', kind: 'sandbox', from: '2026-10-16T10:00:00.000Z', usdPerSecond: 1, source: 'list', priced: true };
  await demo({ ...options, argv: ['--kill', '--json', '--record', recording], place: ({ paths, self, destroyBoxes, requestFile }) => {
    const inner = localPlace({ self, paths, destroyBoxes, requestFile });
    let boxes = [];
    return {
      ...inner,
      status: async () => ({ record: null, boxes }),
      start: async (order) => { boxes = [same, same]; return inner.start(order); },
      // The second box ends first, then the first: the labels follow the order the boxes appeared in.
      kill: async (runner, kind) => { boxes = [same, { ...same, to: '2026-10-16T10:00:20.000Z' }]; await inner.kill(runner, kind); },
      recover: async (last, kind, order) => { const next = await inner.recover(last, kind, order); boxes = [{ ...same, to: '2026-10-16T10:00:10.000Z' }, { ...same, to: '2026-10-16T10:00:20.000Z' }]; return next; },
    };
  } });
  const receipts = readEvents(recording).filter((line) => line.source === 'host' && line.kind === 'box.receipt').map((line) => [line.data.box, line.data.seconds]);
  assert.deepEqual(receipts, [['box-2', 20], ['box-1', 10]], 'two boxes with equal fields are two; box-1 is the one that appeared first, though it ended last');
  // The cap: a $1 box and an unpriced one: the cost is unknown, and the spend so far counts the $1.
  const dir = join(tmp, 'meter');
  mkdirSync(join(dir, '.spool'), { recursive: true });
  const receipt = (box, cost_usd) => JSON.stringify({ channel: 'live', source: 'host', kind: 'box.receipt', t: 1, seq: 0, data: { box, cost_usd } });
  writeFileSync(join(dir, '.spool', 'supervisor-1.jsonl'), `${receipt('box-1', 1)}\n${receipt('box-2', null)}\n`);
  assert.equal(meterKnown(dir), 1, 'the priced box counts against the cap, though the other has no price');
});
test('the slow tick does not queue a carry behind one still running: a place whose transfers take seconds is carried a bounded number of times', { timeout: 120_000 }, async (t) => {
  const { tmp, options } = await specWith(t, { name: 'reference' });
  process.env.DEMO_LINGER_MS = '7000';
  let carries = 0;
  const started = Date.now();
  await demo({ ...options, argv: ['--json', '--record', join(tmp, 'recording')], place: ({ paths, self, destroyBoxes, requestFile }) => ({
    ...localPlace({ self, paths, destroyBoxes, requestFile }),
    recordHome: { dir: (attempt) => join(tmp, 'box', `record-${attempt}`), bringHome: async () => { carries += 1; await new Promise((resolve) => setTimeout(resolve, 2500)); } },
  }) });
  // The ticks that found no carry running, plus the final one; a tick queued behind every slow carry would make six or more.
  assert.ok(carries <= 4, `carried ${carries} times in ${Date.now() - started} ms`);

});
test('a box charge that first appears in the last status read counts against the cap: the run is over budget', { timeout: 300_000 }, async (t) => {
  const { tmp, options } = await specWith(t, { name: 'reference', expectedCost: 0.05 });
  const recording = join(tmp, 'recording');
  let exited = false;
  const result = await demo({ ...options, argv: ['--json', '--record', recording], place: ({ paths, self, destroyBoxes, requestFile }) => {
    const inner = localPlace({ self, paths, destroyBoxes, requestFile });
    const box = { provider: 'prov', kind: 'sandbox', from: '2026-10-16T10:00:00.000Z', usdPerSecond: 1, source: 'list', priced: true };
    // The box's end is first reported by a read made after the runner has exited (the supervisor's last), never by how many reads came before: the slow tick reads too, so a count can land mid-run. $60 against a cap of $0.10.
    return { ...inner,
      start: async (order) => { const runner = await inner.start(order); runner.exited.then(() => { exited = true; }, () => { exited = true; }); return runner; },
      status: async () => ({ record: null, boxes: [exited ? { ...box, to: '2026-10-16T10:01:00.000Z' } : box] }) };
  } });
  assert.equal(result.processes.at(-1).outcome.status, 'complete');
  assert.equal(result.overBudget, true, 'the charge that arrived with the last read is over the cap');
});
test('a box charge that first appears in the very last status read the supervisor makes (the second after the runner exits) counts against the cap: the run is over budget, which only the final budget check can see', { timeout: 300_000 }, async (t) => {
  const { tmp, options } = await specWith(t, { name: 'reference', expectedCost: 0.05 });
  const recording = join(tmp, 'recording');
  let exited = false;
  let afterExit = 0;
  const result = await demo({ ...options, argv: ['--json', '--record', recording], place: ({ paths, self, destroyBoxes, requestFile }) => {
    const inner = localPlace({ self, paths, destroyBoxes, requestFile });
    const box = { provider: 'prov', kind: 'sandbox', from: '2026-10-16T10:00:00.000Z', usdPerSecond: 1, source: 'list', priced: true };
    // The box's end is first reported by the second read after the runner has exited: the first is the exit read, the second the last one the supervisor makes, before its final budget check. A charge that arrived at the exit read could be counted by the meter before that check; the slow tick reads too, so a count can land mid-run. $60 against a cap of $0.10.
    return { ...inner,
      start: async (order) => { const runner = await inner.start(order); runner.exited.then(() => { exited = true; }, () => { exited = true; }); return runner; },
      status: async () => { if (exited) afterExit += 1; return { record: null, boxes: [afterExit >= 2 ? { ...box, to: '2026-10-16T10:01:00.000Z' } : box] }; } };
  } });
  assert.equal(result.processes.at(-1).outcome.status, 'complete');
  assert.equal(result.overBudget, true, 'the charge that arrived with the last read is over the cap');
});

